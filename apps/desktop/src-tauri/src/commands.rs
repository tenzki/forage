use crate::assets::{AssetMetadata, AssetStore, MAX_ASSET_BYTES};
use crate::persistence::{
    CheckpointRecord, EventRecord, EventStore, StorageMode, StoredEvent, SyncState,
};
use base64::Engine;
use tauri::State;

pub struct NativeState {
    pub event_store: EventStore,
    pub asset_store: AssetStore,
    pub credential_vault: crate::credential_vault::CredentialVault,
    pub http_client: reqwest::Client,
}

fn command_error(error: impl std::fmt::Display) -> String {
    error.to_string()
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetContent {
    #[serde(flatten)]
    pub metadata: AssetMetadata,
    pub bytes: Vec<u8>,
}

#[tauri::command]
pub fn asset_ingest_data_url(
    state: State<'_, NativeState>,
    data_url: String,
) -> Result<AssetMetadata, String> {
    if data_url.len() > (MAX_ASSET_BYTES * 4 / 3) + 128 {
        return Err("generated image exceeds the allowed encoded size".to_string());
    }
    let (header, encoded) = data_url
        .split_once(',')
        .ok_or_else(|| "invalid generated image data URL".to_string())?;
    let media_type = header
        .strip_prefix("data:")
        .and_then(|value| value.strip_suffix(";base64"))
        .ok_or_else(|| "invalid generated image data URL".to_string())?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(command_error)?;
    state
        .asset_store
        .ingest(&bytes, Some(media_type))
        .map_err(command_error)
}

#[tauri::command]
pub fn asset_read(state: State<'_, NativeState>, asset_id: String) -> Result<AssetContent, String> {
    let metadata = state
        .asset_store
        .metadata_for(&asset_id)
        .map_err(command_error)?;
    let bytes = state
        .asset_store
        .read_verified(&asset_id)
        .map_err(command_error)?;
    Ok(AssetContent { metadata, bytes })
}

#[tauri::command]
pub fn event_store_append(
    state: State<'_, NativeState>,
    event: EventRecord,
) -> Result<i64, String> {
    state.event_store.append(&event).map_err(command_error)
}

#[tauri::command]
pub fn event_store_events_after(
    state: State<'_, NativeState>,
    outline_id: String,
    local_sequence: i64,
) -> Result<Vec<StoredEvent>, String> {
    state
        .event_store
        .events_after_sequence(&outline_id, local_sequence)
        .map_err(command_error)
}

#[tauri::command]
pub fn event_store_pending(
    state: State<'_, NativeState>,
    outline_id: String,
    limit: i64,
) -> Result<Vec<StoredEvent>, String> {
    state
        .event_store
        .pending_events(&outline_id, limit)
        .map_err(command_error)
}

#[tauri::command]
pub fn event_store_acknowledge(
    state: State<'_, NativeState>,
    outline_id: String,
    acknowledgements: Vec<(String, i64)>,
) -> Result<(), String> {
    let borrowed = acknowledgements
        .iter()
        .map(|(event_id, revision)| (event_id.as_str(), *revision))
        .collect::<Vec<_>>();
    state
        .event_store
        .acknowledge_batch(&outline_id, &borrowed)
        .map_err(command_error)
}

#[tauri::command]
pub fn event_store_supersede(
    state: State<'_, NativeState>,
    event_id: String,
    replacement_id: String,
) -> Result<(), String> {
    state
        .event_store
        .supersede(&event_id, &replacement_id)
        .map_err(command_error)
}

#[tauri::command]
pub fn event_store_commit_rebase(
    state: State<'_, NativeState>,
    outline_id: String,
    pulled_events: Vec<EventRecord>,
    replacements: Vec<(String, EventRecord)>,
    pulled_revision: i64,
    acknowledgements: Vec<(String, i64)>,
) -> Result<(), String> {
    let borrowed_acknowledgements = acknowledgements
        .iter()
        .map(|(event_id, revision)| (event_id.as_str(), *revision))
        .collect::<Vec<_>>();
    state
        .event_store
        .commit_rebase(
            &outline_id,
            &pulled_events,
            &replacements,
            pulled_revision,
            &borrowed_acknowledgements,
        )
        .map_err(command_error)
}

#[tauri::command]
pub fn event_store_save_checkpoint(
    state: State<'_, NativeState>,
    checkpoint: CheckpointRecord,
) -> Result<(), String> {
    state
        .event_store
        .save_checkpoint(&checkpoint)
        .map_err(command_error)
}

#[tauri::command]
pub fn event_store_latest_checkpoint(
    state: State<'_, NativeState>,
    outline_id: String,
    document_version: i64,
    schema_epoch: i64,
) -> Result<Option<CheckpointRecord>, String> {
    state
        .event_store
        .latest_compatible_checkpoint(&outline_id, document_version, schema_epoch)
        .map_err(command_error)
}

#[tauri::command]
pub fn event_store_sync_state(
    state: State<'_, NativeState>,
    outline_id: String,
) -> Result<SyncState, String> {
    state
        .event_store
        .sync_state(&outline_id)
        .map_err(command_error)
}

#[tauri::command]
pub fn event_store_record_pulled(
    state: State<'_, NativeState>,
    outline_id: String,
    revision: i64,
) -> Result<(), String> {
    state
        .event_store
        .record_pulled_revision(&outline_id, revision)
        .map_err(command_error)
}

#[tauri::command]
pub fn event_store_storage_mode(state: State<'_, NativeState>) -> Result<StorageMode, String> {
    state.event_store.storage_mode().map_err(command_error)
}

#[tauri::command]
pub fn event_store_set_storage_mode(
    state: State<'_, NativeState>,
    mode: StorageMode,
) -> Result<(), String> {
    state
        .event_store
        .set_storage_mode(mode)
        .map_err(command_error)
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalIdentity {
    pub outline_id: String,
    pub actor_id: String,
    pub device_id: String,
}

#[tauri::command]
pub fn event_store_identity(state: State<'_, NativeState>) -> Result<LocalIdentity, String> {
    Ok(LocalIdentity {
        outline_id: state
            .event_store
            .get_or_create_identity("outline_id", "outline")
            .map_err(command_error)?,
        actor_id: state
            .event_store
            .get_or_create_identity("actor_id", "owner")
            .map_err(command_error)?,
        device_id: state
            .event_store
            .get_or_create_identity("device_id", "device")
            .map_err(command_error)?,
    })
}
