# ADR-0011: Retain Tauri and TipTap Instead of Migrating to GPUix

- **Status:** Accepted
- **Date:** 2026-08-30
- **Deciders:** Bojan Babic
- **Supersedes:** None
- **Superseded by:** None

## Context

Forage is a macOS outliner whose primary interaction surface is one TipTap/ProseMirror document. Text editing, rich-text marks, nested list structure, selection, structural commands, agent insertion, and undo/redo all participate in that document's transaction model. Tauri provides the desktop shell, packaging path, scoped native capabilities, and access to the filesystem, settings, HTTP, URL opening, and child processes.

[GPUix](https://gpuix.dev/) is a React renderer for Zed's GPUI. It renders through native GPU APIs rather than a webview and offers native text inputs, scrolling, virtual lists, markdown/code/diff rendering, window management, motion, and GPU-backed automation. Its promise of a React/TypeScript development model without Electron or a browser rendering surface makes it a plausible alternative desktop client technology.

GPUix does not currently expose a structured rich-text editor comparable to TipTap/ProseMirror. Its editable primitives are single-line input and multiline textarea controls, while its markdown element renders rather than edits structured content. Replacing Forage's renderer would therefore also replace its editor engine and transaction model.

The detailed technical assessment is recorded in [`docs/gpuix-migration-assessment.md`](../gpuix-migration-assessment.md).

## Decision Drivers

- Preserve atomic undo/redo across text edits, nesting, moves, deletion, and agent-generated branches.
- Preserve one authoritative outline model with stable bullet identity and selection mapping.
- Retain rich text, internal links, tags, notes, generated images, decorations, and structural keyboard behavior.
- Avoid a large client rewrite without a measured user-facing performance problem.
- Retain narrowly scoped native permissions for filesystem, network, and process access.
- Keep a supported path to macOS application bundling, signing, notarization, and resource packaging.
- Limit reliance on a young, pre-1.0 dependency for the product's most important subsystem.

## Considered Options

1. **Retain Tauri + TipTap/ProseMirror** — continue the accepted thin-shell and single-document architecture.
2. **Migrate the complete client to GPUix** — replace the webview, editor view, native service adapters, styling, and packaging workflow.
3. **Adopt GPUix incrementally or inside Tauri** — render selected surfaces through GPUix while retaining the existing application shell and editor.
4. **Run an isolated GPUix viability spike** — build a disposable prototype only after profiling identifies a material current-client bottleneck.

## Decision

We will **retain the Tauri + TipTap/ProseMirror client and not migrate Forage to GPUix at this time** because **GPUix does not provide the structured editor and unified transaction model on which Forage's correctness depends, while Forage already receives most of the distribution-size advantage of a non-Electron architecture from Tauri's system webview**.

GPUix remains a technology to monitor. A disposable viability spike is permitted when current-client profiling demonstrates a material product problem or GPUix gains an editor primitive capable of satisfying the validation gates below. Such a spike is research, not an incremental production migration.

## Consequences

### Positive

- The established single-document editing and undo invariants remain intact.
- Existing TipTap extensions, ProseMirror transactions, tests, persisted document format, and agent-to-editor projection remain usable.
- Tauri continues to provide explicit capability scopes for sensitive native operations.
- The project avoids rewriting the editor, application chrome, native adapters, and distribution pipeline before the product need is demonstrated.
- Engineering effort can remain focused on product capability and measured optimization.

### Negative

- Forage retains a webview rendering layer and cannot directly use GPUix's native GPUI controls, virtual lists, GPU text painting, or deterministic native screenshot harness.
- Very large single ProseMirror documents may eventually need transaction-aware indexing or rendering optimization.
- The decision must be revisited if profiling shows that the current editor cannot meet product-scale latency or memory targets.

### Risks and Mitigations

- **Risk:** The team dismisses GPUix before it matures into a good fit.  
  **Mitigation:** Reassess on a concrete trigger: a production-grade structured editor, stable native extension API, documented accessibility support, or a Forage performance target missed after reasonable optimization.
- **Risk:** The current client develops performance problems on large outlines.  
  **Mitigation:** Benchmark cold start, idle memory, key-to-paint latency, scroll latency, search, and streamed agent insertion at representative 1,000- and 10,000-bullet documents before selecting a replacement architecture.
- **Risk:** A future prototype recreates the abandoned one-editor-per-bullet design with independent history.  
  **Mitigation:** Require the prototype to demonstrate atomic cross-bullet structural undo, selection preservation, and data round-tripping before it can inform a production proposal.
- **Risk:** A hybrid renderer appears incremental but preserves both runtimes' costs.  
  **Mitigation:** Do not embed GPUix's browser/WebGPU target in the current Tauri view as a migration strategy; evaluate a standalone prototype against explicit gates instead.

## Option Analysis

### Option A: Retain Tauri + TipTap/ProseMirror

**Advantages**

- Directly satisfies Forage's richest and most correctness-sensitive subsystem.
- Preserves the current document schema, transaction semantics, undo history, and native permission model.
- Uses a system webview rather than bundling an Electron/Chromium runtime.
- Keeps macOS packaging on an established Tauri path.

**Disadvantages**

- Does not receive GPUix's native rendering and testing advantages.
- Large outlines may require targeted ProseMirror optimization.

### Option B: Migrate the Complete Client to GPUix

**Advantages**

- Native GPU rendering without a webview.
- Native scrolling, text input, motion, window chrome, and GPU-backed interaction automation.
- React and TypeScript remain available for application code.

**Disadvantages**

- Requires a new rich outliner/editor implementation rather than a renderer substitution.
- Replaces the transaction, selection, decoration, and unified history behavior currently supplied by ProseMirror.
- Requires replacement adapters for Tauri filesystem, settings, HTTP, opener, shell, resource, and packaging behavior.
- Moves the product's critical path onto a young pre-1.0 project with concentrated maintenance ownership.

### Option C: Adopt GPUix Incrementally or Inside Tauri

**Advantages**

- Appears to reduce rollout risk by preserving existing components.
- Could demonstrate selected GPUix rendering capabilities.

**Disadvantages**

- GPUix is a renderer and window host, not a DOM component library that can replace isolated React components inside TipTap.
- Its browser target renders into a GPU canvas, retaining the webview while remaining incompatible with TipTap's DOM-based editor view.
- A dual-renderer architecture would add integration boundaries without addressing the editor migration.

### Option D: Run an Isolated Viability Spike

**Advantages**

- Produces evidence without committing production architecture.
- Can compare real outline workloads rather than chat or timeline examples.
- Makes missing editor, accessibility, packaging, and integration capabilities concrete.

**Disadvantages**

- Still consumes engineering time and can become throwaway work.
- A simple list or textarea demo would overstate viability unless it exercises the full validation gates.

## Implementation Notes

- Continue following ADR-0001 and ADR-0002. This decision does not change production code.
- Treat optimization inside the current architecture as the first response to measured performance issues.
- Keep the persisted ProseMirror JSON versioned and portable so a future prototype can test lossless import/export without changing the production source of truth.
- Do not introduce a per-bullet editor, external outline source of truth, or separate undo stack as a GPUix stepping stone.
- Record future GPUix reassessments as updates to the research note. A production migration requires a superseding ADR.

## Validation

The decision remains valid while the current client meets agreed product targets and GPUix lacks a structured editor satisfying all of these gates:

- Rich inline marks, internal links, notes, generated images, and nested bullets round-trip without loss.
- Text and structural operations share one atomic undo/redo history.
- Cursor and selection survive indentation, moves, agent streaming, zoom, collapse, and rerendering.
- Clipboard, IME composition, grapheme deletion, keyboard navigation, and drag reordering behave correctly.
- Screen-reader and keyboard-only workflows have a documented and tested accessibility contract.
- iCloud persistence, settings, OAuth/API-key handling, bounded HTTP, URL opening, and sidecar lifecycle preserve or improve the current security boundaries.
- A signed and notarized macOS `.app`/DMG can bundle all required resources and supported architectures.
- Representative Forage workloads show a material improvement over the optimized Tauri client.

## References

- [`docs/gpuix-migration-assessment.md`](../gpuix-migration-assessment.md)
- [ADR-0001: Keep Tauri as a Thin Desktop Shell](ADR-0001-thin-tauri-shell.md)
- [ADR-0002: Represent the Outline as One ProseMirror Document](ADR-0002-single-prosemirror-outline.md)
- [ADR-0003: Embed Bullet Identity](ADR-0003-embed-bullet-identity.md)
- [GPUix documentation and repository](https://github.com/remorses/gpuix)
- [GPUix releases](https://github.com/remorses/gpuix/releases)
- [Tauri architecture](https://v2.tauri.app/concept/architecture/)
- [TipTap editor API](https://tiptap.dev/docs/editor/api/editor)
