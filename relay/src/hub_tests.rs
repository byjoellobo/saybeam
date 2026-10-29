//! Unit tests for `hub.rs`: fan-out, replacement, slow clients and presence.

use serde_json::{Value, json};

use super::*;

fn frame(hub: &Hub, code: &str, conn: &Connection, msg: Value) {
    let raw = msg.to_string();
    hub.handle_frame(code, conn.id, Frame::Text(&raw));
}

/// Everything queued for a connection right now, as JSON (close frames as `{"close": code}`).
fn drain(conn: &mut Connection) -> Vec<Value> {
    let mut out = Vec::new();
    while let Ok(msg) = conn.rx.try_recv() {
        out.push(match msg {
            Outgoing::Text(text) => serde_json::from_str(text.as_str()).unwrap_or(Value::Null),
            Outgoing::Close { code, .. } => json!({ "close": code }),
        });
    }
    out
}

fn types(msgs: &[Value]) -> Vec<String> {
    msgs.iter()
        .map(|m| {
            m["t"]
                .as_str()
                .map_or_else(|| format!("close {}", m["close"]), str::to_string)
        })
        .collect()
}

fn setup() -> (Hub, CreateRoomResponse) {
    let hub = Hub::default();
    let created = hub.create_room(CreateRoomRequest {
        title: Some("Bio".into()),
        ..Default::default()
    });
    (hub, created.expect("room"))
}

fn join(hub: &Hub, room: &CreateRoomResponse, role: &str) -> Connection {
    let mut conn = hub.connect(&room.code).expect("room exists");
    let mut hello = json!({"t": "hello", "role": role});
    match role {
        "speaker" => hello["token"] = json!(room.speaker_token),
        "corrector" => hello["token"] = json!(room.corrector_token),
        _ => {
            if let Some(token) = &room.listener_token {
                hello["token"] = json!(token);
            }
        }
    }
    frame(hub, &room.code, &conn, hello);
    let msgs = drain(&mut conn);
    assert_eq!(
        msgs.first().map(|m| m["t"].clone()),
        Some(json!("welcome")),
        "{msgs:?}"
    );
    conn
}

#[tokio::test]
async fn creates_rooms_with_valid_codes_and_hashed_tokens() {
    let (hub, room) = setup();
    assert!(crate::codes::is_valid_room_code(&room.code));
    assert_eq!(room.speaker_token.len(), 43);
    assert_ne!(room.speaker_token, room.corrector_token);
    assert!(hub.room_exists(&room.code));
    let summary = hub.room_summary(&room.code).expect("summary");
    assert_eq!(
        (summary.title.as_str(), summary.status),
        ("Bio", RoomStatus::Live)
    );
    assert!(hub.connect("ZZZZZZ").is_none());
    assert!(hub.room_summary("ZZZZZZ").is_none());
}

#[tokio::test]
async fn caps_the_number_of_rooms() {
    let hub = Hub::new(HubSettings {
        max_rooms: 2,
        ..HubSettings::default()
    });
    assert!(hub.create_room(CreateRoomRequest::default()).is_ok());
    assert!(hub.create_room(CreateRoomRequest::default()).is_ok());
    assert_eq!(
        hub.create_room(CreateRoomRequest::default()).err(),
        Some(CreateRoomError::TooManyRooms)
    );
    assert_eq!(hub.room_count(), 2);
}

#[tokio::test]
async fn fans_out_partials_to_others_and_finals_to_all() {
    let (hub, room) = setup();
    let mut speaker = join(&hub, &room, "speaker");
    let mut listener = join(&hub, &room, "listener");
    let mut pending = hub.connect(&room.code).expect("room");
    frame(
        &hub,
        &room.code,
        &speaker,
        json!({"t": "partial", "id": "a", "text": "hel"}),
    );
    frame(
        &hub,
        &room.code,
        &speaker,
        json!({"t": "final", "id": "a", "text": "Hello."}),
    );
    let to_speaker: Vec<Value> = drain(&mut speaker)
        .into_iter()
        .filter(|m| m["t"] != "presence")
        .collect();
    let to_listener: Vec<Value> = drain(&mut listener)
        .into_iter()
        .filter(|m| m["t"] != "presence")
        .collect();
    assert_eq!(types(&to_speaker), vec!["final"]);
    assert_eq!(types(&to_listener), vec!["partial", "final"]);
    assert_eq!(to_listener[1]["seg"]["seq"], 1);
    assert!(
        drain(&mut pending).is_empty(),
        "connections that have not joined get no broadcasts"
    );
}

#[tokio::test]
async fn bad_tokens_get_an_error_then_close_4003() {
    let (hub, room) = setup();
    let mut conn = hub.connect(&room.code).expect("room");
    frame(
        &hub,
        &room.code,
        &conn,
        json!({"t": "hello", "role": "speaker", "token": "not-the-right-token"}),
    );
    let msgs = drain(&mut conn);
    assert_eq!(
        msgs,
        vec![
            json!({"t": "error", "code": "unauthorized", "message": "This link is not valid for that role."}),
            json!({"close": 4003})
        ]
    );
    // Detached: later frames are ignored.
    frame(
        &hub,
        &room.code,
        &conn,
        json!({"t": "hello", "role": "listener"}),
    );
    assert!(drain(&mut conn).is_empty());
}

#[tokio::test]
async fn newest_speaker_wins() {
    let (hub, room) = setup();
    let mut old = join(&hub, &room, "speaker");
    let mut listener = join(&hub, &room, "listener");
    frame(
        &hub,
        &room.code,
        &old,
        json!({"t": "partial", "id": "a", "text": "half"}),
    );
    let mut new = join(&hub, &room, "speaker");
    let to_old = drain(&mut old);
    assert_eq!(to_old.last(), Some(&json!({"close": 4001})));
    assert!(drain(&mut new).iter().all(|m| m["t"] != "error"));
    // A speaker connection remains, so the replaced one's partial is left alone.
    let to_listener = drain(&mut listener);
    assert_eq!(
        to_listener
            .iter()
            .filter(|m| m["t"] == "partial")
            .collect::<Vec<_>>(),
        vec![&json!({"t": "partial", "id": "a", "text": "half"})]
    );
    // When the last speaker leaves, the partial is cleared for everyone else.
    hub.disconnect(&room.code, new.id);
    let cleared: Vec<Value> = drain(&mut listener)
        .into_iter()
        .filter(|m| m["t"] == "partial")
        .collect();
    assert_eq!(
        cleared,
        vec![json!({"t": "partial", "id": "a", "text": ""})]
    );
    let mut new = join(&hub, &room, "speaker");
    // Frames from the replaced connection are ignored.
    frame(
        &hub,
        &room.code,
        &old,
        json!({"t": "final", "id": "x", "text": "Ghost."}),
    );
    assert!(drain(&mut listener).iter().all(|m| m["t"] != "final"));
    frame(
        &hub,
        &room.code,
        &new,
        json!({"t": "final", "id": "y", "text": "Real."}),
    );
    assert!(drain(&mut new).iter().any(|m| m["seg"]["text"] == "Real."));
}

#[tokio::test]
async fn drops_clients_that_cannot_keep_up() {
    let hub = Hub::new(HubSettings {
        channel_capacity: 2,
        ..HubSettings::default()
    });
    let room = hub.create_room(CreateRoomRequest::default()).expect("room");
    let mut speaker = join(&hub, &room, "speaker");
    let slow = join(&hub, &room, "listener");
    // The slow listener never reads: its queue of 2 overflows on the third final.
    for i in 0..3 {
        frame(
            &hub,
            &room.code,
            &speaker,
            json!({"t": "final", "id": format!("id{i}"), "text": "Line."}),
        );
        assert_eq!(drain(&mut speaker).len(), 1);
    }
    // The kill permit is stored, so this resolves immediately.
    tokio::time::timeout(Duration::from_secs(1), slow.kill.notified())
        .await
        .expect("slow client was dropped");
    // Its later frames are ignored and the room keeps working.
    frame(&hub, &room.code, &slow, json!({"t": "ping", "ts": 1}));
    frame(
        &hub,
        &room.code,
        &speaker,
        json!({"t": "final", "id": "after", "text": "Still here."}),
    );
    assert!(
        drain(&mut speaker)
            .iter()
            .any(|m| m["seg"]["id"] == "after")
    );
}

#[tokio::test(start_paused = true)]
async fn debounces_presence_broadcasts() {
    let (hub, room) = setup();
    let mut speaker = join(&hub, &room, "speaker");
    let _a = join(&hub, &room, "listener");
    let _b = join(&hub, &room, "listener");
    tokio::time::sleep(Duration::from_millis(1000)).await;
    let _c = join(&hub, &room, "listener");
    tokio::time::sleep(Duration::from_millis(400)).await;
    assert!(
        drain(&mut speaker).iter().all(|m| m["t"] != "presence"),
        "waits for the debounce"
    );
    tokio::time::sleep(Duration::from_millis(200)).await;
    let presence: Vec<Value> = drain(&mut speaker)
        .into_iter()
        .filter(|m| m["t"] == "presence")
        .collect();
    assert_eq!(
        presence,
        vec![
            json!({"t": "presence", "presence": {"listeners": 3, "correctors": 0, "speaker": true}})
        ]
    );
    tokio::time::sleep(Duration::from_secs(5)).await;
    assert!(drain(&mut speaker).is_empty(), "one broadcast per burst");
}

#[tokio::test]
async fn disconnect_updates_room_and_is_idempotent() {
    let (hub, room) = setup();
    let speaker = join(&hub, &room, "speaker");
    let mut listener = join(&hub, &room, "listener");
    frame(
        &hub,
        &room.code,
        &speaker,
        json!({"t": "partial", "id": "a", "text": "half"}),
    );
    hub.disconnect(&room.code, speaker.id);
    hub.disconnect(&room.code, speaker.id);
    let cleared: Vec<Value> = drain(&mut listener)
        .into_iter()
        .filter(|m| m["t"] == "partial" && m["text"] == "")
        .collect();
    assert_eq!(cleared.len(), 1);
}

#[tokio::test]
async fn evicts_only_idle_ended_rooms() {
    let (hub, room) = setup();
    let other = hub.create_room(CreateRoomRequest::default()).expect("room");
    let speaker = join(&hub, &room, "speaker");
    frame(&hub, &room.code, &speaker, json!({"t": "end"}));
    let day = Duration::from_secs(24 * 3600);
    let later = now_ms() + 25 * 3600 * 1000;
    assert_eq!(hub.evict_idle(later, day), 0, "still connected");
    hub.disconnect(&room.code, speaker.id);
    assert_eq!(hub.evict_idle(now_ms(), day), 0, "not idle long enough");
    assert_eq!(hub.evict_idle(later, day), 1);
    assert!(!hub.room_exists(&room.code));
    assert!(hub.room_exists(&other.code), "live rooms are kept");
}

#[tokio::test]
async fn closes_connections_that_never_say_hello() {
    let (hub, room) = setup();
    let mut pending = hub.connect(&room.code).expect("room");
    let mut joined = join(&hub, &room, "listener");
    hub.close_if_not_joined(&room.code, pending.id);
    hub.close_if_not_joined(&room.code, joined.id);
    assert_eq!(drain(&mut pending), vec![json!({"close": 1008})]);
    assert!(drain(&mut joined).iter().all(|m| m.get("close").is_none()));
}

#[tokio::test]
async fn private_rooms_get_a_listener_secret() {
    let hub = Hub::default();
    let public = hub.create_room(CreateRoomRequest::default()).expect("room");
    assert_eq!(public.listener_token, None);
    let req = CreateRoomRequest {
        title: Some("Staff meeting".into()),
        private: Some(true),
        ..Default::default()
    };
    let room = hub.create_room(req).expect("room");
    assert_eq!(room.listener_token.as_deref().map(str::len), Some(43));
    let summary = hub.room_summary(&room.code).expect("summary");
    assert_eq!((summary.title.as_str(), summary.private), ("", true));
    let _listener = join(&hub, &room, "listener");
    let mut anonymous = hub.connect(&room.code).expect("room");
    frame(
        &hub,
        &room.code,
        &anonymous,
        json!({"t": "hello", "role": "listener"}),
    );
    assert_eq!(drain(&mut anonymous).last(), Some(&json!({"close": 4003})));
}

#[tokio::test]
async fn rotation_closes_every_other_connection_with_that_role() {
    let (hub, room) = setup();
    let mut speaker = join(&hub, &room, "speaker");
    let mut corrector_a = join(&hub, &room, "corrector");
    let mut corrector_b = join(&hub, &room, "corrector");
    let mut listener = join(&hub, &room, "listener");
    frame(
        &hub,
        &room.code,
        &speaker,
        json!({"t": "rotate", "target": "corrector"}),
    );
    let to_speaker = drain(&mut speaker);
    let rotated: Vec<&Value> = to_speaker.iter().filter(|m| m["t"] == "rotated").collect();
    assert_eq!(rotated.len(), 1);
    assert!(to_speaker.iter().all(|m| m.get("close").is_none()));
    for corrector in [&mut corrector_a, &mut corrector_b] {
        let msgs = drain(corrector);
        assert!(
            msgs.iter().all(|m| m["t"] != "rotated"),
            "the secret goes to the speaker only"
        );
        assert_eq!(msgs.last(), Some(&json!({"close": 4003})));
    }
    assert!(
        drain(&mut listener)
            .iter()
            .all(|m| m["t"] != "rotated" && m.get("close").is_none())
    );
    // The old corrector link is dead; the new one works.
    let mut stale = hub.connect(&room.code).expect("room");
    let hello = json!({"t": "hello", "role": "corrector", "token": room.corrector_token});
    frame(&hub, &room.code, &stale, hello);
    assert_eq!(drain(&mut stale).last(), Some(&json!({"close": 4003})));
    let fresh = CreateRoomResponse {
        corrector_token: rotated[0]["token"].as_str().unwrap_or_default().to_string(),
        ..room.clone()
    };
    let _corrector = join(&hub, &fresh, "corrector");
}
