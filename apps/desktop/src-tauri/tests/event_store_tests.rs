use forage_lib::persistence::{
    AgentRunRecord, CheckpointRecord, EventRecord, EventStore, StorageMode,
};
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
fn commits_an_accepted_rebase_as_one_local_transaction() {
    let store = EventStore::open_in_memory().expect("open event store");
    store
        .append(&event("event-old", 0))
        .expect("append original");
    let mut pulled = event("event-remote", 0);
    pulled.status = "accepted".to_string();
    pulled.server_revision = Some(1);
    let replacement = event("event-new", 1);

    store
        .commit_rebase(
            "outline-1",
            &[pulled],
            &[("event-old".to_string(), replacement)],
            1,
            &[("event-new", 2)],
        )
        .expect("commit rebase");

    assert_eq!(
        store
            .event("event-old")
            .expect("old event")
            .unwrap()
            .superseded_by
            .as_deref(),
        Some("event-new")
    );
    assert!(store
        .pending_events("outline-1", 100)
        .expect("pending")
        .is_empty());
    let state = store.sync_state("outline-1").expect("sync state");
    assert_eq!(state.last_pulled_revision, 1);
    assert_eq!(state.last_acked_revision, 2);
}

#[test]
fn rolls_back_every_local_rebase_write_when_one_event_conflicts() {
    let store = EventStore::open_in_memory().expect("open event store");
    store
        .append(&event("event-old", 0))
        .expect("append original");
    let mut pulled = event("event-remote", 0);
    pulled.status = "accepted".to_string();
    pulled.server_revision = Some(1);
    let mut conflicting_replacement = event("event-old", 1);
    conflicting_replacement.envelope = json!({ "id": "event-old", "changed": true });

    assert!(store
        .commit_rebase(
            "outline-1",
            &[pulled],
            &[("event-old".to_string(), conflicting_replacement)],
            1,
            &[("event-old", 2)],
        )
        .is_err());

    assert!(store
        .event("event-remote")
        .expect("remote lookup")
        .is_none());
    assert_eq!(
        store
            .event("event-old")
            .expect("old event")
            .unwrap()
            .superseded_by,
        None
    );
    assert_eq!(
        store
            .sync_state("outline-1")
            .expect("sync state")
            .last_pulled_revision,
        0
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
fn upcasts_a_legacy_zero_sequence_reset_checkpoint_to_its_event_barrier() {
    let store = EventStore::open_in_memory().expect("open event store");
    let mut first = event("event-1", 0);
    first.created_at = "2026-08-30T12:00:00.000Z".to_string();
    let mut second = event("event-2", 0);
    second.created_at = "2026-08-30T12:01:00.000Z".to_string();
    let mut after_reset = event("event-3", 0);
    after_reset.created_at = "2026-08-30T12:03:00.000Z".to_string();
    after_reset.envelope = json!({
        "type": "document.steps_applied",
        "payload": {
            "beforeHash": EventStore::checkpoint_hash("{\"type\":\"doc\"}")
        }
    });
    store.append(&first).expect("append first");
    store.append(&second).expect("append second");
    store.append(&after_reset).expect("append after reset");

    let old = CheckpointRecord {
        id: "checkpoint-old".to_string(),
        outline_id: "outline-1".to_string(),
        document_version: 1,
        schema_epoch: 1,
        local_sequence: 2,
        server_revision: 0,
        state_json: "{\"doc\":\"old\"}".to_string(),
        integrity_hash: EventStore::checkpoint_hash("{\"doc\":\"old\"}"),
        created_at: "2026-08-30T12:01:30.000Z".to_string(),
    };
    let reset = CheckpointRecord {
        id: "checkpoint-reset".to_string(),
        local_sequence: 0,
        state_json: "{\"doc\":{\"type\":\"doc\"},\"trash\":[],\"shortcuts\":[],\"schemaEpoch\":1}"
            .to_string(),
        integrity_hash: EventStore::checkpoint_hash(
            "{\"doc\":{\"type\":\"doc\"},\"trash\":[],\"shortcuts\":[],\"schemaEpoch\":1}",
        ),
        created_at: "2026-08-30T12:02:00.000Z".to_string(),
        ..old.clone()
    };
    store.save_checkpoint(&old).expect("old checkpoint");
    store
        .save_checkpoint(&reset)
        .expect("legacy reset checkpoint");

    let selected = store
        .latest_compatible_checkpoint("outline-1", 1, 1)
        .expect("select checkpoint")
        .expect("checkpoint exists");

    assert_eq!(selected.id, "checkpoint-reset");
    assert_eq!(selected.local_sequence, 2);
    assert_eq!(
        store
            .events_after_sequence("outline-1", selected.local_sequence)
            .expect("events after reset")
            .iter()
            .map(|stored| stored.id.as_str())
            .collect::<Vec<_>>(),
        ["event-3"]
    );
}

#[test]
fn does_not_infer_a_legacy_reset_barrier_without_a_matching_next_document_event() {
    let store = EventStore::open_in_memory().expect("open event store");
    let mut before_reset = event("event-before", 0);
    before_reset.created_at = "2026-08-30T12:00:00.000Z".to_string();
    let mut ambiguous = event("event-ambiguous", 0);
    ambiguous.created_at = "2026-08-30T12:03:00.000Z".to_string();
    ambiguous.envelope = json!({ "type": "shortcut.created", "payload": {} });
    store.append(&before_reset).expect("append before reset");
    store.append(&ambiguous).expect("append ambiguous event");

    let old = CheckpointRecord {
        id: "checkpoint-old".to_string(),
        outline_id: "outline-1".to_string(),
        document_version: 1,
        schema_epoch: 1,
        local_sequence: 1,
        server_revision: 0,
        state_json: "{\"doc\":\"old\"}".to_string(),
        integrity_hash: EventStore::checkpoint_hash("{\"doc\":\"old\"}"),
        created_at: "2026-08-30T12:01:00.000Z".to_string(),
    };
    let reset_state =
        "{\"doc\":{\"type\":\"doc\"},\"trash\":[],\"shortcuts\":[],\"schemaEpoch\":1}";
    let reset = CheckpointRecord {
        id: "checkpoint-reset".to_string(),
        local_sequence: 0,
        state_json: reset_state.to_string(),
        integrity_hash: EventStore::checkpoint_hash(reset_state),
        created_at: "2026-08-30T12:02:00.000Z".to_string(),
        ..old.clone()
    };
    store.save_checkpoint(&old).expect("old checkpoint");
    store.save_checkpoint(&reset).expect("reset checkpoint");

    let selected = store
        .latest_compatible_checkpoint("outline-1", 1, 1)
        .expect("select checkpoint")
        .expect("checkpoint exists");

    assert_eq!(selected.id, "checkpoint-old");
    assert_eq!(selected.local_sequence, 1);
}

#[test]
fn does_not_fall_back_to_an_older_reset_when_the_newest_reset_is_ambiguous() {
    let store = EventStore::open_in_memory().expect("open event store");
    let mut before_reset = event("event-before", 0);
    before_reset.created_at = "2026-08-30T12:00:00.000Z".to_string();
    let mut after_first_reset = event("event-after-first-reset", 0);
    after_first_reset.created_at = "2026-08-30T12:03:00.000Z".to_string();
    after_first_reset.envelope = json!({
        "type": "document.steps_applied",
        "payload": {
            "beforeHash": EventStore::checkpoint_hash("{\"reset\":1,\"type\":\"doc\"}")
        }
    });
    store.append(&before_reset).expect("append before reset");
    store
        .append(&after_first_reset)
        .expect("append after first reset");

    let old = CheckpointRecord {
        id: "checkpoint-old".to_string(),
        outline_id: "outline-1".to_string(),
        document_version: 1,
        schema_epoch: 1,
        local_sequence: 1,
        server_revision: 0,
        state_json: "{\"doc\":\"old\"}".to_string(),
        integrity_hash: EventStore::checkpoint_hash("{\"doc\":\"old\"}"),
        created_at: "2026-08-30T12:01:00.000Z".to_string(),
    };
    let first_state =
        "{\"doc\":{\"type\":\"doc\",\"reset\":1},\"trash\":[],\"shortcuts\":[],\"schemaEpoch\":1}";
    let first_reset = CheckpointRecord {
        id: "checkpoint-reset-1".to_string(),
        local_sequence: 0,
        state_json: first_state.to_string(),
        integrity_hash: EventStore::checkpoint_hash(first_state),
        created_at: "2026-08-30T12:02:00.000Z".to_string(),
        ..old.clone()
    };
    let newest_state =
        "{\"doc\":{\"type\":\"doc\",\"reset\":2},\"trash\":[],\"shortcuts\":[],\"schemaEpoch\":1}";
    let newest_reset = CheckpointRecord {
        id: "checkpoint-reset-2".to_string(),
        state_json: newest_state.to_string(),
        integrity_hash: EventStore::checkpoint_hash(newest_state),
        created_at: "2026-08-30T12:04:00.000Z".to_string(),
        ..first_reset.clone()
    };
    store.save_checkpoint(&old).expect("old checkpoint");
    store.save_checkpoint(&first_reset).expect("first reset");
    store.save_checkpoint(&newest_reset).expect("newest reset");

    let selected = store
        .latest_compatible_checkpoint("outline-1", 1, 1)
        .expect("select checkpoint")
        .expect("checkpoint exists");

    assert_eq!(selected.id, "checkpoint-old");
    assert_eq!(selected.local_sequence, 1);
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

fn agent_run(id: &str, status: &str) -> AgentRunRecord {
    AgentRunRecord {
        id: id.to_string(),
        outline_id: "outline-1".to_string(),
        snapshot: json!({ "version": 1, "runId": id, "credentialRef": "local-openai" }),
        status: status.to_string(),
        attempt_count: 0,
        result_identity: None,
        result: None,
        retry_of_run_id: None,
        cancel_requested_at: None,
        error_code: None,
        created_at: "2026-08-31T10:00:00.000Z".to_string(),
        updated_at: "2026-08-31T10:00:00.000Z".to_string(),
    }
}

#[test]
fn persists_local_agent_runs_ordered_activity_and_one_terminal_result() {
    let store = EventStore::open_in_memory().expect("open event store");
    store
        .admit_agent_run(&agent_run("run-1", "queued"))
        .expect("admit run");
    store
        .begin_agent_attempt("run-1", "2026-08-31T10:00:01.000Z")
        .expect("begin attempt");
    let first = store
        .append_agent_activity(
            "run-1",
            &json!({ "kind": "status", "label": "Running" }),
            "2026-08-31T10:00:01.000Z",
        )
        .expect("first activity");
    let second = store
        .append_agent_activity(
            "run-1",
            &json!({ "kind": "output", "label": "Ready" }),
            "2026-08-31T10:00:02.000Z",
        )
        .expect("second activity");
    assert_eq!((first, second), (1, 2));

    store
        .settle_agent_run(
            "run-1",
            "completed",
            Some("result-run-1"),
            Some(&json!({ "version": 1, "nodes": [{ "type": "text", "text": "Done" }], "sources": [] })),
            None,
            "2026-08-31T10:00:03.000Z",
        )
        .expect("settle run");

    let loaded = store
        .agent_run("run-1")
        .expect("load run")
        .expect("run exists");
    assert_eq!(loaded.status, "completed");
    assert_eq!(loaded.attempt_count, 1);
    assert_eq!(loaded.result_identity.as_deref(), Some("result-run-1"));
    let activity = store
        .agent_activity_after("run-1", 0, 100)
        .expect("activity");
    assert_eq!(
        activity
            .iter()
            .map(|event| event.sequence)
            .collect::<Vec<_>>(),
        [1, 2]
    );

    let duplicate = store.settle_agent_run(
        "run-1",
        "completed",
        Some("different-result"),
        Some(&json!({ "version": 1, "nodes": [{ "type": "text", "text": "Duplicate" }], "sources": [] })),
        None,
        "2026-08-31T10:00:04.000Z",
    );
    assert!(duplicate.is_err());
}

#[test]
fn cancellation_retry_and_startup_interruption_preserve_history() {
    let store = EventStore::open_in_memory().expect("open event store");
    store
        .admit_agent_run(&agent_run("queued", "queued"))
        .expect("queued");
    store
        .admit_agent_run(&agent_run("running", "queued"))
        .expect("running");
    store
        .begin_agent_attempt("running", "2026-08-31T10:00:01.000Z")
        .expect("begin running");
    store
        .cancel_agent_run("queued", "2026-08-31T10:00:02.000Z")
        .expect("cancel queued");
    assert_eq!(
        store.agent_run("queued").unwrap().unwrap().status,
        "cancelled"
    );

    let interrupted = store
        .interrupt_unfinished_agent_runs("2026-08-31T10:00:03.000Z")
        .expect("interrupt unfinished");
    assert_eq!(interrupted, 1);
    assert_eq!(
        store.agent_run("running").unwrap().unwrap().status,
        "interrupted"
    );

    let mut retry = agent_run("retry", "queued");
    retry.retry_of_run_id = Some("running".to_string());
    store
        .retry_agent_run("running", &retry)
        .expect("retry terminal run");
    assert_eq!(
        store
            .agent_run("retry")
            .unwrap()
            .unwrap()
            .retry_of_run_id
            .as_deref(),
        Some("running")
    );
    assert_eq!(
        store.agent_run("running").unwrap().unwrap().status,
        "interrupted"
    );
}
