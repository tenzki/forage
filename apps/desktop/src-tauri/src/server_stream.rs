//! Live outline change delivery over a WebSocket the webview never sees.
//!
//! The socket stays in Rust because it carries the server bearer credential and
//! must honour the pinned origin. The webview receives validated frames as
//! `server:stream` Tauri events and never handles the credential itself.

use crate::commands::NativeState;
use crate::sync_commands::connection;
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::time::{interval, timeout, Instant};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::header::AUTHORIZATION;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::{Error as WsError, Message};

pub const STREAM_EVENT: &str = "server:stream";

const INITIAL_BACKOFF: Duration = Duration::from_secs(1);
const MAX_BACKOFF: Duration = Duration::from_secs(30);
const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(30);
const HEARTBEAT_TIMEOUT: Duration = Duration::from_secs(60);
const MAX_FRAME_BYTES: usize = 4 * 1024 * 1024;

/// Frames the server may send. Anything else is dropped rather than relayed, so
/// the webview never has to defend against unknown shapes.
const RELAYED_FRAMES: [&str; 5] = ["ready", "events", "resync", "agent", "pong"];

#[derive(Default)]
pub struct ServerStreamState {
    task: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
}

impl ServerStreamState {
    fn replace(&self, next: Option<tauri::async_runtime::JoinHandle<()>>) {
        let previous = {
            let mut slot = self.task.lock().expect("stream task lock poisoned");
            std::mem::replace(&mut *slot, next)
        };
        if let Some(handle) = previous {
            handle.abort();
        }
    }
}

/// Opens the outline stream, replacing any stream already running.
#[tauri::command]
pub async fn server_stream_connect(
    app: AppHandle,
    stream: State<'_, ServerStreamState>,
    after_revision: u64,
) -> Result<(), String> {
    // Fail fast on a misconfigured connection so the caller learns about it here
    // rather than through a silent retry loop.
    {
        let native = app.state::<NativeState>();
        connection(&native)?;
    }
    let handle = tauri::async_runtime::spawn(run_stream(app.clone(), after_revision));
    stream.replace(Some(handle));
    Ok(())
}

/// Closes the outline stream. Safe to call when no stream is running.
#[tauri::command]
pub async fn server_stream_disconnect(stream: State<'_, ServerStreamState>) -> Result<(), String> {
    stream.replace(None);
    Ok(())
}

fn emit(app: &AppHandle, frame: Value) {
    let _ = app.emit(STREAM_EVENT, frame);
}

async fn run_stream(app: AppHandle, after_revision: u64) {
    let mut backoff = INITIAL_BACKOFF;
    loop {
        match connect_once(&app, after_revision).await {
            Ok(()) => backoff = INITIAL_BACKOFF,
            Err(StreamExit::Refused(status)) => {
                // A refusal that will not change on its own: stop retrying and let
                // the application surface it instead of hammering the server.
                emit(&app, json!({ "type": "stream_auth_failed", "status": status }));
                return;
            }
            Err(StreamExit::Dropped(message)) => {
                emit(&app, json!({ "type": "stream_disconnected", "reason": message }));
            }
        }
        tokio::time::sleep(with_jitter(backoff)).await;
        backoff = next_backoff(backoff);
    }
}

enum StreamExit {
    /// The server declined the upgrade in a way retrying cannot fix.
    Refused(u16),
    /// The socket closed or failed; reconnecting is worth trying.
    Dropped(String),
}

async fn connect_once(app: &AppHandle, after_revision: u64) -> Result<(), StreamExit> {
    let (endpoint, token, device_id) = {
        let native = app.state::<NativeState>();
        let (configuration, pinned, token) =
            connection(&native).map_err(StreamExit::Dropped)?;
        let path = format!(
            "/api/v1/outlines/{}/stream",
            urlencoding(&configuration.outline_id)
        );
        let endpoint = pinned
            .websocket_endpoint(&path)
            .map_err(|error| StreamExit::Dropped(error.to_string()))?;
        let device_id = native
            .event_store
            .get_or_create_identity("device_id", "device")
            .map_err(|error| StreamExit::Dropped(error.to_string()))?;
        (endpoint, token, device_id)
    };

    let mut request = endpoint
        .as_str()
        .into_client_request()
        .map_err(|error| StreamExit::Dropped(error.to_string()))?;
    let mut authorization = HeaderValue::from_str(&format!("Bearer {token}"))
        .map_err(|_| StreamExit::Dropped("invalid server credential".to_string()))?;
    authorization.set_sensitive(true);
    request.headers_mut().insert(AUTHORIZATION, authorization);

    let (mut socket, _) = tokio_tungstenite::connect_async(request)
        .await
        .map_err(handshake_failure)?;

    socket
        .send(Message::Text(
            json!({ "type": "hello", "afterRevision": after_revision, "deviceId": device_id })
                .to_string()
                .into(),
        ))
        .await
        .map_err(|error| StreamExit::Dropped(error.to_string()))?;

    // Time passed while this client was away, so its revision cursor cannot be
    // assumed contiguous. Saying so up front collapses reconnect, sleep, and
    // network flap into the resynchronization path the application already has.
    emit(app, json!({ "type": "stream_connected" }));

    pump(app, &mut socket).await
}

async fn pump<S>(app: &AppHandle, socket: &mut S) -> Result<(), StreamExit>
where
    S: futures_util::Stream<Item = Result<Message, WsError>>
        + futures_util::Sink<Message, Error = WsError>
        + Unpin,
{
    let mut heartbeat = interval(HEARTBEAT_INTERVAL);
    heartbeat.tick().await;
    let mut last_seen = Instant::now();
    loop {
        tokio::select! {
            _ = heartbeat.tick() => {
                if last_seen.elapsed() > HEARTBEAT_TIMEOUT {
                    return Err(StreamExit::Dropped("the server stopped responding".to_string()));
                }
                socket.send(Message::Ping(Vec::new().into()))
                    .await
                    .map_err(|error| StreamExit::Dropped(error.to_string()))?;
            }
            received = timeout(HEARTBEAT_INTERVAL, socket.next()) => {
                let Ok(received) = received else { continue };
                match received {
                    None => return Err(StreamExit::Dropped("the server closed the stream".to_string())),
                    Some(Err(error)) => return Err(StreamExit::Dropped(error.to_string())),
                    Some(Ok(message)) => {
                        last_seen = Instant::now();
                        match message {
                            Message::Text(text) => {
                                if let Some(frame) = relayable_frame(text.as_str()) {
                                    emit(app, frame);
                                }
                            }
                            Message::Close(_) => {
                                return Err(StreamExit::Dropped("the server closed the stream".to_string()))
                            }
                            Message::Ping(payload) => {
                                socket.send(Message::Pong(payload))
                                    .await
                                    .map_err(|error| StreamExit::Dropped(error.to_string()))?;
                            }
                            _ => {}
                        }
                    }
                }
            }
        }
    }
}

/// Returns the frame only when it is a known server frame, so unknown or
/// malformed payloads never reach the webview.
fn relayable_frame(text: &str) -> Option<Value> {
    if text.len() > MAX_FRAME_BYTES {
        return None;
    }
    let value: Value = serde_json::from_str(text).ok()?;
    let kind = value.get("type")?.as_str()?;
    if !RELAYED_FRAMES.contains(&kind) {
        return None;
    }
    Some(value)
}

fn handshake_failure(error: WsError) -> StreamExit {
    match error {
        WsError::Http(response) => {
            let status = response.status().as_u16();
            if matches!(status, 401 | 403 | 426) {
                StreamExit::Refused(status)
            } else {
                StreamExit::Dropped(format!("the server refused the stream with status {status}"))
            }
        }
        other => StreamExit::Dropped(other.to_string()),
    }
}

fn next_backoff(current: Duration) -> Duration {
    std::cmp::min(current.saturating_mul(2), MAX_BACKOFF)
}

/// Spreads reconnection attempts so several devices do not retry in lockstep.
fn with_jitter(base: Duration) -> Duration {
    let millis = base.as_millis() as u64;
    let spread = (millis / 4).max(1);
    base + Duration::from_millis(rand::random::<u64>() % spread)
}

/// Percent-encodes the path segment characters an outline identifier may contain.
fn urlencoding(value: &str) -> String {
    value
        .bytes()
        .map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (byte as char).to_string()
            }
            _ => format!("%{byte:02X}"),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relays_only_known_server_frames() {
        assert!(relayable_frame(r#"{"type":"ready","currentRevision":4}"#).is_some());
        assert!(relayable_frame(r#"{"type":"events","fromRevision":4}"#).is_some());
        assert!(relayable_frame(r#"{"type":"unknown"}"#).is_none());
        assert!(relayable_frame(r#"{"type":"stream_connected"}"#).is_none());
        assert!(relayable_frame("not json").is_none());
        assert!(relayable_frame(r#"{"missing":"type"}"#).is_none());
        assert!(relayable_frame(r#"["ready"]"#).is_none());
    }

    #[test]
    fn backoff_grows_and_settles_at_the_ceiling() {
        let mut delay = INITIAL_BACKOFF;
        let mut seen = vec![delay];
        for _ in 0..10 {
            delay = next_backoff(delay);
            seen.push(delay);
        }
        assert_eq!(seen[0], Duration::from_secs(1));
        assert_eq!(seen[1], Duration::from_secs(2));
        assert_eq!(seen[2], Duration::from_secs(4));
        assert_eq!(*seen.last().unwrap(), MAX_BACKOFF);
    }

    #[test]
    fn jitter_stays_within_a_quarter_of_the_delay() {
        for _ in 0..100 {
            let jittered = with_jitter(Duration::from_secs(4));
            assert!(jittered >= Duration::from_secs(4));
            assert!(jittered < Duration::from_millis(5_000));
        }
    }

    #[test]
    fn encodes_path_segments_that_could_escape_the_route() {
        assert_eq!(urlencoding("outline_1"), "outline_1");
        assert_eq!(urlencoding("a/b"), "a%2Fb");
        assert_eq!(urlencoding("../x"), "..%2Fx");
        assert_eq!(urlencoding("a?b#c"), "a%3Fb%23c");
    }
}
