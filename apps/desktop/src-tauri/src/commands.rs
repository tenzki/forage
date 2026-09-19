use crate::assets::{AssetMetadata, AssetStore, MAX_ASSET_BYTES};
use crate::persistence::{
    AgentActivityRecord, AgentRunHistoryRecord, AgentRunRecord, CheckpointRecord, EventRecord,
    EventStore, StorageMode, StoredEvent, SyncState,
};
use base64::Engine;
use tauri::State;

pub struct NativeState {
    pub event_store: EventStore,
    pub asset_store: AssetStore,
    pub http_client: reqwest::Client,
}

/// Label of the page-peek window, mirrored from `useLinkPeek.tsx`.
const PEEK_WINDOW_LABEL: &str = "link-peek";

const SERVER_AGENT_CONFIGURATION_MIRROR_KEY: &str = "server_agent_configuration_mirror";
const REMEMBERED_SERVER_RUNS_KEY: &str = "remembered_server_runs";
const SERVER_PROVISIONING_STATE_KEY: &str = "server_provisioning_state";
const REMEMBERED_SERVER_IDENTITY_KEY: &str = "remembered_server_identity";

fn json_configuration(
    state: State<'_, NativeState>,
    key: &str,
) -> Result<Option<serde_json::Value>, String> {
    state.event_store.app_configuration_value(key)
        .map_err(command_error)?
        .map(|value| serde_json::from_str(&value).map_err(command_error))
        .transpose()
}

fn set_json_configuration(
    state: State<'_, NativeState>,
    key: &str,
    value: serde_json::Value,
) -> Result<(), String> {
    state.event_store.set_app_configuration_value(
        key,
        &serde_json::to_string(&value).map_err(command_error)?,
    ).map_err(command_error)
}

#[tauri::command]
pub fn server_agent_configuration_mirror(state: State<'_, NativeState>) -> Result<Option<serde_json::Value>, String> {
    json_configuration(state, SERVER_AGENT_CONFIGURATION_MIRROR_KEY)
}

#[tauri::command]
pub fn server_agent_set_configuration_mirror(
    state: State<'_, NativeState>,
    mirror: serde_json::Value,
) -> Result<(), String> {
    set_json_configuration(state, SERVER_AGENT_CONFIGURATION_MIRROR_KEY, mirror)
}

#[tauri::command]
pub fn server_agent_remembered_runs(state: State<'_, NativeState>) -> Result<Option<serde_json::Value>, String> {
    json_configuration(state, REMEMBERED_SERVER_RUNS_KEY)
}

#[tauri::command]
pub fn server_agent_set_remembered_runs(
    state: State<'_, NativeState>,
    runs: serde_json::Value,
) -> Result<(), String> {
    set_json_configuration(state, REMEMBERED_SERVER_RUNS_KEY, runs)
}

#[tauri::command]
pub fn server_provisioning_state(state: State<'_, NativeState>) -> Result<Option<serde_json::Value>, String> {
    json_configuration(state, SERVER_PROVISIONING_STATE_KEY)
}

#[tauri::command]
pub fn server_set_provisioning_state(
    state: State<'_, NativeState>,
    progress: serde_json::Value,
) -> Result<(), String> {
    set_json_configuration(state, SERVER_PROVISIONING_STATE_KEY, progress)
}

#[tauri::command]
pub fn remembered_server_identity(state: State<'_, NativeState>) -> Result<Option<serde_json::Value>, String> {
    json_configuration(state, REMEMBERED_SERVER_IDENTITY_KEY)
}

#[tauri::command]
pub fn set_remembered_server_identity(
    state: State<'_, NativeState>,
    identity: serde_json::Value,
) -> Result<(), String> {
    set_json_configuration(state, REMEMBERED_SERVER_IDENTITY_KEY, identity)
}

fn command_error(error: impl std::fmt::Display) -> String {
    error.to_string()
}

fn validate_local_credential_reference(reference: &str) -> Result<(), String> {
    if matches!(reference, "local-openai" | "local-openai-codex") {
        return Ok(());
    }

    let Some(scoped) = reference.strip_prefix("forage-extension/") else {
        return Err("invalid local credential reference".to_string());
    };
    let Some((installation_id, setting_key)) = scoped.split_once('/') else {
        return Err("invalid local credential reference".to_string());
    };
    let installation_is_valid = !installation_id.is_empty()
        && installation_id.len() <= 128
        && installation_id
            .chars()
            .next()
            .is_some_and(|character| character.is_ascii_alphanumeric())
        && installation_id.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | ':' | '-')
        });
    let setting_is_valid = !setting_key.is_empty()
        && setting_key.len() <= 64
        && setting_key
            .chars()
            .next()
            .is_some_and(|character| character.is_ascii_lowercase())
        && setting_key
            .chars()
            .all(|character| {
                character.is_ascii_lowercase()
                    || character.is_ascii_digit()
                    || character == '_'
            });
    if installation_is_valid && setting_is_valid {
        Ok(())
    } else {
        Err("invalid local credential reference".to_string())
    }
}

#[cfg(test)]
mod local_credential_reference_tests {
    use super::validate_local_credential_reference;

    #[test]
    fn accepts_model_and_scoped_extension_references() {
        assert!(validate_local_credential_reference("local-openai").is_ok());
        assert!(validate_local_credential_reference("local-openai-codex").is_ok());
        assert!(validate_local_credential_reference(
            "forage-extension/installation-1/api_token"
        )
        .is_ok());
    }

    #[test]
    fn rejects_unscoped_or_malformed_extension_references() {
        for reference in [
            "extension-secret",
            "forage-extension//api_token",
            "forage-extension/installation-1/ApiToken",
            "forage-extension/installation-1/api/token",
            "forage-extension/../api_token",
        ] {
            assert!(
                validate_local_credential_reference(reference).is_err(),
                "accepted {reference}"
            );
        }
    }
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
pub fn event_store_events_before(
    state: State<'_, NativeState>,
    outline_id: String,
    local_sequence: i64,
    limit: i64,
) -> Result<Vec<StoredEvent>, String> {
    state
        .event_store
        .events_before_sequence(&outline_id, local_sequence, limit)
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
pub fn event_store_mark_seeded(
    state: State<'_, NativeState>,
    outline_id: String,
    checkpoint: CheckpointRecord,
) -> Result<(), String> {
    state
        .event_store
        .mark_seeded(&outline_id, &checkpoint)
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

#[tauri::command]
pub fn agent_run_admit(state: State<'_, NativeState>, run: AgentRunRecord) -> Result<(), String> {
    state
        .event_store
        .admit_agent_run(&run)
        .map_err(command_error)
}

#[tauri::command]
pub fn agent_run_get(
    state: State<'_, NativeState>,
    run_id: String,
) -> Result<Option<AgentRunRecord>, String> {
    state.event_store.agent_run(&run_id).map_err(command_error)
}

#[tauri::command]
pub fn agent_run_begin_attempt(
    state: State<'_, NativeState>,
    run_id: String,
    started_at: String,
) -> Result<i64, String> {
    state
        .event_store
        .begin_agent_attempt(&run_id, &started_at)
        .map_err(command_error)
}

#[tauri::command]
pub fn agent_run_append_activity(
    state: State<'_, NativeState>,
    run_id: String,
    event: serde_json::Value,
    created_at: String,
) -> Result<i64, String> {
    state
        .event_store
        .append_agent_activity(&run_id, &event, &created_at)
        .map_err(command_error)
}

#[tauri::command]
pub fn agent_run_activity_after(
    state: State<'_, NativeState>,
    run_id: String,
    after_sequence: i64,
    limit: i64,
) -> Result<Vec<AgentActivityRecord>, String> {
    state
        .event_store
        .agent_activity_after(&run_id, after_sequence, limit)
        .map_err(command_error)
}

#[tauri::command]
pub fn agent_run_recent(
    state: State<'_, NativeState>,
    outline_id: String,
    limit: i64,
) -> Result<Vec<AgentRunHistoryRecord>, String> {
    state
        .event_store
        .recent_agent_runs(&outline_id, limit)
        .map_err(command_error)
}

#[tauri::command]
pub fn agent_runs_clear(state: State<'_, NativeState>, outline_id: String) -> Result<usize, String> {
    state
        .event_store
        .clear_agent_runs(&outline_id)
        .map_err(command_error)
}

#[tauri::command]
pub fn agent_run_cancel(
    state: State<'_, NativeState>,
    run_id: String,
    cancelled_at: String,
) -> Result<(), String> {
    state
        .event_store
        .cancel_agent_run(&run_id, &cancelled_at)
        .map_err(command_error)
}

#[tauri::command]
pub fn agent_run_settle(
    state: State<'_, NativeState>,
    run_id: String,
    status: String,
    result_identity: Option<String>,
    result: Option<serde_json::Value>,
    error_code: Option<String>,
    settled_at: String,
) -> Result<(), String> {
    state
        .event_store
        .settle_agent_run(
            &run_id,
            &status,
            result_identity.as_deref(),
            result.as_ref(),
            error_code.as_deref(),
            &settled_at,
        )
        .map_err(command_error)
}

#[tauri::command]
pub fn agent_run_retry(
    state: State<'_, NativeState>,
    original_run_id: String,
    run: AgentRunRecord,
) -> Result<(), String> {
    state
        .event_store
        .retry_agent_run(&original_run_id, &run)
        .map_err(command_error)
}

#[tauri::command]
pub fn agent_run_interrupt_unfinished(
    state: State<'_, NativeState>,
    interrupted_at: String,
) -> Result<usize, String> {
    state
        .event_store
        .interrupt_unfinished_agent_runs(&interrupted_at)
        .map_err(command_error)
}

#[tauri::command]
pub fn local_credential_store(
    state: State<'_, NativeState>,
    reference: String,
    secret: String,
) -> Result<(), String> {
    validate_local_credential_reference(&reference)?;
    if secret.is_empty() || secret.len() > 100_000 {
        return Err("invalid local credential secret".to_string());
    }
    state
        .event_store
        .store_credential(&reference, &secret)
        .map_err(command_error)
}

#[tauri::command]
pub fn local_credential_load(
    state: State<'_, NativeState>,
    reference: String,
) -> Result<String, String> {
    validate_local_credential_reference(&reference)?;
    state
        .event_store
        .load_credential(&reference)
        .map_err(command_error)
}

#[tauri::command]
pub fn local_credential_remove(
    state: State<'_, NativeState>,
    reference: String,
) -> Result<(), String> {
    validate_local_credential_reference(&reference)?;
    state
        .event_store
        .remove_credential(&reference)
        .map_err(command_error)
}

/// The URL the page peek is currently showing.
///
/// The peeked window holds no capability of its own and is a remote page, so it
/// cannot report its own address; and the JS API exposes no accessor for another
/// webview's current URL. This reads it natively so the peek's header bar can
/// follow the page as the user navigates inside it.
#[tauri::command]
pub fn peek_page_url(app: tauri::AppHandle) -> Option<String> {
    use tauri::Manager;
    app.get_webview_window(PEEK_WINDOW_LABEL)
        .and_then(|peek| peek.url().ok())
        .map(|url| url.to_string())
}
