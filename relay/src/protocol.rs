//! Wire types for the Caption Room protocol, version 1.
//!
//! Mirrors `packages/protocol/src/messages.ts`. Field names are camelCase on
//! the wire and optional fields are omitted when absent, exactly like the
//! TypeScript reference. Inbound parsing and validation live in `validate.rs`.

use serde::{Deserialize, Serialize};

pub const PROTOCOL_VERSION: u32 = 1;

/// Limits shared with the TypeScript reference (`LIMITS` in messages.ts).
pub mod limits {
    /// Largest accepted inbound frame, counted in UTF-16 code units like the reference.
    pub const MAX_FRAME_UNITS: usize = 8 * 1024;
    pub const MAX_TEXT_CHARS: usize = 2000;
    pub const MAX_TITLE_CHARS: usize = 120;
    pub const MIN_LANG_CHARS: usize = 2;
    pub const MAX_LANG_CHARS: usize = 35;
    pub const MAX_ID_CHARS: usize = 64;
    pub const MIN_TOKEN_CHARS: usize = 16;
    pub const MAX_TOKEN_CHARS: usize = 128;
    /// Largest `startMs` / `endMs`: 72 hours.
    pub const MAX_OFFSET_MS: u64 = 1000 * 60 * 60 * 72;
    pub const MAX_SEGMENTS: usize = 20_000;
    /// Stored caption characters (UTF-16 units) per room, adjusted by corrections.
    pub const MAX_ROOM_CHARS: usize = 4_000_000;
    /// Rejected frames (bad-frame or rate-limited) before the connection is closed.
    pub const MAX_STRIKES: u32 = 20;
    /// Token cost of a `history` request; every other frame costs 1.
    pub const HISTORY_COST: f64 = 10.0;
    /// Most changed segments a resuming client receives as a delta.
    pub const RESUME_LIMIT: usize = 1000;
    /// Recent segments in a fresh listener welcome.
    pub const WELCOME_HISTORY: usize = 200;
    /// Recent segments in a fresh speaker or corrector welcome.
    pub const STAFF_WELCOME_HISTORY: usize = 2000;
    /// Max segments per history page.
    pub const HISTORY_PAGE: usize = 500;
    /// Minimum interval between partial broadcasts, ms.
    pub const PARTIAL_MIN_INTERVAL_MS: u64 = 80;
}

/// WebSocket close codes (application range 4000-4999).
pub mod close {
    pub const REPLACED: u16 = 4001;
    pub const UNAUTHORIZED: u16 = 4003;
    pub const NOT_FOUND: u16 = 4004;
    pub const BAD_FRAME: u16 = 4400;
    pub const EXPIRED: u16 = 4410;
}

/// Literal keepalive frames (not JSON).
pub const KEEPALIVE_PING: &str = "ping";
pub const KEEPALIVE_PONG: &str = "pong";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    Speaker,
    Listener,
    Corrector,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RoomStatus {
    Live,
    Paused,
    Ended,
}

impl RoomStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            RoomStatus::Live => "live",
            RoomStatus::Paused => "paused",
            RoomStatus::Ended => "ended",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Segment {
    pub seq: u64,
    pub id: String,
    /// Empty means a corrector removed the segment.
    pub text: String,
    pub ts: u64,
    pub rev: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end_ms: Option<u64>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub edited: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct PartialCaption {
    pub id: String,
    pub text: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomMeta {
    pub title: String,
    pub lang: String,
    pub allow_export: bool,
    pub created_at: u64,
    /// Listeners need the secret from the QR link, not just the code.
    pub private: bool,
}

/// Which shareable link a `rotate` replaces.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LinkTarget {
    Corrector,
    Listener,
}

impl LinkTarget {
    /// The role whose connections use this link.
    pub fn role(self) -> Role {
        match self {
            LinkTarget::Corrector => Role::Corrector,
            LinkTarget::Listener => Role::Listener,
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
pub struct Presence {
    pub listeners: u32,
    pub correctors: u32,
    pub speaker: bool,
}

impl Presence {
    /// Count one more connection with `role`.
    pub fn with_role(self, role: Role) -> Presence {
        match role {
            Role::Speaker => Presence {
                speaker: true,
                ..self
            },
            Role::Corrector => Presence {
                correctors: self.correctors + 1,
                ..self
            },
            Role::Listener => Presence {
                listeners: self.listeners + 1,
                ..self
            },
        }
    }

    /// Count presence over the roles of a set of connections.
    pub fn count<I: IntoIterator<Item = Option<Role>>>(roles: I) -> Presence {
        roles
            .into_iter()
            .flatten()
            .fold(Presence::default(), Presence::with_role)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ErrorCode {
    BadFrame,
    HelloRequired,
    Unauthorized,
    Forbidden,
    NotFound,
    RoomEnded,
    RoomFull,
    Invalid,
    RateLimited,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum WelcomeMode {
    Append,
    Replace,
}

/// Validated client-to-server message (see `validate::parse_client_frame`).
#[derive(Clone, Debug, PartialEq)]
pub enum ClientMsg {
    Hello {
        role: Role,
        token: Option<String>,
        since: Option<u64>,
    },
    Partial {
        id: String,
        text: String,
    },
    Final {
        id: String,
        text: String,
        start_ms: Option<u64>,
        end_ms: Option<u64>,
    },
    Correct {
        seq: u64,
        text: String,
    },
    Meta {
        title: Option<String>,
        lang: Option<String>,
        allow_export: Option<bool>,
    },
    Status {
        status: RoomStatus,
    },
    History {
        before: u64,
        limit: Option<usize>,
    },
    End,
    /// `ts` is echoed back untouched, so keep the original JSON number.
    Ping {
        ts: serde_json::Number,
    },
    /// Replace a link's secret (speaker only).
    Rotate {
        target: LinkTarget,
    },
}

/// Server-to-client message.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "t", rename_all = "lowercase", rename_all_fields = "camelCase")]
pub enum ServerMsg {
    Welcome {
        v: u32,
        room: String,
        role: Role,
        meta: RoomMeta,
        status: RoomStatus,
        mode: WelcomeMode,
        segments: Vec<Segment>,
        /// Serialized as `null` when there is no partial.
        partial: Option<PartialCaption>,
        has_more: bool,
        rev: u64,
        presence: Presence,
        server_time: u64,
    },
    Partial {
        id: String,
        text: String,
    },
    Final {
        seg: Segment,
    },
    Correct {
        seq: u64,
        text: String,
        rev: u64,
        by: Role,
    },
    Meta {
        meta: RoomMeta,
    },
    Status {
        status: RoomStatus,
    },
    History {
        segments: Vec<Segment>,
        has_more: bool,
    },
    Presence {
        presence: Presence,
    },
    Error {
        code: ErrorCode,
        message: String,
    },
    Pong {
        ts: serde_json::Number,
        server_time: u64,
    },
    /// Reply to `rotate`, sent to the speaker only.
    Rotated {
        target: LinkTarget,
        token: String,
    },
}

impl ServerMsg {
    pub fn error(code: ErrorCode, message: impl Into<String>) -> ServerMsg {
        ServerMsg::Error {
            code,
            message: message.into(),
        }
    }
}

/// `GET /api/info` body.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerInfo {
    pub mode: &'static str,
    pub version: &'static str,
    pub public_base: Option<String>,
    pub local_models: bool,
}

/// Validated `POST /api/rooms` body.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct CreateRoomRequest {
    pub title: Option<String>,
    pub lang: Option<String>,
    pub allow_export: Option<bool>,
    /// Require the listener secret (carried in the QR link) to join.
    pub private: Option<bool>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateRoomResponse {
    pub code: String,
    pub speaker_token: String,
    pub corrector_token: String,
    /// Present only for private rooms.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub listener_token: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct RoomSummary {
    pub code: String,
    pub status: RoomStatus,
    /// Empty for private rooms: the code alone reveals nothing but existence.
    pub title: String,
    pub private: bool,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn seg() -> Segment {
        Segment {
            seq: 1,
            id: "a".into(),
            text: "Hi.".into(),
            ts: 5,
            rev: 1,
            start_ms: None,
            end_ms: Some(1800),
            edited: false,
        }
    }

    #[test]
    fn segment_omits_absent_fields() {
        let v = serde_json::to_value(seg()).unwrap();
        assert_eq!(
            v,
            json!({"seq":1,"id":"a","text":"Hi.","ts":5,"rev":1,"endMs":1800})
        );
        let edited = Segment {
            edited: true,
            ..seg()
        };
        assert_eq!(serde_json::to_value(edited).unwrap()["edited"], json!(true));
    }

    #[test]
    fn server_messages_use_camel_case_and_tags() {
        let msg = ServerMsg::History {
            segments: vec![],
            has_more: true,
        };
        assert_eq!(
            serde_json::to_value(msg).unwrap(),
            json!({"t":"history","segments":[],"hasMore":true})
        );
        let err = ServerMsg::error(ErrorCode::HelloRequired, "Send hello first.");
        assert_eq!(
            serde_json::to_value(err).unwrap(),
            json!({"t":"error","code":"hello-required","message":"Send hello first."})
        );
        let pong = ServerMsg::Pong {
            ts: serde_json::Number::from(42),
            server_time: 7,
        };
        assert_eq!(
            serde_json::to_value(pong).unwrap(),
            json!({"t":"pong","ts":42,"serverTime":7})
        );
    }

    #[test]
    fn welcome_serializes_null_partial() {
        let msg = ServerMsg::Welcome {
            v: PROTOCOL_VERSION,
            room: "ABCDEF".into(),
            role: Role::Listener,
            meta: RoomMeta {
                title: "T".into(),
                lang: "en-US".into(),
                allow_export: true,
                created_at: 1,
                private: false,
            },
            status: RoomStatus::Live,
            mode: WelcomeMode::Replace,
            segments: vec![],
            partial: None,
            has_more: false,
            rev: 0,
            presence: Presence {
                listeners: 1,
                correctors: 0,
                speaker: false,
            },
            server_time: 9,
        };
        let v = serde_json::to_value(msg).unwrap();
        assert_eq!(v["t"], "welcome");
        assert_eq!(v["partial"], serde_json::Value::Null);
        assert_eq!(v["hasMore"], false);
        assert_eq!(v["serverTime"], 9);
        assert_eq!(v["meta"]["allowExport"], true);
        assert_eq!(v["meta"]["createdAt"], 1);
    }

    #[test]
    fn presence_counts_roles() {
        let p = Presence::count([
            Some(Role::Listener),
            Some(Role::Listener),
            Some(Role::Corrector),
            Some(Role::Speaker),
            None,
        ]);
        assert_eq!(
            p,
            Presence {
                listeners: 2,
                correctors: 1,
                speaker: true
            }
        );
    }
}
