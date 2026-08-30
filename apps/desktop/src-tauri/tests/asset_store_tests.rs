use forage_lib::assets::{AssetError, AssetStore, MAX_ASSET_BYTES};

fn png_bytes() -> Vec<u8> {
    let mut bytes = vec![137, 80, 78, 71, 13, 10, 26, 10];
    bytes.extend_from_slice(b"bounded-test-image");
    bytes
}

fn temp_asset_dir(test_name: &str) -> std::path::PathBuf {
    std::env::temp_dir().join(format!(
        "forage-assets-{}-{}",
        test_name,
        std::process::id()
    ))
}

#[test]
fn validates_hashes_and_deduplicates_content_addressed_raster_bytes() {
    let root = temp_asset_dir("dedup");
    let store = AssetStore::new(&root).expect("asset store");
    let first = store
        .ingest(&png_bytes(), Some("image/png"))
        .expect("first ingest");
    let second = store
        .ingest(&png_bytes(), Some("image/png"))
        .expect("second ingest");

    assert_eq!(first.asset_id, second.asset_id);
    assert_eq!(first.media_type, "image/png");
    assert_eq!(
        store.read_verified(&first.asset_id).expect("read"),
        png_bytes()
    );
    std::fs::remove_dir_all(root).ok();
}

#[test]
fn rejects_svg_mismatched_signatures_and_oversized_content() {
    let root = temp_asset_dir("reject");
    let store = AssetStore::new(&root).expect("asset store");

    assert!(matches!(
        store.ingest(b"<svg></svg>", Some("image/svg+xml")),
        Err(AssetError::UnsupportedMedia)
    ));
    assert!(matches!(
        store.ingest(&png_bytes(), Some("image/jpeg")),
        Err(AssetError::MediaTypeMismatch { .. })
    ));
    assert!(matches!(
        store.ingest(&vec![0; MAX_ASSET_BYTES + 1], None),
        Err(AssetError::TooLarge)
    ));
    std::fs::remove_dir_all(root).ok();
}

#[test]
fn reports_missing_or_tampered_cached_content_as_recoverable_unavailability() {
    let root = temp_asset_dir("missing");
    let store = AssetStore::new(&root).expect("asset store");
    let metadata = store.ingest(&png_bytes(), None).expect("ingest");
    std::fs::write(
        store.path_for(&metadata.asset_id).expect("path"),
        b"tampered",
    )
    .expect("tamper");

    assert!(matches!(
        store.read_verified(&metadata.asset_id),
        Err(AssetError::HashMismatch)
    ));
    assert!(matches!(
        store.read_verified(&"0".repeat(64)),
        Err(AssetError::Unavailable)
    ));
    std::fs::remove_dir_all(root).ok();
}
