//! Rooms in memory plus the live connections attached to each one.
//!
//! The hub feeds frames into [`Room`] and executes the returned [`Outcome`]:
//! fan-out to per-connection bounded channels, role changes, closes and
//! debounced presence. Locks are `std::sync::Mutex` held only for synchronous
//! work, never across an `.await`.

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use axum::extract::ws::Utf8Bytes;
use tokio::sync::Notify;
use tokio::sync::mpsc::{self, error::TrySendError};

use crate::codes::{generate_room_code, generate_token, hash_token};
use crate::protocol::{
    CreateRoomRequest, CreateRoomResponse, Presence, Role, RoomStatus, RoomSummary, ServerMsg,
    close,
};
use crate::room::{CloseRequest, ConnId, ConnState, Outbound, Outcome, Room, RoomInit, Target};
use crate::validate::Frame;

/// Tunables. The defaults match the protocol spec.
#[derive(Clone, Copy, Debug)]
pub struct HubSettings {
    /// Queued outbound messages per connection before it counts as too slow and is dropped.
    pub channel_capacity: usize,
    /// Presence changes are coalesced and broadcast once this long after the first one.
    pub presence_debounce: Duration,
    /// Upper bound on rooms held in memory (a classroom laptop needs a handful).
    pub max_rooms: usize,
}

impl Default for HubSettings {
    fn default() -> Self {
        HubSettings {
            channel_capacity: 512,
            presence_debounce: Duration::from_millis(1500),
            max_rooms: 200,
        }
    }
}

/// A message queued for one connection's writer.
#[derive(Debug)]
pub enum Outgoing {
    Text(Utf8Bytes),
    Close { code: u16, reason: &'static str },
}

/// Handles for a freshly attached connection.
#[derive(Debug)]
pub struct Connection {
    pub id: ConnId,
    pub rx: mpsc::Receiver<Outgoing>,
    /// For replies that skip the room (the literal keepalive `pong`).
    pub tx: mpsc::Sender<Outgoing>,
    /// Fires when the hub drops this connection without a close frame (too slow).
    pub kill: Arc<Notify>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum CreateRoomError {
    TooManyRooms,
    NoFreeCode,
}

#[derive(Debug)]
struct ConnEntry {
    role: Option<Role>,
    tx: mpsc::Sender<Outgoing>,
    kill: Arc<Notify>,
}

/// How a connection leaves the room.
#[derive(Clone, Copy, Debug)]
enum Detach {
    /// The socket already went away.
    Gone,
    /// Send a close frame after anything already queued.
    Close(CloseRequest),
    /// Too slow to keep up: tear the socket down now.
    Kill,
}

#[derive(Debug)]
struct RoomState {
    room: Room,
    conns: HashMap<ConnId, ConnEntry>,
    presence_scheduled: bool,
    /// Set when the room is dropped from the hub, so late connects fail.
    evicted: bool,
}

#[derive(Debug)]
struct RoomSlot {
    state: Mutex<RoomState>,
}

/// Id used as the sender of hub-originated broadcasts; real ids start at 1.
const NO_SENDER: ConnId = 0;
/// Close for a connection that never sent hello (1008: policy violation).
const HELLO_TIMEOUT: CloseRequest = CloseRequest {
    code: 1008,
    reason: "send hello first",
};
const MAX_CODE_ATTEMPTS: usize = 64;

#[derive(Debug)]
pub struct Hub {
    rooms: Mutex<HashMap<String, Arc<RoomSlot>>>,
    next_conn: AtomicU64,
    settings: HubSettings,
}

impl Default for Hub {
    fn default() -> Self {
        Hub::new(HubSettings::default())
    }
}

impl Hub {
    pub fn new(settings: HubSettings) -> Hub {
        Hub {
            rooms: Mutex::new(HashMap::new()),
            next_conn: AtomicU64::new(NO_SENDER + 1),
            settings,
        }
    }

    /// Create a room with a fresh code and tokens. Only token hashes are kept.
    pub fn create_room(
        &self,
        req: CreateRoomRequest,
    ) -> Result<CreateRoomResponse, CreateRoomError> {
        let speaker_token = generate_token();
        let corrector_token = generate_token();
        let speaker_token_hash = hash_token(&speaker_token);
        let corrector_token_hash = hash_token(&corrector_token);
        // Private rooms get a third secret for listeners (carried in the QR link).
        let listener_token = (req.private == Some(true)).then(generate_token);
        let listener_token_hash = listener_token.as_deref().map(hash_token);
        let mut rooms = lock(&self.rooms);
        if rooms.len() >= self.settings.max_rooms {
            return Err(CreateRoomError::TooManyRooms);
        }
        let code = (0..MAX_CODE_ATTEMPTS)
            .map(|_| generate_room_code())
            .find(|code| !rooms.contains_key(code))
            .ok_or(CreateRoomError::NoFreeCode)?;
        let init = RoomInit {
            code: code.clone(),
            speaker_token_hash,
            corrector_token_hash,
            listener_token_hash,
            title: req.title,
            lang: req.lang,
            allow_export: req.allow_export,
        };
        let state = RoomState {
            room: Room::new(init, now_ms()),
            conns: HashMap::new(),
            presence_scheduled: false,
            evicted: false,
        };
        rooms.insert(
            code.clone(),
            Arc::new(RoomSlot {
                state: Mutex::new(state),
            }),
        );
        Ok(CreateRoomResponse {
            code,
            speaker_token,
            corrector_token,
            listener_token,
        })
    }

    pub fn room_exists(&self, code: &str) -> bool {
        lock(&self.rooms).contains_key(code)
    }

    pub fn room_count(&self) -> usize {
        lock(&self.rooms).len()
    }

    pub fn room_summary(&self, code: &str) -> Option<RoomSummary> {
        let slot = self.slot(code)?;
        let state = lock(&slot.state);
        Some(state.room.summary())
    }

    /// Attach a new connection to a room. `None` when the room does not exist.
    pub fn connect(&self, code: &str) -> Option<Connection> {
        let slot = self.slot(code)?;
        let mut state = lock(&slot.state);
        if state.evicted {
            return None;
        }
        let id = self.next_conn.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = mpsc::channel(self.settings.channel_capacity);
        let kill = Arc::new(Notify::new());
        state.conns.insert(
            id,
            ConnEntry {
                role: None,
                tx: tx.clone(),
                kill: Arc::clone(&kill),
            },
        );
        Some(Connection { id, rx, tx, kill })
    }

    /// Feed one inbound frame from a connection into its room.
    pub fn handle_frame(&self, code: &str, conn_id: ConnId, frame: Frame<'_>) {
        let Some(slot) = self.slot(code) else { return };
        let mut state = lock(&slot.state);
        // Detached connections (replaced, closed, dropped) are ignored.
        let Some(role) = state.conns.get(&conn_id).map(|e| e.role) else {
            return;
        };
        // Split the guard into disjoint borrows: presence is only counted for hello.
        let RoomState { room, conns, .. } = &mut *state;
        let others = || {
            Presence::count(
                conns
                    .iter()
                    .filter(|(id, _)| **id != conn_id)
                    .map(|(_, e)| e.role),
            )
        };
        let conn = ConnState { id: conn_id, role };
        let outcome = room.handle_frame(conn, frame, others, now_ms());
        apply(&slot, &mut state, conn_id, outcome, &self.settings);
    }

    /// The connection's socket is gone.
    pub fn disconnect(&self, code: &str, conn_id: ConnId) {
        let Some(slot) = self.slot(code) else { return };
        let mut state = lock(&slot.state);
        let Some(outcome) = detach(&mut state, conn_id, Detach::Gone) else {
            return;
        };
        apply(&slot, &mut state, conn_id, outcome, &self.settings);
    }

    /// Close a connection that is still waiting for its hello. Joined ones are left alone.
    pub fn close_if_not_joined(&self, code: &str, conn_id: ConnId) {
        let Some(slot) = self.slot(code) else { return };
        let mut state = lock(&slot.state);
        if !state.conns.get(&conn_id).is_some_and(|e| e.role.is_none()) {
            return;
        }
        if let Some(outcome) = detach(&mut state, conn_id, Detach::Close(HELLO_TIMEOUT)) {
            apply(&slot, &mut state, conn_id, outcome, &self.settings);
        }
    }

    /// Drop ended rooms nobody is connected to after `max_idle` without activity.
    pub fn evict_idle(&self, now: u64, max_idle: Duration) -> usize {
        let max_idle_ms = u64::try_from(max_idle.as_millis()).unwrap_or(u64::MAX);
        let mut rooms = lock(&self.rooms);
        let before = rooms.len();
        rooms.retain(|_, slot| {
            let mut state = lock(&slot.state);
            let idle = state.conns.is_empty()
                && state.room.status() == RoomStatus::Ended
                && now.saturating_sub(state.room.last_activity()) >= max_idle_ms;
            state.evicted = idle;
            !idle
        });
        before - rooms.len()
    }

    fn slot(&self, code: &str) -> Option<Arc<RoomSlot>> {
        lock(&self.rooms).get(code).cloned()
    }
}

/// Execute an outcome, plus any follow-up outcomes from connections it detaches.
fn apply(
    slot: &Arc<RoomSlot>,
    state: &mut RoomState,
    sender: ConnId,
    outcome: Outcome,
    settings: &HubSettings,
) {
    let mut queue = VecDeque::from([(sender, outcome)]);
    let mut presence_changed = false;
    while let Some((sender, outcome)) = queue.pop_front() {
        presence_changed |= outcome.presence_changed;
        if let (Some(role), Some(entry)) = (outcome.joined_as, state.conns.get_mut(&sender)) {
            entry.role = Some(role);
        }
        let mut leaving: Vec<(ConnId, Detach)> = Vec::new();
        for out in &outcome.send {
            deliver(state, sender, out, &mut leaving);
        }
        if let Some(req) = outcome.close {
            leaving.push((sender, Detach::Close(req)));
        }
        if outcome.replace_other_speakers {
            let replaced = CloseRequest {
                code: close::REPLACED,
                reason: "replaced by a newer speaker connection",
            };
            leaving.extend(
                state
                    .conns
                    .iter()
                    .filter(|(id, e)| **id != sender && e.role == Some(Role::Speaker))
                    .map(|(id, _)| (*id, Detach::Close(replaced))),
            );
        }
        if let Some(others) = outcome.close_others {
            leaving.extend(
                state
                    .conns
                    .iter()
                    .filter(|(id, e)| **id != sender && e.role == Some(others.role))
                    .map(|(id, _)| (*id, Detach::Close(others.close))),
            );
        }
        for (id, how) in leaving {
            if let Some(next) = detach(state, id, how) {
                queue.push_back((id, next));
            }
        }
    }
    if presence_changed {
        schedule_presence(slot, state, settings);
    }
}

/// Serialize once and queue for every target. Failed sends are collected in `leaving`.
fn deliver(state: &RoomState, sender: ConnId, out: &Outbound, leaving: &mut Vec<(ConnId, Detach)>) {
    let text = match serde_json::to_string(&out.msg) {
        Ok(text) => Utf8Bytes::from(text),
        Err(err) => {
            tracing::error!(%err, "could not serialize a server message");
            return;
        }
    };
    let targets = state.conns.iter().filter(|(id, entry)| match out.to {
        Target::Sender => **id == sender,
        Target::All => entry.role.is_some(),
        Target::Others => **id != sender && entry.role.is_some(),
    });
    for (id, entry) in targets {
        match entry.tx.try_send(Outgoing::Text(text.clone())) {
            Ok(()) => {}
            Err(TrySendError::Full(_)) => {
                tracing::info!(
                    conn = id,
                    "client cannot keep up, dropping it (it will resume on reconnect)"
                );
                leaving.push((*id, Detach::Kill));
            }
            Err(TrySendError::Closed(_)) => leaving.push((*id, Detach::Gone)),
        }
    }
}

/// Remove a connection and let the room react. `None` if it was already gone.
fn detach(state: &mut RoomState, id: ConnId, how: Detach) -> Option<Outcome> {
    let entry = state.conns.remove(&id)?;
    match how {
        Detach::Gone => {}
        Detach::Close(req) => {
            let queued = entry.tx.try_send(Outgoing::Close {
                code: req.code,
                reason: req.reason,
            });
            if queued.is_err() {
                entry.kill.notify_one();
            }
        }
        Detach::Kill => entry.kill.notify_one(),
    }
    // A replaced speaker leaves while the new one is connected: keep the partial.
    let speaker_remains = state.conns.values().any(|e| e.role == Some(Role::Speaker));
    let conn = ConnState {
        id,
        role: entry.role,
    };
    Some(state.room.handle_disconnect(conn, speaker_remains))
}

/// Coalesce join/leave storms (a whole class scanning the QR code) into one
/// broadcast, sent `presence_debounce` after the first change (like the cloud server).
fn schedule_presence(slot: &Arc<RoomSlot>, state: &mut RoomState, settings: &HubSettings) {
    if state.presence_scheduled {
        return;
    }
    let Ok(runtime) = tokio::runtime::Handle::try_current() else {
        tracing::warn!("no async runtime: skipping presence broadcast");
        return;
    };
    state.presence_scheduled = true;
    let slot = Arc::clone(slot);
    let settings = *settings;
    runtime.spawn(async move {
        tokio::time::sleep(settings.presence_debounce).await;
        flush_presence(&slot, &settings);
    });
}

fn flush_presence(slot: &Arc<RoomSlot>, settings: &HubSettings) {
    let mut state = lock(&slot.state);
    state.presence_scheduled = false;
    if state.evicted {
        return;
    }
    let presence = Presence::count(state.conns.values().map(|e| e.role));
    let outcome = Outcome {
        send: vec![Outbound {
            to: Target::All,
            msg: ServerMsg::Presence { presence },
        }],
        ..Outcome::default()
    };
    apply(slot, &mut state, NO_SENDER, outcome, settings);
}

/// A poisoned lock only means another thread panicked mid-update; keep serving.
fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Milliseconds since the Unix epoch.
pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
        .unwrap_or(0)
}

#[cfg(test)]
#[path = "hub_tests.rs"]
mod tests;
