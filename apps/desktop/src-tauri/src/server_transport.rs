use url::Url;

#[derive(Debug, thiserror::Error, PartialEq)]
pub enum TransportError {
    #[error("server URL must be a bare HTTP(S) origin")]
    InvalidOrigin,
    #[error("HTTPS is required except for loopback development")]
    InsecureOrigin,
    #[error("the response changed the configured server origin")]
    OriginChanged,
    #[error("the configured URL now identifies a different server instance")]
    InstanceChanged,
}

#[derive(Clone, Debug)]
pub struct PinnedServer {
    origin: Url,
    instance_id: String,
}

impl PinnedServer {
    pub fn parse(value: &str, instance_id: &str) -> Result<Self, TransportError> {
        let origin = Url::parse(value).map_err(|_| TransportError::InvalidOrigin)?;
        if !origin.username().is_empty()
            || origin.password().is_some()
            || origin.query().is_some()
            || origin.fragment().is_some()
            || !matches!(origin.path(), "" | "/")
            || origin.host_str().is_none()
        {
            return Err(TransportError::InvalidOrigin);
        }
        match origin.scheme() {
            "https" => {}
            "http" if is_loopback(&origin) => {}
            "http" => return Err(TransportError::InsecureOrigin),
            _ => return Err(TransportError::InvalidOrigin),
        }
        if instance_id.trim().is_empty() {
            return Err(TransportError::InvalidOrigin);
        }
        Ok(Self {
            origin,
            instance_id: instance_id.to_string(),
        })
    }

    pub fn endpoint(&self, path: &str) -> Result<Url, TransportError> {
        if !path.starts_with('/') || path.starts_with("//") {
            return Err(TransportError::InvalidOrigin);
        }
        let endpoint = self
            .origin
            .join(path)
            .map_err(|_| TransportError::InvalidOrigin)?;
        self.verify_url(&endpoint)?;
        Ok(endpoint)
    }

    pub fn verify_response_url(&self, value: &str) -> Result<(), TransportError> {
        let response = Url::parse(value).map_err(|_| TransportError::OriginChanged)?;
        self.verify_url(&response)
    }

    pub fn verify_instance(&self, actual: &str) -> Result<(), TransportError> {
        if actual == self.instance_id {
            Ok(())
        } else {
            Err(TransportError::InstanceChanged)
        }
    }

    pub fn origin(&self) -> &Url {
        &self.origin
    }

    fn verify_url(&self, other: &Url) -> Result<(), TransportError> {
        if self.origin.scheme() == other.scheme()
            && self.origin.host_str() == other.host_str()
            && self.origin.port_or_known_default() == other.port_or_known_default()
        {
            Ok(())
        } else {
            Err(TransportError::OriginChanged)
        }
    }
}

fn is_loopback(url: &Url) -> bool {
    match url.host_str() {
        Some("localhost") => true,
        Some(host) => host
            .parse::<std::net::IpAddr>()
            .is_ok_and(|address| address.is_loopback()),
        None => false,
    }
}
