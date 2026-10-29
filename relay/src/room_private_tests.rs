//! Room tests for private rooms and link rotation, mirroring the
//! "private rooms and link rotation" block of room-core.test.ts.

use serde_json::{Value, json};

use super::*;

const LISTENER_TOKEN: &str = "listener-token-0123456789abcdef";

fn private_room() -> Harness {
    Harness::with_listener_token(Some(LISTENER_TOKEN))
}

/// Raw hello from a fresh connection, returning the whole outcome.
fn hello(h: &mut Harness, id: ConnId, role: &str, token: Option<&str>) -> Outcome {
    let mut msg = json!({"t": "hello", "role": role});
    if let Some(token) = token {
        msg["token"] = json!(token);
    }
    h.send(pending(id), msg)
}

fn assert_unauthorized(out: &Outcome) {
    assert_eq!(first(out)["code"], "unauthorized");
    assert_eq!(out.close.map(|c| c.code), Some(close::UNAUTHORIZED));
}

fn rotated_token(out: &Outcome) -> String {
    first(out)["token"].as_str().unwrap_or_default().to_string()
}

#[test]
fn private_rooms_require_a_listener_secret() {
    let mut h = private_room();
    assert_unauthorized(&hello(&mut h, 1, "listener", None));
    assert_unauthorized(&hello(
        &mut h,
        2,
        "listener",
        Some("wrong-token-wrong-token"),
    ));
    let with_key = hello(&mut h, 3, "listener", Some(LISTENER_TOKEN));
    assert_eq!(first(&with_key)["role"], "listener");
    assert_eq!(first(&with_key)["meta"]["private"], true);
    // Corrector and speaker secrets also let you listen.
    for (id, token) in [(4, CORRECTOR_TOKEN), (5, SPEAKER_TOKEN)] {
        assert_eq!(
            first(&hello(&mut h, id, "listener", Some(token)))["t"],
            "welcome"
        );
    }
}

#[test]
fn the_listener_secret_grants_nothing_else() {
    let mut h = private_room();
    assert_unauthorized(&hello(&mut h, 1, "corrector", Some(LISTENER_TOKEN)));
    assert_unauthorized(&hello(&mut h, 2, "speaker", Some(LISTENER_TOKEN)));
    // The corrector secret still cannot speak.
    assert_unauthorized(&hello(&mut h, 3, "speaker", Some(CORRECTOR_TOKEN)));
}

#[test]
fn public_rooms_stay_open_to_listeners() {
    let mut h = Harness::new();
    let (_, welcome, _) = h.join(1, Role::Listener, json!({}));
    assert_eq!(welcome["meta"]["private"], false);
    // A token on a public listener hello is ignored, as in the reference.
    let out = hello(&mut h, 2, "listener", Some("not-a-real-token-at-all"));
    assert_eq!(first(&out)["t"], "welcome");
}

#[test]
fn summaries_hide_private_titles() {
    let public = Harness::new().room.summary();
    assert_eq!(
        (public.title.as_str(), public.private),
        ("Physics 101", false)
    );
    let private = private_room().room.summary();
    assert_eq!((private.title.as_str(), private.private), ("", true));
    assert_eq!(
        serde_json::to_value(&private).unwrap_or(Value::Null),
        json!({"code": "ABCDEF", "status": "live", "title": "", "private": true})
    );
}

#[test]
fn rotating_the_corrector_link_replies_to_the_speaker_and_kicks_correctors() {
    let mut h = Harness::new();
    let (speaker, _, _) = h.join(1, Role::Speaker, json!({}));
    let out = h.send(speaker, json!({"t": "rotate", "target": "corrector"}));
    assert_eq!(out.send.len(), 1);
    assert_eq!(out.send[0].to, Target::Sender);
    assert_eq!(first(&out)["t"], "rotated");
    assert_eq!(first(&out)["target"], "corrector");
    let fresh = rotated_token(&out);
    assert_eq!(fresh.len(), 43);
    assert!(
        fresh
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    );
    assert_eq!(
        out.close_others,
        Some(CloseOthers {
            role: Role::Corrector,
            close: CloseRequest {
                code: close::UNAUTHORIZED,
                reason: "link replaced"
            },
        })
    );
    assert_unauthorized(&hello(&mut h, 2, "corrector", Some(CORRECTOR_TOKEN)));
    assert_eq!(
        first(&hello(&mut h, 3, "corrector", Some(&fresh)))["t"],
        "welcome"
    );
    // The speaker secret is untouched.
    assert_eq!(
        first(&hello(&mut h, 4, "corrector", Some(SPEAKER_TOKEN)))["t"],
        "welcome"
    );
}

#[test]
fn rotating_the_listener_link_only_works_in_private_rooms() {
    let mut public = Harness::new();
    let (speaker, _, _) = public.join(1, Role::Speaker, json!({}));
    assert_eq!(
        first(&public.send(speaker, json!({"t": "rotate", "target": "listener"}))),
        json!({"t": "error", "code": "invalid", "message": "This room is not private."})
    );

    let mut h = private_room();
    let (speaker, _, _) = h.join(1, Role::Speaker, json!({}));
    let out = h.send(speaker, json!({"t": "rotate", "target": "listener"}));
    assert_eq!(out.close_others.map(|c| c.role), Some(Role::Listener));
    let fresh = rotated_token(&out);
    assert_unauthorized(&hello(&mut h, 2, "listener", Some(LISTENER_TOKEN)));
    assert_eq!(
        first(&hello(&mut h, 3, "listener", Some(&fresh)))["t"],
        "welcome"
    );
    assert_eq!(
        first(&hello(&mut h, 4, "listener", Some(CORRECTOR_TOKEN)))["t"],
        "welcome"
    );
}

#[test]
fn only_the_speaker_can_rotate() {
    let mut h = private_room();
    let (corrector, _, _) = h.join(1, Role::Corrector, json!({}));
    let (listener, _, _) = h.join(2, Role::Listener, json!({"token": LISTENER_TOKEN}));
    for conn in [corrector, listener] {
        assert_eq!(
            first(&h.send(conn, json!({"t": "rotate", "target": "corrector"}))),
            json!({"t": "error", "code": "forbidden", "message": "Only the speaker can replace links."})
        );
    }
}

#[test]
fn rotation_is_allowed_after_the_session_ends() {
    let mut h = Harness::new();
    let (speaker, _, _) = h.join(1, Role::Speaker, json!({}));
    h.send(speaker, json!({"t": "end"}));
    let out = h.send(speaker, json!({"t": "rotate", "target": "corrector"}));
    assert_eq!(first(&out)["t"], "rotated");
}

#[test]
fn rotation_costs_ten_tokens() {
    let mut h = Harness::new();
    let (speaker, _, _) = h.join(1, Role::Speaker, json!({}));
    // Leave 5 of the speaker's 60 tokens: the first is taken, the other 9 are missing.
    for i in 0..55 {
        assert_eq!(
            first(&h.send(speaker, json!({"t": "ping", "ts": i})))["t"],
            "pong"
        );
    }
    assert_eq!(
        first(&h.send(speaker, json!({"t": "rotate", "target": "corrector"}))),
        json!({"t": "error", "code": "rate-limited", "message": "Slow down."})
    );
    // The refused rotation changed nothing.
    assert_eq!(
        first(&hello(&mut h, 2, "corrector", Some(CORRECTOR_TOKEN)))["t"],
        "welcome"
    );
}
