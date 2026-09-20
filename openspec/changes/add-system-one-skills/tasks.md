# Tasks

## Replan status

This replaces the earlier built-in System One / Jev-adapter slices. The old slice 3 is stopped. Existing edits and review fixes are retained for reuse, but all tasks require verification against the corrected ownership boundary; old completion checkmarks do not transfer. Implement one revised slice at a time.

## 1. Generic skill and extension contracts

- [x] 1.1 Replace unshipped System One-specific skill/run/provider variants with generic extension-backed skills, bounded non-secret config and extension-qualified executor authority; preserve historical LLM/configuration/result readers and unknown executor references.
- [x] 1.2 Define bounded declarative per-skill configuration plus generic validation/preparation/execution contracts, without domain question/model types; verify independent public API typechecking and unsupported-schema rejection.
- [x] 1.3 Define generic immutable context, prepared plans, preview annotations and host-admitted reference IDs; verify unique-node budgets, plan confinement, independent portable/local revisions and aggregate result-text limits.
- [x] 1.4 Update the single current manifest and reference extension in place without version negotiation/adapters; verify existing tool/hook behavior and order-independent semantic declaration agreement.

## 2. Generic executor host

- [x] 2.1 Generalize inventory, readiness, ownership/collisions and runtime registration to generic skill executors; verify untrusted entries are not imported and undeclared contributions fail closed.
- [x] 2.2 Run bounded config validation/input preparation without inference credentials; validate selected IDs, preview/data bounds and source-pinned plans.
- [x] 2.3 Generalize direct execution, scoped settings/secrets and managed leases without Pi, LLM credentials or unrelated hooks; verify actual packaged workers/sidecar.
- [x] 2.4 Enforce generic complete-result validation, cancellation, process deadlines and late rejection; verify host-owned reference allowlists and redaction of decoded/nested logs/activity/errors.
- [x] 2.5 Show generic executor contributions/readiness and preserve selections through reload/disable/removal; verify external directories and saved output survive removal.

## 3. Generic skill UI and invocation

- [x] 3.1 Populate existing skill execution choices from built-in LLM plus extension declarations; remove hardcoded System One forms/branches and retain unavailable references without creating commands/skills.
- [x] 3.2 Render bounded declared fields/repeated groups/conditional branches and surface validation; verify with a non-evaluation fixture, not app-owned question controls.
- [x] 3.3 Supply generic ancestor/local-parent/linked snapshots and validated preparation previews; verify stable IDs, invocation/image exclusion, exact budgets and missing references without domain candidate policy in core.
- [x] 3.4 Route existing slash skills through generic admission/execution with declared empty-prompt policy; verify no LLM credential dependency and pre-request unavailable/server failures.
- [x] 3.5 Keep incomplete production placement gated before paid execution until slice 5 is ready; verify no result discard or fake success.

## 4. Full System One extension

- [x] 4.1 Create independent public-API-only extensions/system-one with its execution label and configuration declarations; verify filtered checks and no activation through installation. Do not create a separate Jev-only extension.
- [x] 4.2 Implement Choice comparison/classification, Score rubrics, Noul definitions and domain validation in the extension; test invalid settings and idea/tool/outreach/filter configurations.
- [x] 4.3 Implement deterministic sibling/descendant candidate preparation and preview labels in the extension; test shared linked/ancestor evidence, invocation exclusion, document order, no candidates and too few comparative choices.
- [x] 4.4 Implement internal Jev/TypeSafe transport, batching, scoped secrets and bounded cancellable requests; verify complete Choice sets and controlled errors without automatic billable retries.
- [x] 4.5 Validate domain answers and format ordinary linked output inside the extension; test distributions/rubrics/completeness, confidence labels, raw-value sorting, stable ties, inclusive thresholds and no-matches output.
- [x] 4.6 Exercise every mode through the generic host with mocked HTTP, no LLM credentials, source changes/cancellation/missing secrets and actual-model reporting.

## 5. Generic ordinary-output integration

- [x] 5.1 Materialize extension-returned text/reference nodes with existing links and atomic placement, without core scoring/filtering/formatting; validate bounds and host-admitted targets.
- [x] 5.2 Connect generic execution to usable result placement and remove the pre-request gate only when complete results can be safely retained; test progress/cancellation/failure and disappeared-target recovery.
- [x] 5.3 Verify navigation after rename/move/trash, persistence/replay/sync and undo/redo without extension code; keep source nodes unchanged.
- [x] 5.4 Verify removal preserves plain output and unavailable skills; new runs create separate output and editing/reopening never evaluates or adds refresh/stale-state controls.

## 6. Configuration and execution authority

- [x] 6.1 Update server readers/capability checks for generic executor-backed skills; reject unavailable execution before queueing without desktop fallback.
- [x] 6.2 Preserve supported LLM/configuration/result compatibility and bounded unknown executor config without secrets/trust/paths; verify unsupported peer diagnostics.
- [x] 6.3 Reconcile shared contracts with server-executor work and run local/server LLM regressions preserving admission/placement authority.

## 7. Boundary proof, documentation and verification

- [x] 7.1 Add a non-System-One executor fixture using the same forms/preparation/execution/output path with no app changes.
- [x] 7.2 Audit core production code for domain imports/types, identity branches and scoring/filtering logic; move feature code into the extension and remove duplicates.
- [x] 7.3 Update ADR/architecture/authoring/user docs for whole-feature extension ownership, one current contract, one skill system, trusted code and static output.
- [x] 7.4 Run affected API/host/extension/desktop/server/replay checks, independent package typechecks, build and strict OpenSpec validation without paid calls or development database tests.
- [x] 7.5 Perform a real Tauri mocked smoke test covering installation, configuration, preview, invocation, links, cancellation, undo/restart/removal, absence without installation and unavailable server mode.
