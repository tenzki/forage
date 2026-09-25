use forage_lib::agent_sessions;
use forage_lib::persistence::{AgentRunRecord, EventStore};
use serde_json::json;
use std::path::{Path, PathBuf};
use uuid::Uuid;

fn turn(id: &str, outline_id: &str, call_id: &str, turn: u32) -> AgentRunRecord {
    AgentRunRecord {
        id: id.to_string(),
        outline_id: outline_id.to_string(),
        snapshot: json!({
            "version": 1,
            "runId": id,
            "thread": { "callId": call_id, "turn": turn },
        }),
        status: "queued".to_string(),
        attempt_count: 0,
        result_identity: None,
        result: None,
        retry_of_run_id: None,
        cancel_requested_at: None,
        error_code: None,
        created_at: "2026-09-25T10:00:00.000Z".to_string(),
        updated_at: "2026-09-25T10:00:00.000Z".to_string(),
    }
}

fn settle(store: &EventStore, run_id: &str, status: &str) {
    store
        .begin_agent_attempt(run_id, "2026-09-25T10:00:01.000Z")
        .expect("begin attempt");
    let result = json!({ "version": 1, "type": "answer", "text": "Done" });
    store
        .settle_agent_run(
            run_id,
            status,
            Some(&format!("result:{run_id}")),
            Some(&result),
            None,
            "2026-09-25T10:00:02.000Z",
        )
        .expect("settle run");
}

fn session_dir() -> PathBuf {
    let dir = agent_sessions::directory(
        &std::env::temp_dir().join(format!("forage-agent-sessions-{}", Uuid::new_v4())),
    );
    std::fs::create_dir_all(&dir).expect("create session dir");
    dir
}

fn write(dir: &Path, name: &str) {
    std::fs::write(dir.join(name), "{}\n").expect("write session file");
}

fn names(dir: &Path) -> Vec<String> {
    let mut names = std::fs::read_dir(dir)
        .expect("read session dir")
        .map(|entry| entry.unwrap().file_name().into_string().unwrap())
        .collect::<Vec<_>>();
    names.sort();
    names
}

#[test]
fn lists_call_ids_of_conversation_turns_only() {
    let store = EventStore::open_in_memory().expect("open event store");
    store.admit_agent_run(&turn("run-1", "outline-1", "call-a", 1)).unwrap();
    store.admit_agent_run(&turn("run-2", "outline-1", "call-a", 2)).unwrap();
    store.admit_agent_run(&turn("run-3", "outline-2", "call-b", 1)).unwrap();
    let mut legacy = turn("run-4", "outline-1", "unused", 1);
    legacy.snapshot = json!({ "version": 1, "runId": "run-4" });
    store.admit_agent_run(&legacy).unwrap();

    let mut ids = store
        .agent_conversation_ids()
        .expect("conversation ids")
        .into_iter()
        .collect::<Vec<_>>();
    ids.sort();
    assert_eq!(ids, ["call-a", "call-b"]);
}

#[test]
fn clearing_history_removes_session_files_of_cleared_calls_only() {
    let store = EventStore::open_in_memory().expect("open event store");
    store.admit_agent_run(&turn("run-1", "outline-1", "call-cleared", 1)).unwrap();
    settle(&store, "run-1", "completed");
    store.admit_agent_run(&turn("run-2", "outline-1", "call-unplaced", 1)).unwrap();
    settle(&store, "run-2", "completed_unplaced");
    store.admit_agent_run(&turn("run-3", "outline-2", "call-other", 1)).unwrap();

    let dir = session_dir();
    for name in [
        "call-cleared.jsonl",
        "call-unplaced.jsonl",
        "call-other.jsonl",
        "call-orphan.jsonl",
        "notes.txt",
        "bad.name.jsonl",
    ] {
        write(&dir, name);
    }
    std::fs::create_dir(dir.join("call-folder.jsonl")).unwrap();

    assert_eq!(store.clear_agent_runs("outline-1").unwrap(), 1);
    assert_eq!(agent_sessions::prune_orphaned(&store, &dir).unwrap(), 2);
    assert_eq!(
        names(&dir),
        [
            "bad.name.jsonl",
            "call-folder.jsonl",
            "call-other.jsonl",
            "call-unplaced.jsonl",
            "notes.txt",
        ]
    );

    store
        .place_agent_run_result("run-2", "2026-09-25T10:00:03.000Z")
        .unwrap();
    store.clear_agent_runs("outline-1").unwrap();
    assert_eq!(agent_sessions::prune_orphaned(&store, &dir).unwrap(), 1);
    assert!(!dir.join("call-unplaced.jsonl").exists());

    std::fs::remove_dir_all(dir.parent().unwrap().parent().unwrap()).unwrap();
}

#[test]
fn pruning_a_missing_session_directory_is_a_no_op() {
    let store = EventStore::open_in_memory().expect("open event store");
    let dir = std::env::temp_dir().join(format!("forage-missing-{}", Uuid::new_v4()));
    assert_eq!(agent_sessions::prune_orphaned(&store, &dir).unwrap(), 0);
}
