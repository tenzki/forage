use forage_lib::server_transport::{PinnedServer, TransportError};

#[test]
fn requires_https_except_for_loopback_development() {
    assert!(PinnedServer::parse("https://notes.example.com", "instance-1").is_ok());
    assert!(PinnedServer::parse("http://127.0.0.1:3210", "instance-1").is_ok());
    assert!(matches!(
        PinnedServer::parse("http://notes.example.com", "instance-1"),
        Err(TransportError::InsecureOrigin)
    ));
}

#[test]
fn pins_exact_origins_and_rejects_credentials_paths_and_origin_changes() {
    let pinned =
        PinnedServer::parse("https://notes.example.com:8443", "instance-1").expect("valid origin");
    assert!(pinned.endpoint("/api/v1/status").is_ok());
    assert!(pinned
        .verify_response_url("https://notes.example.com:8443/api/v1/status")
        .is_ok());
    assert!(matches!(
        pinned.verify_response_url("https://attacker.example/api/v1/status"),
        Err(TransportError::OriginChanged)
    ));
    assert!(
        PinnedServer::parse("https://user:secret@notes.example.com/path", "instance-1").is_err()
    );
}

#[test]
fn verifies_the_server_instance_after_initial_enrollment() {
    let pinned =
        PinnedServer::parse("https://notes.example.com", "instance-1").expect("valid origin");
    assert!(pinned.verify_instance("instance-1").is_ok());
    assert!(matches!(
        pinned.verify_instance("instance-2"),
        Err(TransportError::InstanceChanged)
    ));
}
