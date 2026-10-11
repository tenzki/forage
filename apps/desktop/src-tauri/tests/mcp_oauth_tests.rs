use forage_lib::{
    mcp_oauth::{Lease, McpOAuthState},
    persistence::EventStore,
};
use serde_json::{json, Value};

fn credential() -> Value {
    json!({"resource":"https://example.com/mcp","issuer":"https://auth.example.com",
      "discovery":{"authorizationServerUrl":"https://auth.example.com"},"clientInformation":{"client_id":"forage"},
      "tokens":{"access_token":"private-access","refresh_token":"private-refresh","token_type":"Bearer"},"expiresAt":1000})
}
fn configuration() -> String {
    json!({"url":"https://example.com/mcp","headers":{},"authentication":{"method":"oauth"}})
        .to_string()
}
fn seed(broker: &McpOAuthState, store: &EventStore) {
    let lease = broker
        .begin(store, "fixture", "https://example.com/mcp", true)
        .unwrap();
    broker
        .commit(
            store,
            "fixture",
            &lease,
            credential(),
            Some(configuration()),
        )
        .unwrap();
}

#[test]
fn validates_scoped_identity_and_destination() {
    let broker = McpOAuthState::default();
    let store = EventStore::open_in_memory().unwrap();
    for id in ["", "../other", "foo/bar", "_hidden"] {
        assert!(broker
            .begin(&store, id, "https://example.com/mcp", true)
            .is_err());
    }
    for url in [
        "file:///etc/passwd",
        "https://user:pass@example.com",
        "http://example.com",
    ] {
        assert!(broker.begin(&store, "fixture", url, true).is_err());
    }
}

#[test]
fn browser_recovery_accepts_only_one_bound_active_authorization_link() {
    let broker = McpOAuthState::default();
    let store = EventStore::open_in_memory().unwrap();
    let lease = broker
        .begin(&store, "fixture", "https://example.com/mcp", true)
        .unwrap();
    assert!(broker
        .authorization_url("fixture", &lease, Some("file:///etc/passwd".into()))
        .is_err());
    assert!(broker
        .authorization_url(
            "fixture",
            &lease,
            Some("https://auth.example.com/authorize".into())
        )
        .is_err());
    let mut url = url::Url::parse("https://auth.example.com/authorize").unwrap();
    url.query_pairs_mut()
        .append_pair("state", &"s".repeat(43))
        .append_pair("code_challenge", &"c".repeat(43))
        .append_pair("code_challenge_method", "S256")
        .append_pair("redirect_uri", "http://127.0.0.1:34567/oauth/callback");
    let link = url.to_string();
    assert_eq!(
        broker
            .authorization_url("fixture", &lease, Some(link.clone()))
            .unwrap(),
        link
    );
    assert_eq!(
        broker.authorization_url("fixture", &lease, None).unwrap(),
        link
    );
    url.query_pairs_mut().append_pair("other", "changed");
    assert!(broker
        .authorization_url("fixture", &lease, Some(url.to_string()))
        .is_err());
    broker.release("fixture", &lease).unwrap();
    assert!(broker.authorization_url("fixture", &lease, None).is_err());
}

#[test]
fn a_configuration_storage_failure_rolls_back_the_entire_oauth_commit() {
    let path = std::env::temp_dir().join(format!("forage-oauth-{}.sqlite", uuid::Uuid::new_v4()));
    {
        let broker = McpOAuthState::default();
        let store = EventStore::open(&path).unwrap();
        let database = rusqlite::Connection::open(&path).unwrap();
        database.execute_batch("CREATE TRIGGER fail_mcp_config BEFORE INSERT ON local_credentials
            WHEN NEW.reference = 'forage-mcp/fixture/configuration' BEGIN SELECT RAISE(ABORT, 'fixture storage failure'); END;").unwrap();
        let lease = broker
            .begin(&store, "fixture", "https://example.com/mcp", true)
            .unwrap();
        assert!(broker
            .commit(
                &store,
                "fixture",
                &lease,
                credential(),
                Some(configuration())
            )
            .is_err());
        assert_eq!(broker.load(&store, "fixture", &lease).unwrap(), None);
        assert!(store
            .load_credential("forage-mcp/fixture/configuration")
            .is_err());
    }
    std::fs::remove_file(path).unwrap();
}
#[test]
fn commits_configuration_and_credentials_together_and_returns_only_with_a_lease() {
    let broker = McpOAuthState::default();
    let store = EventStore::open_in_memory().unwrap();
    seed(&broker, &store);
    let lease = broker
        .begin(&store, "fixture", "https://example.com/mcp", false)
        .unwrap();
    assert_eq!(
        broker.load(&store, "fixture", &lease).unwrap(),
        Some(credential())
    );
    assert_eq!(
        store
            .load_credential("forage-mcp/fixture/configuration")
            .unwrap(),
        configuration()
    );
    let wrong = Lease {
        lease_id: uuid::Uuid::new_v4().to_string(),
        ..lease.clone()
    };
    assert!(broker.load(&store, "fixture", &wrong).is_err());
    assert!(broker.load(&store, "other", &lease).is_err());
    assert!(broker
        .begin(&store, "fixture", "https://example.com/mcp", false)
        .is_err());
}
#[test]
fn cancellation_and_disconnect_reject_late_commit_without_resurrecting_secrets() {
    let broker = McpOAuthState::default();
    let store = EventStore::open_in_memory().unwrap();
    let lease = broker
        .begin(&store, "fixture", "https://example.com/mcp", true)
        .unwrap();
    broker.release("fixture", &lease).unwrap();
    assert!(broker
        .commit(
            &store,
            "fixture",
            &lease,
            credential(),
            Some(configuration())
        )
        .is_err());
    seed(&broker, &store);
    let lease = broker
        .begin(&store, "fixture", "https://example.com/mcp", false)
        .unwrap();
    broker.invalidate(&store, "fixture").unwrap();
    assert!(broker
        .commit(&store, "fixture", &lease, credential(), None)
        .is_err());
    assert!(store
        .load_credential("forage-mcp/fixture/configuration")
        .is_err());
    assert!(!store
        .load_credential("forage-mcp/fixture/oauth")
        .unwrap()
        .contains("private-"));
}
#[test]
fn isolates_resources_issuers_versions_and_preserves_unrelated_credentials() {
    let broker = McpOAuthState::default();
    let store = EventStore::open_in_memory().unwrap();
    seed(&broker, &store);
    store.store_credential("unrelated", "keep-me").unwrap();
    assert!(broker
        .begin(&store, "fixture", "https://other.example/mcp", false)
        .is_err());
    let lease = broker
        .begin(&store, "fixture", "https://example.com/mcp", false)
        .unwrap();
    let mut wrong = credential();
    wrong["issuer"] = json!("https://different.example.com");
    assert!(broker
        .commit(&store, "fixture", &lease, wrong, None)
        .is_err());
    let stale = Lease {
        version: lease.version + 1,
        ..lease.clone()
    };
    assert!(broker
        .commit(&store, "fixture", &stale, credential(), None)
        .is_err());
    broker.invalidate(&store, "fixture").unwrap();
    assert_eq!(store.load_credential("unrelated").unwrap(), "keep-me");
}
#[test]
fn ambiguous_refresh_is_not_automatically_repeated_even_after_restart() {
    let broker = McpOAuthState::default();
    let store = EventStore::open_in_memory().unwrap();
    seed(&broker, &store);
    let lease = broker
        .begin(&store, "fixture", "https://example.com/mcp", false)
        .unwrap();
    broker.refresh_start(&store, "fixture", &lease).unwrap();
    broker.release("fixture", &lease).unwrap();
    let restarted = McpOAuthState::default();
    assert!(restarted
        .begin(&store, "fixture", "https://example.com/mcp", false)
        .is_err());
    seed(&restarted, &store);
    assert!(restarted
        .begin(&store, "fixture", "https://example.com/mcp", false)
        .is_ok());
}
#[test]
fn durable_rotation_clears_pending_marker_before_a_new_lease_can_use_it() {
    let broker = McpOAuthState::default();
    let store = EventStore::open_in_memory().unwrap();
    seed(&broker, &store);
    let lease = broker
        .begin(&store, "fixture", "https://example.com/mcp", false)
        .unwrap();
    broker.refresh_start(&store, "fixture", &lease).unwrap();
    let mut next = credential();
    next["tokens"]["refresh_token"] = json!("rotated");
    broker
        .commit(&store, "fixture", &lease, next.clone(), None)
        .unwrap();
    let current = broker
        .begin(&store, "fixture", "https://example.com/mcp", false)
        .unwrap();
    assert_eq!(current.version, lease.version + 1);
    assert_eq!(
        broker.load(&store, "fixture", &current).unwrap(),
        Some(next)
    );
}
