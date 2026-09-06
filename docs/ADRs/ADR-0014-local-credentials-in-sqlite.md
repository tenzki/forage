# ADR-0014: Store Local Credentials in the SQLite Event Store

- **Status:** Accepted
- **Date:** 2026-09-06
- **Deciders:** Forage maintainers
- **Supersedes:** None
- **Superseded by:** None

## Context

The desktop app holds three local secrets: an OpenAI API key, a short-lived ChatGPT OAuth credential, and the device token that authenticates this device to an optional server. They were kept in the macOS Keychain through the `keyring` crate behind a `CredentialVault` abstraction.

That arrangement failed in two ways.

The crate was declared as `keyring = "3"` with no backend feature. keyring 3.x selects its platform backend by cargo feature and otherwise falls back to an in-memory `mock` keystore, so on macOS every `store` succeeded, nothing was written, and every `load` returned `NoEntry`. The app recorded credential metadata as `connected` while the secret did not exist, and agent runs failed with `stored credential is missing` no matter how often the user re-authenticated.

Enabling `apple-native` fixed correctness but exposed the second problem. Keychain items are bound to the accessing binary's code signature. Development builds are ad-hoc, linker-signed, and their signature changes on every rebuild, so macOS asks for the login-keychain password after each build. A per-rebuild password prompt is not an acceptable development loop, and the workaround — maintaining a stable signing identity for debug binaries — adds toolchain requirements unrelated to the product.

Server-mode agent provider credentials are a separate concern already solved: they live in PostgreSQL, encrypted by `apps/server/src/credentialCrypto.ts` under operator-supplied keys.

## Decision

We will **store local desktop secrets in the existing SQLite event store**, in a `local_credentials` table keyed by credential reference, and remove the `keyring` dependency and the `CredentialVault` module.

`EventStore::store_credential`, `load_credential`, and `remove_credential` replace the vault API. Call sites, credential references (`local-openai`, `local-openai-codex`, `device_<uuid>`), and the `local_credential_store` / `local_credential_load` / `local_credential_remove` commands are unchanged, as is the `stored credential is missing` error surfaced to the frontend.

Secrets are stored as plaintext columns. The database file, and its `-wal` and `-shm` companions, are restricted to owner read/write (`0600`) on Unix when opened.

Server mode is unaffected: PostgreSQL remains authoritative for server-side provider credentials, encrypted under server-managed keys. The device token remains local because it is this device's identity, not shared state.

## Consequences

### Positive

- Credential storage now works, deterministically, with no dependence on backend feature flags.
- No keychain authorization prompts in development or after a rebuild.
- One durability mechanism, one transactional store, one backup unit for local state.
- Local credentials clear with the outline database, so uninstall and reset leave nothing behind.
- Test coverage runs fully in-memory instead of touching a real user keychain.

### Negative

- Secrets are no longer encrypted at rest by the OS. Any process running as the user, and any backup or sync that captures application data, can read them. This is a real reduction in protection compared with a working Keychain integration.
- File permissions are the only access control, and they do not survive careless copying of the database file.
- A future hardened distribution will need a deliberate at-rest encryption story rather than inheriting one from the OS.

## Security Boundary

- Local secrets stay behind the Rust IPC boundary. `local_credential_*` commands accept only the two known local references; the device token is reachable only through server transport commands.
- Secrets are passed to the sidecar through the child-process environment, never through arguments, prompts, tool definitions, or activity events (ADR-0013 is unchanged).
- The event-store database is created with owner-only permissions.
- `plugin-store` continues to hold non-secret credential metadata only.

## Implementation Notes

- `apps/desktop/src-tauri/migrations/0003_local_credentials.sql` defines the table.
- `apps/desktop/src-tauri/src/persistence.rs` implements the three operations and `restrict_to_owner`.
- `apps/desktop/src-tauri/src/commands.rs` and `sync_commands.rs` call the store directly; `credential_vault.rs` is deleted.
- `apps/desktop/src-tauri/tests/local_credentials_tests.rs` covers store, replace, missing, idempotent removal, and reference isolation.

Existing keychain items are not migrated. Users re-enter an API key or reconnect their ChatGPT subscription once; a server-mode device enrollment must be redone.

## Validation

- `cargo test` covers the store operations against an in-memory database.
- Absent references return `StoreError::CredentialMissing`, preserving the `stored credential is missing` message the frontend already handles.
