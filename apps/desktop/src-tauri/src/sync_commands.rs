use crate::commands::NativeState;
use crate::persistence::ServerConfiguration;
use crate::server_transport::PinnedServer;
use base64::Engine;
use reqwest::{Method, StatusCode};
use serde_json::{json, Value};
use std::collections::BTreeSet;
use tauri::State;

const MAX_STATUS_BYTES: usize = 64 * 1024;
const MAX_EVENT_RESPONSE_BYTES: usize = 2 * 1024 * 1024;
const MAX_CHECKPOINT_BYTES: usize = 16 * 1024 * 1024;

#[tauri::command]
pub async fn server_enroll(
    state: State<'_, NativeState>,
    origin: String,
    outline_id: String,
    device_token: String,
) -> Result<Value, String> {
    if outline_id.is_empty()
        || outline_id.len() > 128
        || !outline_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
    {
        return Err("invalid outline identifier".to_string());
    }
    if device_token.trim().is_empty() || device_token.len() > 1_024 {
        return Err("invalid device token".to_string());
    }
    let provisional = PinnedServer::parse(&origin, "pending").map_err(|error| error.to_string())?;
    let status = request_json(
        &state.http_client,
        &provisional,
        None,
        Method::GET,
        "/api/v1/status",
        None,
        MAX_STATUS_BYTES,
    )
    .await?;
    let instance_id = status
        .get("instanceId")
        .and_then(Value::as_str)
        .ok_or_else(|| "server status omitted instanceId".to_string())?;
    let api_compatible = status
        .get("apiVersions")
        .and_then(Value::as_array)
        .is_some_and(|versions| versions.iter().any(|version| version.as_i64() == Some(1)));
    let document_compatible =
        status.get("documentSchemaVersion").and_then(Value::as_i64) == Some(1);
    if !api_compatible || !document_compatible {
        return Err("upgrade_required".to_string());
    }
    let pinned = PinnedServer::parse(&origin, instance_id).map_err(|error| error.to_string())?;
    pinned
        .verify_instance(instance_id)
        .map_err(|error| error.to_string())?;
    request_json(
        &state.http_client,
        &pinned,
        Some(&device_token),
        Method::GET,
        &format!("/api/v1/outlines/{outline_id}/checkpoint"),
        None,
        MAX_CHECKPOINT_BYTES,
    )
    .await?;

    let credential_reference = format!("device_{}", uuid::Uuid::new_v4());
    state
        .credential_vault
        .store(&credential_reference, &device_token)
        .map_err(|error| error.to_string())?;
    let configuration = ServerConfiguration {
        origin: pinned.origin().as_str().trim_end_matches('/').to_string(),
        instance_id: instance_id.to_string(),
        credential_reference: credential_reference.clone(),
        outline_id,
    };
    if let Err(error) = state.event_store.set_server_configuration(&configuration) {
        let _ = state.credential_vault.remove(&credential_reference);
        return Err(error.to_string());
    }
    state
        .event_store
        .set_storage_mode(crate::persistence::StorageMode::Server)
        .map_err(|error| error.to_string())?;
    Ok(status)
}

#[tauri::command]
pub async fn server_test_connection(state: State<'_, NativeState>) -> Result<Value, String> {
    let (configuration, pinned, _token) = connection(&state)?;
    let status = request_json(
        &state.http_client,
        &pinned,
        None,
        Method::GET,
        "/api/v1/status",
        None,
        MAX_STATUS_BYTES,
    )
    .await?;
    let instance = status
        .get("instanceId")
        .and_then(Value::as_str)
        .ok_or_else(|| "server status omitted instanceId".to_string())?;
    pinned
        .verify_instance(instance)
        .map_err(|error| error.to_string())?;
    if instance != configuration.instance_id {
        return Err("server instance changed".to_string());
    }
    Ok(status)
}

#[tauri::command]
pub async fn server_checkpoint(state: State<'_, NativeState>) -> Result<Value, String> {
    let (configuration, pinned, token) = connection(&state)?;
    request_json(
        &state.http_client,
        &pinned,
        Some(&token),
        Method::GET,
        &format!("/api/v1/outlines/{}/checkpoint", configuration.outline_id),
        None,
        MAX_CHECKPOINT_BYTES,
    )
    .await
}

#[tauri::command]
pub async fn server_pull_events(
    state: State<'_, NativeState>,
    after_revision: i64,
    limit: i64,
) -> Result<Value, String> {
    let (configuration, pinned, token) = connection(&state)?;
    let response = request_json(
        &state.http_client,
        &pinned,
        Some(&token),
        Method::GET,
        &format!(
            "/api/v1/outlines/{}/events?afterRevision={}&limit={}",
            configuration.outline_id,
            after_revision.max(0),
            limit.clamp(1, 100),
        ),
        None,
        MAX_EVENT_RESPONSE_BYTES,
    )
    .await?;
    for asset_id in referenced_asset_ids(response.get("events").unwrap_or(&Value::Null)) {
        if state.asset_store.read_verified(&asset_id).is_err() {
            download_asset(&state, &pinned, &token, &asset_id).await?;
        }
    }
    Ok(response)
}

#[tauri::command]
pub async fn server_push_events(
    state: State<'_, NativeState>,
    base_revision: i64,
    events: Vec<Value>,
) -> Result<Value, String> {
    if events.is_empty() || events.len() > 100 {
        return Err("event batch must contain 1 to 100 events".to_string());
    }
    let (configuration, pinned, token) = connection(&state)?;
    for asset_id in referenced_asset_ids(&Value::Array(events.clone())) {
        upload_asset(&state, &pinned, &token, &asset_id).await?;
    }
    request_json(
        &state.http_client,
        &pinned,
        Some(&token),
        Method::POST,
        &format!("/api/v1/outlines/{}/events", configuration.outline_id),
        Some(json!({ "baseRevision": base_revision, "events": events })),
        MAX_EVENT_RESPONSE_BYTES,
    )
    .await
}

#[tauri::command]
pub async fn server_upload_asset(
    state: State<'_, NativeState>,
    asset_id: String,
) -> Result<Value, String> {
    let (_configuration, pinned, token) = connection(&state)?;
    upload_asset(&state, &pinned, &token, &asset_id).await
}

#[tauri::command]
pub async fn server_download_asset(
    state: State<'_, NativeState>,
    asset_id: String,
) -> Result<Value, String> {
    let (_configuration, pinned, token) = connection(&state)?;
    download_asset(&state, &pinned, &token, &asset_id).await
}

#[tauri::command]
pub fn server_disconnect(state: State<'_, NativeState>) -> Result<(), String> {
    if let Some(configuration) = state
        .event_store
        .server_configuration()
        .map_err(|error| error.to_string())?
    {
        state
            .credential_vault
            .remove(&configuration.credential_reference)
            .map_err(|error| error.to_string())?;
    }
    state
        .event_store
        .clear_server_configuration()
        .map_err(|error| error.to_string())?;
    state
        .event_store
        .set_storage_mode(crate::persistence::StorageMode::Local)
        .map_err(|error| error.to_string())
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerConnectionInfo {
    pub origin: String,
    pub instance_id: String,
    pub outline_id: String,
}

#[tauri::command]
pub fn server_connection_info(
    state: State<'_, NativeState>,
) -> Result<Option<ServerConnectionInfo>, String> {
    Ok(state
        .event_store
        .server_configuration()
        .map_err(|error| error.to_string())?
        .map(|configuration| ServerConnectionInfo {
            origin: configuration.origin,
            instance_id: configuration.instance_id,
            outline_id: configuration.outline_id,
        }))
}

fn connection(
    state: &State<'_, NativeState>,
) -> Result<(ServerConfiguration, PinnedServer, String), String> {
    let configuration = state
        .event_store
        .server_configuration()
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "server mode is not configured".to_string())?;
    let pinned = PinnedServer::parse(&configuration.origin, &configuration.instance_id)
        .map_err(|error| error.to_string())?;
    let token = state
        .credential_vault
        .load(&configuration.credential_reference)
        .map_err(|error| error.to_string())?;
    Ok((configuration, pinned, token))
}

async fn upload_asset(
    state: &State<'_, NativeState>,
    pinned: &PinnedServer,
    token: &str,
    asset_id: &str,
) -> Result<Value, String> {
    let metadata = state
        .asset_store
        .metadata_for(asset_id)
        .map_err(|error| error.to_string())?;
    let initiation = request_json(
        &state.http_client, pinned, Some(token), Method::POST, "/api/v1/assets/initiate",
        Some(json!({ "assetId": metadata.asset_id, "mediaType": metadata.media_type, "byteSize": metadata.byte_size })),
        MAX_STATUS_BYTES,
    ).await?;
    if initiation.get("status").and_then(Value::as_str) == Some("complete") {
        return Ok(initiation);
    }
    let bytes = state
        .asset_store
        .read_verified(asset_id)
        .map_err(|error| error.to_string())?;
    request_json(
        &state.http_client,
        pinned,
        Some(token),
        Method::POST,
        &format!("/api/v1/assets/{asset_id}/complete"),
        Some(json!({
            "mediaType": metadata.media_type,
            "byteSize": metadata.byte_size,
            "bytesBase64": base64::engine::general_purpose::STANDARD.encode(bytes),
        })),
        MAX_STATUS_BYTES,
    )
    .await
}

async fn download_asset(
    state: &State<'_, NativeState>,
    pinned: &PinnedServer,
    token: &str,
    asset_id: &str,
) -> Result<Value, String> {
    let response = request_json(
        &state.http_client,
        pinned,
        Some(token),
        Method::GET,
        &format!("/api/v1/assets/{asset_id}"),
        None,
        8 * 1024 * 1024,
    )
    .await?;
    let encoded = response
        .get("bytesBase64")
        .and_then(Value::as_str)
        .ok_or_else(|| "asset response omitted bytes".to_string())?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|_| "asset response contained invalid base64".to_string())?;
    let media_type = response
        .get("mediaType")
        .and_then(Value::as_str)
        .ok_or_else(|| "asset response omitted media type".to_string())?;
    let stored = state
        .asset_store
        .ingest(&bytes, Some(media_type))
        .map_err(|error| error.to_string())?;
    if stored.asset_id != asset_id {
        return Err("downloaded asset hash did not match its identifier".to_string());
    }
    Ok(
        json!({ "assetId": stored.asset_id, "mediaType": stored.media_type, "byteSize": stored.byte_size }),
    )
}

fn referenced_asset_ids(value: &Value) -> BTreeSet<String> {
    fn visit(value: &Value, result: &mut BTreeSet<String>) {
        match value {
            Value::Array(values) => values.iter().for_each(|value| visit(value, result)),
            Value::Object(values) => {
                for (key, value) in values {
                    if key == "assetId" {
                        if let Some(asset_id) = value.as_str() {
                            result.insert(asset_id.to_string());
                        }
                    } else {
                        visit(value, result);
                    }
                }
            }
            _ => {}
        }
    }
    let mut result = BTreeSet::new();
    visit(value, &mut result);
    result
}

async fn request_json(
    client: &reqwest::Client,
    server: &PinnedServer,
    bearer_token: Option<&str>,
    method: Method,
    path: &str,
    body: Option<Value>,
    max_response_bytes: usize,
) -> Result<Value, String> {
    let url = server.endpoint(path).map_err(|error| error.to_string())?;
    let mut request = client.request(method, url);
    if let Some(token) = bearer_token {
        request = request.bearer_auth(token);
    }
    if let Some(value) = body {
        request = request.json(&value);
    }
    let mut response = request
        .send()
        .await
        .map_err(|error| format!("server unavailable: {error}"))?;
    server
        .verify_response_url(response.url().as_str())
        .map_err(|error| error.to_string())?;
    if response.status() == StatusCode::UNAUTHORIZED {
        return Err("authentication_required".to_string());
    }
    if response.status() == StatusCode::UPGRADE_REQUIRED {
        return Err("upgrade_required".to_string());
    }
    let status = response.status();
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|error| error.to_string())? {
        if bytes.len() + chunk.len() > max_response_bytes {
            return Err("server response exceeded the allowed size".to_string());
        }
        bytes.extend_from_slice(&chunk);
    }
    let value: Value =
        serde_json::from_slice(&bytes).map_err(|_| "server returned invalid JSON".to_string())?;
    if !status.is_success() && status != StatusCode::CONFLICT {
        return Err(value
            .pointer("/error/code")
            .and_then(Value::as_str)
            .unwrap_or("server_error")
            .to_string());
    }
    Ok(value)
}
