//! Pi session files that keep each local skill call's agent conversation.
//!
//! The sidecar writes `<agentDir>/agent-sessions/<callId>.jsonl`, where `agentDir`
//! is `PI_CODING_AGENT_DIR` (`<appData>/pi-agent`, set in `piSdkClient.ts`). The
//! files are a cache keyed by run rows in SQLite: a file is removed once no run
//! of its call remains.

use crate::persistence::EventStore;
use std::collections::HashSet;
use std::path::{Path, PathBuf};

/// Session directory under the application data directory.
pub fn directory(app_data: &Path) -> PathBuf {
    app_data.join("pi-agent").join("agent-sessions")
}

/// The call ID a session file belongs to, if the name is one the sidecar writes.
fn call_id(file_name: &str) -> Option<&str> {
    let call_id = file_name.strip_suffix(".jsonl")?;
    let valid = (1..=128).contains(&call_id.len())
        && call_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-');
    valid.then_some(call_id)
}

/// Delete session files whose call is not in `keep`. Only regular files named
/// like a session are touched; a missing directory has nothing to prune.
pub fn prune(directory: &Path, keep: &HashSet<String>) -> std::io::Result<usize> {
    let entries = match std::fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(error) => return Err(error),
    };
    let mut removed = 0;
    for entry in entries {
        let entry = entry?;
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        let Some(call_id) = call_id(&name) else {
            continue;
        };
        if keep.contains(call_id) || !entry.file_type()?.is_file() {
            continue;
        }
        match std::fs::remove_file(entry.path()) {
            Ok(()) => removed += 1,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
    }
    Ok(removed)
}

/// Delete session files of calls that have no remaining run.
pub fn prune_orphaned(store: &EventStore, directory: &Path) -> std::io::Result<usize> {
    let keep = store
        .agent_conversation_ids()
        .map_err(std::io::Error::other)?;
    prune(directory, &keep)
}
