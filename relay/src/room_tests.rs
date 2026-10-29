//! Unit tests for `room.rs`, mirroring `packages/protocol/test/room-core.test.ts`.

use serde_json::{Value, json};

use super::*;

const SPEAKER_TOKEN: &str = "speaker-token-0123456789abcdef";
const CORRECTOR_TOKEN: &str = "corrector-token-0123456789abcdef";
const NOBODY: Presence = Presence {
    listeners: 0,
    correctors: 0,
    speaker: false,
};
const START: u64 = 1_000_000;

struct Harness {
    room: Room,
    now: u64,
}

impl Harness {
    fn new() -> Harness {
        let init = RoomInit {
            code: "ABCDEF".into(),
            speaker_token_hash: hash_token(SPEAKER_TOKEN),
            corrector_token_hash: hash_token(CORRECTOR_TOKEN),
            title: Some("  Physics 101  ".into()),
            lang: None,
            allow_export: None,
        };
        Harness {
            room: Room::new(init, START),
            now: START,
        }
    }

    fn send(&mut self, conn: ConnState, msg: Value) -> Outcome {
        let raw = msg.to_string();
        self.room
            .handle_frame(conn, Frame::Text(&raw), || NOBODY, self.now)
    }

    fn join(&mut self, id: ConnId, role: Role, extra: Value) -> (ConnState, Value, Outcome) {
        let mut hello = json!({"t": "hello", "role": role});
        let token = match role {
            Role::Speaker => Some(SPEAKER_TOKEN),
            Role::Corrector => Some(CORRECTOR_TOKEN),
            Role::Listener => None,
        };
        if let Some(token) = token {
            hello["token"] = json!(token);
        }
        if let (Some(obj), Some(extra)) = (hello.as_object_mut(), extra.as_object()) {
            obj.extend(extra.clone());
        }
        let out = self.send(ConnState { id, role: None }, hello);
        let welcome = first(&out);
        assert_eq!(welcome["t"], "welcome", "join failed: {welcome}");
        let role = out.joined_as.expect("joined");
        (
            ConnState {
                id,
                role: Some(role),
            },
            welcome,
            out,
        )
    }

    /// Send a final one second after the previous message (like the TS `speak`).
    fn speak(&mut self, speaker: ConnState, id: &str, text: &str) -> Outcome {
        self.now += 1000;
        self.send(speaker, json!({"t": "final", "id": id, "text": text}))
    }
}

fn to_json(msg: &ServerMsg) -> Value {
    serde_json::to_value(msg).expect("serializable")
}

fn first(out: &Outcome) -> Value {
    to_json(&out.send.first().expect("a message").msg)
}

fn msgs(out: &Outcome) -> Vec<Value> {
    out.send.iter().map(|o| to_json(&o.msg)).collect()
}

fn pending(id: ConnId) -> ConnState {
    ConnState { id, role: None }
}

#[test]
fn creates_room_with_trimmed_title_and_defaults() {
    let h = Harness::new();
    assert_eq!(h.room.meta.title, "Physics 101");
    assert_eq!(h.room.meta.lang, "en-US");
    assert!(h.room.meta.allow_export);
    assert_eq!(h.room.last_activity(), START);
    assert_eq!(h.room.summary().status, RoomStatus::Live);
}

#[test]
fn listeners_join_without_a_token_and_count_in_presence() {
    let mut h = Harness::new();
    let (_, welcome, out) = h.join(1, Role::Listener, json!({}));
    assert_eq!(welcome["role"], "listener");
    assert_eq!(welcome["mode"], "replace");
    assert_eq!(welcome["meta"]["title"], "Physics 101");
    assert_eq!(welcome["presence"]["listeners"], 1);
    assert_eq!(welcome["partial"], Value::Null);
    assert!(out.presence_changed);
    assert!(!out.replace_other_speakers);
}

#[test]
fn rejects_bad_speaker_tokens_with_4003() {
    let mut h = Harness::new();
    for hello in [
        json!({"t": "hello", "role": "speaker", "token": "wrong-token-wrong-token"}),
        json!({"t": "hello", "role": "speaker"}),
        json!({"t": "hello", "role": "speaker", "token": CORRECTOR_TOKEN}),
        json!({"t": "hello", "role": "corrector"}),
    ] {
        let out = h.send(pending(9), hello);
        assert_eq!(first(&out)["code"], "unauthorized");
        assert_eq!(out.close.map(|c| c.code), Some(close::UNAUTHORIZED));
        assert_eq!(out.joined_as, None);
    }
}

#[test]
fn speaker_token_can_join_as_corrector() {
    let mut h = Harness::new();
    let out = h.send(
        pending(1),
        json!({"t": "hello", "role": "corrector", "token": SPEAKER_TOKEN}),
    );
    assert_eq!(first(&out)["role"], "corrector");
    assert_eq!(out.joined_as, Some(Role::Corrector));
}

#[test]
fn speaker_join_replaces_older_speakers() {
    let mut h = Harness::new();
    let (_, _, out) = h.join(1, Role::Speaker, json!({}));
    assert!(out.replace_other_speakers);
}

#[test]
fn requires_hello_first_and_refuses_a_second_hello() {
    let mut h = Harness::new();
    let out = h.send(pending(1), json!({"t": "ping", "ts": 1}));
    assert_eq!(first(&out)["code"], "hello-required");
    let (conn, _, _) = h.join(2, Role::Listener, json!({}));
    let again = h.send(conn, json!({"t": "hello", "role": "listener"}));
    assert_eq!(first(&again)["code"], "invalid");
}

#[test]
fn rejects_malformed_frames() {
    let mut h = Harness::new();
    let bad = h
        .room
        .handle_frame(pending(1), Frame::Text("not json"), || NOBODY, h.now);
    assert_eq!(first(&bad)["code"], "bad-frame");
    let binary = h
        .room
        .handle_frame(pending(2), Frame::Binary, || NOBODY, h.now);
    assert_eq!(first(&binary)["code"], "bad-frame");
    let bad_id = h.send(
        pending(3),
        json!({"t": "final", "id": "bad id!", "text": "x"}),
    );
    assert_eq!(first(&bad_id)["code"], "bad-frame");
}

#[test]
fn partials_go_to_others_and_are_throttled() {
    let mut h = Harness::new();
    let (speaker, _, _) = h.join(1, Role::Speaker, json!({}));
    let p1 = h.send(speaker, json!({"t": "partial", "id": "a", "text": "hello"}));
    assert_eq!(p1.send.len(), 1);
    assert_eq!(p1.send[0].to, Target::Others);
    assert_eq!(
        first(&p1),
        json!({"t": "partial", "id": "a", "text": "hello"})
    );
    h.now += 10;
    let p2 = h.send(
        speaker,
        json!({"t": "partial", "id": "a", "text": "hello wor"}),
    );
    assert!(p2.send.is_empty(), "throttled partial is stored, not sent");
    h.now += limits::PARTIAL_MIN_INTERVAL_MS;
    let p3 = h.send(
        speaker,
        json!({"t": "partial", "id": "a", "text": "hello world"}),
    );
    assert_eq!(
        msgs(&p3),
        vec![json!({"t": "partial", "id": "a", "text": "hello world"})]
    );
    h.now += 1000;
    let same = h.send(
        speaker,
        json!({"t": "partial", "id": "a", "text": "hello world"}),
    );
    assert!(same.send.is_empty(), "identical partial is a no-op");
    let (_, welcome, _) = h.join(2, Role::Listener, json!({}));
    assert_eq!(
        welcome["partial"],
        json!({"id": "a", "text": "hello world"})
    );
}

#[test]
fn empty_partial_clears_once() {
    let mut h = Harness::new();
    let (speaker, _, _) = h.join(1, Role::Speaker, json!({}));
    h.send(speaker, json!({"t": "partial", "id": "a", "text": "hi"}));
    let cleared = h.send(speaker, json!({"t": "partial", "id": "a", "text": "  "}));
    assert_eq!(
        msgs(&cleared),
        vec![json!({"t": "partial", "id": "a", "text": ""})]
    );
    assert!(
        h.send(speaker, json!({"t": "partial", "id": "a", "text": ""}))
            .send
            .is_empty()
    );
}

#[test]
fn finals_get_increasing_seq_and_rev_and_go_to_all() {
    let mut h = Harness::new();
    let (speaker, _, _) = h.join(1, Role::Speaker, json!({}));
    h.send(
        speaker,
        json!({"t": "partial", "id": "a", "text": "good morn"}),
    );
    let f1 = h.send(
        speaker,
        json!({"t": "final", "id": "a", "text": " Good morning. ", "startMs": 0, "endMs": 1500}),
    );
    assert_eq!(f1.send[0].to, Target::All);
    assert!(f1.activity);
    assert_eq!(
        first(&f1),
        json!({"t": "final", "seg": {"seq": 1, "id": "a", "text": "Good morning.", "ts": START, "rev": 1, "startMs": 0, "endMs": 1500}})
    );
    let f2 = h.speak(speaker, "b", "Second.");
    assert_eq!(first(&f2)["seg"]["seq"], 2);
    assert_eq!(first(&f2)["seg"]["rev"], 2);
    assert_eq!(h.room.last_activity(), h.now);
    let (_, welcome, _) = h.join(2, Role::Listener, json!({}));
    assert_eq!(
        welcome["partial"],
        Value::Null,
        "the final cleared its partial"
    );
    assert_eq!(welcome["rev"], 2);
}

#[test]
fn repeated_final_id_is_idempotent_and_replies_to_sender_only() {
    let mut h = Harness::new();
    let (speaker, _, _) = h.join(1, Role::Speaker, json!({}));
    h.speak(speaker, "a", "Once.");
    let dup = h.speak(speaker, "a", "Once again?");
    assert_eq!(dup.send.len(), 1);
    assert_eq!(dup.send[0].to, Target::Sender);
    assert_eq!(first(&dup)["seg"]["seq"], 1);
    assert_eq!(first(&dup)["seg"]["text"], "Once.");
    assert!(!dup.activity);
    assert_eq!(h.room.rev, 1);
}

#[test]
fn rejects_empty_finals_and_captions_from_non_speakers() {
    let mut h = Harness::new();
    let (speaker, _, _) = h.join(1, Role::Speaker, json!({}));
    let (listener, _, _) = h.join(2, Role::Listener, json!({}));
    assert_eq!(
        first(&h.send(speaker, json!({"t": "final", "id": "a", "text": "   "})))["code"],
        "invalid"
    );
    assert_eq!(
        first(&h.send(listener, json!({"t": "final", "id": "a", "text": "x"})))["code"],
        "forbidden"
    );
    assert_eq!(
        first(&h.send(listener, json!({"t": "partial", "id": "a", "text": "x"})))["code"],
        "forbidden"
    );
}

#[test]
fn room_full_after_max_segments() {
    let mut h = Harness::new();
    h.room.max_segments = 3;
    let (speaker, _, _) = h.join(1, Role::Speaker, json!({}));
    for i in 1..=3 {
        assert_eq!(
            first(&h.speak(speaker, &format!("id{i}"), "Line."))["t"],
            "final"
        );
    }
    assert_eq!(
        first(&h.speak(speaker, "id4", "Too many."))["code"],
        "room-full"
    );
    // A duplicate id still gets its stored copy.
    assert_eq!(first(&h.speak(speaker, "id2", "Again."))["seg"]["seq"], 2);
}

#[test]
fn correctors_edit_and_bump_rev() {
    let mut h = Harness::new();
    let (speaker, _, _) = h.join(1, Role::Speaker, json!({}));
    let (corrector, _, _) = h.join(2, Role::Corrector, json!({}));
    h.speak(speaker, "a", "The quantum of solace.");
    let out = h.send(
        corrector,
        json!({"t": "correct", "seq": 1, "text": "The quantum of action."}),
    );
    assert_eq!(out.send[0].to, Target::All);
    assert_eq!(
        first(&out),
        json!({"t": "correct", "seq": 1, "text": "The quantum of action.", "rev": 2, "by": "corrector"})
    );
    let seg = &h.room.segments[0];
    assert_eq!(
        (seg.text.as_str(), seg.rev, seg.edited),
        ("The quantum of action.", 2, true)
    );
    assert_eq!(h.room.rev, 2);
}

#[test]
fn ignores_noop_corrections_unknown_seqs_and_forbids_listeners() {
    let mut h = Harness::new();
    let (speaker, _, _) = h.join(1, Role::Speaker, json!({}));
    let (listener, _, _) = h.join(2, Role::Listener, json!({}));
    h.speak(speaker, "a", "Same.");
    assert!(
        h.send(
            speaker,
            json!({"t": "correct", "seq": 1, "text": " Same. "})
        )
        .send
        .is_empty()
    );
    let unknown = h.send(speaker, json!({"t": "correct", "seq": 9, "text": "x"}));
    assert_eq!(
        first(&unknown),
        json!({"t": "error", "code": "not-found", "message": "No caption #9."})
    );
    assert_eq!(
        first(&h.send(listener, json!({"t": "correct", "seq": 1, "text": "x"})))["code"],
        "forbidden"
    );
}

#[test]
fn empty_correction_removes_segment_even_after_end() {
    let mut h = Harness::new();
    let (speaker, _, _) = h.join(1, Role::Speaker, json!({}));
    h.speak(speaker, "a", "Thanks for watching!");
    h.send(speaker, json!({"t": "end"}));
    let out = h.send(speaker, json!({"t": "correct", "seq": 1, "text": ""}));
    assert_eq!(
        first(&out),
        json!({"t": "correct", "seq": 1, "text": "", "rev": 2, "by": "speaker"})
    );
    let (_, welcome, _) = h.join(2, Role::Listener, json!({}));
    assert_eq!(welcome["segments"][0]["text"], "");
    assert_eq!(welcome["segments"][0]["edited"], true);
}

#[test]
fn resume_with_since_appends_changed_segments() {
    let mut h = Harness::new();
    let (speaker, _, _) = h.join(1, Role::Speaker, json!({}));
    h.speak(speaker, "a", "One.");
    h.speak(speaker, "b", "Two.");
    let (_, w1, _) = h.join(2, Role::Listener, json!({}));
    assert_eq!(w1["rev"], 2);
    h.speak(speaker, "c", "Three.");
    h.send(speaker, json!({"t": "correct", "seq": 1, "text": "Uno."}));
    let (_, w2, _) = h.join(3, Role::Listener, json!({"since": 2}));
    assert_eq!(w2["mode"], "append");
    assert_eq!(w2["hasMore"], false);
    let got: Vec<(u64, String)> = w2["segments"]
        .as_array()
        .expect("segments")
        .iter()
        .map(|s| {
            (
                s["seq"].as_u64().unwrap_or(0),
                s["text"].as_str().unwrap_or("").to_string(),
            )
        })
        .collect();
    assert_eq!(
        got,
        vec![(1, "Uno.".to_string()), (3, "Three.".to_string())]
    );
    // Nothing new since the latest rev: an empty append.
    let (_, w3, _) = h.join(4, Role::Listener, json!({"since": 4}));
    assert_eq!(w3["mode"], "append");
    assert_eq!(w3["segments"], json!([]));
}

#[test]
fn resume_falls_back_to_replace() {
    let mut h = Harness::new();
    let (speaker, _, _) = h.join(1, Role::Speaker, json!({}));
    h.speak(speaker, "a", "One.");
    let (_, ahead, _) = h.join(2, Role::Listener, json!({"since": 99}));
    assert_eq!(ahead["mode"], "replace");
    assert_eq!(ahead["segments"].as_array().map(Vec::len), Some(1));
    let (_, zero, _) = h.join(3, Role::Listener, json!({"since": 0}));
    assert_eq!(zero["mode"], "replace");
}

#[test]
fn resume_with_too_many_changes_replaces() {
    let mut h = Harness::new();
    let (speaker, _, _) = h.join(1, Role::Speaker, json!({}));
    for i in 1..=(limits::RESUME_LIMIT + 2) {
        h.speak(speaker, &format!("id{i}"), "Line.");
    }
    let (_, welcome, _) = h.join(2, Role::Listener, json!({"since": 1}));
    assert_eq!(welcome["mode"], "replace");
    assert_eq!(
        welcome["segments"].as_array().map(Vec::len),
        Some(limits::WELCOME_HISTORY)
    );
    let (_, staff, _) = h.join(3, Role::Corrector, json!({}));
    assert_eq!(
        staff["segments"].as_array().map(Vec::len),
        Some(limits::RESUME_LIMIT + 2)
    );
    assert_eq!(staff["hasMore"], false);
}

#[test]
fn caps_listener_history_and_pages_with_history() {
    let mut h = Harness::new();
    let (speaker, _, _) = h.join(1, Role::Speaker, json!({}));
    for i in 1..=(limits::WELCOME_HISTORY + 5) {
        h.speak(speaker, &format!("id{i}"), &format!("Line {i}."));
    }
    let (conn, welcome, _) = h.join(2, Role::Listener, json!({}));
    let segments = welcome["segments"].as_array().expect("segments");
    assert_eq!(segments.len(), limits::WELCOME_HISTORY);
    assert_eq!(welcome["hasMore"], true);
    assert_eq!(segments[0]["seq"], 6);
    let page = first(&h.send(conn, json!({"t": "history", "before": 6, "limit": 3})));
    assert_eq!(page["t"], "history");
    assert_eq!(page["hasMore"], true);
    let seqs: Vec<u64> = page["segments"]
        .as_array()
        .expect("page")
        .iter()
        .filter_map(|s| s["seq"].as_u64())
        .collect();
    assert_eq!(seqs, vec![3, 4, 5]);
    let page2 = first(&h.send(conn, json!({"t": "history", "before": 3})));
    assert_eq!(page2["hasMore"], false);
    let seqs: Vec<u64> = page2["segments"]
        .as_array()
        .expect("page")
        .iter()
        .filter_map(|s| s["seq"].as_u64())
        .collect();
    assert_eq!(seqs, vec![1, 2]);
    // Each page costs 10 of the listener's 20 tokens: let the bucket refill.
    h.now += 5000;
    let empty = first(&h.send(conn, json!({"t": "history", "before": 1})));
    assert_eq!(
        empty,
        json!({"t": "history", "segments": [], "hasMore": false})
    );
    h.now += 5000;
    let beyond = first(&h.send(
        conn,
        json!({"t": "history", "before": 9_000_000, "limit": 2}),
    ));
    let seqs: Vec<u64> = beyond["segments"]
        .as_array()
        .expect("page")
        .iter()
        .filter_map(|s| s["seq"].as_u64())
        .collect();
    assert_eq!(seqs, vec![204, 205]);
}

#[test]
fn pauses_clears_partial_and_end_blocks_captions() {
    let mut h = Harness::new();
    let (speaker, _, _) = h.join(1, Role::Speaker, json!({}));
    h.send(
        speaker,
        json!({"t": "partial", "id": "a", "text": "mid sentence"}),
    );
    let paused = h.send(speaker, json!({"t": "status", "status": "paused"}));
    assert_eq!(
        msgs(&paused),
        vec![
            json!({"t": "status", "status": "paused"}),
            json!({"t": "partial", "id": "a", "text": ""})
        ]
    );
    assert_eq!(paused.send[1].to, Target::Others);
    assert!(
        h.send(speaker, json!({"t": "status", "status": "paused"}))
            .send
            .is_empty()
    );
    let ended = h.send(speaker, json!({"t": "end"}));
    assert_eq!(
        msgs(&ended),
        vec![json!({"t": "status", "status": "ended"})]
    );
    assert!(ended.activity);
    assert!(h.send(speaker, json!({"t": "end"})).send.is_empty());
    assert_eq!(
        first(&h.speak(speaker, "z", "Too late."))["code"],
        "room-ended"
    );
    assert_eq!(
        first(&h.send(speaker, json!({"t": "partial", "id": "z", "text": "x"})))["code"],
        "room-ended"
    );
    assert_eq!(
        first(&h.send(speaker, json!({"t": "status", "status": "live"})))["code"],
        "room-ended"
    );
    assert_eq!(h.room.status(), RoomStatus::Ended);
}

#[test]
fn meta_is_speaker_only() {
    let mut h = Harness::new();
    let (speaker, _, _) = h.join(1, Role::Speaker, json!({}));
    let (listener, _, _) = h.join(2, Role::Listener, json!({}));
    let out = h.send(
        speaker,
        json!({"t": "meta", "title": " Chemistry ", "allowExport": false, "lang": "en-IN"}),
    );
    assert_eq!(out.send[0].to, Target::All);
    assert_eq!(
        first(&out),
        json!({"t": "meta", "meta": {"title": "Chemistry", "lang": "en-IN", "allowExport": false, "createdAt": START}})
    );
    assert_eq!(
        first(&h.send(listener, json!({"t": "meta", "title": "x"})))["code"],
        "forbidden"
    );
    assert_eq!(
        first(&h.send(listener, json!({"t": "end"})))["code"],
        "forbidden"
    );
    assert_eq!(
        first(&h.send(listener, json!({"t": "status", "status": "paused"})))["code"],
        "forbidden"
    );
}

#[test]
fn answers_json_pings_with_server_time() {
    let mut h = Harness::new();
    let (conn, _, _) = h.join(1, Role::Listener, json!({}));
    assert_eq!(
        first(&h.send(conn, json!({"t": "ping", "ts": 42}))),
        json!({"t": "pong", "ts": 42, "serverTime": START})
    );
    assert_eq!(
        first(&h.send(conn, json!({"t": "ping", "ts": 1.25})))["ts"],
        1.25
    );
}

#[test]
fn rate_limits_a_flooding_listener() {
    let mut h = Harness::new();
    let (conn, _, _) = h.join(1, Role::Listener, json!({}));
    let limited = (0..40)
        .filter(|i| first(&h.send(conn, json!({"t": "ping", "ts": i})))["t"] == "error")
        .count();
    assert!(limited > 10, "limited {limited}");
    h.now += 10_000;
    assert_eq!(
        first(&h.send(conn, json!({"t": "ping", "ts": 0})))["t"],
        "pong"
    );
}

#[test]
fn rate_limits_pending_connections_tightly() {
    let mut h = Harness::new();
    let codes: Vec<Value> = (0..7)
        .map(|_| first(&h.send(pending(1), json!({"t": "ping", "ts": 1})))["code"].clone())
        .collect();
    assert_eq!(codes.iter().filter(|c| *c == "hello-required").count(), 5);
    assert_eq!(codes.iter().filter(|c| *c == "rate-limited").count(), 2);
}

#[test]
fn joining_starts_a_fresh_bucket_for_the_role() {
    let mut h = Harness::new();
    // Spend most of the pending bucket (capacity 5) before joining.
    for _ in 0..4 {
        h.send(pending(1), json!({"t": "ping", "ts": 1}));
    }
    let hello = json!({"t": "hello", "role": "speaker", "token": SPEAKER_TOKEN});
    assert_eq!(first(&h.send(pending(1), hello))["t"], "welcome");
    let speaker = ConnState {
        id: 1,
        role: Some(Role::Speaker),
    };
    // A reconnecting speaker can resend a burst of queued finals (capacity 60).
    let errors = (0..50)
        .filter(|i| {
            first(&h.send(
                speaker,
                json!({"t": "final", "id": format!("q{i}"), "text": "Queued."}),
            ))["t"]
                == "error"
        })
        .count();
    assert_eq!(errors, 0);
}

#[test]
fn speaker_disconnect_clears_partial() {
    let mut h = Harness::new();
    let (speaker, _, _) = h.join(1, Role::Speaker, json!({}));
    h.send(speaker, json!({"t": "partial", "id": "a", "text": "half"}));
    let out = h.room.handle_disconnect(speaker, false);
    assert_eq!(out.send.len(), 1);
    assert_eq!(out.send[0].to, Target::Others);
    assert_eq!(first(&out), json!({"t": "partial", "id": "a", "text": ""}));
    assert!(out.presence_changed);
    assert_eq!(
        h.room.handle_disconnect(pending(5), false),
        Outcome::default()
    );
    let (listener, _, _) = h.join(2, Role::Listener, json!({}));
    assert_eq!(
        h.room.handle_disconnect(listener, false),
        Outcome {
            presence_changed: true,
            ..Outcome::default()
        }
    );
}

/// Tests for the abuse limits and text cleaning share the helpers above.
#[path = "room_limit_tests.rs"]
mod limit_tests;
