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
  --kind api --name raycast --scope notes:create
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
  --data '{"text":"Captured from another app","source":{"application":"Raycast"}}'
```

With no `parentId`, the server inserts under the configured API Inbox. A supplied parent must be an existing non-deleted stable note ID. HTML, ProseMirror JSON, nested children, and asset data are rejected. A successful response is `201 Created` and contains `noteId`, `eventId`, authoritative `revision`, resolved `parentId`, provenance, and timestamp.

## Operations and limitations

- `/health/live` reports process liveness; `/health/ready` verifies PostgreSQL connectivity; `/api/v1/status` advertises protocol compatibility.
- Normal server writes lock the outline row, assign contiguous revisions, update projections atomically, and cannot update or delete accepted events.
- PNG, JPEG, and WebP assets are limited to 5 MiB and verified independently by signature, size, and SHA-256 hash. There is intentionally no asset garbage collector yet, so referenced content is retained conservatively.
- Conflict recovery preserves the local events involved and reports a conflict instead of silently choosing one document. The initial UI exposes synchronization state but does not yet provide a side-by-side merge editor.
- Production durability is not claimed. Backup and restore requirements are tracked in [backing-up-pq.md](backing-up-pq.md).
