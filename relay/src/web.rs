//! Serves the built web app (`apps/web/dist`), embedded in the binary or read
//! from a directory, with SPA fallback to `index.html`.

use std::borrow::Cow;
use std::path::PathBuf;

use axum::body::Body;
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode, header};
use axum::response::{IntoResponse, Response};
use rust_embed::RustEmbed;

use crate::paths::safe_relative;

/// The web app as built by `npm run build`. Missing at compile time is fine:
/// the relay then serves a page explaining how to build it.
#[derive(RustEmbed)]
#[folder = "../apps/web/dist"]
#[allow_missing = true]
struct EmbeddedWeb;

/// Hashed build output: safe to cache forever.
const IMMUTABLE: &str = "public, max-age=31536000, immutable";
/// Everything else (index.html, service worker, manifest): always revalidate.
const REVALIDATE: &str = "no-cache";
const INDEX: &str = "index.html";
const ASSETS_PREFIX: &str = "assets/";

#[derive(Clone, Debug)]
pub enum WebSource {
    /// Files compiled into the binary.
    Embedded,
    /// Files read from disk on every request (handy while developing the web app).
    Dir(PathBuf),
}

struct Asset {
    body: Cow<'static, [u8]>,
    etag: Option<String>,
}

impl WebSource {
    /// True when the web app's `index.html` is available.
    pub async fn has_index(&self) -> bool {
        self.load(INDEX).await.is_some()
    }

    async fn load(&self, rel: &str) -> Option<Asset> {
        match self {
            WebSource::Embedded => EmbeddedWeb::get(rel).map(|file| Asset {
                etag: Some(format!(
                    "\"{}\"",
                    hex::encode(&file.metadata.sha256_hash()[..16])
                )),
                body: file.data,
            }),
            WebSource::Dir(dir) => {
                let path = dir.join(rel);
                let meta = tokio::fs::metadata(&path).await.ok()?;
                if !meta.is_file() {
                    return None;
                }
                let bytes = tokio::fs::read(&path).await.ok()?;
                Some(Asset {
                    body: Cow::Owned(bytes),
                    etag: None,
                })
            }
        }
    }
}

/// Paths owned by the API, WebSocket and model routes never fall back to the app.
pub fn is_reserved_path(path: &str) -> bool {
    ["/api", "/ws", "/models"].iter().any(|p| {
        path == *p
            || path
                .strip_prefix(p)
                .is_some_and(|rest| rest.starts_with('/'))
    })
}

/// Serve a static file, falling back to `index.html` for client-side routes.
pub async fn serve_static(
    web: &WebSource,
    method: &Method,
    path: &str,
    headers: &HeaderMap,
) -> Response {
    if method != Method::GET && method != Method::HEAD {
        return (
            StatusCode::METHOD_NOT_ALLOWED,
            [(header::ALLOW, "GET, HEAD")],
        )
            .into_response();
    }
    let rel = path.trim_start_matches('/');
    let rel = if rel.is_empty() || rel.ends_with('/') {
        format!("{rel}{INDEX}")
    } else {
        rel.to_string()
    };
    if let Some(safe) = safe_relative(&rel)
        && let Some(asset) = web.load(&safe).await
    {
        return file_response(&safe, asset, headers);
    }
    // A missing hashed asset is a real 404; serving HTML instead breaks module loading.
    if rel.starts_with(ASSETS_PREFIX) {
        return (
            StatusCode::NOT_FOUND,
            [(header::CACHE_CONTROL, REVALIDATE)],
            "Not found",
        )
            .into_response();
    }
    match web.load(INDEX).await {
        Some(asset) => file_response(INDEX, asset, headers),
        None => setup_page(),
    }
}

fn file_response(rel: &str, asset: Asset, request_headers: &HeaderMap) -> Response {
    let cache = if rel.starts_with(ASSETS_PREFIX) {
        IMMUTABLE
    } else {
        REVALIDATE
    };
    let etag = asset.etag.and_then(|e| HeaderValue::from_str(&e).ok());
    if let Some(etag) = &etag
        && request_headers
            .get(header::IF_NONE_MATCH)
            .is_some_and(|inm| inm == etag)
    {
        return (
            StatusCode::NOT_MODIFIED,
            [(header::ETAG, etag.clone())],
            [(header::CACHE_CONTROL, cache)],
        )
            .into_response();
    }
    let body = match asset.body {
        Cow::Borrowed(bytes) => Body::from(bytes),
        Cow::Owned(bytes) => Body::from(bytes),
    };
    let mut response = (
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, content_type(rel)),
            (header::CACHE_CONTROL, cache.to_string()),
        ],
        body,
    )
        .into_response();
    if let Some(etag) = etag {
        response.headers_mut().insert(header::ETAG, etag);
    }
    response
}

fn content_type(rel: &str) -> String {
    let mime = mime_guess::from_path(rel).first_or_octet_stream();
    let essence = mime.essence_str();
    let textual = mime.type_() == mime_guess::mime::TEXT
        || matches!(
            essence,
            "application/javascript"
                | "application/json"
                | "application/manifest+json"
                | "image/svg+xml"
        );
    if textual {
        format!("{essence}; charset=utf-8")
    } else {
        essence.to_string()
    }
}

/// Shown when the relay was built before the web app.
fn setup_page() -> Response {
    const PAGE: &str = r#"<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Saybeam relay</title>
<style>
  body { font: 18px/1.5 system-ui, sans-serif; max-width: 40rem; margin: 3rem auto; padding: 0 1rem; color: #111; }
  code, pre { background: #f1f1f1; border-radius: 4px; padding: 0.1rem 0.3rem; }
  pre { padding: 0.75rem 1rem; overflow-x: auto; }
</style>
</head>
<body>
<h1>The relay is running, but the web app is missing</h1>
<p>This copy of <code>saybeam-relay</code> was built without the Saybeam web app.
Run <code>npm run build</code> first, then rebuild the relay so the app is embedded:</p>
<pre>npm install
npm run build
cargo build --release --manifest-path relay/Cargo.toml</pre>
<p>Or point the relay at a built copy with <code>--web-dir apps/web/dist</code>.</p>
</body>
</html>
"#;
    (
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, "text/html; charset=utf-8"),
            (header::CACHE_CONTROL, REVALIDATE),
        ],
        PAGE,
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reserves_api_ws_and_models() {
        for p in ["/api", "/api/x", "/ws/ABCDEF", "/ws", "/models/a.onnx"] {
            assert!(is_reserved_path(p), "{p}");
        }
        for p in [
            "/",
            "/apis",
            "/wsx",
            "/r/ABCDEF",
            "/assets/app.js",
            "/modelsx",
        ] {
            assert!(!is_reserved_path(p), "{p}");
        }
    }

    #[test]
    fn guesses_content_types() {
        assert_eq!(content_type("index.html"), "text/html; charset=utf-8");
        assert_eq!(content_type("assets/app.css"), "text/css; charset=utf-8");
        assert!(content_type("assets/app.js").ends_with("javascript; charset=utf-8"));
        assert_eq!(content_type("ort.wasm"), "application/wasm");
        assert_eq!(content_type("model.onnx"), "application/octet-stream");
    }

    #[tokio::test]
    async fn serves_files_from_a_directory_with_spa_fallback() {
        let dir =
            std::env::temp_dir().join(format!("saybeam-web-test-{}", std::process::id()));
        let assets = dir.join("assets");
        std::fs::create_dir_all(&assets).expect("temp dir");
        std::fs::write(dir.join(INDEX), "<p>app</p>").expect("index");
        std::fs::write(assets.join("app-1234.js"), "console.log(1)").expect("asset");
        let web = WebSource::Dir(dir.clone());
        let none = HeaderMap::new();

        let index = serve_static(&web, &Method::GET, "/", &none).await;
        assert_eq!(index.status(), StatusCode::OK);
        assert_eq!(index.headers()[header::CACHE_CONTROL], REVALIDATE);

        let asset = serve_static(&web, &Method::GET, "/assets/app-1234.js", &none).await;
        assert_eq!(asset.headers()[header::CACHE_CONTROL], IMMUTABLE);

        let spa = serve_static(&web, &Method::GET, "/r/ABCDEF", &none).await;
        assert_eq!(spa.status(), StatusCode::OK);
        assert!(
            spa.headers()[header::CONTENT_TYPE]
                .to_str()
                .unwrap_or("")
                .starts_with("text/html")
        );

        let missing = serve_static(&web, &Method::GET, "/assets/gone.js", &none).await;
        assert_eq!(missing.status(), StatusCode::NOT_FOUND);

        let post = serve_static(&web, &Method::POST, "/", &none).await;
        assert_eq!(post.status(), StatusCode::METHOD_NOT_ALLOWED);

        let _ = std::fs::remove_dir_all(&dir);
        let empty = WebSource::Dir(dir);
        assert!(!empty.has_index().await);
        let setup = serve_static(&empty, &Method::GET, "/", &none).await;
        assert_eq!(setup.status(), StatusCode::OK);
    }
}
