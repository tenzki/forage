use sha2::{Digest, Sha256};
use std::io::Write;
use std::path::{Path, PathBuf};

pub const MAX_ASSET_BYTES: usize = 5 * 1024 * 1024;

#[derive(Debug, thiserror::Error)]
pub enum AssetError {
    #[error("asset content is empty")]
    Empty,
    #[error("asset exceeds the five-megabyte limit")]
    TooLarge,
    #[error("only PNG, JPEG, and WebP assets are supported")]
    UnsupportedMedia,
    #[error("declared media type {declared} does not match detected {detected}")]
    MediaTypeMismatch { declared: String, detected: String },
    #[error("asset id must be a lowercase SHA-256 digest")]
    InvalidAssetId,
    #[error("asset bytes are unavailable locally")]
    Unavailable,
    #[error("cached asset content does not match its identifier")]
    HashMismatch,
    #[error("asset filesystem operation failed: {0}")]
    Io(#[from] std::io::Error),
}

pub type AssetResult<T> = Result<T, AssetError>;

#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetMetadata {
    pub asset_id: String,
    pub media_type: String,
    pub byte_size: usize,
}

pub struct AssetStore {
    root: PathBuf,
}

impl AssetStore {
    pub fn new(root: impl AsRef<Path>) -> AssetResult<Self> {
        std::fs::create_dir_all(root.as_ref())?;
        Ok(Self {
            root: root.as_ref().to_path_buf(),
        })
    }

    pub fn ingest(
        &self,
        bytes: &[u8],
        declared_media_type: Option<&str>,
    ) -> AssetResult<AssetMetadata> {
        if bytes.is_empty() {
            return Err(AssetError::Empty);
        }
        if bytes.len() > MAX_ASSET_BYTES {
            return Err(AssetError::TooLarge);
        }
        let detected = detect_media_type(bytes).ok_or(AssetError::UnsupportedMedia)?;
        if let Some(declared) = declared_media_type {
            if declared != detected {
                return Err(AssetError::MediaTypeMismatch {
                    declared: declared.to_string(),
                    detected: detected.to_string(),
                });
            }
        }
        let asset_id = hex_digest(bytes);
        let path = self.path_for(&asset_id)?;
        if !path.exists() {
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent)?;
            }
            let temporary = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
            let write_result = (|| -> std::io::Result<()> {
                let mut file = std::fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(&temporary)?;
                file.write_all(bytes)?;
                file.sync_all()?;
                std::fs::rename(&temporary, &path)?;
                Ok(())
            })();
            if write_result.is_err() {
                let _ = std::fs::remove_file(&temporary);
            }
            write_result?;
        }
        Ok(AssetMetadata {
            asset_id,
            media_type: detected.to_string(),
            byte_size: bytes.len(),
        })
    }

    pub fn path_for(&self, asset_id: &str) -> AssetResult<PathBuf> {
        if asset_id.len() != 64
            || !asset_id
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            return Err(AssetError::InvalidAssetId);
        }
        Ok(self
            .root
            .join(&asset_id[0..2])
            .join(&asset_id[2..4])
            .join(asset_id))
    }

    pub fn read_verified(&self, asset_id: &str) -> AssetResult<Vec<u8>> {
        let path = self.path_for(asset_id)?;
        let bytes = std::fs::read(path).map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                AssetError::Unavailable
            } else {
                AssetError::Io(error)
            }
        })?;
        if hex_digest(&bytes) != asset_id {
            return Err(AssetError::HashMismatch);
        }
        if detect_media_type(&bytes).is_none() {
            return Err(AssetError::UnsupportedMedia);
        }
        Ok(bytes)
    }

    pub fn metadata_for(&self, asset_id: &str) -> AssetResult<AssetMetadata> {
        let bytes = self.read_verified(asset_id)?;
        let media_type = detect_media_type(&bytes).ok_or(AssetError::UnsupportedMedia)?;
        Ok(AssetMetadata {
            asset_id: asset_id.to_string(),
            media_type: media_type.to_string(),
            byte_size: bytes.len(),
        })
    }
}

fn hex_digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn detect_media_type(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(&[137, 80, 78, 71, 13, 10, 26, 10]) {
        return Some("image/png");
    }
    if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        return Some("image/jpeg");
    }
    if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        return Some("image/webp");
    }
    None
}
