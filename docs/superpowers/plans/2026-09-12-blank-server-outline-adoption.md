# Blank Server Outline Adoption Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A freshly bootstrapped server holds no outline; the first desktop to enroll claims it and seeds it from that desktop's own local content.

**Architecture:** `bootstrapOwner` stops creating an outline. Claiming becomes two phases because the asset endpoints resolve their outline from the caller's credential: `POST /api/v1/outlines` creates a `seeding` outline and binds the credential, then `PUT /api/v1/outlines/:id/seed` accepts the desktop's replayed document state as the revision-0 checkpoint once its assets have uploaded. The desktop settles its local outbox in one transaction before flipping to server mode.

**Tech Stack:** TypeScript (Fastify, zod, node-postgres), PostgreSQL, Rust (Tauri v2, rusqlite, reqwest), React, Vitest, `cargo test`.

**Spec:** `docs/superpowers/specs/2026-09-12-blank-server-outline-adoption-design.md`

## Global Constraints

- There is no linter. `tsc` is the gate; `tsconfig.json` is strict with `noUnusedLocals` and `noUnusedParameters`.
- PostgreSQL contract tests run only when `TEST_DATABASE_URL` is set, and must point at `forage_contract_test`, never the development database `forage_test`. `postgres.test.ts` refuses to run when the two URLs match.
- Contract tests `TRUNCATE` every table before each test. Start PostgreSQL with `podman compose up -d postgres`; it listens on `127.0.0.1:55437`.
- Migrations are applied idempotently and are additive only. New file: `apps/server/migrations/0003_blank_bootstrap.sql`.
- Native commands only work in the real Tauri app (`npm run dev` / `npm run dev:desktop`), never in `npm run dev:web`.
- Scope names are exactly `notes:create`, `sync`, `agents:read`, `agents:execute`, `agents:manage`.
- `RepositoryError` codes are exactly `authentication_required`, `authorization_denied`, `upgrade_required`, `conflict`, `idempotency_conflict`. A not-seeded outline uses `conflict`.
- Outline state values are exactly `seeding` and `ready`.

---

### Task 1: Migration for a blank bootstrap

**Files:**
- Create: `apps/server/migrations/0003_blank_bootstrap.sql`
- Test: `apps/server/src/migrate.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `outlines.state` (`text NOT NULL DEFAULT 'ready'`, constrained to `'seeding' | 'ready'`), `outlines.api_inbox_id` nullable, `credentials.outline_id` nullable.

Existing rows must stay valid: an already-bootstrapped server keeps a `ready` outline with its inbox, which is why `state` defaults to `'ready'` rather than `'seeding'`.

- [ ] **Step 1: Write the failing test**

Add to `apps/server/src/migrate.test.ts`:

```ts
it('allows a claimed outline with no inbox and an unbound credential', async () => {
  await migrate(pool)
  await pool.query(`INSERT INTO owners(id, email) VALUES ('owner_1', 'a@b.invalid')`)
  await pool.query(
    `INSERT INTO outlines(id, owner_id, name, api_inbox_id, state) VALUES ('outline_1', 'owner_1', 'Notes', NULL, 'seeding')`,
  )
  await pool.query(
    `INSERT INTO credentials(id, owner_id, outline_id, kind, name, secret_hash, scopes)
     VALUES ('token_1', 'owner_1', NULL, 'device', 'desktop', 'hash', ARRAY['sync'])`,
  )
  const outline = await pool.query(`SELECT state, api_inbox_id FROM outlines WHERE id = 'outline_1'`)
  expect(outline.rows[0]).toEqual({ state: 'seeding', api_inbox_id: null })
})

it('rejects an unknown outline state', async () => {
  await migrate(pool)
  await pool.query(`INSERT INTO owners(id, email) VALUES ('owner_2', 'c@d.invalid')`)
  await expect(pool.query(
    `INSERT INTO outlines(id, owner_id, name, api_inbox_id, state) VALUES ('outline_2', 'owner_2', 'Notes', NULL, 'archived')`,
  )).rejects.toThrow()
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/server/src/migrate.test.ts`
Expected: FAIL — `column "state" of relation "outlines" does not exist`.

- [ ] **Step 3: Write the migration**

`apps/server/migrations/0003_blank_bootstrap.sql`:

```sql
ALTER TABLE outlines ADD COLUMN IF NOT EXISTS state text NOT NULL DEFAULT 'ready';

ALTER TABLE outlines DROP CONSTRAINT IF EXISTS outlines_state_check;
ALTER TABLE outlines ADD CONSTRAINT outlines_state_check CHECK (state IN ('seeding', 'ready'));

ALTER TABLE outlines ALTER COLUMN api_inbox_id DROP NOT NULL;

ALTER TABLE outlines DROP CONSTRAINT IF EXISTS outlines_ready_has_inbox;
ALTER TABLE outlines ADD CONSTRAINT outlines_ready_has_inbox
  CHECK (state <> 'ready' OR api_inbox_id IS NOT NULL);

ALTER TABLE credentials ALTER COLUMN outline_id DROP NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS outlines_one_per_owner ON outlines(owner_id);
```

`outlines_one_per_owner` is what makes claim-once a database invariant rather than a code convention.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run apps/server/src/migrate.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/migrations/0003_blank_bootstrap.sql apps/server/src/migrate.test.ts
git commit -m "feat(server): allow seeding outlines and unbound credentials"
```

---

### Task 2: Let a principal have no outline

**Files:**
- Modify: `apps/server/src/repository.ts:20-26` (`Principal`), `apps/server/src/postgres.ts:138-154` (`authenticate`)
- Modify: `apps/server/src/app.ts:344-369` (`authorize`, `authorizeOutline`)
- Test: `apps/server/src/app.test.ts`

**Interfaces:**
- Consumes: Task 1's nullable `credentials.outline_id`.
- Produces:
  - `Principal.outlineId: string | null`
  - `requireOutline(principal: Principal): string` — returns the bound outline id or throws `RepositoryError('conflict', ...)`.

Every existing caller of `principal.outlineId` that needs a real id routes through `requireOutline`, so `tsc` will list them for you.

- [ ] **Step 1: Write the failing test**

Add to `apps/server/src/app.test.ts`:

```ts
it('rejects a sync request from a credential bound to no outline', async () => {
  const { app, repository } = await buildTestServer()
  repository.authenticate = async () => ({
    tokenId: 'token_1', ownerId: 'owner_1', outlineId: null, kind: 'device', scopes: ['sync'],
  })
  const response = await app.inject({
    method: 'GET', url: '/api/v1/outlines/outline_1/checkpoint',
    headers: { authorization: 'Bearer secret' },
  })
  expect(response.statusCode).toBe(409)
  expect(response.json().error.code).toBe('conflict')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/server/src/app.test.ts -t "bound to no outline"`
Expected: FAIL — `tsc` rejects `outlineId: null`, or the route answers 200/500 rather than 409.

- [ ] **Step 3: Implement**

`apps/server/src/repository.ts`, in `Principal`:

```ts
export interface Principal {
  tokenId: string
  ownerId: string
  outlineId: string | null
  scopes: TokenScope[]
  kind: 'api' | 'device'
}
```

`apps/server/src/app.ts`, after `authorize`:

```ts
function requireOutline(principal: Principal): string {
  if (!principal.outlineId) {
    throw new RepositoryError('conflict', 'This credential is not bound to an outline yet.')
  }
  return principal.outlineId
}
```

and in `authorizeOutline`:

```ts
async function authorizeOutline(repository: ServerRepository, authorization: string | undefined, scope: TokenScope, params: unknown) {
  const principal = await authorize(repository, authorization, scope)
  if (routeOutlineId(params) !== requireOutline(principal)) {
    throw new RepositoryError('authorization_denied', 'The requested resource is unavailable.')
  }
  return principal
}
```

Import `Principal` alongside the existing `ServerRepository` / `TokenScope` type import. Then run `npm run typecheck --workspace @forage/server` and wrap each reported `principal.outlineId` use in `requireOutline(principal)`. In `postgres.ts` `authenticate`, `row.outline_id` is already nullable at the database level, so the returned object needs no change beyond the widened type.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run apps/server/src/app.test.ts` then `npm run typecheck --workspace @forage/server`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/repository.ts apps/server/src/postgres.ts apps/server/src/app.ts apps/server/src/app.test.ts
git commit -m "feat(server): allow a credential with no bound outline"
```

---

### Task 3: Bootstrap issues owner and tokens only

**Files:**
- Modify: `apps/server/src/postgres.ts:62-118` (`bootstrapOwner`)
- Modify: `apps/server/src/repository.ts` (`BootstrapResult`)
- Modify: `apps/server/src/bootstrap.ts:17-18` (printed output)
- Test: `apps/server/src/postgres.test.ts`

**Interfaces:**
- Consumes: Task 1's schema, Task 2's nullable `Principal.outlineId`.
- Produces: `BootstrapResult = { ownerId: string; apiToken: string; deviceToken: string }` — `outlineId` and `inboxId` are gone.

- [ ] **Step 1: Write the failing test**

Add to `apps/server/src/postgres.test.ts`:

```ts
it('bootstraps an owner with no outline and unbound tokens', async () => {
  const result = await repository.bootstrapOwner('owner@example.invalid')
  expect(result).toEqual({
    ownerId: expect.stringMatching(/^owner_/),
    apiToken: expect.stringMatching(/^fg_api_/),
    deviceToken: expect.stringMatching(/^fg_device_/),
  })
  const outlines = await pool.query('SELECT id FROM outlines')
  expect(outlines.rowCount).toBe(0)
  const principal = await repository.authenticate(result.deviceToken, 'sync')
  expect(principal.outlineId).toBeNull()
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/server/src/postgres.test.ts -t "no outline and unbound tokens"`
Expected: FAIL — one outline row exists and `outlineId` is a string.

- [ ] **Step 3: Implement**

Replace the body of `bootstrapOwner` (`postgres.ts:62-118`) with:

```ts
async bootstrapOwner(email: string): Promise<BootstrapResult> {
  return this.transaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock($1)', [0x464f5241])
    const existing = await client.query('SELECT id FROM owners LIMIT 1')
    if (existing.rowCount) throw new Error('The one-owner server is already bootstrapped.')

    const ownerId = `owner_${randomUUID()}`
    await client.query('INSERT INTO owners(id, email) VALUES ($1, $2)', [ownerId, email])
    const apiToken = await this.issueToken(client, ownerId, null, 'api', 'External note capture', ['notes:create'])
    const deviceToken = await this.issueToken(client, ownerId, null, 'device', 'Initial desktop', ['sync', 'agents:read', 'agents:execute', 'agents:manage'])
    return { ownerId, apiToken, deviceToken }
  })
}
```

Widen `issueToken`'s `outlineId` parameter to `string | null`. Update `BootstrapResult` in `repository.ts`:

```ts
export interface BootstrapResult {
  ownerId: string
  apiToken: string
  deviceToken: string
}
```

The unused imports `createInitialOutlineState`, `repairSystemNodes`, `canonicalJson`, and `sha256Hex` may now be unused in `postgres.ts` — `noUnusedLocals` will tell you; remove only the ones `tsc` flags, since Task 5 reintroduces some of them.

In `apps/server/src/bootstrap.ts`, replace the success message so it does not promise an outline id:

```ts
process.stdout.write('The tokens are displayed once. Store them before closing this terminal.\n')
process.stdout.write('This server holds no outline yet. Connect a desktop to seed it from that device.\n')
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run apps/server/src/postgres.test.ts`
Expected: PASS. Other tests in this file that expected `result.outlineId` now fail to compile — update them to claim an outline explicitly once Task 4 lands; for now, mark them with the claim helper you add in Task 4 and keep this task's commit limited to `bootstrapOwner`.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/postgres.ts apps/server/src/repository.ts apps/server/src/bootstrap.ts apps/server/src/postgres.test.ts
git commit -m "feat(server): bootstrap an owner without creating an outline"
```

---

### Task 4: Claim endpoint

**Files:**
- Modify: `packages/protocol/src/index.ts` (new schemas)
- Modify: `apps/server/src/repository.ts` (`ServerRepository`, `InMemoryServerRepository`)
- Modify: `apps/server/src/postgres.ts` (`claimOutline`)
- Modify: `apps/server/src/app.ts` (route)
- Test: `apps/server/src/postgres.test.ts`, `apps/server/src/app.test.ts`

**Interfaces:**
- Consumes: Tasks 1-3.
- Produces:
  - `claimOutlineRequestSchema` = `{ outlineId: string; name: string }`, `claimOutlineResponseSchema` = `{ outlineId: string; state: 'seeding' | 'ready' }`
  - `ServerRepository.claimOutline(principal: Principal, input: { outlineId: string; name: string }): Promise<{ outlineId: string; state: 'seeding' | 'ready' }>`
  - `POST /api/v1/outlines`

- [ ] **Step 1: Write the failing test**

Add to `apps/server/src/postgres.test.ts`:

```ts
async function bootstrapAndClaim(outlineId = 'outline_seed') {
  const bootstrap = await repository.bootstrapOwner('owner@example.invalid')
  const principal = await repository.authenticate(bootstrap.deviceToken, 'sync')
  const claim = await repository.claimOutline(principal, { outlineId, name: 'Notes' })
  return { bootstrap, principal, claim }
}

it('claims a blank server and binds the calling credential', async () => {
  const { bootstrap, claim } = await bootstrapAndClaim()
  expect(claim).toEqual({ outlineId: 'outline_seed', state: 'seeding' })
  const rebound = await repository.authenticate(bootstrap.deviceToken, 'sync')
  expect(rebound.outlineId).toBe('outline_seed')
})

it('is idempotent when the same credential re-claims the same outline', async () => {
  const { principal } = await bootstrapAndClaim()
  const again = await repository.claimOutline(principal, { outlineId: 'outline_seed', name: 'Notes' })
  expect(again).toEqual({ outlineId: 'outline_seed', state: 'seeding' })
})

it('rejects a claim from a second credential', async () => {
  const { bootstrap } = await bootstrapAndClaim()
  const other = await repository.authenticate(bootstrap.apiToken, 'notes:create')
  await expect(repository.claimOutline(other, { outlineId: 'outline_other', name: 'Notes' }))
    .rejects.toThrow(RepositoryError)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/server/src/postgres.test.ts -t "claims a blank server"`
Expected: FAIL — `repository.claimOutline is not a function`.

- [ ] **Step 3: Implement**

`packages/protocol/src/index.ts`:

```ts
export const claimOutlineRequestSchema = z.object({
  outlineId: boundedId,
  name: z.string().trim().min(1).max(200),
}).strict()

export const claimOutlineResponseSchema = z.object({
  outlineId: boundedId,
  state: z.enum(['seeding', 'ready']),
}).strict()
```

`apps/server/src/repository.ts`, in `ServerRepository`:

```ts
claimOutline(principal: Principal, input: { outlineId: string; name: string }): Promise<{ outlineId: string; state: 'seeding' | 'ready' }>
```

`apps/server/src/postgres.ts`:

```ts
async claimOutline(
  principal: Principal,
  input: { outlineId: string; name: string },
): Promise<{ outlineId: string; state: 'seeding' | 'ready' }> {
  return this.transaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock($1)', [0x464f5242])
    const existing = await client.query<{ id: string; state: 'seeding' | 'ready' }>(
      'SELECT id, state FROM outlines WHERE owner_id = $1', [principal.ownerId],
    )
    const current = existing.rows[0]
    if (current) {
      if (current.id !== input.outlineId || principal.outlineId !== current.id) {
        throw new RepositoryError('conflict', 'This server already holds an outline.')
      }
      return { outlineId: current.id, state: current.state }
    }
    await client.query(
      `INSERT INTO outlines(id, owner_id, name, api_inbox_id, state) VALUES ($1, $2, $3, NULL, 'seeding')`,
      [input.outlineId, principal.ownerId, input.name],
    )
    await client.query('UPDATE credentials SET outline_id = $2 WHERE id = $1', [principal.tokenId, input.outlineId])
    return { outlineId: input.outlineId, state: 'seeding' as const }
  })
}
```

Only the claiming credential is rebound. Other tokens stay unbound until Task 5 seeds the outline, which is deliberate: an API capture token must not reach a `seeding` outline.

Mirror the method on `InMemoryServerRepository` using its existing `ownerId` / `outlineId` fields, returning `'seeding'` and recording the state in a new private `outlineState: 'seeding' | 'ready' = 'seeding'` field.

`apps/server/src/app.ts`, beside the other outline routes:

```ts
app.post('/api/v1/outlines', async (request, reply) => {
  try {
    const principal = await authorize(repository, request.headers.authorization, 'sync')
    const input = claimOutlineRequestSchema.parse(request.body)
    const result = await repository.claimOutline(principal, input)
    return reply.code(201).send(claimOutlineResponseSchema.parse(result))
  } catch (error) { return sendError(reply, error) }
})
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run apps/server/src/postgres.test.ts apps/server/src/app.test.ts`
Expected: PASS. Update the Task 3 tests that referenced `bootstrap.outlineId` to call `bootstrapAndClaim()`.

- [ ] **Step 5: Commit**

```bash
git add packages/protocol/src/index.ts apps/server/src/repository.ts apps/server/src/postgres.ts apps/server/src/app.ts apps/server/src/postgres.test.ts apps/server/src/app.test.ts
git commit -m "feat(server): add the outline claim endpoint"
```

---

### Task 5: Seed endpoint

**Files:**
- Modify: `packages/protocol/src/index.ts`
- Modify: `apps/server/src/repository.ts`, `apps/server/src/postgres.ts`, `apps/server/src/app.ts`
- Test: `apps/server/src/postgres.test.ts`

**Interfaces:**
- Consumes: Task 4's `claimOutline`.
- Produces:
  - `seedOutlineRequestSchema` = `{ state: Record<string, unknown> }`
  - `seedOutlineResponseSchema` = `{ outlineId: string; revision: 0; integrityHash: string }`
  - `ServerRepository.seedOutline(principal: Principal, state: OutlineState): Promise<{ outlineId: string; revision: number; integrityHash: string }>`
  - `PUT /api/v1/outlines/:outlineId/seed`

- [ ] **Step 1: Write the failing test**

Add to `apps/server/src/postgres.test.ts`:

```ts
function seedState(nodes: { inboxId: string; dailyId: string; bulletId: string }) {
  const { doc } = repairSystemNodes({
    type: 'doc',
    content: [{
      type: 'bulletList',
      content: [{
        type: 'listItem',
        attrs: {
          nodeId: nodes.bulletId, nodeType: 'user', collapsed: false,
          bulletKind: 'bullet', completed: false, systemRole: null, dailyDate: null,
        },
        content: [{ type: 'paragraph' }],
      }],
    }],
  }, () => [nodes.inboxId, nodes.dailyId].shift()!)
  return createInitialOutlineState(doc)
}

it('seeds a claimed outline and derives the inbox from the document', async () => {
  const { principal } = await bootstrapAndClaim()
  const state = seedState({ inboxId: 'note_inbox', dailyId: 'note_daily', bulletId: 'note_bullet' })
  const result = await repository.seedOutline(principal, state)
  expect(result.revision).toBe(0)
  const outline = await pool.query(`SELECT state, api_inbox_id FROM outlines WHERE id = 'outline_seed'`)
  expect(outline.rows[0]).toEqual({ state: 'ready', api_inbox_id: 'note_inbox' })
  const checkpoint = await repository.checkpoint('outline_seed')
  expect(checkpoint.integrityHash).toBe(result.integrityHash)
})

it('is idempotent for an identical re-seed of a seeding outline', async () => {
  const { principal } = await bootstrapAndClaim()
  const state = seedState({ inboxId: 'note_inbox', dailyId: 'note_daily', bulletId: 'note_bullet' })
  const first = await repository.seedOutline(principal, state)
  const second = await repository.seedOutline(principal, state)
  expect(second).toEqual(first)
})

it('rejects a different seed once the outline is ready', async () => {
  const { principal } = await bootstrapAndClaim()
  await repository.seedOutline(principal, seedState({ inboxId: 'note_inbox', dailyId: 'note_daily', bulletId: 'note_a' }))
  await expect(repository.seedOutline(principal, seedState({ inboxId: 'note_inbox', dailyId: 'note_daily', bulletId: 'note_b' })))
    .rejects.toThrow(RepositoryError)
})

it('rejects a seed referencing an incomplete asset', async () => {
  const { principal } = await bootstrapAndClaim()
  const state = seedState({ inboxId: 'note_inbox', dailyId: 'note_daily', bulletId: 'note_bullet' })
  const assetId = 'a'.repeat(64)
  await repository.initiateAsset(principal, { assetId, mediaType: 'image/png', byteSize: 128 })
  const withAsset = JSON.parse(JSON.stringify(state))
  withAsset.doc.content[0].content.push({
    type: 'generatedImageItem', attrs: { nodeId: 'note_image', assetId, alt: 'x' },
  })
  await expect(repository.seedOutline(principal, withAsset)).rejects.toThrow(RepositoryError)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/server/src/postgres.test.ts -t "seeds a claimed outline"`
Expected: FAIL — `repository.seedOutline is not a function`.

- [ ] **Step 3: Implement**

`packages/protocol/src/index.ts`:

```ts
export const seedOutlineRequestSchema = z.object({
  state: z.record(z.string(), z.unknown()),
}).strict()

export const seedOutlineResponseSchema = z.object({
  outlineId: boundedId,
  revision,
  integrityHash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict()
```

`apps/server/src/repository.ts`, in `ServerRepository`:

```ts
seedOutline(principal: Principal, state: OutlineState): Promise<{ outlineId: string; revision: number; integrityHash: string }>
```

`apps/server/src/postgres.ts` — a module-level helper beside the others:

```ts
function referencedAssetIds(value: unknown, found: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) {
    for (const entry of value) referencedAssetIds(entry, found)
  } else if (value && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) {
      if (key === 'assetId' && typeof entry === 'string') found.add(entry)
      else referencedAssetIds(entry, found)
    }
  }
  return found
}
```

This mirrors the completion check the repository already performs at
`apps/server/src/postgres.ts:487`: the `assets` primary key is `asset_id`, and
completion is `completed_at IS NOT NULL` — `storage_key` is `NOT NULL` and
proves nothing.

and the method:

```ts
async seedOutline(
  principal: Principal,
  state: OutlineState,
): Promise<{ outlineId: string; revision: number; integrityHash: string }> {
  const outlineId = principal.outlineId
  if (!outlineId) throw new RepositoryError('conflict', 'This credential is not bound to an outline yet.')
  const integrityHash = await sha256Hex(canonicalJson(state))
  return this.transaction(async (client) => {
    const outline = await client.query<{ state: 'seeding' | 'ready' }>(
      'SELECT state FROM outlines WHERE id = $1 AND owner_id = $2 FOR UPDATE',
      [outlineId, principal.ownerId],
    )
    if (!outline.rows[0]) throw hiddenResourceError()
    if (outline.rows[0].state === 'ready') {
      const existing = await client.query<{ integrity_hash: string }>(
        'SELECT integrity_hash FROM outline_checkpoints WHERE outline_id = $1 AND revision = 0',
        [outlineId],
      )
      if (existing.rows[0]?.integrity_hash === integrityHash) {
        return { outlineId, revision: 0, integrityHash }
      }
      throw new RepositoryError('conflict', 'This outline has already been seeded.')
    }

    const referenced = [...referencedAssetIds(state)]
    if (referenced.length) {
      const complete = await client.query<{ asset_id: string }>(
        'SELECT asset_id FROM assets WHERE owner_id = $1 AND completed_at IS NOT NULL AND asset_id = ANY($2::text[])',
        [principal.ownerId, referenced],
      )
      const uploaded = new Set(complete.rows.map((row) => row.asset_id))
      const missing = referenced.filter((assetId) => !uploaded.has(assetId))
      if (missing.length) {
        throw new RepositoryError('conflict', `The seed references assets that are not uploaded: ${missing.join(', ')}`)
      }
    }

    const schema = createOutlineSchema(state.schemaEpoch)
    const inbox = findSystemNode(schema.nodeFromJSON(state.doc), 'inbox')
    if (!inbox) throw new RepositoryError('conflict', 'The seed document has no Inbox node.')

    await client.query(
      `INSERT INTO note_projections(outline_id, id, parent_id, text_content, created_at)
       SELECT $1, value->>'id', value->>'parentId', value->>'text', now()
       FROM jsonb_array_elements($2::jsonb) AS value`,
      [outlineId, JSON.stringify(noteProjectionsFromState(state))],
    )
    await client.query(
      'INSERT INTO outline_projections(outline_id, revision, state) VALUES ($1, 0, $2)',
      [outlineId, state],
    )
    await client.query(
      `INSERT INTO outline_checkpoints
       (id, outline_id, revision, document_version, schema_epoch, state, integrity_hash)
       VALUES ($1, $2, 0, $3, $4, $5, $6)`,
      [`checkpoint_${randomUUID()}`, outlineId, state.documentVersion, state.schemaEpoch, state, integrityHash],
    )
    await client.query(
      `UPDATE outlines SET state = 'ready', api_inbox_id = $2, document_version = $3, schema_epoch = $4 WHERE id = $1`,
      [outlineId, inbox.attrs.nodeId, state.documentVersion, state.schemaEpoch],
    )
    return { outlineId, revision: 0, integrityHash }
  })
}
```

`noteProjectionsFromState` is the existing projection-derivation the repository already performs when accepting events; reuse it rather than writing a second walker. If it is currently inlined, extract it to a module-level function with signature `noteProjectionsFromState(state: OutlineState): Array<{ id: string; parentId: string | null; text: string }>` and call it from both places.

`apps/server/src/app.ts`:

```ts
app.put('/api/v1/outlines/:outlineId/seed', async (request, reply) => {
  try {
    const principal = await authorizeOutline(repository, request.headers.authorization, 'sync', request.params)
    const input = seedOutlineRequestSchema.parse(request.body)
    const result = await repository.seedOutline(principal, outlineStateSchema.parse(input.state))
    return reply.code(200).send(seedOutlineResponseSchema.parse(result))
  } catch (error) { return sendError(reply, error) }
})
```

Use whichever `OutlineState` parser `@forage/domain` already exports for checkpoint states; the checkpoint route validates the same shape today.

Mirror `seedOutline` on `InMemoryServerRepository`, setting its `state`, `inboxId`, `revision = 0`, and `outlineState = 'ready'`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run apps/server/src/postgres.test.ts apps/server/src/app.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/protocol/src/index.ts apps/server/src/repository.ts apps/server/src/postgres.ts apps/server/src/app.ts apps/server/src/postgres.test.ts
git commit -m "feat(server): seed a claimed outline from a desktop document state"
```

---

### Task 6: Reject every other route while seeding

**Files:**
- Modify: `apps/server/src/app.ts` (sync, notes, and agent routes)
- Test: `apps/server/src/app.test.ts`

**Interfaces:**
- Consumes: Task 5's outline state.
- Produces: `requireReadyOutline(repository, principal): Promise<string>` — returns the outline id, throws `conflict` while `seeding`.

- [ ] **Step 1: Write the failing test**

Add to `apps/server/src/app.test.ts`:

```ts
it.each([
  ['GET', '/api/v1/outlines/outline_seed/checkpoint'],
  ['GET', '/api/v1/outlines/outline_seed/events?afterRevision=0'],
  ['GET', '/api/v1/outlines/outline_seed/agent-configuration'],
])('rejects %s %s while the outline is seeding', async (method, url) => {
  const { app, deviceToken } = await buildSeedingServer()
  const response = await app.inject({ method, url, headers: { authorization: `Bearer ${deviceToken}` } })
  expect(response.statusCode).toBe(409)
  expect(response.json().error.message).toMatch(/not been seeded/i)
})

it('rejects note capture while the outline is seeding', async () => {
  const { app, apiToken } = await buildSeedingServer()
  const response = await app.inject({
    method: 'POST', url: '/api/v1/notes',
    headers: { authorization: `Bearer ${apiToken}`, 'idempotency-key': 'k1' },
    payload: { text: 'hello' },
  })
  expect(response.statusCode).toBe(409)
})
```

`buildSeedingServer` bootstraps, claims, and returns the app plus both tokens without seeding.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/server/src/app.test.ts -t "while the outline is seeding"`
Expected: FAIL — routes answer 200 or 500 instead of 409.

- [ ] **Step 3: Implement**

Add to `apps/server/src/repository.ts` (`ServerRepository`):

```ts
outlineState(outlineId: string): Promise<'seeding' | 'ready'>
```

`postgres.ts`:

```ts
async outlineState(outlineId: string): Promise<'seeding' | 'ready'> {
  const result = await this.pool.query<{ state: 'seeding' | 'ready' }>(
    'SELECT state FROM outlines WHERE id = $1', [outlineId],
  )
  if (!result.rows[0]) throw hiddenResourceError()
  return result.rows[0].state
}
```

`app.ts`:

```ts
async function requireReadyOutline(repository: ServerRepository, principal: Principal): Promise<string> {
  const outlineId = requireOutline(principal)
  if (await repository.outlineState(outlineId) !== 'ready') {
    throw new RepositoryError('conflict', 'This outline has not been seeded yet.')
  }
  return outlineId
}
```

Call it in every route that reads or writes outline content — the sync routes (`app.ts:244`, `:253`, `:266`), `POST /api/v1/notes` (`:81`), and every `agent-*` route — but **not** in `POST /api/v1/outlines`, `PUT .../seed`, or the asset routes, which must work while `seeding`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run apps/server/src/app.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/app.ts apps/server/src/repository.ts apps/server/src/postgres.ts apps/server/src/app.test.ts
git commit -m "feat(server): reject outline traffic until the outline is seeded"
```

---

### Task 7: Native enrol without an outline id

**Files:**
- Modify: `apps/desktop/src-tauri/src/sync_commands.rs:16-89` (`server_enroll`)
- Test: `apps/desktop/src-tauri/src/sync_commands.rs` (test module) or the existing native test file for this module

**Interfaces:**
- Consumes: Task 4's `POST /api/v1/outlines`.
- Produces: `server_enroll(origin: String, device_token: String) -> Result<Value, String>` — no `outline_id` parameter.

- [ ] **Step 1: Write the failing test**

Add a test against a mock HTTP server asserting that enrolling posts to `/api/v1/outlines` with the local outline identity and stores a `ServerConfiguration` whose `outline_id` matches that identity, and that storage mode stays `Local`:

```rust
#[tokio::test]
async fn enroll_claims_the_local_outline_and_stays_local() {
    let server = mock_status_and_claim_server().await;
    let state = native_state_with_local_outline("outline_local");
    server_enroll(state.handle(), server.origin(), "fg_device_x".into())
        .await
        .expect("enrol succeeds");
    let configuration = state.event_store.server_configuration().unwrap().unwrap();
    assert_eq!(configuration.outline_id, "outline_local");
    assert_eq!(state.event_store.storage_mode().unwrap(), StorageMode::Local);
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/desktop/src-tauri && cargo test enroll_claims_the_local_outline`
Expected: FAIL — the function still takes three arguments and sets `StorageMode::Server`.

- [ ] **Step 3: Implement**

In `server_enroll`: drop the `outline_id` parameter and its validation block (`sync_commands.rs:22-28`); keep the device token validation. After `pinned.verify_instance(...)`, replace the `GET .../checkpoint` probe (`:61-68`) with a claim, and remove the `set_storage_mode` call at `:85-88`:

```rust
let outline_id = state
    .event_store
    .get_or_create_identity("outline_id", "outline")
    .map_err(|error| error.to_string())?;
let credential_reference = format!("device_{}", uuid::Uuid::new_v4());
state
    .event_store
    .store_credential(&credential_reference, &device_token)
    .map_err(|error| error.to_string())?;
let configuration = ServerConfiguration {
    origin: pinned.origin().as_str().trim_end_matches('/').to_string(),
    instance_id: instance_id.to_string(),
    credential_reference: credential_reference.clone(),
    outline_id: outline_id.clone(),
};
if let Err(error) = state.event_store.set_server_configuration(&configuration) {
    let _ = state.event_store.remove_credential(&credential_reference);
    return Err(error.to_string());
}
request_json(
    &state.http_client,
    &pinned,
    Some(&device_token),
    Method::POST,
    "/api/v1/outlines",
    Some(json!({ "outlineId": outline_id, "name": "Notes" })),
    MAX_STATUS_BYTES,
)
.await?;
Ok(status)
```

The configuration is stored before the claim so a claim failure still leaves a retryable, inspectable connection; storage mode stays `Local` until Task 9.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/desktop/src-tauri && cargo test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src-tauri/src/sync_commands.rs
git commit -m "feat(desktop): claim the local outline when enrolling a server"
```

---

### Task 8: Native seed command

**Files:**
- Modify: `apps/desktop/src-tauri/src/sync_commands.rs`, `apps/desktop/src-tauri/src/lib.rs:66` (command registration)
- Test: `apps/desktop/src-tauri/src/sync_commands.rs` test module

**Interfaces:**
- Consumes: Task 5's `PUT .../seed`, Task 7's stored configuration, the existing `referenced_asset_ids` (`sync_commands.rs:662`) and `upload_asset` (`:575`).
- Produces: `server_seed_outline(state: Value) -> Result<Value, String>` returning `{ outlineId, revision, integrityHash }`.

Asset upload lives in Rust, matching `server_push_events` (`sync_commands.rs:176`), which already walks its payload for `assetId`s and uploads each before the request. A consequence: the webview cannot observe per-asset progress, so the wizard reports the asset **count** up front rather than an incremental `n of m`. Emitting Tauri progress events from the upload loop would restore incremental progress and is deliberately left out of this plan.

- [ ] **Step 1: Write the failing test**

```rust
#[tokio::test]
async fn seed_uploads_referenced_assets_before_sending_the_state() {
    let server = mock_seed_server().await;
    let state = native_state_with_local_outline("outline_local");
    state.asset_store.ingest(PNG_BYTES, Some("image/png")).unwrap();
    let document = json!({
        "doc": { "content": [{ "type": "generatedImageItem", "attrs": { "assetId": PNG_ASSET_ID } }] },
        "documentVersion": 1, "schemaEpoch": 1,
    });
    server_seed_outline(state.handle(), document).await.expect("seed succeeds");
    assert_eq!(server.recorded_paths(), vec![
        "/api/v1/assets/initiate",
        &format!("/api/v1/assets/{PNG_ASSET_ID}/complete"),
        "/api/v1/outlines/outline_local/seed",
    ]);
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/desktop/src-tauri && cargo test seed_uploads_referenced_assets`
Expected: FAIL — `server_seed_outline` is not defined.

- [ ] **Step 3: Implement**

```rust
#[tauri::command]
pub async fn server_seed_outline(
    state: State<'_, NativeState>,
    document_state: Value,
) -> Result<Value, String> {
    let (configuration, pinned, token) = connection(&state)?;
    for asset_id in referenced_asset_ids(&document_state) {
        upload_asset(&state, &pinned, &token, &asset_id).await?;
    }
    request_json(
        &state.http_client,
        &pinned,
        Some(&token),
        Method::PUT,
        &format!("/api/v1/outlines/{}/seed", configuration.outline_id),
        Some(json!({ "state": document_state })),
        MAX_CHECKPOINT_BYTES,
    )
    .await
}
```

Register it in `apps/desktop/src-tauri/src/lib.rs` next to `sync_commands::server_enroll`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/desktop/src-tauri && cargo test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src-tauri/src/sync_commands.rs apps/desktop/src-tauri/src/lib.rs
git commit -m "feat(desktop): add the native outline seed command"
```

---

### Task 9: Settle the local outbox atomically

**Files:**
- Modify: `apps/desktop/src-tauri/src/persistence.rs`, `apps/desktop/src-tauri/src/commands.rs`, `apps/desktop/src-tauri/src/lib.rs`
- Test: `apps/desktop/src-tauri/src/persistence.rs` test module

**Interfaces:**
- Consumes: Task 8's seed response.
- Produces:
  - `EventStore::mark_seeded(&self, outline_id: &str, checkpoint: &CheckpointRecord) -> StoreResult<()>`
  - `event_store_mark_seeded(outline_id: String, checkpoint: CheckpointRecord) -> Result<(), String>`

- [ ] **Step 1: Write the failing test**

```rust
#[test]
fn mark_seeded_settles_pending_events_and_writes_the_checkpoint() {
    let store = temporary_store();
    store.append(&pending_event("event_1", "outline_1")).unwrap();
    store.append(&pending_event("event_2", "outline_1")).unwrap();
    let checkpoint = checkpoint_record("outline_1", 0, "hash");

    store.mark_seeded("outline_1", &checkpoint).unwrap();

    assert!(store.pending_events("outline_1", 10).unwrap().is_empty());
    let stored = store.latest_compatible_checkpoint("outline_1", 1, 1).unwrap().unwrap();
    assert_eq!(stored.server_revision, 0);
    assert_eq!(stored.integrity_hash, "hash");
}

#[test]
fn mark_seeded_leaves_the_outbox_intact_when_the_checkpoint_is_invalid() {
    let store = temporary_store();
    store.append(&pending_event("event_1", "outline_1")).unwrap();
    let invalid = checkpoint_record("outline_1", -1, "hash");

    assert!(store.mark_seeded("outline_1", &invalid).is_err());
    assert_eq!(store.pending_events("outline_1", 10).unwrap().len(), 1);
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/desktop/src-tauri && cargo test mark_seeded`
Expected: FAIL — no method named `mark_seeded`.

- [ ] **Step 3: Implement**

In `apps/desktop/src-tauri/src/persistence.rs`, beside `acknowledge_batch` (`:347`):

```rust
pub fn mark_seeded(&self, outline_id: &str, checkpoint: &CheckpointRecord) -> StoreResult<()> {
    let mut connection = self.connection()?;
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    transaction.execute(
        "UPDATE outline_events
         SET status = 'accepted', server_revision = 0
         WHERE outline_id = ?1 AND status = 'pending' AND superseded_by IS NULL",
        params![outline_id],
    )?;
    transaction.execute(
        "INSERT OR REPLACE INTO outline_checkpoints
         (id, outline_id, document_version, schema_epoch, local_sequence, server_revision,
          state_json, integrity_hash, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            checkpoint.id, checkpoint.outline_id, checkpoint.document_version,
            checkpoint.schema_epoch, checkpoint.local_sequence, checkpoint.server_revision,
            checkpoint.state_json, checkpoint.integrity_hash, checkpoint.created_at,
        ],
    )?;
    transaction.commit()?;
    Ok(())
}
```

Add the command in `commands.rs` beside the other event-store commands and register it in `lib.rs`:

```rust
#[tauri::command]
pub fn event_store_mark_seeded(
    state: State<'_, NativeState>,
    outline_id: String,
    checkpoint: CheckpointRecord,
) -> Result<(), String> {
    state
        .event_store
        .mark_seeded(&outline_id, &checkpoint)
        .map_err(|error| error.to_string())
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/desktop/src-tauri && cargo test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src-tauri/src/persistence.rs apps/desktop/src-tauri/src/commands.rs apps/desktop/src-tauri/src/lib.rs
git commit -m "feat(desktop): settle the outbox and write the seed checkpoint atomically"
```

---

### Task 10: Adoption orchestration

**Files:**
- Create: `apps/desktop/src/sync/adoptOutline.ts`
- Create: `apps/desktop/src/sync/adoptOutline.test.ts`
- Modify: `apps/desktop/src/persistence/eventStore.ts` (repository method)

**Interfaces:**
- Consumes: Tasks 8 and 9's native commands; `loadReplayInput` and `reduceOutlineEvent` as used by `syncEngine.ts:176-195`. `ReplayInput` and `StoredCheckpoint` are declared in `apps/desktop/src/persistence/eventStore.ts:28-45`, not in `syncEngine.ts`.
- Produces:

```ts
export interface AdoptionProgress { phase: 'replaying' | 'seeding' | 'settling'; assetCount: number }
export async function adoptLocalOutline(
  repository: AdoptionRepository,
  outlineId: string,
  onProgress?: (progress: AdoptionProgress) => void,
): Promise<{ revision: number; integrityHash: string }>
```

- [ ] **Step 1: Write the failing test**

`apps/desktop/src/sync/adoptOutline.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
import { adoptLocalOutline } from './adoptOutline'

function repositoryWith(events: unknown[]) {
  return {
    loadReplayInput: vi.fn(async () => ({
      checkpoint: { id: 'c1', outlineId: 'outline_1', documentVersion: 1, schemaEpoch: 1, localSequence: 0, serverRevision: 0, stateJson: '{}', integrityHash: '', createdAt: '' },
      state: { doc: { type: 'doc', content: [] }, documentVersion: 1, schemaEpoch: 1 },
      events,
    })),
    seedOutline: vi.fn(async () => ({ outlineId: 'outline_1', revision: 0, integrityHash: 'b'.repeat(64) })),
    markSeeded: vi.fn(async () => {}),
  }
}

describe('adoptLocalOutline', () => {
  it('seeds the replayed state and then settles the outbox', async () => {
    const repository = repositoryWith([])
    const result = await adoptLocalOutline(repository, 'outline_1')
    expect(result.integrityHash).toBe('b'.repeat(64))
    expect(repository.seedOutline).toHaveBeenCalledBefore(repository.markSeeded)
    expect(repository.markSeeded.mock.calls[0][1]).toMatchObject({ serverRevision: 0, integrityHash: 'b'.repeat(64) })
  })

  it('does not settle the outbox when seeding fails', async () => {
    const repository = repositoryWith([])
    repository.seedOutline = vi.fn(async () => { throw new Error('conflict') })
    await expect(adoptLocalOutline(repository, 'outline_1')).rejects.toThrow('conflict')
    expect(repository.markSeeded).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/desktop/src/sync/adoptOutline.test.ts`
Expected: FAIL — cannot resolve `./adoptOutline`.

- [ ] **Step 3: Implement**

`apps/desktop/src/sync/adoptOutline.ts`:

```ts
import { reduceOutlineEvent, type OutlineState } from '@forage/domain'
import type { ReplayInput, StoredCheckpoint } from '../persistence/eventStore'

export interface AdoptionProgress { phase: 'replaying' | 'seeding' | 'settling'; assetCount: number }

function referencedAssetCount(state: OutlineState): number {
  const found = new Set<string>()
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) value.forEach(visit)
    else if (value && typeof value === 'object') {
      for (const [key, entry] of Object.entries(value)) {
        if (key === 'assetId' && typeof entry === 'string') found.add(entry)
        else visit(entry)
      }
    }
  }
  visit(state)
  return found.size
}

export interface AdoptionRepository {
  loadReplayInput(outlineId: string): Promise<ReplayInput | null>
  seedOutline(state: OutlineState): Promise<{ outlineId: string; revision: number; integrityHash: string }>
  markSeeded(outlineId: string, checkpoint: StoredCheckpoint): Promise<void>
}

export async function adoptLocalOutline(
  repository: AdoptionRepository,
  outlineId: string,
  onProgress?: (progress: AdoptionProgress) => void,
): Promise<{ revision: number; integrityHash: string }> {
  onProgress?.({ phase: 'replaying', assetCount: 0 })
  const replay = await repository.loadReplayInput(outlineId)
  if (!replay) throw new Error('This device has no local outline to copy.')
  let state = replay.state
  for (const event of replay.events) state = reduceOutlineEvent(state, event)
  const assetCount = referencedAssetCount(state)

  onProgress?.({ phase: 'seeding', assetCount })
  const seeded = await repository.seedOutline(state)

  onProgress?.({ phase: 'settling', assetCount })
  await repository.markSeeded(outlineId, {
    id: `checkpoint_${crypto.randomUUID()}`,
    outlineId,
    documentVersion: state.documentVersion,
    schemaEpoch: state.schemaEpoch,
    localSequence: 0,
    serverRevision: seeded.revision,
    stateJson: JSON.stringify(state),
    integrityHash: seeded.integrityHash,
    createdAt: new Date().toISOString(),
  })
  return { revision: seeded.revision, integrityHash: seeded.integrityHash }
}
```

Add to `NativeEventRepository` in `apps/desktop/src/persistence/eventStore.ts`:

```ts
async seedOutline(state: OutlineState) {
  return invoke<{ outlineId: string; revision: number; integrityHash: string }>(
    'server_seed_outline', { documentState: state },
  )
}

async markSeeded(outlineId: string, checkpoint: StoredCheckpoint): Promise<void> {
  await invoke('event_store_mark_seeded', { outlineId, checkpoint })
}
```

`localSequence: 0` is deliberate: `mark_seeded` accepts every pending event at revision 0, so the checkpoint is the new replay floor.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run apps/desktop/src/sync/adoptOutline.test.ts` then `npm run build`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/sync/adoptOutline.ts apps/desktop/src/sync/adoptOutline.test.ts apps/desktop/src/persistence/eventStore.ts
git commit -m "feat(desktop): orchestrate local outline adoption"
```

---

### Task 11: Wizard copy step

**Files:**
- Modify: `apps/desktop/src/components/Settings/ComputeSettings.tsx:16-23`, `:35-36`, `:80-92`, `:246-258`, `:300-315`
- Test: `apps/desktop/src/components/Settings/ComputeSettings.test.tsx`

**Interfaces:**
- Consumes: Task 7's two-argument `server_enroll`, Task 10's `adoptLocalOutline`.
- Produces: wizard steps `connect | copy | verify | credential | publish`; no Outline ID input.

- [ ] **Step 1: Write the failing test**

```tsx
it('enrols with only a server URL and a device token', async () => {
  const user = userEvent.setup()
  render(<ComputeSettings />)
  await user.click(screen.getByRole('radio', { name: 'Server' }))
  expect(screen.queryByLabelText('Outline ID')).not.toBeInTheDocument()
  await user.type(screen.getByLabelText('Server URL'), 'https://forage.example')
  await user.type(screen.getByLabelText('Device token'), 'device-token')
  await user.click(screen.getByRole('button', { name: 'Connect server' }))
  expect(invoke).toHaveBeenCalledWith('server_enroll', {
    origin: 'https://forage.example', deviceToken: 'device-token',
  })
})

it('stays in local mode when the copy step fails', async () => {
  const user = userEvent.setup()
  invoke.mockImplementation(async (command: string) => {
    if (command === 'server_seed_outline') throw new Error('conflict')
    return null
  })
  render(<ComputeSettings />)
  await user.click(screen.getByRole('radio', { name: 'Server' }))
  await user.click(screen.getByRole('button', { name: 'Copy outline to server' }))
  expect(await screen.findByRole('status')).toHaveTextContent('conflict')
  expect(invoke).not.toHaveBeenCalledWith('event_store_set_storage_mode', expect.anything())
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/desktop/src/components/Settings/ComputeSettings.test.tsx`
Expected: FAIL — the Outline ID field still renders and `server_enroll` is called with three arguments.

- [ ] **Step 3: Implement**

- Change `WizardStep` to `'connect' | 'copy' | 'verify' | 'credential' | 'publish'` and add `{ id: 'copy', label: 'Copy' }` after Connect in `WIZARD_STEPS`.
- Delete the `outlineId` state and its input; drop `outlineId` from the `server_enroll` invocation and from the Connect button's `disabled` predicate.
- `enrollServer` advances to `'copy'` instead of `'verify'`.
- Add the copy step body and handler:

```tsx
async function copyOutline() {
  setBusy(true)
  setStatus(null)
  try {
    const identity = await invoke<{ outlineId: string }>('outline_identity')
    await adoptLocalOutline(new NativeEventRepository(), identity.outlineId, (progress) => {
      setStatus(progress.phase === 'replaying' ? 'Reading the local outline…'
        : progress.phase === 'seeding'
          ? progress.assetCount
            ? `Uploading ${progress.assetCount} image(s), then the outline…`
            : 'Uploading the outline…'
          : 'Finishing up…')
    })
    await invoke('event_store_set_storage_mode', { mode: 'server' })
    setStatus('Outline copied. Restart Forage to finish switching to server mode.')
    setStep('verify')
  } catch (error) { setStatus(message(error)) } finally { setBusy(false) }
}
```

```tsx
{step === 'copy' && (
  <>
    <p className="settings-hint">This device's outline becomes the server's content. Images upload first.</p>
    <button type="button" className="settings-save" disabled={busy} onClick={() => void copyOutline()}>
      Copy outline to server
    </button>
  </>
)}
```

- For a device meeting an already-seeded server, `server_seed_outline` returns `conflict`. Catch that specific code and render the parked-outline warning instead of a raw error: "This server already holds an outline. Connecting will switch this device to it and leave this device's local outline behind." with a confirm button that skips to `'verify'` without seeding.

Use the exact command name for the storage-mode setter that `commands.rs:211-213` registers; check it rather than copying the name above verbatim.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run apps/desktop/src/components/Settings/ComputeSettings.test.tsx` then `npm run build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/components/Settings/ComputeSettings.tsx apps/desktop/src/components/Settings/ComputeSettings.test.tsx
git commit -m "feat(desktop): add the outline copy step to the connection wizard"
```

---

### Task 12: Sync engine regression cover

**Files:**
- Test: `apps/desktop/src/sync/syncEngine.test.ts`

**Interfaces:**
- Consumes: everything above. No production change is expected; this task proves it.

- [ ] **Step 1: Write the test**

```ts
it('pushes nothing and pulls from revision 0 after a seed', async () => {
  const repo = repositoryFixture()
  repo.loadReplayInput = async () => ({
    checkpoint: { id: 'c1', outlineId: 'outline_1', documentVersion: 1, schemaEpoch: 1, localSequence: 0, serverRevision: 0, stateJson: '{}', integrityHash: 'h', createdAt: '' },
    state: emptyOutlineState(),
    events: [],
  })
  repo.pending = async () => []
  const transport = transportFixture({ currentRevision: 0, events: [] })
  await new DesktopSyncEngine(repo, transport, () => {}).sync()
  expect(transport.push).not.toHaveBeenCalled()
  expect(transport.pull).toHaveBeenCalledWith(0, 100)
})
```

- [ ] **Step 2: Run the test**

Run: `npx vitest run apps/desktop/src/sync/syncEngine.test.ts -t "after a seed"`
Expected: PASS with no production change. If it fails, the bootstrap branch at `syncEngine.ts:128-147` is re-adopting the server checkpoint over the seeded local one — fix by having it skip bootstrap whenever `loadReplayInput` returns a replay, which it already intends to do.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/sync/syncEngine.test.ts
git commit -m "test(desktop): cover the first sync after an outline seed"
```

---

### Task 13: Documentation and ADR

**Files:**
- Modify: `docs/server-backend.md` (bootstrap and connection sections)
- Create: `docs/ADRs/ADR-0015-blank-server-outline-adoption.md`
- Modify: `docs/architecture.md` (server mode description)

**Interfaces:**
- Consumes: the shipped behavior.

- [ ] **Step 1: Rewrite the bootstrap section**

In `docs/server-backend.md`, replace the paragraph instructing the reader to store the printed outline ID. `npm run server:bootstrap` now prints an owner id and two tokens. Replace the Settings instruction with: supply the server origin and device token in Settings → Connection; the wizard's Copy step uploads this device's outline and makes it the server's content. Note that the first device to connect seeds the server and later devices pull it, leaving their own local outlines behind.

- [ ] **Step 2: Write the ADR**

`docs/ADRs/ADR-0015-blank-server-outline-adoption.md`, following the shape of `docs/ADRs/ADR-template.md`. Status Accepted, dated the merge date, superseding nothing but explicitly amending ADR-0012's "No legacy iCloud or relational database migration is provided" for the local-to-server direction. Record the three scope decisions from the spec: claim once, checkpoint genesis rather than event replay, assets before checkpoint. Record the negative consequence: pre-seed local history never reaches other devices.

- [ ] **Step 3: Verify the full suite**

Run: `npm test && npm run build && (cd apps/desktop/src-tauri && cargo test)`
Expected: PASS. With PostgreSQL up and `TEST_DATABASE_URL` pointed at `forage_contract_test`, the contract tests run too.

- [ ] **Step 4: Commit**

```bash
git add docs/server-backend.md docs/ADRs/ADR-0015-blank-server-outline-adoption.md docs/architecture.md
git commit -m "docs: record blank server outline adoption"
```
