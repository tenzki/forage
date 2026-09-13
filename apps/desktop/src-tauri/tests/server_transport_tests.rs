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

#[test]
fn passes_the_rebase_signal_through_and_reports_every_other_conflict() {
    use forage_lib::sync_commands::interpret_response;
    use serde_json::json;

    let rebase = json!({ "status": "rebase_required", "currentRevision": 7, "pullAfterRevision": 4 });
    assert_eq!(interpret_response(409, rebase.clone()), Ok(rebase));

    assert_eq!(
        interpret_response(
            409,
            json!({ "error": { "code": "conflict", "message": "This outline has not been seeded yet." } }),
        ),
        Err("conflict: This outline has not been seeded yet.".to_string()),
    );

    assert_eq!(
        interpret_response(403, json!({ "error": { "code": "authorization_denied" } })),
        Err("authorization_denied".to_string()),
    );
    assert_eq!(
        interpret_response(500, json!({})),
        Err("server_error".to_string()),
    );

    let accepted = json!({ "status": "accepted" });
    assert_eq!(interpret_response(200, accepted.clone()), Ok(accepted));
}
