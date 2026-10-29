//! HTTP routes: the JSON API, the WebSocket upgrade, model files and the web app.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use axum::body::{Body, to_bytes};
use axum::extract::rejection::PathRejection;
use axum::extract::ws::rejection::WebSocketUpgradeRejection;
use axum::extract::{DefaultBodyLimit, Path, Request, State, WebSocketUpgrade};
use axum::http::{HeaderMap, HeaderName, HeaderValue, Method, StatusCode, Uri, header};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::json;
use tower_http::services::ServeDir;

use crate::codes::is_valid_room_code;
use crate::hub::{CreateRoomError, Hub, HubSettings, now_ms};
use crate::paths::has_device_name;
use crate::protocol::ServerInfo;
use crate::validate::parse_create_room;
use crate::web::{WebSource, is_reserved_path, serve_static};
use crate::ws::{MAX_TRANSPORT_MESSAGE, run_connection};

/// Largest accepted JSON request body (same as the cloud server; larger gets 413).
const MAX_BODY_BYTES: usize = 4096;
/// Ended rooms nobody is watching are dropped after this long without activity.
pub const ENDED_ROOM_TTL: Duration = Duration::from_secs(24 * 60 * 60);
const EVICTION_INTERVAL: Duration = Duration::from_secs(10 * 60);

/// Everything needed to build the app.
#[derive(Clone, Debug)]
pub struct ServerConfig {
    /// URL listeners should open, e.g. `http://192.168.1.23:7300`.
    pub public_base: Option<String>,
    /// Directory served at `/models/` (must exist).
    pub models_dir: Option<PathBuf>,
    pub web: WebSource,
    pub hub: HubSettings,
}

#[derive(Clone)]
struct AppState {
    hub: Arc<Hub>,
    info: Arc<ServerInfo>,
    web: Arc<WebSource>,
}

/// Build the router. The hub is returned too so the caller can run housekeeping.
pub fn build_app(config: ServerConfig) -> (Router, Arc<Hub>) {
    let hub = Arc::new(Hub::new(config.hub));
    let info = ServerInfo {
        mode: "lan",
        version: env!("CARGO_PKG_VERSION"),
        public_base: config.public_base,
        local_models: config.models_dir.is_some(),
    };
    let state = AppState {
        hub: Arc::clone(&hub),
        info: Arc::new(info),
        web: Arc::new(config.web),
    };
    // Wrong methods get the same answers as the cloud Worker: 404 JSON on the API, 426 on /ws.
    let mut router = Router::new()
        .route("/api/info", get(api_info).fallback(api_not_found))
        .route("/api/rooms", post(create_room).fallback(api_not_found))
        .route("/api/rooms/{code}", get(get_room).fallback(api_not_found))
        .route("/ws/{code}", get(ws_upgrade).fallback(upgrade_required));
    if let Some(dir) = config.models_dir {
        router = router.nest_service("/models", ServeDir::new(dir));
    }
    let router = router
        .fallback(fallback)
        .layer(middleware::from_fn(guard_models))
        .layer(middleware::from_fn(response_headers))
        .layer(DefaultBodyLimit::max(MAX_BODY_BYTES))
        .with_state(state);
    (router, hub)
}

/// Periodically drop ended rooms that nobody has used for a day.
pub fn spawn_evictor(hub: Arc<Hub>) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(EVICTION_INTERVAL);
        loop {
            tick.tick().await;
            let evicted = hub.evict_idle(now_ms(), ENDED_ROOM_TTL);
            if evicted > 0 {
                tracing::info!(evicted, "dropped old ended rooms");
            }
        }
    })
}

async fn api_info(State(state): State<AppState>) -> Json<ServerInfo> {
    Json(state.info.as_ref().clone())
}

async fn create_room(State(state): State<AppState>, headers: HeaderMap, body: Body) -> Response {
    // Requiring JSON forces a CORS preflight, so other sites cannot create rooms
    // from a visitor's browser. Checked before the body is read.
    if !is_json_content_type(&headers) {
        return error(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "Send JSON (content-type: application/json).",
        );
    }
    // Any read error here is the size limit or a broken upload; the cloud answers 413 too.
    let Ok(body) = to_bytes(body, MAX_BODY_BYTES).await else {
        return error(StatusCode::PAYLOAD_TOO_LARGE, "Request too large.");
    };
    let req = match parse_create_room(&body) {
        Ok(req) => req,
        Err(message) => return error(StatusCode::BAD_REQUEST, &message),
    };
    match state.hub.create_room(req) {
        Ok(created) => {
            tracing::info!(room = %created.code, "room created");
            (StatusCode::CREATED, Json(created)).into_response()
        }
        Err(CreateRoomError::TooManyRooms) => error(
            StatusCode::TOO_MANY_REQUESTS,
            "Too many rooms on this relay. Restart it to clear old rooms.",
        ),
        Err(CreateRoomError::NoFreeCode) => error(
            StatusCode::SERVICE_UNAVAILABLE,
            "Could not pick a room code. Try again.",
        ),
    }
}

async fn get_room(
    State(state): State<AppState>,
    code: Result<Path<String>, PathRejection>,
) -> Response {
    let summary = code
        .ok()
        .filter(|Path(code)| is_valid_room_code(code))
        .and_then(|Path(code)| state.hub.room_summary(&code));
    match summary {
        Some(summary) => Json(summary).into_response(),
        None => room_not_found(),
    }
}

/// Same checks, in the same order, as the cloud Worker: upgrade first (426),
/// then the code format and the room (404), before touching any room state.
async fn ws_upgrade(
    State(state): State<AppState>,
    code: Result<Path<String>, PathRejection>,
    upgrade: Result<WebSocketUpgrade, WebSocketUpgradeRejection>,
) -> Response {
    let Ok(upgrade) = upgrade else {
        return upgrade_required().await;
    };
    let Some(Path(code)) = code
        .ok()
        .filter(|Path(code)| is_valid_room_code(code) && state.hub.room_exists(code))
    else {
        return (StatusCode::NOT_FOUND, "Room not found").into_response();
    };
    let hub = Arc::clone(&state.hub);
    upgrade
        .max_message_size(MAX_TRANSPORT_MESSAGE)
        .max_frame_size(MAX_TRANSPORT_MESSAGE)
        .on_upgrade(move |socket| run_connection(socket, hub, code))
}

async fn fallback(
    State(state): State<AppState>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
) -> Response {
    if is_reserved_path(uri.path()) {
        return error(StatusCode::NOT_FOUND, "Not found");
    }
    serve_static(&state.web, &method, uri.path(), &headers).await
}

/// Cross-origin isolation (the speaker page runs speech models on WASM threads)
/// plus basic hardening, on every response.
async fn response_headers(req: Request, next: Next) -> Response {
    let path = req.uri().path();
    let is_models = path.starts_with("/models/");
    let is_api = path.starts_with("/api/");
    let mut response = next.run(req).await;
    let headers = response.headers_mut();
    let set = |headers: &mut HeaderMap, name: &'static str, value: &'static str| {
        headers.insert(
            HeaderName::from_static(name),
            HeaderValue::from_static(value),
        );
    };
    set(headers, "cross-origin-opener-policy", "same-origin");
    set(headers, "cross-origin-embedder-policy", "credentialless");
    set(headers, "x-content-type-options", "nosniff");
    set(headers, "referrer-policy", "no-referrer");
    if is_models {
        set(headers, "cross-origin-resource-policy", "same-origin");
    }
    // API responses can carry room secrets: never cache them.
    if is_api && !headers.contains_key(header::CACHE_CONTROL) {
        set(headers, "cache-control", "no-store");
    }
    response
}

/// `content-type` starts with `application/json`, ignoring case (parameters allowed).
fn is_json_content_type(headers: &HeaderMap) -> bool {
    headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.to_ascii_lowercase().starts_with("application/json"))
}

async fn api_not_found() -> Response {
    error(StatusCode::NOT_FOUND, "Not found")
}

async fn upgrade_required() -> Response {
    (
        StatusCode::UPGRADE_REQUIRED,
        [(header::UPGRADE, "websocket")],
        "Expected a WebSocket upgrade",
    )
        .into_response()
}

/// Model files come from disk: never let a path name a Windows device (`CON`, `NUL`, ...).
async fn guard_models(req: Request, next: Next) -> Response {
    let path = req.uri().path();
    if path.starts_with("/models/") && has_device_name(path) {
        return (StatusCode::NOT_FOUND, "Not found").into_response();
    }
    next.run(req).await
}

fn room_not_found() -> Response {
    error(StatusCode::NOT_FOUND, "No room with that code.")
}

fn error(status: StatusCode, message: &str) -> Response {
    (status, Json(json!({ "error": message }))).into_response()
}
