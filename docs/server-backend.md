# Optional Server Backend

Forage works in local mode without an account or network connection. Local mode stores immutable events, checkpoints, synchronization metadata, and asset-cache metadata in SQLite under the platform application-data directory. It is single-device; iCloud is not used.

Server mode synchronizes the same event stream with a self-hosted Node.js server. PostgreSQL is authoritative, while each desktop keeps a readable offline cache and durable pending outbox. The initial implementation supports one owner, multiple device credentials, scoped API tokens, one or more outlines in the schema, and polling rather than real-time presence. It does not support registration, sharing, teams, or concurrent collaborative cursors.

## Start a development server

After `npm install`, the normal development command starts PostgreSQL, applies the schema idempotently, and then runs the API and Tauri desktop app concurrently through Turborepo:

```bash
npm run dev
```

On a fresh development database, bootstrap the only owner once before connecting the desktop. This command also starts PostgreSQL and applies migrations. It prints the outline ID plus initial API and device tokens exactly once; store them immediately.

```bash
npm run server:bootstrap
```

Focused commands are available when the full stack is unnecessary:

```bash
npm run dev:desktop # Tauri only, using local SQLite storage
npm run dev:server  # PostgreSQL, migrations, and API only
npm run dev:down    # stop compose infrastructure
```

The development API listens at `http://127.0.0.1:3210`. Production invocations of `@forage/server` still require explicit `DATABASE_URL`, `FORAGE_INSTANCE_ID`, and `FORAGE_ASSET_DIR`; development defaults exist only in the root orchestration scripts.

Use Settings → Connection → Notes storage to supply the server origin, outline ID, and device token. HTTPS is required except for an HTTP loopback origin. The native client records the server instance identity, stores the token in OS credential storage, rejects redirects, and will not send it to another origin. Switching modes takes effect after restart.

## Token management

Create an API token and capture the displayed secret; only its SHA-256 hash is stored:

```bash
npm run tokens --workspace @forage/server -- create \
    --kind api --name apple-shortcuts --scope notes:create
```

Optional flags are `--outline OUTLINE_ID` and `--expires 2027-01-01T00:00:00Z`. Device tokens use `--kind device --scope sync`. List non-secret metadata or revoke a token with:

```bash
npm run tokens --workspace @forage/server -- list
npm run tokens --workspace @forage/server -- revoke TOKEN_ID
```

## Add a note from another application

`POST /api/v1/notes` accepts plain text only. `Idempotency-Key` is mandatory and scoped to the token. Repeating the same key and input returns the original note; reusing it with different input returns `409`.

```bash
curl --request POST https://notes.example.com/api/v1/notes \
  --header "Authorization: Bearer $FORAGE_NOTES_TOKEN" \
  --header "Idempotency-Key: capture-20260830-001" \
  --header "Content-Type: application/json" \
  --data '{"text":"Captured from another app","source":{"application":"Apple Shortcuts"}}'
```

With no `parentId`, the server resolves the current canonical Inbox role for every request. A supplied parent must be an existing non-deleted stable note ID. HTML, ProseMirror JSON, nested children, and asset data are rejected. A successful response is `201 Created` and contains `noteId`, `eventId`, authoritative `revision`, resolved `parentId`, origin, and timestamp. Optional source provenance remains in the immutable event.

The response remains synchronous and backward compatible when agent automation is enabled. A matching Inbox capture admits background runs in the same database transaction, but the request does not wait for enrichment. Provider failures never remove the original capture.

For the system share-sheet workflow, see [Capture to Inbox with Apple Shortcuts](apple-shortcuts-capture.md). It uses this endpoint and requires server mode; Forage does not bundle a native macOS share extension.

## Operations and limitations

- `/health/live` reports process liveness; `/health/ready` verifies PostgreSQL connectivity; `/api/v1/status` advertises protocol compatibility.
- Normal server writes lock the outline row, assign contiguous revisions, update projections atomically, and cannot update or delete accepted events.

## Server agent executor

Server mode executes both manual slash commands and eligible Inbox automation on the authoritative server. It never falls back to the desktop executor during an outage. PostgreSQL is the durable queue; no Redis service is required. Runs use bounded leases, `FOR UPDATE SKIP LOCKED` claims, append-only activity, limited retry attempts, durable cancellation, and exactly one result identity. Successful structured output is committed below the stable target as ordinary `agent`-origin outline events, so every device receives it through normal synchronization.

The desktop Settings view publishes a distinct skill for YouTube, X, and general webpage captures and lets the owner order those policies explicitly. An optional dispatcher policy must name a published dispatcher agent and a bounded set of allowed skill IDs. Its model call receives untrusted capture data, has no tools, and can only return a validated subset of that allowlist.

Apply migrations before enabling workers. Configure the executor with environment variables:

```text
FORAGE_AGENT_WORKER_ENABLED=true
FORAGE_AGENT_ENCRYPTION_KEY=1:<base64-encoded-32-byte-key>
FORAGE_AGENT_WORKER_CONCURRENCY=2
FORAGE_AGENT_POLL_MS=1000
FORAGE_AGENT_LEASE_SECONDS=60
FORAGE_AGENT_MAX_ATTEMPTS=3
FORAGE_AGENT_MAX_BACKOFF_SECONDS=300
```

`FORAGE_AGENT_ENCRYPTION_KEY` is an authenticated-encryption master key and must be supplied outside PostgreSQL. Back it up separately from the database: losing every configured key version makes enrolled credentials unrecoverable. To rotate, put the new key first in `FORAGE_AGENT_ENCRYPTION_KEY` and retain comma-separated old versions in `FORAGE_AGENT_PREVIOUS_ENCRYPTION_KEYS` until credentials have been re-enrolled or rewritten. Never reuse the key as an API token or commit it to source control.

For ChatGPT device authorization, also set `FORAGE_OAUTH_CLIENT_ID`; the authorization and token URLs have OpenAI defaults but can be overridden with `FORAGE_OAUTH_DEVICE_URL` and `FORAGE_OAUTH_TOKEN_URL`. The browser flow is explicit because desktop OAuth files and refresh tokens are never uploaded automatically. The server encrypts access and rotating refresh tokens, refreshes under a row lock, and marks revoked credentials `authentication_required`. An OpenAI API key can be enrolled instead. Enrollment responses, run snapshots, events, and logs expose only credential references and sanitized metadata.

Server image generation currently uses the enrolled OpenAI API key with `gpt-image-2`. Generated raster bytes are signature-checked, size-bounded, written to the configured content-addressed asset store, and exposed to the model only as an opaque SHA-256 asset reference. ChatGPT OAuth is not reused for the billed Images API; a skill that requires server image generation must use an OpenAI API-key credential.

YouTube transcription uses the replaceable Supadata adapter when both variables are configured:

```text
FORAGE_SUPADATA_API_URL=https://api.supadata.ai/v1
FORAGE_SUPADATA_API_KEY=<deployment-secret>
```

The adapter supports immediate and asynchronous transcripts, cancellation, deadlines, language metadata, and a 100,000-character limit. Forage does not scrape captions or download audio. Public webpage and X readers resolve and reject private, loopback, link-local, and special-use destinations; redirects are revalidated. All fetched material is labelled untrusted before it enters the model.

In Settings → Connection, enroll a server credential, publish the selected agents and skills, then publish link policies. Policies are disabled unless explicitly enabled. Manual server runs require `agents:execute`; run/configuration reads require `agents:read`; publishing and credential management require `agents:manage`. The initial device credential receives these scopes. A `notes:create` capture token cannot inspect runs, configuration, or credentials.

To recover from failure, first disable Inbox policies to stop new automatic admission, then stop workers gracefully. Queued work and sanitized history remain in PostgreSQL. Expired leases become claimable after restart; exhausted runs remain failed and can be retried deliberately from current configuration. Disconnecting a credential makes future resolution fail safely. Never delete run/result rows to retry work, because their identities protect against duplicate outline output.

Activity records are bounded operational history, not model transcripts: raw reasoning, fetched bodies, and provider errors are not retained. Operators should define a retention policy appropriate to their deployment while preserving `agent_run_results` and the small provenance attached to outline events.
- PNG, JPEG, and WebP assets are limited to 5 MiB and verified independently by signature, size, and SHA-256 hash. There is intentionally no asset garbage collector yet, so referenced content is retained conservatively.
- Conflict recovery preserves the local events involved and reports a conflict instead of silently choosing one document. The initial UI exposes synchronization state but does not yet provide a side-by-side merge editor.
- Production durability is not claimed. Backup and restore requirements are tracked in [backing-up-pq.md](backing-up-pq.md).
