# ADR-0010: Rename the Project from AI Chat to Forage

- **Status:** Accepted
- **Date:** 2026-08-25
- **Deciders:** Bojan Babic
- **Supersedes:** None
- **Superseded by:** None

## Context

The product outgrew its working name "ai-chat". User-visible identity (window title, app name, bundle identifier), package names, and persistent data locations all carried the old name and needed to be aligned under a single product name, **Forage**, without losing existing user data (outline, settings, Codex credentials).

## Decision Drivers

- Existing users must not lose their outline or settings when upgrading to the renamed build.
- The rename should be complete for shipped identity (bundle id, app name) but avoid churning historical documents.
- Migrations must be idempotent and safe when interrupted.

## Decision

We will **rename all shipped identity to Forage and migrate both data locations one time on first launch** because **a half-renamed product is worse than either endpoint, and the only meaningful cost is a small, well-scoped migration**.

Changes:

- `package.json`/lockfiles → `forage`; sidecar package → `forage-sidecar`.
- `tauri.conf.json`: `productName: Forage`, `identifier: com.forage.app`, window title `Forage`.
- Cargo crate `forage`, lib `forage_lib`.
- User-Agent strings, Codex `clientInfo`/`serviceName`, temp-dir prefixes → `forage`.
- iCloud outline folder: `…/com~apple~CloudDocs/AIChat` → `…/com~apple~CloudDocs/Forage`.
- Settings: `…/Application Support/com.ai-chat.app/settings.json` → `com.forage.app/settings.json` (the identifier change moves the plugin-store home).

The migration lives in `src/persistence/legacyMigration.ts` and runs in `App.tsx` before outline and settings load. Each step only fires when the new location is absent and the old one exists; failures are logged but never block startup (data remains at the old location and is never overwritten). The legacy iCloud path and old settings path remain in the `fs` scope in `capabilities/default.json` solely to serve this migration.

Not renamed: stale files `ai-chat-bridge.ts`/`piRpcClient.ts` (dead code pending deletion), historical plans under `.planning/phases/`, and the repository directory on disk (owner's choice).

## Consequences

### Positive

- Consistent product identity across UI, bundle, and filesystem.
- No data loss for existing installations.

### Negative

- The legacy fs-scope entries and migration module persist until we decide legacy support can be dropped.
- Historical docs reference both names.

### Risks and Mitigations

- **Risk:** Migration partially fails (e.g. scope error), app starts with an empty-looking outline.
  **Mitigation:** Nothing is deleted or overwritten; the migration re-runs on next launch and errors are logged. User can also restore from the still-existing `AIChat` folder.

## Validation

- `src/persistence/legacyMigration.test.ts` covers the migrate, no-op, fresh-install, and partial-failure cases.
- Manual: launch the renamed build with an existing `AIChat` folder and verify the outline and settings appear and save round-trips to `Forage/`.

## References

- `.planning/RENAME-TO-FORAGE.md` (execution plan)
- ADR-0004 (iCloud persistence design, folder path updated by this ADR)
