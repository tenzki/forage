use forage_lib::persistence::{CheckpointRecord, EventRecord, EventStore, StorageMode};
use serde_json::json;

fn event(id: &str, base_revision: i64) -> EventRecord {
    EventRecord {
        id: id.to_string(),
        outline_id: "outline-1".to_string(),
        base_revision,
        server_revision: None,
        envelope: json!({ "id": id, "baseRevision": base_revision }),
        status: "pending".to_string(),
        superseded_by: None,
        created_at: "2026-08-30T12:00:00.000Z".to_string(),
    }
}

#[test]
fn appends_reads_and_acknowledges_events_transactionally() {
    let store = EventStore::open_in_memory().expect("open event store");
    store.append(&event("event-1", 0)).expect("append first");
    store.append(&event("event-2", 0)).expect("append second");

    let pending = store
        .pending_events("outline-1", 100)
        .expect("pending events");
    assert_eq!(
        pending
            .iter()
            .map(|event| event.id.as_str())
            .collect::<Vec<_>>(),
        ["event-1", "event-2"]
    );

    store
        .acknowledge_batch("outline-1", &[("event-1", 1), ("event-2", 2)])
        .expect("acknowledge batch");
    assert!(store
        .pending_events("outline-1", 100)
        .expect("pending after ack")
        .is_empty());
    assert_eq!(
        store
            .sync_state("outline-1")
            .expect("sync state")
            .last_acked_revision,
        2
    );
}

#[test]
fn duplicate_append_and_interrupted_acknowledgement_are_idempotent() {
    let store = EventStore::open_in_memory().expect("open event store");
    store.append(&event("event-1", 0)).expect("append");
    store.append(&event("event-1", 0)).expect("retry append");
    store
        .acknowledge_batch("outline-1", &[("event-1", 1)])
        .expect("first ack");
    store
        .acknowledge_batch("outline-1", &[("event-1", 1)])
        .expect("retry ack");

    assert_eq!(
        store
            .events_after_sequence("outline-1", 0)
            .expect("events")
            .len(),
        1
    );
    assert_eq!(
        store
            .sync_state("outline-1")
            .expect("sync state")
            .last_acked_revision,
        1
    );
}

#[test]
fn keeps_superseded_pending_events_for_recovery_but_excludes_them_from_outbox() {
    let store = EventStore::open_in_memory().expect("open event store");
    store.append(&event("event-old", 0)).expect("append old");
    store.append(&event("event-new", 1)).expect("append new");
    store
        .supersede("event-old", "event-new")
        .expect("supersede");

    let pending = store.pending_events("outline-1", 100).expect("pending");
    assert_eq!(
        pending
            .iter()
            .map(|event| event.id.as_str())
            .collect::<Vec<_>>(),
        ["event-new"]
    );
    assert_eq!(
        store
            .event("event-old")
            .expect("read old")
            .unwrap()
            .superseded_by
            .as_deref(),
        Some("event-new")
    );
}

#[test]
fn skips_a_corrupted_newest_checkpoint_and_uses_the_latest_verified_compatible_one() {
    let store = EventStore::open_in_memory().expect("open event store");
    let valid = CheckpointRecord {
        id: "checkpoint-1".to_string(),
        outline_id: "outline-1".to_string(),
        document_version: 1,
        schema_epoch: 1,
        local_sequence: 1,
        server_revision: 1,
        state_json: "{\"doc\":1}".to_string(),
        integrity_hash: EventStore::checkpoint_hash("{\"doc\":1}"),
        created_at: "2026-08-30T12:00:00.000Z".to_string(),
    };
    let mut corrupt = valid.clone();
    corrupt.id = "checkpoint-2".to_string();
    corrupt.local_sequence = 2;
    corrupt.state_json = "{\"doc\":2}".to_string();
    store.save_checkpoint(&valid).expect("valid checkpoint");
    store.save_checkpoint(&corrupt).expect("corrupt checkpoint");

    let selected = store
        .latest_compatible_checkpoint("outline-1", 1, 1)
        .expect("select checkpoint")
        .expect("checkpoint exists");
    assert_eq!(selected.id, "checkpoint-1");
}

#[test]
fn persists_explicit_local_or_server_mode() {
    let store = EventStore::open_in_memory().expect("open event store");
    assert_eq!(
        store.storage_mode().expect("default mode"),
        StorageMode::Local
    );
    store
        .set_storage_mode(StorageMode::Server)
        .expect("set mode");
    assert_eq!(
        store.storage_mode().expect("server mode"),
        StorageMode::Server
    );
}

#[test]
fn creates_stable_local_identity_values_once() {
    let store = EventStore::open_in_memory().expect("open event store");
    let first = store
        .get_or_create_identity("device_id", "device")
        .expect("first identity");
    let second = store
        .get_or_create_identity("device_id", "device")
        .expect("second identity");
    assert_eq!(first, second);
    assert!(first.starts_with("device_"));
}
