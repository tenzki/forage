use forage_lib::persistence::{EventStore, StoreError};

#[test]
fn stores_loads_and_replaces_local_credentials() {
    let store = EventStore::open_in_memory().expect("open event store");
    store
        .store_credential("local-openai", "secret-value")
        .expect("store credential");

    assert_eq!(
        store.load_credential("local-openai").expect("load credential"),
        "secret-value"
    );

    store
        .store_credential("local-openai", "rotated-value")
        .expect("replace credential");
    assert_eq!(
        store.load_credential("local-openai").expect("load rotated"),
        "rotated-value"
    );
}

#[test]
fn reports_a_missing_credential_and_removes_idempotently() {
    let store = EventStore::open_in_memory().expect("open event store");
    assert!(matches!(
        store.load_credential("local-openai-codex"),
        Err(StoreError::CredentialMissing)
    ));

    store
        .store_credential("local-openai-codex", "token")
        .expect("store credential");
    store
        .remove_credential("local-openai-codex")
        .expect("remove credential");
    store
        .remove_credential("local-openai-codex")
        .expect("removing an absent credential succeeds");

    assert!(matches!(
        store.load_credential("local-openai-codex"),
        Err(StoreError::CredentialMissing)
    ));
}

#[test]
fn keeps_credentials_separated_by_reference() {
    let store = EventStore::open_in_memory().expect("open event store");
    store.store_credential("local-openai", "api-key").expect("store api key");
    store.store_credential("device_1", "device-token").expect("store device token");

    assert_eq!(store.load_credential("local-openai").unwrap(), "api-key");
    assert_eq!(store.load_credential("device_1").unwrap(), "device-token");
}
