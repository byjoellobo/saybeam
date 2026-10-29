//! Transport-agnostic room logic, mirroring `packages/protocol/src/room-core.ts`.
//!
//! The hub owns the sockets. It hands every inbound frame to
//! [`Room::handle_frame`] and executes the returned [`Outcome`]: send messages
//! to targets, record the connection's new role, close sockets. Time is passed
//! in explicitly so the rules are unit-testable without a clock or sockets.

use std::collections::HashMap;

use crate::codes::{generate_token, hash_token, timing_safe_equal};
use crate::protocol::{
    ClientMsg, ErrorCode, LinkTarget, PROTOCOL_VERSION, PartialCaption, Presence, Role, RoomMeta,
    RoomStatus, RoomSummary, Segment, ServerMsg, WelcomeMode, close, limits,
};
use crate::ratelimit::ConnLimits;
use crate::validate::{
    Frame, clean_text, exceeds_frame_limit, parse_client_frame, truncate_utf16, utf16_len,
};

pub type ConnId = u64;

/// What the room knows about one connection.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ConnState {
    pub id: ConnId,
    /// `None` until the client has sent a valid hello.
    pub role: Option<Role>,
}

/// Who receives a message. `Others` means every joined connection except the sender.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Target {
    Sender,
    All,
    Others,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Outbound {
    pub to: Target,
    pub msg: ServerMsg,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CloseRequest {
    pub code: u16,
    pub reason: &'static str,
}

/// Close every connection with `role` except the sender.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CloseOthers {
    pub role: Role,
    pub close: CloseRequest,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Outcome {
    pub send: Vec<Outbound>,
    /// New role for the sender after a successful hello.
    pub joined_as: Option<Role>,
    /// Close the sender after delivering `send`.
    pub close: Option<CloseRequest>,
    /// The newest speaker wins: close every other speaker connection.
    pub replace_other_speakers: bool,
    /// A link was replaced: close every other connection with this role.
    pub close_others: Option<CloseOthers>,
    /// Presence counts changed (the hub debounces the broadcast).
    pub presence_changed: bool,
    /// Room content changed (finals, corrections, end).
    pub activity: bool,
}

impl Outcome {
    fn reply(msg: ServerMsg) -> Outcome {
        Outcome {
            send: vec![Outbound {
                to: Target::Sender,
                msg,
            }],
            ..Outcome::default()
        }
    }

    fn error(code: ErrorCode, message: impl Into<String>) -> Outcome {
        Outcome::reply(ServerMsg::error(code, message))
    }

    fn broadcast(to: Target, msg: ServerMsg) -> Outcome {
        Outcome {
            send: vec![Outbound { to, msg }],
            ..Outcome::default()
        }
    }

    fn closing(self, code: u16, reason: &'static str) -> Outcome {
        Outcome {
            close: Some(CloseRequest { code, reason }),
            ..self
        }
    }
}

const ROOM_FULL: &str = "This room is full. Start a new session.";

/// Inputs for a new room. Token values are never stored, only their hashes.
#[derive(Clone, Debug)]
pub struct RoomInit {
    pub code: String,
    pub speaker_token_hash: String,
    pub corrector_token_hash: String,
    /// Makes the room private: listeners need this secret from the QR link.
    pub listener_token_hash: Option<String>,
    pub title: Option<String>,
    pub lang: Option<String>,
    pub allow_export: Option<bool>,
}

/// One room: metadata, segments, the live partial and per-connection limits.
#[derive(Debug)]
pub struct Room {
    code: String,
    meta: RoomMeta,
    status: RoomStatus,
    speaker_token_hash: String,
    corrector_token_hash: String,
    /// Present only for private rooms.
    listener_token_hash: Option<String>,
    /// Bumped by every new final and every correction.
    rev: u64,
    last_activity: u64,
    /// Seqs start at 1 and segments are never deleted, so `segments[i].seq == i + 1`.
    segments: Vec<Segment>,
    /// Speaker-assigned id to index in `segments`.
    ids: HashMap<String, usize>,
    /// Stored caption characters (UTF-16 units), kept up to date by corrections.
    chars: usize,
    partial: Option<PartialCaption>,
    last_partial_at: Option<u64>,
    conn_limits: ConnLimits,
    max_segments: usize,
    max_chars: usize,
}

impl Room {
    pub fn new(init: RoomInit, now: u64) -> Room {
        let title = clean_text(init.title.as_deref().unwrap_or(""));
        Room {
            code: init.code,
            meta: RoomMeta {
                title: truncate_utf16(&title, limits::MAX_TITLE_CHARS).to_string(),
                lang: init.lang.unwrap_or_else(|| "en-US".to_string()),
                allow_export: init.allow_export.unwrap_or(true),
                created_at: now,
                private: init.listener_token_hash.is_some(),
            },
            status: RoomStatus::Live,
            speaker_token_hash: init.speaker_token_hash,
            corrector_token_hash: init.corrector_token_hash,
            listener_token_hash: init.listener_token_hash,
            rev: 0,
            last_activity: now,
            segments: Vec::new(),
            ids: HashMap::new(),
            chars: 0,
            partial: None,
            last_partial_at: None,
            conn_limits: ConnLimits::default(),
            max_segments: limits::MAX_SEGMENTS,
            max_chars: limits::MAX_ROOM_CHARS,
        }
    }

    pub fn code(&self) -> &str {
        &self.code
    }

    pub fn status(&self) -> RoomStatus {
        self.status
    }

    pub fn last_activity(&self) -> u64 {
        self.last_activity
    }

    /// Public description for the join screen. Private rooms do not reveal their title.
    pub fn summary(&self) -> RoomSummary {
        let private = self.meta.private;
        RoomSummary {
            code: self.code.clone(),
            status: self.status,
            title: if private {
                String::new()
            } else {
                self.meta.title.clone()
            },
            private,
        }
    }

    /// Handle one raw frame. `others` computes presence over every other
    /// connection; it is only called for `hello`.
    pub fn handle_frame(
        &mut self,
        conn: ConnState,
        frame: Frame<'_>,
        others: impl FnOnce() -> Presence,
        now: u64,
    ) -> Outcome {
        if let Frame::Text(raw) = frame
            && exceeds_frame_limit(raw)
        {
            return Outcome::error(ErrorCode::BadFrame, "frame too large")
                .closing(close::BAD_FRAME, "frame too large");
        }
        if !self.conn_limits.charge(conn.id, conn.role, 1.0, now) {
            return self.strike(
                conn,
                ErrorCode::RateLimited,
                "Slow down: too many messages.",
            );
        }
        let msg = match parse_client_frame(frame) {
            Ok(msg) => msg,
            Err(reason) => return self.strike(conn, ErrorCode::BadFrame, reason),
        };
        // History pages can be large and rotation does crypto work, so both cost more.
        let expensive = match msg {
            ClientMsg::History { .. } => Some("Slow down: too many history requests."),
            ClientMsg::Rotate { .. } => Some("Slow down."),
            _ => None,
        };
        if let Some(message) = expensive
            && !self
                .conn_limits
                .charge(conn.id, conn.role, limits::HISTORY_COST - 1.0, now)
        {
            return self.strike(conn, ErrorCode::RateLimited, message);
        }
        self.handle(conn, msg, others, now)
    }

    /// Handle one validated message.
    pub fn handle(
        &mut self,
        conn: ConnState,
        msg: ClientMsg,
        others: impl FnOnce() -> Presence,
        now: u64,
    ) -> Outcome {
        if let ClientMsg::Hello { role, token, since } = msg {
            let hello = Hello {
                role,
                token: token.as_deref(),
                since: since.unwrap_or(0),
            };
            return self.on_hello(conn, hello, others, now);
        }
        let Some(role) = conn.role else {
            return Outcome::error(ErrorCode::HelloRequired, "Send hello first.");
        };
        match msg {
            ClientMsg::Hello { .. } => Outcome::default(), // handled above
            ClientMsg::Partial { id, text } => self.on_partial(role, id, &text, now),
            ClientMsg::Final {
                id,
                text,
                start_ms,
                end_ms,
            } => self.on_final(role, id, &text, (start_ms, end_ms), now),
            ClientMsg::Correct { seq, text } => self.on_correct(role, seq, &text, now),
            ClientMsg::Meta {
                title,
                lang,
                allow_export,
            } => self.on_meta(role, title, lang, allow_export),
            ClientMsg::Status { status } => self.on_status(role, status),
            ClientMsg::End => self.on_end(role, now),
            ClientMsg::History { before, limit } => self.on_history(role, before, limit),
            ClientMsg::Ping { ts } => Outcome::reply(ServerMsg::Pong {
                ts,
                server_time: now,
            }),
            ClientMsg::Rotate { target } => self.on_rotate(role, target),
        }
    }

    /// A connection went away. `speaker_remains`: another speaker connection is
    /// still open (this one was replaced), so its partial is left alone.
    pub fn handle_disconnect(&mut self, conn: ConnState, speaker_remains: bool) -> Outcome {
        self.conn_limits.forget(conn.id);
        match conn.role {
            None => Outcome::default(),
            Some(Role::Speaker) if self.partial.is_some() && !speaker_remains => {
                let cleared = self.partial.take().map(|p| p.id).unwrap_or_default();
                let clear = ServerMsg::Partial {
                    id: cleared,
                    text: String::new(),
                };
                Outcome {
                    presence_changed: true,
                    ..Outcome::broadcast(Target::Others, clear)
                }
            }
            Some(_) => Outcome {
                presence_changed: true,
                ..Outcome::default()
            },
        }
    }

    /* ------------------------------- handlers ------------------------------- */

    fn on_hello(
        &mut self,
        conn: ConnState,
        hello: Hello<'_>,
        others: impl FnOnce() -> Presence,
        now: u64,
    ) -> Outcome {
        if conn.role.is_some() {
            return Outcome::error(ErrorCode::Invalid, "Already joined.");
        }
        let role = hello.role;
        let needs_token = role != Role::Listener || self.meta.private;
        if needs_token && !hello.token.is_some_and(|t| self.check_token(role, t)) {
            return Outcome::error(
                ErrorCode::Unauthorized,
                "This link is not valid for that role.",
            )
            .closing(close::UNAUTHORIZED, "unauthorized");
        }
        // Start the role's own rate-limit bucket fresh instead of inheriting the pre-hello one.
        self.conn_limits.reset_bucket(conn.id);
        let (mode, segments, has_more) = self.snapshot(hello.since, role);
        let welcome = ServerMsg::Welcome {
            v: PROTOCOL_VERSION,
            room: self.code.clone(),
            role,
            meta: self.meta.clone(),
            status: self.status,
            mode,
            segments,
            partial: self.partial.clone(),
            has_more,
            rev: self.rev,
            presence: others().with_role(role),
            server_time: now,
        };
        Outcome {
            joined_as: Some(role),
            presence_changed: true,
            replace_other_speakers: role == Role::Speaker,
            ..Outcome::reply(welcome)
        }
    }

    fn on_partial(&mut self, role: Role, id: String, text: &str, now: u64) -> Outcome {
        if role != Role::Speaker {
            return Outcome::error(ErrorCode::Forbidden, "Only the speaker can send captions.");
        }
        if self.status == RoomStatus::Ended {
            return Outcome::error(ErrorCode::RoomEnded, "This session has ended.");
        }
        let text = clean_text(text);
        if text.is_empty() {
            // Only clear the partial this id refers to; a late clear must not wipe a newer one.
            if !self.partial.as_ref().is_some_and(|p| p.id == id) {
                return Outcome::default();
            }
            self.partial = None;
            let clear = ServerMsg::Partial {
                id,
                text: String::new(),
            };
            return Outcome::broadcast(Target::Others, clear);
        }
        if self
            .partial
            .as_ref()
            .is_some_and(|p| p.id == id && p.text == text)
        {
            return Outcome::default();
        }
        self.partial = Some(PartialCaption {
            id: id.clone(),
            text: text.clone(),
        });
        // Throttle: store the newest partial but only broadcast every 80 ms.
        if self
            .last_partial_at
            .is_some_and(|t| now.saturating_sub(t) < limits::PARTIAL_MIN_INTERVAL_MS)
        {
            return Outcome::default();
        }
        self.last_partial_at = Some(now);
        Outcome::broadcast(Target::Others, ServerMsg::Partial { id, text })
    }

    fn on_final(
        &mut self,
        role: Role,
        id: String,
        text: &str,
        (start_ms, end_ms): (Option<u64>, Option<u64>),
        now: u64,
    ) -> Outcome {
        if role != Role::Speaker {
            return Outcome::error(ErrorCode::Forbidden, "Only the speaker can send captions.");
        }
        if self.status == RoomStatus::Ended {
            return Outcome::error(ErrorCode::RoomEnded, "This session has ended.");
        }
        let text = clean_text(text);
        if text.is_empty() {
            return Outcome::error(ErrorCode::Invalid, "Empty caption.");
        }
        // Idempotent: a speaker resending after a reconnect gets the stored copy back.
        if let Some(existing) = self.ids.get(&id).and_then(|&i| self.segments.get(i)) {
            return Outcome::reply(ServerMsg::Final {
                seg: existing.clone(),
            });
        }
        let chars = self.chars + utf16_len(&text);
        if self.segments.len() >= self.max_segments || chars > self.max_chars {
            return Outcome::error(ErrorCode::RoomFull, ROOM_FULL);
        }
        let seg = Segment {
            seq: self.segments.len() as u64 + 1,
            id: id.clone(),
            text,
            ts: now,
            rev: self.rev + 1,
            start_ms,
            end_ms,
            edited: false,
        };
        self.rev = seg.rev;
        self.chars = chars;
        self.last_activity = now;
        self.ids.insert(id.clone(), self.segments.len());
        self.segments.push(seg.clone());
        if self.partial.as_ref().is_some_and(|p| p.id == id) {
            self.partial = None;
        }
        Outcome {
            activity: true,
            ..Outcome::broadcast(Target::All, ServerMsg::Final { seg })
        }
    }

    fn on_correct(&mut self, role: Role, seq: u64, text: &str, now: u64) -> Outcome {
        if role == Role::Listener {
            return Outcome::error(
                ErrorCode::Forbidden,
                "Only the speaker or a corrector can edit captions.",
            );
        }
        let rev = self.rev + 1;
        let (room_chars, max_chars) = (self.chars, self.max_chars);
        let Some(seg) = self.segment_mut(seq) else {
            return Outcome::error(ErrorCode::NotFound, format!("No caption #{seq}."));
        };
        let text = clean_text(text);
        if seg.text == text {
            return Outcome::default();
        }
        let (old_len, new_len) = (utf16_len(&seg.text), utf16_len(&text));
        let chars = room_chars.saturating_sub(old_len) + new_len;
        if new_len > old_len && chars > max_chars {
            return Outcome::error(ErrorCode::RoomFull, ROOM_FULL);
        }
        seg.text = text.clone();
        seg.rev = rev;
        seg.edited = true;
        self.rev = rev;
        self.chars = chars;
        self.last_activity = now;
        let msg = ServerMsg::Correct {
            seq,
            text,
            rev,
            by: role,
        };
        Outcome {
            activity: true,
            ..Outcome::broadcast(Target::All, msg)
        }
    }

    fn on_meta(
        &mut self,
        role: Role,
        title: Option<String>,
        lang: Option<String>,
        allow_export: Option<bool>,
    ) -> Outcome {
        if role != Role::Speaker {
            return Outcome::error(
                ErrorCode::Forbidden,
                "Only the speaker can change room settings.",
            );
        }
        if let Some(title) = title {
            self.meta.title = clean_text(&title);
        }
        if let Some(lang) = lang {
            self.meta.lang = lang;
        }
        if let Some(allow_export) = allow_export {
            self.meta.allow_export = allow_export;
        }
        let meta = self.meta.clone();
        Outcome::broadcast(Target::All, ServerMsg::Meta { meta })
    }

    fn on_status(&mut self, role: Role, status: RoomStatus) -> Outcome {
        if role != Role::Speaker {
            return Outcome::error(ErrorCode::Forbidden, "Only the speaker can pause captions.");
        }
        if self.status == RoomStatus::Ended {
            return Outcome::error(ErrorCode::RoomEnded, "This session has ended.");
        }
        if self.status == status {
            return Outcome::default();
        }
        self.status = status;
        let mut send = vec![Outbound {
            to: Target::All,
            msg: ServerMsg::Status { status },
        }];
        if status == RoomStatus::Paused
            && let Some(partial) = self.partial.take()
        {
            send.push(Outbound {
                to: Target::Others,
                msg: ServerMsg::Partial {
                    id: partial.id,
                    text: String::new(),
                },
            });
        }
        Outcome {
            send,
            ..Outcome::default()
        }
    }

    fn on_end(&mut self, role: Role, now: u64) -> Outcome {
        if role != Role::Speaker {
            return Outcome::error(
                ErrorCode::Forbidden,
                "Only the speaker can end the session.",
            );
        }
        if self.status == RoomStatus::Ended {
            return Outcome::default();
        }
        self.status = RoomStatus::Ended;
        self.last_activity = now;
        self.partial = None;
        let ended = ServerMsg::Status {
            status: RoomStatus::Ended,
        };
        Outcome {
            activity: true,
            ..Outcome::broadcast(Target::All, ended)
        }
    }

    fn on_history(&self, role: Role, before: u64, limit: Option<usize>) -> Outcome {
        // With downloads off, listeners keep the live window only (the welcome's recent lines).
        if role == Role::Listener && !self.meta.allow_export {
            return Outcome::error(
                ErrorCode::Forbidden,
                "The speaker has turned off transcript access.",
            );
        }
        let limit = limit
            .unwrap_or(limits::WELCOME_HISTORY)
            .min(limits::HISTORY_PAGE);
        let segments = self.before(before, limit);
        let has_more = self.older_exist(&segments);
        Outcome::reply(ServerMsg::History { segments, has_more })
    }

    fn on_rotate(&mut self, role: Role, target: LinkTarget) -> Outcome {
        if role != Role::Speaker {
            return Outcome::error(ErrorCode::Forbidden, "Only the speaker can replace links.");
        }
        if target == LinkTarget::Listener && !self.meta.private {
            return Outcome::error(ErrorCode::Invalid, "This room is not private.");
        }
        // Store the new hash before anyone learns the token. Allowed after the session ended.
        let token = generate_token();
        let hash = hash_token(&token);
        match target {
            LinkTarget::Corrector => self.corrector_token_hash = hash,
            LinkTarget::Listener => self.listener_token_hash = Some(hash),
        }
        Outcome {
            close_others: Some(CloseOthers {
                role: target.role(),
                close: CloseRequest {
                    code: close::UNAUTHORIZED,
                    reason: "link replaced",
                },
            }),
            ..Outcome::reply(ServerMsg::Rotated { target, token })
        }
    }

    /* ------------------------------- helpers ------------------------------- */

    /// Reply with an error, and close connections that keep sending rejected frames.
    fn strike(&mut self, conn: ConnState, code: ErrorCode, message: impl Into<String>) -> Outcome {
        let out = Outcome::error(code, message);
        if self.conn_limits.strike(conn.id) {
            out.closing(close::BAD_FRAME, "too many rejected messages")
        } else {
            out
        }
    }

    fn snapshot(&self, since: u64, role: Role) -> (WelcomeMode, Vec<Segment>, bool) {
        if since > 0 && since <= self.rev && self.count_changed_since(since) <= limits::RESUME_LIMIT
        {
            let changed = self
                .segments
                .iter()
                .filter(|s| s.rev > since)
                .cloned()
                .collect();
            return (WelcomeMode::Append, changed, false);
        }
        let count = if role == Role::Listener {
            limits::WELCOME_HISTORY
        } else {
            limits::STAFF_WELCOME_HISTORY
        };
        let latest = self.segments[self.segments.len().saturating_sub(count)..].to_vec();
        let has_more = self.older_exist(&latest);
        (WelcomeMode::Replace, latest, has_more)
    }

    fn count_changed_since(&self, rev: u64) -> usize {
        self.segments.iter().filter(|s| s.rev > rev).count()
    }

    /// Up to `limit` segments with seq < `before`, ascending.
    fn before(&self, before: u64, limit: usize) -> Vec<Segment> {
        // Segments with seq < before occupy indices 0..before-1.
        let end = usize::try_from(before.saturating_sub(1))
            .unwrap_or(usize::MAX)
            .min(self.segments.len());
        self.segments[end.saturating_sub(limit)..end].to_vec()
    }

    fn older_exist(&self, shown: &[Segment]) -> bool {
        match (self.segments.first(), shown.first()) {
            (Some(first), Some(shown)) => first.seq < shown.seq,
            _ => false,
        }
    }

    fn segment_mut(&mut self, seq: u64) -> Option<&mut Segment> {
        let index = usize::try_from(seq.checked_sub(1)?).ok()?;
        self.segments.get_mut(index)
    }

    /// The speaker token grants every role, the corrector token grants corrector
    /// and listener, and the listener token (private rooms) grants listener only.
    fn check_token(&self, role: Role, token: &str) -> bool {
        let hash = hash_token(token);
        if timing_safe_equal(&hash, &self.speaker_token_hash) {
            return true;
        }
        if role == Role::Speaker {
            return false;
        }
        if timing_safe_equal(&hash, &self.corrector_token_hash) {
            return true;
        }
        role == Role::Listener
            && self
                .listener_token_hash
                .as_deref()
                .is_some_and(|expected| timing_safe_equal(&hash, expected))
    }
}

/// A validated `hello`.
struct Hello<'a> {
    role: Role,
    token: Option<&'a str>,
    since: u64,
}

#[cfg(test)]
#[path = "room_tests.rs"]
mod tests;
