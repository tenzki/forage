# Design

## Corrected boundary

The earlier built-in System One / Jev-adapter architecture is superseded. The whole System One feature belongs to an extension. Previous slice completion does not establish compliance with this design; preserve work and extract reusable generic infrastructure.

The canonical architecture remains [docs/architecture.md](../../../docs/architecture.md): one ProseMirror outline, stable IDs, application-owned context authority and ordinary document events. Extensions are trusted local Node.js code, not an OS sandbox. Server execution never falls back to desktop extensions.

## Decisions

### 1. Generic extension-backed skills

Persist built-in LLM skills and generic extension-backed skills. The latter contain user-defined identity/label/description, an extension-qualified executor reference and bounded non-secret JSON configuration. Core validates the generic envelope and declared structure, not executor-specific configuration keys or domain unions.

Populate execution choices from installed extension declarations. System One is an extension-supplied label, not a built-in execution discriminator. No installation creates commands or skills. Without the extension, its choice is absent for new skills; existing references/configuration remain stored as unavailable. Keep historical LLM/configuration/result readers, but no compatibility adapters for unshipped extension APIs. Portable skill and device-local extension configuration revisions remain independent.

### 2. Extension-owned configuration, generic rendering

Generic executor declarations include stable identity, display metadata and bounded declarative configuration/form descriptions. Runtime operations validate configuration, prepare input and execute a skill. Built-in controls support text, multiline text, numbers, booleans, choices, bounded objects/repeated groups and conditional branches. Define allowed constructs and depth/size/field limits explicitly; reject unsupported declarations. No executable React/HTML/webview extension UI.

The System One extension declares every model/question/category/rubric/definition/scope/order/threshold field and owns domain validation. Host validation enforces generic structure and safety, not Choice/Score/Noul semantics. Secrets are separate source settings, never portable skill configuration.

Manifest inventory and form rendering require no code import. Runtime validation/preparation requires explicit trust and enablement, bounded processes and no inference credentials. System One implements these phases deterministically without network/billable calls. Trusted code still has process permissions; this is not a network sandbox.

### 3. Host context authority, extension selection policy

Forage supplies one immutable context tree with stable IDs, text, hierarchy/document order, invocation location, local parent branch, full ancestor path and explicit linked branches. Exclude the invocation subtree and image bytes; serialize each node once. Enforce existing 100-node/40,000-character bounds including invocation text, and reject missing links before extension preparation. Extensions receive no editor or arbitrary outline access.

An executor prepares a bounded generic plan identifying selected input IDs, descriptive preview annotations and non-secret prepared data. The host validates IDs against its snapshot and enforces plan bounds. It renders generic selection/shared-context/exclusion highlights without interpreting domain configuration. Pin the plan, configuration and source revision; execution uses precisely the previewed plan, not an independently recomputed selection. Preparation has no credentials or document-commit ability.

System One owns sibling/descendant candidate policy. Direct text siblings carry subtree evidence; descendant mode selects text notes in document order. Ancestors and explicitly linked branches are shared evidence, not additional candidates. The extension rejects no candidates or fewer than two comparative choices and supplies domain-specific labels/errors. Core does not branch on candidateScope or question type. Earlier plain outputs can be selected as ordinary content; preview makes this visible without hidden managed-node metadata.

### 4. One generic executor host

Update the existing manifest/API in place with generic skill executors alongside tools/hooks. Remove API/manifest version discriminators and negotiation; retain ordinary package release versions. Update `extensions/reference`, fixtures, tests and documentation together. Validate static/runtime agreement semantically, independent of object property order. Untrusted inventory never imports entries; conflicting extension-qualified identities are unavailable.

Run only the admitted executor in an isolated local process with scoped declared settings/secrets, context/plan/configuration, cancellation and bounded activity. No Pi session, LLM credentials or unrelated hooks. The host owns source verification, managed-revision leases, deadlines/termination, stale/late-result rejection and sanitization of decoded observable data, including nested logs, without corrupting result payloads.

The executor returns one complete ordinary structured result, not a System One answer union. Host validation enforces output limits and reference targets against host-admitted IDs, never a self-authorized extension allowlist. Reject invalid/late results atomically; extensions cannot mutate the document.

### 5. Full System One extension with Jev inside

Create independent `extensions/system-one` using only the public API. Keep the deterministic tool reference package separate. Dependency installation does not register, trust, enable or select an extension. There is no separate Jev-only Forage extension and no System One provider abstraction in core.

The extension owns its execution label, configuration, domain types and validation, preparation/candidate selection, Choice comparison/classification, Score rubrics, Noul questions, semantic filtering, numeric ordering and output formatting. Jev/TypeSafe is its initial backend; additional backends need no desktop or shared-host changes.

The internal Jev adapter owns authenticated requests, scoped TypeSafe credentials, batching, request/question/response bounds, cancellation, deadlines and sanitized failure classification. Comparative Choice alternatives stay in one comparison. Independent questions sharing state may be batched within bounds; excessive expansion fails without truncation. No automatic billable retries.

Validate complete candidate/category IDs, finite values/ranges, distributions within documented tolerance, selected options and rubric/legend consistency inside the extension before formatting. Noul exposes yes probability, not invented confidence. Core validates only the generic result contract/references. Recheck TypeSafe primary documentation when implementing the adapter; default checks use mocked HTTP, not paid requests.

### 6. Extension formatting, host insertion

The extension returns ordinary text/reference nodes containing the question, relevant rubric/categories/threshold and candidate rows with snapshot labels and stable IDs. Choice labels probabilities and selected options/categories; Score uses its native explicit rubric scale; Noul labels yes probabilities. Confidence is separately labelled where supplied. Do not invent explanations.

Sorting and inclusive Noul filtering use unrounded values; document order breaks ties and rounding is display-only. Empty filtering yields a no-matches summary. All these semantics live in the extension.

Forage materializes generic references as existing internalLink marks and owns aggregate text limits, atomic placement, provenance, event persistence, synchronization, undo/redo and completed_unplaced recovery. It does not interpret scores/questions/thresholds. Moves/renames/trash follow existing link behavior. Source nodes remain unchanged. Saved output remains readable/editable after extension removal, with no code execution on reopening/replay and no refresh/staleness UI.

### 7. Authority and boundary proof

Server readers preserve generic executor references and bounded non-secret configuration, but local-only execution is rejected before queueing with no desktop fallback. Installing/restoring a source never bypasses trust or validation.

A deterministic non-evaluation executor fixture must work through the same configuration renderer, preparation, runner and ordinary output path without core changes. Core production code must have no System One/Jev imports, identity branches, question enums or scoring/filtering logic. Integration tests may name System One; generic host tests use generic fixtures.

## Risks / Trade-offs

- Declarative forms/preparation expand the host surface: bound supported constructs and avoid an arbitrary application plugin framework.
- Extraction can leave duplicate domain code: remove core implementations rather than wrapping or renaming them.
- Trusted preparation can access Node.js resources: retain honest trust disclosure and process limits.
- Numeric precision can mislead: extension criteria, labels and representative-note trials matter.
- Existing data compatibility remains necessary even though extension API compatibility does not.

## Transition plan

Stop the superseded slice. Reset completion claims pending verification against the corrected boundary and re-slice around generic contracts, host, UI and the complete feature extension. Preserve the shared worktree; reuse unique-context counting, aggregate text limits, source pinning, cancellation and security fixes. Do not reset/stage/commit as part of replanning.

Implement generic infrastructure and the full extension, then connect safe ordinary output placement. Keep paid execution gated until complete output can be retained/placed. Verify independence with the non-evaluation fixture, LLM regressions, server authority, replay and extension removal.
