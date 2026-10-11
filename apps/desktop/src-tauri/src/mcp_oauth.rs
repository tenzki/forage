use crate::{
    commands::NativeState,
    persistence::{EventStore, StoreError},
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::HashMap,
    sync::Mutex,
    time::{Duration, Instant},
};
use tauri_plugin_opener::OpenerExt;

#[derive(Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Lease {
    pub generation: u64,
    pub version: u64,
    pub lease_id: String,
}

#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Record {
    generation: u64,
    version: u64,
    credential: Option<Value>,
    #[serde(default)]
    refresh_pending: bool,
}

struct Job {
    lease: Lease,
    resource: String,
    expires: Instant,
    authorization_url: Option<String>,
}

#[derive(Default)]
pub struct McpOAuthState {
    jobs: Mutex<HashMap<String, Job>>,
}

fn reference(id: &str) -> Result<String, String> {
    if id.is_empty()
        || id.len() > 80
        || !id.as_bytes()[0].is_ascii_alphanumeric()
        || !id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte))
    {
        return Err("Invalid MCP connection identity.".into());
    }
    Ok(format!("forage-mcp/{id}/oauth"))
}

fn read(store: &EventStore, key: &str) -> Result<(Record, Option<String>), String> {
    match store.load_credential(key) {
        Ok(value) => Ok((
            serde_json::from_str(&value).map_err(|_| "Invalid OAuth credential record.")?,
            Some(value),
        )),
        Err(StoreError::CredentialMissing) => Ok((Record::default(), None)),
        Err(_) => Err("Could not read OAuth credentials.".into()),
    }
}

fn write(
    store: &EventStore,
    key: &str,
    previous: Option<&str>,
    record: &Record,
    configuration: Option<(&str, Option<&str>)>,
) -> Result<(), String> {
    let value = serde_json::to_string(record).map_err(|_| "Invalid OAuth credential record.")?;
    match store.compare_exchange_mcp_credentials(key, previous, &value, configuration) {
        Ok(true) => Ok(()),
        _ => Err("OAuth credentials changed. Retry explicitly.".into()),
    }
}

fn destination(value: &str, local: bool) -> Result<url::Url, String> {
    let url = url::Url::parse(value).map_err(|_| "Invalid OAuth URL.")?;
    let loopback = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
    if value.len() > 8000
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
        || !(url.scheme() == "https" || (local && loopback && url.scheme() == "http"))
    {
        return Err("OAuth URL is not allowed.".into());
    }
    Ok(url)
}

impl McpOAuthState {
    pub fn begin(
        &self,
        store: &EventStore,
        id: &str,
        resource: &str,
        interactive: bool,
    ) -> Result<Lease, String> {
        let key = reference(id)?;
        destination(resource, true)?;
        let mut jobs = self.jobs.lock().map_err(|_| "OAuth broker unavailable.")?;
        if jobs.get(id).is_some_and(|job| job.expires > Instant::now()) {
            return Err("OAuth operation is already pending.".into());
        }
        let (mut record, previous) = read(store, &key)?;
        if !interactive && record.refresh_pending {
            return Err("MCP: Authorization service is unavailable. Retry explicitly.".into());
        }
        if !interactive
            && record
                .credential
                .as_ref()
                .and_then(|value| value.get("resource"))
                .and_then(Value::as_str)
                != Some(resource)
        {
            return Err("MCP: Sign in again to use this server.".into());
        }
        record.generation += 1;
        write(store, &key, previous.as_deref(), &record, None)?;
        let lease = Lease {
            generation: record.generation,
            version: record.version,
            lease_id: uuid::Uuid::new_v4().to_string(),
        };
        jobs.insert(
            id.into(),
            Job {
                lease: lease.clone(),
                resource: resource.into(),
                expires: Instant::now() + Duration::from_secs(if interactive { 300 } else { 30 }),
                authorization_url: None,
            },
        );
        Ok(lease)
    }

    pub fn load(
        &self,
        store: &EventStore,
        id: &str,
        lease: &Lease,
    ) -> Result<Option<Value>, String> {
        let jobs = self.jobs.lock().map_err(|_| "OAuth broker unavailable.")?;
        let job = jobs
            .get(id)
            .filter(|job| job.lease == *lease && job.expires > Instant::now())
            .ok_or("OAuth operation is no longer active.")?;
        let (record, _) = read(store, &reference(id)?)?;
        if record.generation != lease.generation || record.version != lease.version {
            return Err("OAuth credentials changed.".into());
        }
        if record.credential.as_ref().is_some_and(|value| {
            value.get("resource").and_then(Value::as_str) != Some(&job.resource)
        }) {
            return Err("OAuth resource changed.".into());
        }
        Ok(record.credential)
    }

    pub fn commit(
        &self,
        store: &EventStore,
        id: &str,
        lease: &Lease,
        credential: Value,
        configuration: Option<String>,
    ) -> Result<(), String> {
        let mut jobs = self.jobs.lock().map_err(|_| "OAuth broker unavailable.")?;
        let job = jobs
            .get(id)
            .filter(|job| job.lease == *lease && job.expires > Instant::now())
            .ok_or("OAuth operation is no longer active.")?;
        let encoded =
            serde_json::to_string(&credential).map_err(|_| "Invalid OAuth credentials.")?;
        let tokens = credential
            .get("tokens")
            .ok_or("Invalid OAuth credentials.")?;
        let resource = credential
            .get("resource")
            .and_then(Value::as_str)
            .ok_or("Invalid OAuth credentials.")?;
        let issuer = credential
            .get("issuer")
            .and_then(Value::as_str)
            .ok_or("Invalid OAuth credentials.")?;
        let information = credential
            .get("clientInformation")
            .and_then(Value::as_object)
            .ok_or("Invalid OAuth credentials.")?;
        let discovery = credential
            .get("discovery")
            .and_then(Value::as_object)
            .ok_or("Invalid OAuth credentials.")?;
        let discovered_issuer = discovery
            .get("authorizationServerMetadata")
            .and_then(|value| value.get("issuer"))
            .and_then(Value::as_str)
            .or_else(|| {
                discovery
                    .get("authorizationServerUrl")
                    .and_then(Value::as_str)
            });
        let token = tokens
            .get("access_token")
            .and_then(Value::as_str)
            .ok_or("Invalid OAuth credentials.")?;
        if encoded.len() > 100_000
            || resource != job.resource
            || token.is_empty()
            || token.len() > 20_000
            || token.chars().any(char::is_whitespace)
            || information
                .get("client_id")
                .and_then(Value::as_str)
                .is_none_or(str::is_empty)
            || information
                .get("client_secret")
                .is_some_and(|value| !value.is_null())
            || information
                .get("issuer")
                .and_then(Value::as_str)
                .is_some_and(|value| value != issuer)
            || discovered_issuer != Some(issuer)
            || tokens
                .get("token_type")
                .and_then(Value::as_str)
                .is_none_or(|value| !value.eq_ignore_ascii_case("bearer"))
        {
            return Err("Invalid OAuth credentials.".into());
        }
        let local = matches!(
            url::Url::parse(resource)
                .ok()
                .and_then(|url| url.host_str().map(str::to_string))
                .as_deref(),
            Some("localhost" | "127.0.0.1" | "[::1]")
        );
        destination(issuer, local)?;
        if let Some(config) = &configuration {
            let value: Value =
                serde_json::from_str(config).map_err(|_| "Invalid MCP configuration.")?;
            if config.len() > 100_000
                || value.get("url").and_then(Value::as_str) != Some(resource)
                || value
                    .pointer("/authentication/method")
                    .and_then(Value::as_str)
                    != Some("oauth")
            {
                return Err("Invalid MCP configuration.".into());
            }
        }
        let key = reference(id)?;
        let (mut record, previous) = read(store, &key)?;
        if record.generation != lease.generation || record.version != lease.version {
            return Err("OAuth credentials changed.".into());
        }
        if configuration.is_none()
            && record
                .credential
                .as_ref()
                .is_none_or(|value| value.get("issuer").and_then(Value::as_str) != Some(issuer))
        {
            return Err("OAuth issuer changed.".into());
        }
        record.version += 1;
        record.credential = Some(credential);
        record.refresh_pending = false;
        let config_key = format!("forage-mcp/{id}/configuration");
        write(
            store,
            &key,
            previous.as_deref(),
            &record,
            configuration
                .as_deref()
                .map(|value| (config_key.as_str(), Some(value))),
        )?;
        jobs.remove(id);
        Ok(())
    }

    pub fn release(&self, id: &str, lease: &Lease) -> Result<(), String> {
        reference(id)?;
        let mut jobs = self.jobs.lock().map_err(|_| "OAuth broker unavailable.")?;
        if jobs.get(id).is_some_and(|job| job.lease == *lease) {
            jobs.remove(id);
        }
        Ok(())
    }

    pub fn refresh_start(&self, store: &EventStore, id: &str, lease: &Lease) -> Result<(), String> {
        let jobs = self.jobs.lock().map_err(|_| "OAuth broker unavailable.")?;
        jobs.get(id)
            .filter(|job| job.lease == *lease && job.expires > Instant::now())
            .ok_or("OAuth operation is no longer active.")?;
        let key = reference(id)?;
        let (mut record, previous) = read(store, &key)?;
        if record.generation != lease.generation
            || record.version != lease.version
            || record.refresh_pending
        {
            return Err("OAuth credentials changed.".into());
        }
        record.refresh_pending = true;
        write(store, &key, previous.as_deref(), &record, None)
    }

    pub fn invalidate(&self, store: &EventStore, id: &str) -> Result<Option<Value>, String> {
        let key = reference(id)?;
        let mut jobs = self.jobs.lock().map_err(|_| "OAuth broker unavailable.")?;
        jobs.remove(id);
        let (mut record, previous) = read(store, &key)?;
        record.generation += 1;
        record.version += 1;
        let removed = record.credential.take();
        record.refresh_pending = false;
        write(
            store,
            &key,
            previous.as_deref(),
            &record,
            Some((&format!("forage-mcp/{id}/configuration"), None)),
        )?;
        Ok(removed)
    }

    pub fn authorization_url(
        &self,
        id: &str,
        lease: &Lease,
        value: Option<String>,
    ) -> Result<String, String> {
        reference(id)?;
        let mut jobs = self.jobs.lock().map_err(|_| "OAuth broker unavailable.")?;
        let job = jobs
            .get_mut(id)
            .filter(|job| job.lease == *lease && job.expires > Instant::now())
            .ok_or("OAuth operation is no longer active.")?;
        if let Some(value) = value {
            let local = matches!(
                url::Url::parse(&job.resource)
                    .ok()
                    .and_then(|url| url.host_str().map(str::to_string))
                    .as_deref(),
                Some("localhost" | "127.0.0.1" | "[::1]")
            );
            let url = destination(&value, local)?;
            let parameters: HashMap<_, _> = url.query_pairs().collect();
            let redirect = parameters
                .get("redirect_uri")
                .and_then(|value| url::Url::parse(value).ok());
            if parameters
                .get("code_challenge_method")
                .is_none_or(|value| value != "S256")
                || parameters.get("state").is_none_or(|value| value.len() < 32)
                || parameters
                    .get("code_challenge")
                    .is_none_or(|value| value.len() < 43)
                || redirect.is_none_or(|value| {
                    value.scheme() != "http"
                        || value.host_str() != Some("127.0.0.1")
                        || value.port().is_none()
                        || value.path() != "/oauth/callback"
                        || value.query().is_some()
                        || value.fragment().is_some()
                })
            {
                return Err("Invalid OAuth authorization URL.".into());
            }
            if job
                .authorization_url
                .as_ref()
                .is_some_and(|before| before != &value)
            {
                return Err("OAuth authorization URL already registered.".into());
            }
            job.authorization_url = Some(value);
        }
        job.authorization_url
            .clone()
            .ok_or("OAuth authorization URL is not ready.".into())
    }
}

#[tauri::command]
pub fn mcp_oauth_begin(
    state: tauri::State<'_, NativeState>,
    broker: tauri::State<'_, McpOAuthState>,
    id: String,
    resource: String,
    interactive: bool,
) -> Result<Lease, String> {
    broker.begin(&state.event_store, &id, &resource, interactive)
}
#[tauri::command]
pub fn mcp_oauth_load(
    state: tauri::State<'_, NativeState>,
    broker: tauri::State<'_, McpOAuthState>,
    id: String,
    lease: Lease,
) -> Result<Option<Value>, String> {
    broker.load(&state.event_store, &id, &lease)
}
#[tauri::command]
pub fn mcp_oauth_commit(
    state: tauri::State<'_, NativeState>,
    broker: tauri::State<'_, McpOAuthState>,
    id: String,
    lease: Lease,
    credential: Value,
    configuration: Option<String>,
) -> Result<(), String> {
    broker.commit(&state.event_store, &id, &lease, credential, configuration)
}
#[tauri::command]
pub fn mcp_oauth_release(
    broker: tauri::State<'_, McpOAuthState>,
    id: String,
    lease: Lease,
) -> Result<(), String> {
    broker.release(&id, &lease)
}
#[tauri::command]
pub fn mcp_oauth_refresh_start(
    state: tauri::State<'_, NativeState>,
    broker: tauri::State<'_, McpOAuthState>,
    id: String,
    lease: Lease,
) -> Result<(), String> {
    broker.refresh_start(&state.event_store, &id, &lease)
}
#[tauri::command]
pub fn mcp_oauth_invalidate(
    state: tauri::State<'_, NativeState>,
    broker: tauri::State<'_, McpOAuthState>,
    id: String,
) -> Result<Option<Value>, String> {
    broker.invalidate(&state.event_store, &id)
}
#[tauri::command]
pub fn mcp_oauth_set_url(
    broker: tauri::State<'_, McpOAuthState>,
    id: String,
    lease: Lease,
    authorization_url: String,
) -> Result<(), String> {
    broker
        .authorization_url(&id, &lease, Some(authorization_url))
        .map(|_| ())
}
#[tauri::command]
pub fn mcp_oauth_open_browser(
    app: tauri::AppHandle,
    broker: tauri::State<'_, McpOAuthState>,
    id: String,
    lease: Lease,
) -> Result<(), String> {
    let url = broker.authorization_url(&id, &lease, None)?;
    app.opener()
        .open_url(url, None::<String>)
        .map_err(|_| "Could not open the system browser. Copy the sign-in link instead.".into())
}
