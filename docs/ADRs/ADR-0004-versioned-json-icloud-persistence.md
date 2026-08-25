# ADR-0004: Persist a Versioned Whole-Document JSON File in iCloud Drive

- **Status:** Accepted
- **Date:** 2026-08-14
- **Deciders:** AI Chat project team
- **Supersedes:** None (replaces an undocumented SQLite persistence design)
- **Superseded by:** None

> **Note:** the persistence folder moved from `AIChat` to `Forage` during the project rename; the one-time migration is documented in ADR-0010. The envelope design itself is unchanged.

## Context

The product is local-first and must make a personal outline available across the user's Macs without operating a synchronization service. Because ADR-0002 establishes one ProseMirror document as the source of truth, relational per-node storage would require translating and synchronizing a second representation.

macOS already synchronizes files placed in the user's iCloud Drive. The current v1 scope does not require collaborative merge semantics or server-side queries.

## Decision Drivers

- Local-first ownership of user data.
- No managed backend or custom sync engine in v1.
- Fidelity with the single-document editor model.
- Human-inspectable, portable storage.
- A format that can evolve through explicit versioning.

## Considered Options

1. **One versioned JSON file in iCloud Drive** — serialize the complete ProseMirror document.
2. **SQLite database in iCloud Drive** — persist normalized bullets and metadata relationally.
3. **One file per bullet or branch** — split the outline into independently synchronized units.
4. **Hosted synchronization service** — store and reconcile data through an application backend.

## Decision

We will **persist `{ version: 1, doc }` as one JSON file at `~/Library/Mobile Documents/com~apple~CloudDocs/AIChat/tree.json` and rely on macOS iCloud Drive synchronization** because **the persisted unit then matches the editor's source of truth without requiring a database or custom sync service**.

Editor updates are coalesced by a 600 ms debounced saver, with a best-effort flush on `beforeunload`.

## Consequences

### Positive

- Persistence is a direct serialization of the authoritative document.
- Users retain a portable local data file.
- No schema joins, ORM, IPC database API, or custom sync engine is required.
- Format migrations can branch on the envelope version.

### Negative

- Each save rewrites the complete document.
- Concurrent edits on multiple Macs have file-level rather than node-level conflict semantics.
- Search and other queries scan the in-memory document instead of a database index.
- Tauri filesystem behavior cannot be tested completely in the browser-only Vite server.

### Risks and Mitigations

- **Risk:** A crash or interrupted write corrupts the only file.  
  **Mitigation:** Add atomic temporary-file replacement and backup recovery before relying on the format for irreplaceable data.
- **Risk:** iCloud produces conflicting versions after concurrent edits.  
  **Mitigation:** Treat v1 as a personal, mostly single-writer tool; add conflict detection before claiming multi-device concurrent editing.
- **Risk:** A malformed or unknown version is mistaken for an empty first run.  
  **Mitigation:** Validate the envelope, surface load errors to the user, and never overwrite an unreadable source until the user chooses a recovery action.
- **Risk:** The Tauri filesystem scope and actual path diverge.  
  **Mitigation:** Keep capability tests and `outlineFile.ts` path changes coordinated.

## Option Analysis

### Option A: One Versioned JSON File in iCloud Drive

**Advantages**

- Matches ProseMirror's document unit exactly.
- Minimal storage and synchronization code.
- Easy to inspect, back up, and migrate.

**Disadvantages**

- Whole-file writes and conflicts.
- Requires additional hardening for atomicity and recovery.

### Option B: SQLite Database in iCloud Drive

**Advantages**

- Efficient indexed queries and partial updates.
- Strong local transactional behavior.

**Disadvantages**

- Duplicates the editor model and complicates undo.
- Cloud synchronization of live database files introduces coordination and corruption concerns.

### Option C: One File per Bullet or Branch

**Advantages**

- Smaller writes and potentially narrower sync conflicts.
- Individual content units are inspectable.

**Disadvantages**

- Structural edits span files and need transaction/recovery logic.
- File lifecycle and ordering become a custom database.

### Option D: Hosted Synchronization Service

**Advantages**

- Can support conflict resolution, history, and collaboration.
- Centralized backup and access control are possible.

**Disadvantages**

- Adds authentication, hosting, privacy, billing, and operations outside v1 scope.

## Implementation Notes

`src/persistence/outlineFile.ts` owns the path, envelope validation, reads, writes, and debounce behavior. `src/App.tsx` loads once before mounting the editor and schedules saves from editor updates. The filesystem scope in `src-tauri/capabilities/default.json` must include only the AIChat iCloud directory.

Atomic writes, backups, user-visible recovery, and conflict detection are follow-up hardening; they should preserve the versioned whole-document contract unless this ADR is superseded.

## Validation

- A nested outline survives save, app restart, and reload with IDs and metadata intact.
- Rapid edits are coalesced and the final state reaches disk.
- A pending change is flushed during normal window close.
- First run creates the target directory and file.
- Unknown versions and malformed JSON do not get silently overwritten.
- A two-Mac test confirms expected iCloud propagation and documents conflict behavior.

## References

- `src/persistence/outlineFile.ts`
- `src/App.tsx`
- `src/types/tree.ts`
- `src-tauri/capabilities/default.json`
- `.planning/ROADMAP.md`
