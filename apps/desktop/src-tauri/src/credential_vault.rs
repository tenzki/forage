#[derive(Debug, thiserror::Error)]
pub enum CredentialError {
    #[error("credential storage failed")]
    Unavailable,
    #[error("stored credential is missing")]
    Missing,
}

#[derive(Clone)]
pub struct CredentialVault {
    service: &'static str,
}

impl Default for CredentialVault {
    fn default() -> Self {
        Self {
            service: "com.forage.app.server",
        }
    }
}

impl CredentialVault {
    pub fn store(&self, reference: &str, secret: &str) -> Result<(), CredentialError> {
        keyring::Entry::new(self.service, reference)
            .map_err(|_| CredentialError::Unavailable)?
            .set_password(secret)
            .map_err(|_| CredentialError::Unavailable)
    }

    pub fn load(&self, reference: &str) -> Result<String, CredentialError> {
        keyring::Entry::new(self.service, reference)
            .map_err(|_| CredentialError::Unavailable)?
            .get_password()
            .map_err(|error| match error {
                keyring::Error::NoEntry => CredentialError::Missing,
                _ => CredentialError::Unavailable,
            })
    }

    pub fn remove(&self, reference: &str) -> Result<(), CredentialError> {
        match keyring::Entry::new(self.service, reference)
            .map_err(|_| CredentialError::Unavailable)?
            .delete_credential()
        {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err(CredentialError::Unavailable),
        }
    }
}
