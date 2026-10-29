//! End-to-end: start the relay on an ephemeral port and drive it over real
//! HTTP and WebSocket connections.

use std::net::SocketAddr;
use std::path::PathBuf;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream, connect_async};

use caption_room_relay::http::{ServerConfig, build_app};
use caption_room_relay::hub::HubSettings;
use caption_room_relay::web::WebSource;

type Ws = WebSocketStream<MaybeTlsStream<TcpStream>>;

const WAIT: Duration = Duration::from_secs(3);

/// A throwaway web root so static-file checks do not depend on `npm run build`.
fn web_root(name: &str) -> PathBuf {
    let dir =
        std::env::temp_dir().join(format!("caption-room-relay-{name}-{}", std::process::id()));
    std::fs::create_dir_all(dir.join("assets")).expect("temp web root");
    std::fs::write(
        dir.join("index.html"),
        "<!doctype html><title>Caption Room</title>",
    )
    .expect("index");
    std::fs::write(dir.join("assets").join("app-abc123.js"), "export {}").expect("asset");
    std::fs::write(dir.join("my notes.txt"), "spaces are fine").expect("spaced file");
    dir
}

async fn start(name: &str) -> SocketAddr {
    let config = ServerConfig {
        public_base: Some("http://192.168.1.23:7300".into()),
        models_dir: None,
        web: WebSource::Dir(web_root(name)),
        hub: HubSettings::default(),
    };
    let (app, _hub) = build_app(config);
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let addr = listener.local_addr().expect("addr");
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    addr
}

struct HttpResponse {
    status: u16,
    head: String,
    body: String,
}

impl HttpResponse {
    fn json(&self) -> Value {
        serde_json::from_str(&self.body).unwrap_or(Value::Null)
    }

    fn header(&self, name: &str) -> Option<String> {
        self.head.lines().find_map(|line| {
            let (key, value) = line.split_once(':')?;
            key.trim()
                .eq_ignore_ascii_case(name)
                .then(|| value.trim().to_string())
        })
    }
}

/// Minimal HTTP/1.1 client with a JSON content type.
async fn http(addr: SocketAddr, method: &str, path: &str, body: &str) -> HttpResponse {
    http_typed(addr, method, path, Some("application/json"), body).await
}

/// Minimal HTTP/1.1 client: enough for JSON APIs and small static files.
async fn http_typed(
    addr: SocketAddr,
    method: &str,
    path: &str,
    content_type: Option<&str>,
    body: &str,
) -> HttpResponse {
    let mut stream = TcpStream::connect(addr).await.expect("connect");
    let type_header = content_type.map_or_else(String::new, |t| format!("Content-Type: {t}\r\n"));
    let request = format!(
        "{method} {path} HTTP/1.1\r\nHost: {addr}\r\nConnection: close\r\n{type_header}Content-Length: {}\r\n\r\n{body}",
        body.len()
    );
    stream.write_all(request.as_bytes()).await.expect("write");
    let mut raw = Vec::new();
    stream.read_to_end(&mut raw).await.expect("read");
    let text = String::from_utf8_lossy(&raw).to_string();
    let (head, body) = text.split_once("\r\n\r\n").unwrap_or((&text, ""));
    let status = head
        .split_whitespace()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);
    HttpResponse {
        status,
        head: head.to_string(),
        body: body.to_string(),
    }
}

async fn create_room(addr: SocketAddr) -> Value {
    let res = http(
        addr,
        "POST",
        "/api/rooms",
        r#"{"title":"Physics","lang":"en-IN"}"#,
    )
    .await;
    assert_eq!(res.status, 201, "{}", res.body);
    res.json()
}

async fn ws(addr: SocketAddr, code: &str) -> Ws {
    connect_async(format!("ws://{addr}/ws/{code}"))
        .await
        .expect("websocket")
        .0
}

async fn send(ws: &mut Ws, msg: Value) {
    ws.send(Message::text(msg.to_string())).await.expect("send");
}

enum Received {
    Json(Value),
    Text(String),
    Closed(Option<u16>),
}

async fn recv(ws: &mut Ws) -> Option<Received> {
    loop {
        let next = tokio::time::timeout(WAIT, ws.next()).await.ok()?;
        match next {
            Some(Ok(Message::Text(text))) => {
                return Some(match serde_json::from_str(text.as_str()) {
                    Ok(value) => Received::Json(value),
                    Err(_) => Received::Text(text.to_string()),
                });
            }
            Some(Ok(Message::Close(frame))) => {
                return Some(Received::Closed(frame.map(|f| u16::from(f.code))));
            }
            Some(Ok(_)) => continue,
            Some(Err(_)) | None => return Some(Received::Closed(None)),
        }
    }
}

/// Next JSON message of type `t`, skipping others (presence and so on).
async fn next_of(ws: &mut Ws, t: &str) -> Value {
    loop {
        match recv(ws).await {
            Some(Received::Json(msg)) if msg["t"] == t => return msg,
            Some(Received::Json(_)) | Some(Received::Text(_)) => continue,
            Some(Received::Closed(code)) => panic!("closed ({code:?}) while waiting for {t}"),
            None => panic!("timed out waiting for {t}"),
        }
    }
}

/// Close code once the server closes the socket.
async fn close_code(ws: &mut Ws) -> Option<u16> {
    loop {
        match recv(ws).await {
            Some(Received::Closed(code)) => return code,
            Some(_) => continue,
            None => return None,
        }
    }
}

async fn join(addr: SocketAddr, code: &str, hello: Value) -> (Ws, Value) {
    let mut socket = ws(addr, code).await;
    send(&mut socket, hello).await;
    let welcome = next_of(&mut socket, "welcome").await;
    (socket, welcome)
}

#[tokio::test]
async fn live_session_with_partials_finals_and_resume() {
    let addr = start("session").await;

    let info = http(addr, "GET", "/api/info", "").await.json();
    assert_eq!(info["mode"], "lan");
    assert_eq!(info["publicBase"], "http://192.168.1.23:7300");
    assert_eq!(info["localModels"], false);
    assert_eq!(info["version"], env!("CARGO_PKG_VERSION"));

    let room = create_room(addr).await;
    let code = room["code"].as_str().expect("code").to_string();
    assert_eq!(room["speakerToken"].as_str().map(str::len), Some(43));
    let summary = http(addr, "GET", &format!("/api/rooms/{code}"), "").await;
    assert_eq!(summary.status, 200);
    assert_eq!(
        summary.json(),
        json!({"code": code, "status": "live", "title": "Physics"})
    );

    // Speaker and listener join.
    let (mut speaker, sw) = join(
        addr,
        &code,
        json!({"t": "hello", "role": "speaker", "token": room["speakerToken"]}),
    )
    .await;
    assert_eq!(
        (sw["role"].as_str(), sw["mode"].as_str(), sw["rev"].as_u64()),
        (Some("speaker"), Some("replace"), Some(0))
    );
    assert_eq!(sw["meta"]["lang"], "en-IN");
    let (mut listener, lw) = join(addr, &code, json!({"t": "hello", "role": "listener"})).await;
    assert_eq!(
        lw["presence"],
        json!({"listeners": 1, "correctors": 0, "speaker": true})
    );

    // Literal keepalive.
    listener.send(Message::text("ping")).await.expect("send");
    loop {
        match recv(&mut listener).await {
            Some(Received::Text(text)) => {
                assert_eq!(text, "pong");
                break;
            }
            Some(Received::Json(_)) => continue,
            _ => panic!("no pong"),
        }
    }

    // A partial reaches the listener but not the speaker.
    send(
        &mut speaker,
        json!({"t": "partial", "id": "s1-1", "text": "good morn"}),
    )
    .await;
    let partial = next_of(&mut listener, "partial").await;
    assert_eq!(
        partial,
        json!({"t": "partial", "id": "s1-1", "text": "good morn"})
    );
    send(&mut speaker, json!({"t": "ping", "ts": 7})).await;
    loop {
        match recv(&mut speaker).await {
            Some(Received::Json(msg)) if msg["t"] == "pong" => break,
            Some(Received::Json(msg)) => {
                assert_ne!(msg["t"], "partial", "speaker got its own partial")
            }
            _ => panic!("no pong for the speaker"),
        }
    }

    // A final reaches both.
    send(&mut speaker, json!({"t": "final", "id": "s1-1", "text": " Good morning, everyone. ", "startMs": 0, "endMs": 1800})).await;
    let expected = json!({"seq": 1, "id": "s1-1", "text": "Good morning, everyone.", "rev": 1, "startMs": 0, "endMs": 1800});
    for socket in [&mut listener, &mut speaker] {
        let mut seg = next_of(socket, "final").await["seg"].clone();
        assert!(seg["ts"].is_u64());
        seg.as_object_mut().map(|o| o.remove("ts"));
        assert_eq!(seg, expected);
    }

    // The listener drops; a caption arrives meanwhile; it resumes with since = 1.
    listener.close(None).await.expect("close");
    send(
        &mut speaker,
        json!({"t": "final", "id": "s1-2", "text": "Second line."}),
    )
    .await;
    assert_eq!(next_of(&mut speaker, "final").await["seg"]["seq"], 2);
    let (_back, bw) = join(
        addr,
        &code,
        json!({"t": "hello", "role": "listener", "since": 1}),
    )
    .await;
    assert_eq!(bw["mode"], "append");
    let seqs: Vec<u64> = bw["segments"]
        .as_array()
        .expect("segments")
        .iter()
        .filter_map(|s| s["seq"].as_u64())
        .collect();
    assert_eq!(seqs, vec![2]);
    assert_eq!(bw["rev"], 2);
}

#[tokio::test]
async fn websocket_rejections_and_replacement() {
    let addr = start("rejections").await;
    let room = create_room(addr).await;
    let code = room["code"].as_str().expect("code").to_string();

    // Unknown and malformed codes are refused before the upgrade.
    assert!(
        connect_async(format!("ws://{addr}/ws/ZZZZZZ"))
            .await
            .is_err()
    );
    assert!(
        connect_async(format!("ws://{addr}/ws/nope0"))
            .await
            .is_err()
    );

    // Bad token: error, then close 4003.
    let mut intruder = ws(addr, &code).await;
    send(
        &mut intruder,
        json!({"t": "hello", "role": "corrector", "token": "not-the-right-token-at-all"}),
    )
    .await;
    assert_eq!(
        next_of(&mut intruder, "error").await["code"],
        "unauthorized"
    );
    assert_eq!(close_code(&mut intruder).await, Some(4003));

    // Frames before hello, binary frames and bad JSON.
    let mut early = ws(addr, &code).await;
    send(
        &mut early,
        json!({"t": "partial", "id": "x", "text": "too early"}),
    )
    .await;
    assert_eq!(next_of(&mut early, "error").await["code"], "hello-required");
    early
        .send(Message::binary(vec![1u8, 2, 3]))
        .await
        .expect("send");
    assert_eq!(next_of(&mut early, "error").await["code"], "bad-frame");
    early.send(Message::text("{not json")).await.expect("send");
    assert_eq!(next_of(&mut early, "error").await["code"], "bad-frame");

    // Oversized frames get bad-frame "frame too large", then close 4400. Same well
    // past 8 KiB (the cloud accepts frames up to 1 MiB before answering).
    for pad in [9000, 200_000] {
        let (mut big, _) = join(addr, &code, json!({"t": "hello", "role": "listener"})).await;
        send(
            &mut big,
            json!({"t": "ping", "ts": 1, "pad": "x".repeat(pad)}),
        )
        .await;
        let err = next_of(&mut big, "error").await;
        assert_eq!(
            (err["code"].as_str(), err["message"].as_str()),
            (Some("bad-frame"), Some("frame too large"))
        );
        assert_eq!(close_code(&mut big).await, Some(4400), "pad {pad}");
    }

    // Twenty rejected frames close the connection with 4400.
    let mut noisy = ws(addr, &code).await;
    for _ in 0..20 {
        noisy.send(Message::text("{nope")).await.expect("send");
    }
    assert_eq!(close_code(&mut noisy).await, Some(4400));

    let (mut listener, _) = join(addr, &code, json!({"t": "hello", "role": "listener"})).await;

    // The newest speaker wins.
    let speaker_hello = json!({"t": "hello", "role": "speaker", "token": room["speakerToken"]});
    let (mut first, _) = join(addr, &code, speaker_hello.clone()).await;
    let (mut second, _) = join(addr, &code, speaker_hello).await;
    assert_eq!(close_code(&mut first).await, Some(4001));
    send(&mut second, json!({"t": "end"})).await;
    assert_eq!(next_of(&mut listener, "status").await["status"], "ended");
    send(
        &mut second,
        json!({"t": "final", "id": "late", "text": "After the end."}),
    )
    .await;
    assert_eq!(next_of(&mut second, "error").await["code"], "room-ended");
}

#[tokio::test]
async fn http_routes_validation_and_headers() {
    let addr = start("http").await;

    assert_eq!(http(addr, "GET", "/api/rooms/ZZZZZZ", "").await.status, 404);
    assert_eq!(http(addr, "GET", "/api/rooms/abc", "").await.status, 404);
    let not_upgrade = http(addr, "GET", "/ws/ZZZZZZ", "").await;
    assert_eq!(not_upgrade.status, 426);

    let long_title = json!({"title": "x".repeat(200)}).to_string();
    assert_eq!(
        http(addr, "POST", "/api/rooms", &long_title).await.status,
        400
    );
    assert_eq!(
        http(addr, "POST", "/api/rooms", r#"{"lang":"not a lang"}"#)
            .await
            .status,
        400
    );
    assert_eq!(http(addr, "POST", "/api/rooms", "{oops").await.status, 400);
    let too_big = http(addr, "POST", "/api/rooms", &"x".repeat(5000)).await;
    assert_eq!(
        (too_big.status, too_big.json()),
        (413, json!({"error": "Request too large."}))
    );
    assert_eq!(http(addr, "POST", "/api/rooms", "[]").await.status, 400);
    // Wrong methods: 404 JSON on the API and 426 on /ws, like the cloud Worker.
    let wrong_method = http(addr, "GET", "/api/rooms", "").await;
    assert_eq!(
        (wrong_method.status, wrong_method.json()),
        (404, json!({"error": "Not found"}))
    );
    assert_eq!(http(addr, "POST", "/ws/ZZZZZZ", "").await.status, 426);
    // JSON content type is required (checked before the body, even an oversized one).
    for content_type in [
        None,
        Some("text/plain"),
        Some("application/x-www-form-urlencoded"),
    ] {
        let res = http_typed(addr, "POST", "/api/rooms", content_type, "{}").await;
        assert_eq!(
            (res.status, res.json()),
            (
                415,
                json!({"error": "Send JSON (content-type: application/json)."})
            ),
            "{content_type:?}"
        );
    }
    let big_plain = http_typed(addr, "POST", "/api/rooms", None, &"x".repeat(5000)).await;
    assert_eq!(big_plain.status, 415);
    let mixed_case = http_typed(
        addr,
        "POST",
        "/api/rooms",
        Some("Application/JSON; charset=utf-8"),
        "{}",
    )
    .await;
    assert_eq!(mixed_case.status, 201);

    let empty = http(addr, "POST", "/api/rooms", "").await;
    assert_eq!(empty.status, 201);
    assert_eq!(empty.header("cache-control").as_deref(), Some("no-store"));

    let unknown = http(addr, "GET", "/api/nope", "").await;
    assert_eq!(
        (unknown.status, unknown.json()),
        (404, json!({"error": "Not found"}))
    );

    // Static files and SPA fallback carry the cross-origin isolation headers.
    for path in ["/", "/r/ABCDEF", "/assets/app-abc123.js"] {
        let res = http(addr, "GET", path, "").await;
        assert_eq!(res.status, 200, "{path}");
        assert_eq!(
            res.header("cross-origin-opener-policy").as_deref(),
            Some("same-origin")
        );
        assert_eq!(
            res.header("cross-origin-embedder-policy").as_deref(),
            Some("credentialless")
        );
        assert_eq!(
            res.header("x-content-type-options").as_deref(),
            Some("nosniff")
        );
        assert_eq!(
            res.header("referrer-policy").as_deref(),
            Some("no-referrer")
        );
    }
    let index = http(addr, "GET", "/", "").await;
    assert_eq!(index.header("cache-control").as_deref(), Some("no-cache"));
    assert!(index.body.contains("Caption Room"));
    let asset = http(addr, "GET", "/assets/app-abc123.js", "").await;
    assert!(
        asset
            .header("cache-control")
            .is_some_and(|c| c.contains("immutable"))
    );
    assert_eq!(
        http(addr, "GET", "/assets/missing.js", "").await.status,
        404
    );
    // Percent-encoded names are decoded; traversal and device names never reach the disk.
    let spaced = http(addr, "GET", "/my%20notes.txt", "").await;
    assert_eq!(spaced.body, "spaces are fine");
    for path in ["/%2e%2e/Cargo.toml", "/CON", "/aux.js"] {
        let res = http(addr, "GET", path, "").await;
        assert!(
            res.body.contains("Caption Room"),
            "{path} falls back to the app"
        );
    }
    assert_eq!(
        http(addr, "GET", "/models/whisper.onnx", "").await.status,
        404
    );
}

#[tokio::test]
async fn serves_models_with_resource_policy() {
    let models =
        std::env::temp_dir().join(format!("caption-room-relay-models-{}", std::process::id()));
    std::fs::create_dir_all(&models).expect("models dir");
    std::fs::write(models.join("tiny.onnx"), b"\x08\x01model").expect("model file");
    let config = ServerConfig {
        public_base: None,
        models_dir: Some(models),
        web: WebSource::Dir(web_root("models")),
        hub: HubSettings::default(),
    };
    let (app, _hub) = build_app(config);
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
    let addr = listener.local_addr().expect("addr");
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });

    let info = http(addr, "GET", "/api/info", "").await.json();
    assert_eq!(
        (info["localModels"].clone(), info["publicBase"].clone()),
        (json!(true), Value::Null)
    );
    assert_eq!(http(addr, "GET", "/models/CON", "").await.status, 404);
    assert_eq!(
        http(addr, "GET", "/models/%4eUL.onnx", "").await.status,
        404
    );
    let model = http(addr, "GET", "/models/tiny.onnx", "").await;
    assert_eq!(model.status, 200);
    assert_eq!(
        model.header("cross-origin-resource-policy").as_deref(),
        Some("same-origin")
    );
    assert_eq!(
        model.header("cross-origin-embedder-policy").as_deref(),
        Some("credentialless")
    );
}
