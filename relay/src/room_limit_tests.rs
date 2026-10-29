//! Room tests for text cleaning, abuse limits and speaker replacement.

use serde_json::{Value, json};

use super::*;

#[test]
fn replaced_speaker_leaving_keeps_the_partial() {
    let mut h = Harness::new();
    let (speaker, _, _) = h.join(1, Role::Speaker, json!({}));
    h.send(speaker, json!({"t": "partial", "id": "a", "text": "half"}));
    let out = h.room.handle_disconnect(speaker, true);
    assert!(out.send.is_empty());
    assert!(out.presence_changed);
    let (_, welcome, _) = h.join(2, Role::Listener, json!({}));
    assert_eq!(welcome["partial"], json!({"id": "a", "text": "half"}));
}

#[test]
fn empty_partial_only_clears_a_matching_id() {
    let mut h = Harness::new();
    let (speaker, _, _) = h.join(1, Role::Speaker, json!({}));
    h.send(speaker, json!({"t": "partial", "id": "b", "text": "newer"}));
    let late = h.send(speaker, json!({"t": "partial", "id": "a", "text": ""}));
    assert!(
        late.send.is_empty(),
        "a late clear for another id is ignored"
    );
    let (_, welcome, _) = h.join(2, Role::Listener, json!({}));
    assert_eq!(welcome["partial"]["id"], "b");
}

#[test]
fn cleans_control_and_bidi_characters() {
    let mut h = Harness::new();
    let (speaker, _, _) = h.join(1, Role::Speaker, json!({}));
    let out = h.speak(speaker, "a", "line one\r\nline two");
    assert_eq!(first(&out)["seg"]["text"], "line one line two");
    let fake_cue = h.speak(speaker, "b", "a\n\n2\n00:00 --> 99:00\nFAKE");
    assert_eq!(first(&fake_cue)["seg"]["text"], "a 2 00:00 --> 99:00 FAKE");
    let meta = h.send(
        speaker,
        json!({"t": "meta", "title": "\u{202E}evil\u{202C} title\t"}),
    );
    assert_eq!(first(&meta)["meta"]["title"], "evil title");
    // Only control characters: empty after cleaning.
    assert_eq!(first(&h.speak(speaker, "c", "\n\t"))["code"], "invalid");
    let fix = h.send(
        speaker,
        json!({"t": "correct", "seq": 1, "text": "fixed\nline"}),
    );
    assert_eq!(first(&fix)["text"], "fixed line");
    let init = RoomInit {
        code: "ABCDEF".into(),
        speaker_token_hash: String::new(),
        corrector_token_hash: String::new(),
        title: Some(" Bio\u{2066}logy\n101 ".into()),
        lang: None,
        allow_export: None,
    };
    assert_eq!(Room::new(init, START).meta.title, "Biology 101");
}

#[test]
fn oversized_frames_close_with_4400_without_a_strike() {
    let mut h = Harness::new();
    let huge = "x".repeat(limits::MAX_FRAME_UNITS + 1);
    let out = h
        .room
        .handle_frame(pending(1), Frame::Text(&huge), || NOBODY, h.now);
    assert_eq!(
        first(&out),
        json!({"t": "error", "code": "bad-frame", "message": "frame too large"})
    );
    assert_eq!(
        out.close,
        Some(CloseRequest {
            code: close::BAD_FRAME,
            reason: "frame too large"
        })
    );
    // It cost no token: the pending bucket (5) is still full.
    let errors: Vec<Value> = (0..5)
        .map(|_| first(&h.send(pending(1), json!({"t": "ping", "ts": 1})))["code"].clone())
        .collect();
    assert!(errors.iter().all(|c| c == "hello-required"));
}

#[test]
fn closes_after_twenty_rejected_frames_and_forgets_on_disconnect() {
    let mut h = Harness::new();
    let mut last = Outcome::default();
    for i in 0..limits::MAX_STRIKES {
        h.now += 2000; // stay inside the rate limit so only bad frames count
        last = h
            .room
            .handle_frame(pending(1), Frame::Text("{nope"), || NOBODY, h.now);
        if i + 1 < limits::MAX_STRIKES {
            assert_eq!(last.close, None, "strike {}", i + 1);
        }
    }
    assert_eq!(first(&last)["code"], "bad-frame");
    assert_eq!(
        last.close,
        Some(CloseRequest {
            code: close::BAD_FRAME,
            reason: "too many rejected messages"
        })
    );
    h.room.handle_disconnect(pending(1), false);
    h.now += 2000;
    let fresh = h
        .room
        .handle_frame(pending(1), Frame::Text("{nope"), || NOBODY, h.now);
    assert_eq!(fresh.close, None);
}

#[test]
fn rate_limited_frames_count_as_strikes() {
    let mut h = Harness::new();
    let (conn, _, _) = h.join(1, Role::Listener, json!({}));
    let outcomes: Vec<Outcome> = (0..40)
        .map(|i| h.send(conn, json!({"t": "ping", "ts": i})))
        .collect();
    // 20 tokens, then 20 rejected frames: the 20th rejection closes.
    assert!(outcomes[..39].iter().all(|o| o.close.is_none()));
    assert_eq!(outcomes[39].close.map(|c| c.code), Some(close::BAD_FRAME));
}

#[test]
fn history_costs_ten_tokens() {
    let mut h = Harness::new();
    let (conn, _, _) = h.join(1, Role::Listener, json!({}));
    let a = h.send(conn, json!({"t": "history", "before": 5}));
    let b = h.send(conn, json!({"t": "history", "before": 5}));
    let c = h.send(conn, json!({"t": "history", "before": 5}));
    assert_eq!(
        (first(&a)["t"].clone(), first(&b)["t"].clone()),
        (json!("history"), json!("history"))
    );
    // 20-token listener bucket, 10 per page: the third is refused (its first token fails).
    assert_eq!(first(&c)["code"], "rate-limited");

    // With 5 tokens left, the frame's first token is taken but the other 9 are not.
    let mut h = Harness::new();
    let (conn, _, _) = h.join(1, Role::Listener, json!({}));
    for i in 0..15 {
        assert_eq!(
            first(&h.send(conn, json!({"t": "ping", "ts": i})))["t"],
            "pong"
        );
    }
    let page = h.send(conn, json!({"t": "history", "before": 5}));
    assert_eq!(
        first(&page),
        json!({"t": "error", "code": "rate-limited", "message": "Slow down: too many history requests."})
    );
    let pongs = (0..5)
        .filter(|i| first(&h.send(conn, json!({"t": "ping", "ts": i})))["t"] == "pong")
        .count();
    assert_eq!(pongs, 4, "the refused history took only its first token");
}

#[test]
fn listeners_lose_history_when_export_is_off() {
    let mut h = Harness::new();
    let (speaker, _, _) = h.join(1, Role::Speaker, json!({}));
    let (listener, _, _) = h.join(2, Role::Listener, json!({}));
    let (corrector, _, _) = h.join(3, Role::Corrector, json!({}));
    h.send(speaker, json!({"t": "meta", "allowExport": false}));
    assert_eq!(
        first(&h.send(listener, json!({"t": "history", "before": 5}))),
        json!({"t": "error", "code": "forbidden", "message": "The speaker has turned off transcript access."})
    );
    assert_eq!(
        first(&h.send(speaker, json!({"t": "history", "before": 5})))["t"],
        "history"
    );
    assert_eq!(
        first(&h.send(corrector, json!({"t": "history", "before": 5})))["t"],
        "history"
    );
}

#[test]
fn caps_stored_characters_per_room() {
    let mut h = Harness::new();
    let (speaker, _, _) = h.join(1, Role::Speaker, json!({}));
    h.room.chars = limits::MAX_ROOM_CHARS - 3;
    assert_eq!(first(&h.speak(speaker, "a", "Hi."))["t"], "final");
    assert_eq!(first(&h.speak(speaker, "b", "More."))["code"], "room-full");
    // A duplicate id still gets its stored copy, even when full.
    assert_eq!(first(&h.speak(speaker, "a", "Hi."))["seg"]["seq"], 1);
    // Corrections may shrink text when full, but not grow it.
    let grow = h.send(speaker, json!({"t": "correct", "seq": 1, "text": "Hello."}));
    assert_eq!(first(&grow)["code"], "room-full");
    let shrink = h.send(speaker, json!({"t": "correct", "seq": 1, "text": "H."}));
    assert_eq!(first(&shrink)["t"], "correct");
    assert_eq!(h.room.chars, limits::MAX_ROOM_CHARS - 1);
    assert_eq!(
        first(&h.send(speaker, json!({"t": "correct", "seq": 1, "text": ""})))["t"],
        "correct"
    );
    assert_eq!(h.room.chars, limits::MAX_ROOM_CHARS - 3);
}

#[test]
fn counts_characters_in_utf16_units() {
    let mut h = Harness::new();
    let (speaker, _, _) = h.join(1, Role::Speaker, json!({}));
    h.speak(speaker, "a", "\u{1F600}\u{00E9}");
    assert_eq!(h.room.chars, 3);
}

#[test]
fn computes_presence_only_for_hello() {
    let mut h = Harness::new();
    let (speaker, _, _) = h.join(1, Role::Speaker, json!({}));
    let calls = std::cell::Cell::new(0);
    let counted = || {
        calls.set(calls.get() + 1);
        NOBODY
    };
    let raw = json!({"t": "partial", "id": "a", "text": "x"}).to_string();
    h.room
        .handle_frame(speaker, Frame::Text(&raw), counted, h.now);
    assert_eq!(calls.get(), 0);
    let hello = json!({"t": "hello", "role": "listener"}).to_string();
    let counted = || {
        calls.set(calls.get() + 1);
        NOBODY
    };
    h.room
        .handle_frame(pending(9), Frame::Text(&hello), counted, h.now);
    assert_eq!(calls.get(), 1);
}
