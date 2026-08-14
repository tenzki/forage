# ADR-0001: Keep Tauri as a Thin Desktop Shell

- **Status:** Accepted
- **Date:** 2026-08-14
- **Deciders:** AI Chat project team
- **Supersedes:** None (replaces an undocumented custom Rust/SQLite/Node-sidecar architecture)
- **Superseded by:** None

## Context

The original application distributed behavior across React, Zustand, Tauri IPC, a custom Rust backend, SQLite, and a Node.js agent sidecar. Features crossing those boundaries created type drift, packaging overhead, and undo/persistence races. The current product is a personal macOS outliner and does not require a server-grade backend in v1.

Tauri is still useful for packaging and for controlled access to native filesystem, settings, HTTP, and URL-opening capabilities.

## Decision Drivers

- Minimize runtime and integration boundaries.
- Keep desktop packaging lighter than Electron.
- Preserve access to macOS and iCloud Drive through supported APIs.
- Avoid custom IPC contracts where frontend code can own the behavior directly.
- Keep v1 implementation and debugging concentrated in TypeScript.

## Considered Options

1. **Thin Tauri shell** — TypeScript owns application logic; Rust registers official plugins only.
2. **Custom Rust backend** — retain domain logic, SQLite, and typed IPC commands in Rust.
3. **Electron/Node desktop runtime** — move native and agent behavior into Node.js.

## Decision

We will **use Tauri v2 as a thin shell and keep v1 application logic in the TypeScript frontend** because **it retains desktop capabilities while removing unnecessary cross-runtime seams**.

Rust will register only the official plugins needed by the frontend: filesystem, store, HTTP, and opener. The application will not add custom Rust commands, a database layer, or a Node.js sidecar without a new ADR.

## Consequences

### Positive

- Most behavior can be developed, typed, and tested in one language.
- There are no application-specific IPC DTOs to keep synchronized.
- The packaged app remains smaller than an Electron-based equivalent.
- Native permissions remain explicit in Tauri capabilities.

### Negative

- Browser-only development cannot exercise Tauri plugin behavior.
- CPU-heavy or security-sensitive operations have no privileged backend by default.
- Frontend code must handle persistence and network failures explicitly.
- Adding capabilities can require coordinated Rust plugin and capability changes.

### Risks and Mitigations

- **Risk:** The webview gains broader native access than a normal browser page.  
  **Mitigation:** Register only required official plugins and keep `src-tauri/capabilities/default.json` narrowly scoped.
- **Risk:** Future arbitrary networking or secret-handling needs exceed a safe frontend boundary.  
  **Mitigation:** Require a separate ADR before adding a narrow Rust command or another runtime.
- **Risk:** Developers validate only under Vite and miss Tauri-only failures.  
  **Mitigation:** Include `npm run tauri dev` and packaged-app checks in acceptance testing for plugin-dependent changes.

## Option Analysis

### Option A: Thin Tauri Shell

**Advantages**

- Few runtime boundaries and low maintenance overhead.
- Uses the existing React and TypeScript expertise.
- Retains native packaging and permission controls.

**Disadvantages**

- Native APIs are unavailable in ordinary browser development.
- The webview becomes responsible for more orchestration.

### Option B: Custom Rust Backend

**Advantages**

- Strong privileged boundary and good support for native or compute-heavy work.
- Could support richer local services in the future.

**Disadvantages**

- Reintroduces IPC schemas, duplicated models, and cross-layer debugging.
- Was not justified by v1 requirements.

### Option C: Electron/Node Desktop Runtime

**Advantages**

- Broad Node.js ecosystem and one JavaScript runtime for native orchestration.
- Straightforward support for Node-only SDKs.

**Disadvantages**

- Larger runtime and distribution footprint.
- Requires a shell migration without solving a current product need.

## Implementation Notes

`src-tauri/src/lib.rs` must remain limited to Tauri setup and official plugin registration. Native permissions are declared in `src-tauri/capabilities/default.json`. Application behavior belongs under `src/` unless a later accepted ADR establishes a privileged backend boundary.

Legacy SQL migrations and Rust database tests predate this decision and are not architectural inputs for new work.

## Validation

- `npm run build` succeeds without application-specific Rust bindings.
- `npm run tauri dev` verifies filesystem, store, HTTP, and opener workflows.
- Code review confirms no custom Tauri command or sidecar is introduced without a superseding ADR.
- Capability review confirms every native permission maps to an implemented feature.

## References

- `src-tauri/src/lib.rs`
- `src-tauri/Cargo.toml`
- `src-tauri/capabilities/default.json`
- `.planning/ROADMAP.md`
- `.planning/PROJECT.md`
