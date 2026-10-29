//! One WebSocket connection: a reader feeding the hub and a writer draining
//! the connection's bounded outbound channel.

use std::future::Future;
use std::sync::Arc;
use std::time::Duration;

use axum::extract::ws::{CloseFrame, Message, Utf8Bytes, WebSocket};
use futures_util::stream::{SplitSink, SplitStream};
use futures_util::{SinkExt, StreamExt};
use tokio::sync::mpsc;

use crate::hub::{Connection, Hub, Outgoing};
use crate::protocol::{ErrorCode, KEEPALIVE_PING, KEEPALIVE_PONG, ServerMsg, close};
use crate::room::ConnId;
use crate::validate::Frame;

/// Hard transport cap per message, matching Cloudflare's 1 MiB. The protocol
/// limit (8 KiB, counted in UTF-16 units like the cloud server) is enforced in
/// `validate.rs`, so oversized frames get `error bad-frame` in both servers
/// instead of a dropped connection.
pub const MAX_TRANSPORT_MESSAGE: usize = 1024 * 1024;

/// How long to wait for the client's close reply after we send a close frame.
const CLOSE_GRACE: Duration = Duration::from_secs(2);
/// Clients send a literal `ping` every 30 s; silence this long means the phone is gone.
const IDLE_TIMEOUT: Duration = Duration::from_secs(120);
/// A peer that stops reading for this long is dropped (it resumes on reconnect).
const WRITE_TIMEOUT: Duration = Duration::from_secs(10);
/// Connections must send `hello` within this time.
const HELLO_DEADLINE: Duration = Duration::from_secs(30);
/// Messages written before each flush when a burst is queued.
const WRITE_BATCH: usize = 64;

/// Detaches the connection from its room however the task ends (even if cancelled).
struct DisconnectGuard<'a> {
    hub: &'a Hub,
    code: &'a str,
    id: ConnId,
}

impl Drop for DisconnectGuard<'_> {
    fn drop(&mut self) {
        self.hub.disconnect(self.code, self.id);
        tracing::debug!(room = %self.code, conn = self.id, "disconnected");
    }
}

/// Drive one upgraded socket until either side goes away.
pub async fn run_connection(socket: WebSocket, hub: Arc<Hub>, code: String) {
    let Some(Connection { id, rx, tx, kill }) = hub.connect(&code) else {
        reject_missing_room(socket).await;
        return;
    };
    tracing::debug!(room = %code, conn = id, "connected");
    let _guard = DisconnectGuard {
        hub: &hub,
        code: &code,
        id,
    };
    let (sink, stream) = socket.split();
    let writer = write_loop(sink, rx);
    let reader = read_loop(stream, &hub, &code, id, tx);
    let deadline = hello_deadline(&hub, &code, id);
    tokio::pin!(writer, reader, deadline);
    tokio::select! {
        () = &mut writer => {
            // We sent a close frame (or writing failed): let the client answer it.
            let _ = tokio::time::timeout(CLOSE_GRACE, &mut reader).await;
        }
        () = &mut reader => {}
        () = kill.notified() => {}
        () = &mut deadline => {}
    }
}

/// Closes the connection (via the hub, after anything queued) if it has not joined in time.
/// Never completes, so the writer finishing is what ends the connection.
async fn hello_deadline(hub: &Hub, code: &str, id: ConnId) {
    tokio::time::sleep(HELLO_DEADLINE).await;
    hub.close_if_not_joined(code, id);
    std::future::pending::<()>().await;
}

async fn read_loop(
    mut stream: SplitStream<WebSocket>,
    hub: &Hub,
    code: &str,
    id: ConnId,
    tx: mpsc::Sender<Outgoing>,
) {
    loop {
        let msg = match tokio::time::timeout(IDLE_TIMEOUT, stream.next()).await {
            Ok(Some(Ok(msg))) => msg,
            Ok(Some(Err(err))) => {
                tracing::debug!(conn = id, %err, "read failed");
                return;
            }
            Ok(None) => return,
            Err(_) => {
                tracing::debug!(conn = id, "no traffic, dropping the connection");
                return;
            }
        };
        match msg {
            // Keepalive: answered without touching the room or its rate limits.
            Message::Text(text) if text.as_str() == KEEPALIVE_PING => {
                let _ = tx.try_send(Outgoing::Text(Utf8Bytes::from_static(KEEPALIVE_PONG)));
            }
            Message::Text(text) => hub.handle_frame(code, id, Frame::Text(text.as_str())),
            Message::Binary(_) => hub.handle_frame(code, id, Frame::Binary),
            // Protocol pings are answered by the WebSocket layer; keep reading after
            // a close so the close reply gets flushed.
            Message::Ping(_) | Message::Pong(_) | Message::Close(_) => {}
        }
    }
}

async fn write_loop(mut sink: SplitSink<WebSocket, Message>, mut rx: mpsc::Receiver<Outgoing>) {
    while let Some(first) = rx.recv().await {
        let mut next = Some(first);
        let mut written = 0;
        while let Some(out) = next {
            match out {
                Outgoing::Text(text) => {
                    if !within_write_timeout(sink.feed(Message::Text(text))).await {
                        return;
                    }
                }
                Outgoing::Close { code, reason } => {
                    let frame = CloseFrame {
                        code,
                        reason: Utf8Bytes::from_static(reason),
                    };
                    within_write_timeout(sink.send(Message::Close(Some(frame)))).await;
                    return;
                }
            }
            written += 1;
            next = if written < WRITE_BATCH {
                rx.try_recv().ok()
            } else {
                None
            };
        }
        if !within_write_timeout(sink.flush()).await {
            return;
        }
    }
}

/// True when the write finished in time and without error.
async fn within_write_timeout<E>(write: impl Future<Output = Result<(), E>>) -> bool {
    matches!(tokio::time::timeout(WRITE_TIMEOUT, write).await, Ok(Ok(())))
}

/// The room vanished between the HTTP check and the upgrade.
async fn reject_missing_room(mut socket: WebSocket) {
    let msg = ServerMsg::error(
        ErrorCode::NotFound,
        "No room with that code. Check the code and try again.",
    );
    if let Ok(text) = serde_json::to_string(&msg) {
        let _ = within_write_timeout(socket.send(Message::Text(text.into()))).await;
    }
    let frame = CloseFrame {
        code: close::NOT_FOUND,
        reason: Utf8Bytes::from_static("room not found"),
    };
    let _ = within_write_timeout(socket.send(Message::Close(Some(frame)))).await;
}
