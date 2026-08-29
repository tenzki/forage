# GPUix Client Migration Assessment

**Assessment date:** 2026-08-30  
**Decision:** Do not migrate the production Forage client now. Retain Tauri + TipTap/ProseMirror and revisit only on the evidence-based triggers below.  
**Related decision:** [ADR-0011](ADRs/ADR-0011-retain-tauri-tiptap-over-gpuix.md)

## Executive Summary

GPUix is a promising React renderer for Zed's GPUI. It offers native GPU rendering, native text inputs, virtual lists, markdown/code/diff components, window management, motion, and GPU-backed automation without Electron or a webview.

It is not currently a good migration target for Forage. The central Forage client is not ordinary React chrome around a set of form inputs: it is one structured TipTap/ProseMirror editor. The editor owns the nested outline, rich content, stable bullet identity, cursor and selection mapping, decorations, structural commands, agent insertion, and one coherent undo history. GPUix currently supplies plain input and textarea editing, not a structured rich-text editor or an application-facing equivalent of ProseMirror's transaction model.

Consequently, moving to GPUix would be a rewrite of the editor engine, rendering layer, desktop service adapters, and packaging workflow. The performance and footprint benefit is also smaller than GPUix's comparison with Electron implies because Forage already uses Tauri's system webview and does not bundle Chromium.

The appropriate next step is to keep the current architecture, measure it at representative scale, and consider a disposable GPUix spike only if profiling demonstrates a material product problem or GPUix gains the missing editor and platform capabilities.

## Scope and Method

This assessment used:

- the Forage source, accepted ADRs, dependency manifests, Tauri capabilities, persistence implementation, and agent process integration;
- the GPUix repository, README, releases, changelog, issue tracker, package metadata, and published platform packages as available on 2026-08-30;
- the official Tauri architecture documentation and TipTap editor documentation;
- static line counts to estimate the code that is directly coupled to TipTap/ProseMirror, Tauri, and browser CSS.

No comparative runtime benchmark was run. Performance benefits described here are therefore capabilities or hypotheses, not measured Forage improvements.

## Current Forage Architecture

### The editor is the application core

Forage mounts one TipTap editor for the entire outline. Its bullets are nested ProseMirror `listItem` nodes; project extensions add identity, metadata, notes, internal links, images, tags, slash-command decorations, agent-context previews, and outliner UI behavior.

This design is intentional. The previous per-node-editor and external-history architecture produced undo and synchronization failures. The single document now provides:

- one authoritative in-memory tree;
- one selection and position space;
- native ProseMirror transaction mapping;
- atomic undo/redo across text and structure;
- direct serialization to versioned ProseMirror JSON;
- transaction-based insertion and replacement of streamed agent output.

Key references:

- [`src/editor/OutlinerEditor.tsx`](../src/editor/OutlinerEditor.tsx)
- [`src/editor/extensions.ts`](../src/editor/extensions.ts)
- [`src/editor/outlineModel.ts`](../src/editor/outlineModel.ts)
- [`src/agent/insertIntoEditor.ts`](../src/agent/insertIntoEditor.ts)
- [ADR-0002](ADRs/ADR-0002-single-prosemirror-outline.md)

### Tauri is already a thin shell

Forage does not place domain logic in a large Rust backend. Its Rust layer registers official Tauri plugins, while TypeScript owns the application. Tauri currently supplies:

- filesystem and path APIs for the iCloud outline file;
- plugin-store persistence for settings and credentials;
- scoped HTTP access;
- URL opening;
- constrained process spawning and lifecycle control for Node, Pi, and Codex-related workflows;
- resource resolution and desktop packaging.

The capability file statically restricts network destinations, executable names and arguments, and filesystem paths. Moving to direct Node/Bun APIs could reproduce the functionality but would not automatically reproduce this permission boundary.

Key references:

- [`src-tauri/capabilities/default.json`](../src-tauri/capabilities/default.json)
- [`src/persistence/outlineFile.ts`](../src/persistence/outlineFile.ts)
- [`src/store/settingsStore.ts`](../src/store/settingsStore.ts)
- [`src/agent/piSdkClient.ts`](../src/agent/piSdkClient.ts)
- [ADR-0001](ADRs/ADR-0001-thin-tauri-shell.md)

## GPUix Findings

### What GPUix provides

GPUix connects a React reconciler to GPUI through native bindings. React mutations update a retained Rust-side tree, which GPUI lays out and renders through Metal, DirectX, or Vulkan. The documented host surface includes:

- `div` and selectable `text`;
- native `input` and multiline `textarea` with caret, selection, IME, clipboard, undo/redo, and grapheme-aware deletion;
- scroll containers and variable-height virtual lists;
- read-only markdown, syntax-highlighted code, and diff rendering;
- local raster images and SVG icons;
- anchored overlays and headless select, combobox, and tooltip primitives;
- keyboard, focus, mouse, scroll, pointer capture, and drag events;
- native window chrome, menus, multiple windows, background launch, and motion;
- an automation API with locators, native input, deterministic motion time, and GPU screenshots.

Sources: [GPUix repository and README](https://github.com/remorses/gpuix), [release history](https://github.com/remorses/gpuix/releases).

### What is missing or uncertain for Forage

#### No structured editable document

GPUix's textarea is a capable plain-text control. Its markdown element renders GitHub-flavored markdown but is not an editable structured document. The documented supported elements do not include contenteditable, a rich-text editor, a general text-model API, editable spans/marks, or a ProseMirror-compatible view.

TipTap's editor creates and mounts a ProseMirror `EditorView` against a DOM element. Forage also uses DOM event hooks, browser selection behavior, ProseMirror decorations, and dynamically created DOM controls. Those cannot be redirected to GPUix by changing React's renderer. See the [TipTap editor API](https://tiptap.dev/docs/editor/api/editor) and [TipTap's ProseMirror integration](https://tiptap.dev/docs/editor/core-concepts/prosemirror).

It may be possible to retain parts of the ProseMirror schema and state packages without the browser view. That would preserve some data structures and transformations, but Forage would still need to implement native text layout, hit testing, cursor movement, selection, composition, clipboard mapping, decorations, node views, scrolling, and event-to-transaction translation. This is still an editor-engine project.

#### Accessibility is not established

GPUix documents focus handles and keyboard navigation. No public screen-reader or accessibility-tree contract for application content was found in the reviewed README or documentation. Absence from documentation does not prove the capability cannot be built, but it leaves a critical acceptance criterion unverified for a text-first application.

#### Packaging is below Tauri's current path

GPUix documents `bun build --compile` to produce a standalone executable. Its example release warns that the macOS binary is unsigned. The reviewed documentation did not provide an equivalent to Tauri's application bundling path for a signed/notarized `.app` and DMG, entitlements, icons and resources, update delivery, or universal binaries.

The current `@gpuix/native` 0.6.0 package publishes prebuilt optional packages for macOS ARM64, Windows x64, and Linux x64. Intel or universal macOS was not among the published optional packages at the assessment date. Sources: [`@gpuix/react` on npm](https://www.npmjs.com/package/@gpuix/react), [`@gpuix/native` on npm](https://www.npmjs.com/package/@gpuix/native).

#### The project is young and changing rapidly

The GitHub repository was created on 2026-01-29. The npm packages began at 0.1.0 on 2026-03-02 and reached 0.6.0 on 2026-08-29, with most public minor releases landing during the week before this assessment. The repository had approximately 1,321 stars, 37 forks, 291 commits, and nine open issues at review time. Contribution history was highly concentrated: the primary maintainer accounted for 275 of 291 recorded contributions.

Rapid development is a positive sign, but it also means APIs, packaging, behavior, and documentation are still settling. Pre-1.0 status alone is not a rejection criterion; the concern is putting Forage's editor and distribution pipeline on that moving critical path.

The repository had no published security policy at review time. This does not establish a vulnerability in shipped packages, but it is another maturity signal to evaluate before production adoption. Sources: [repository](https://github.com/remorses/gpuix), [issues](https://github.com/remorses/gpuix/issues), [security page](https://github.com/remorses/gpuix/security).

## Fit Matrix

| Capability | Current Forage | GPUix 0.6.0 | Migration assessment |
| --- | --- | --- | --- |
| React + TypeScript application code | Yes | Yes | Much non-editor business logic is conceptually reusable. |
| Native GPU rendering | System webview rendering | GPUI via native GPU APIs | GPUix advantage, but no Forage benchmark yet. |
| Structured rich-text editing | TipTap/ProseMirror | Not provided | Critical blocker. |
| One transaction/history across the outline | ProseMirror transactions/history | Input-local undo only | Must be rebuilt and proven. |
| Nested bullets and structural commands | Native document structure plus project transactions | Application-owned rows/tree | Must be rebuilt. |
| Marks, internal links, notes, images | Schema nodes/marks and node views | No general editable rich schema | Must be rebuilt. |
| Decorations and selection mapping | ProseMirror plugins | No equivalent documented | Must be rebuilt. |
| Large-list virtualization | Whole ProseMirror document | Native variable-height virtual list | GPUix advantage for row-based views; difficult to combine with one editable document. |
| IME, caret, clipboard | Browser/ProseMirror | Native input/textarea | Available only for GPUix's plain-text controls. |
| Browser CSS and component ecosystem | Full DOM/CSS | Subset mapped to GPUI styles | Application chrome and styling need substantial adaptation. |
| Filesystem/iCloud | Scoped Tauri plugin | Node/Bun APIs available to app code | Functional replacement possible; permission model must be recreated. |
| Network restrictions | Static Tauri origin allowlist | Application validation | Security regression unless explicitly redesigned. |
| Child-process restrictions | Named commands and argument validators | Direct process APIs | Security regression unless explicitly redesigned. |
| macOS packaging | Tauri bundler path | Standalone executable documented | Additional distribution engineering required. |
| Accessibility | DOM semantics/ARIA available | Focus documented; screen-reader contract unverified | Must be proven before adoption. |
| Native GPU automation | jsdom/unit tests plus manual Tauri checks | GPU screenshot and native-input harness | GPUix advantage. |

## Estimated Migration Surface

Static counts from the current production source provide an order-of-magnitude estimate:

- **4,884 lines** are in non-test files that directly import TipTap or ProseMirror.
- **2,255 lines** are in non-test files that directly import Tauri APIs; this overlaps with the previous category.
- [`src/style.css`](../src/style.css) contains **2,676 lines** built around DOM selectors, pseudo-classes, media queries, sticky/fixed positioning, browser focus behavior, and ProseMirror-generated markup.
- Production TypeScript/TSX/CSS under `src/` totals approximately **10,845 lines**.

These counts are not a delivery estimate: some files can be partially reused and some required native editor work does not yet exist. They do show that the affected surface is a large fraction of the client.

### Likely reusable areas

- Agent and skill definition schemas.
- Tool policy and validation logic, after replacing Tauri HTTP adapters.
- Pi JSONL event vocabulary and much of the sidecar implementation.
- Context budgets and some pure outline traversal concepts.
- Persisted ProseMirror JSON as an import source, provided lossless compatibility is maintained.
- General React state and product workflows that do not accept a TipTap `Editor` instance.

### Likely rewrite areas

- Editable outline view and all native editing behavior.
- Transaction, selection, decoration, and history integration.
- Structural commands, drag/drop, zoom, collapse, search projection, tags, backlinks, and formatting UI where they depend on ProseMirror or DOM geometry.
- Agent insertion and streaming projection into the editor.
- Browser event coordination and overlay positioning.
- Most CSS and DOM host markup.
- Filesystem, settings, HTTP, opener, process, and resource adapters.
- Application bundling, icons/resources, code signing, notarization, and distribution checks.
- Editor, component, and Tauri-integration tests.

## Expected Benefits and Their Limits

### Native rendering and large-list behavior

GPUix's native virtual list and GPU text pipeline could improve scrolling and rendering for very large row-oriented views. However, Forage currently uses one nested editable document rather than an independent collection of read-only rows. The virtual-list advantage cannot be assumed to transfer without changing the editor model.

### Runtime and bundle footprint

GPUix avoids a webview. This should remove webview process overhead and may improve startup or memory use. The likely gain is smaller than an Electron-to-GPUix comparison because Tauri already uses the operating system's webview and does not bundle a browser engine. Source: [Tauri architecture](https://v2.tauri.app/concept/architecture/).

Forage's eventual distribution footprint is also dominated by agent-related runtime choices, including Node/Pi resources and the optional Codex CLI path. Replacing the UI shell does not remove those requirements automatically.

### Testing

GPUix's GPU-backed test renderer, deterministic motion clock, native event simulation, and screenshot capture are valuable. They could materially improve visual and native-input testing. This benefit is real but is not sufficient to justify replacing the product's editor engine.

## Options Considered

### Full migration now

Rejected. The missing structured editor turns the work into a rewrite, and there is no measured Forage performance result that justifies it.

### One GPUix textarea per bullet

Rejected as a production direction. It recreates independent native editor states and local undo histories. Cross-bullet structure, selection, persistence, and history would need a second coordination system, repeating the class of architecture Forage replaced with the single ProseMirror document.

### GPUix web target inside Tauri

Rejected as a migration strategy. It retains the webview while replacing DOM rendering with a WebGPU canvas. TipTap's editor view still cannot mount into that surface, so this path preserves both the webview cost and the editor rewrite.

### Native GPUix shell around an embedded web editor

Not recommended. GPUix does not document embedding a webview as a host element, and doing so would recreate a multi-runtime shell while keeping the browser dependency for the critical screen.

### Isolated viability spike

Conditionally recommended after a measured trigger. The spike must represent Forage rather than reproduce GPUix's existing chat/todo examples.

## Reconsideration Triggers

Reopen the decision when at least one of these occurs:

1. The optimized Tauri client misses an agreed latency, memory, or scale target on representative hardware.
2. GPUix publishes a production-grade structured rich-text/editor primitive or a stable native extension API suitable for building one.
3. GPUix documents and demonstrates screen-reader accessibility for application content.
4. GPUix provides a supported signed/notarized macOS application packaging workflow and all required target architectures.
5. Forage intentionally changes its product model from one rich document to independent plain-text rows.

## Required Benchmark Before a Spike

Measure the current packaged Tauri client on representative Apple Silicon hardware with generated 1,000- and 10,000-bullet outlines:

- cold launch to editable state;
- idle resident memory;
- key event to painted text p50/p95;
- scroll frame time p50/p95;
- indent, outdent, move, collapse, and zoom latency;
- full-text search latency;
- streamed agent insertion and branch replacement latency;
- save time and main-thread interruption.

Define acceptable thresholds before collecting results. Optimize obvious full-document scans or rerendering in the current architecture before attributing the result to the webview.

## Viability Spike Gates

A GPUix spike is informative only if it demonstrates all of the following on a standalone branch or disposable project:

- import and export of the current persisted outline without data loss;
- at least 1,000 nested bullets with zoom, collapse, search, and drag reorder;
- inline rich marks, stable internal links, notes, and generated images;
- typing, paste, multi-line selection, IME composition, grapheme deletion, and keyboard navigation;
- atomic undo/redo across text, indentation, movement, deletion, and agent-generated branches;
- stable cursor/selection during structural changes and streamed agent updates;
- screen-reader inspection and complete keyboard-only operation;
- iCloud file persistence and safe settings/credential storage;
- bounded network access and constrained sidecar execution at least as strong as the current Tauri capabilities;
- a signed and notarized macOS application bundle containing all resources;
- performance results compared with the same Forage fixture and hardware.

A prototype that demonstrates only a fast list, chat transcript, or independent textareas does not satisfy these gates.

## Conclusion

GPUix is worth watching. Its native renderer, virtual lists, and automation tooling are particularly interesting for future desktop applications or secondary read-heavy surfaces. Forage's defining subsystem is a structured, transactional outliner, and GPUix does not currently replace that subsystem.

The production decision is therefore to retain Tauri + TipTap/ProseMirror, profile before re-platforming, and require a superseding ADR before any GPUix migration enters the production architecture.

## External References

- [GPUix website](https://gpuix.dev/)
- [GPUix repository and documentation](https://github.com/remorses/gpuix)
- [GPUix releases](https://github.com/remorses/gpuix/releases)
- [GPUix issues](https://github.com/remorses/gpuix/issues)
- [GPUix security page](https://github.com/remorses/gpuix/security)
- [`@gpuix/react` package](https://www.npmjs.com/package/@gpuix/react)
- [`@gpuix/native` package](https://www.npmjs.com/package/@gpuix/native)
- [Tauri architecture](https://v2.tauri.app/concept/architecture/)
- [Tauri capabilities](https://tauri.app/security/capabilities/)
- [TipTap editor API](https://tiptap.dev/docs/editor/api/editor)
- [TipTap ProseMirror concepts](https://tiptap.dev/docs/editor/core-concepts/prosemirror)
