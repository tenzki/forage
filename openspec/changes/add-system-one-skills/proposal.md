# Proposal

## Why

Users want to compare product ideas, shortlist tools, evaluate outreach drafts, and filter notes semantically through existing skills. The whole System One capability must be an extension, not a built-in evaluation engine with a Jev adapter. Forage supplies generic extension-backed skills; the System One extension supplies the feature, initially using Jev through TypeSafe.

## What Changes

- Add generic extension-backed execution alongside LLM execution in existing user-created skills. The installed extension supplies the System One execution choice and its configuration; activation never installs commands or creates skills.
- Support bounded extension-declared configuration, runtime validation, input preparation/preview, execution, and ordinary structured output. The application renders generic controls, not extension React/HTML or hardcoded System One forms.
- Put System One models, Choice/Score/Noul definitions, domain validation, candidate-selection policy, Jev requests, answer validation, semantic filtering, ordering and output formatting inside one System One extension.
- Keep discovery/trust, generic form rendering, bounded context access, plan validation, scoped credentials, source-pinned execution/cancellation, generic result validation and document insertion in Forage.
- Update the one current extension contract and existing reference extension in place, without API/manifest version discriminators, parallel versions or legacy extension adapters.
- Preserve historical LLM/configuration/result compatibility and unavailable extension skill definitions. Saved output remains ordinary content without its extension.
- Keep extension execution local-only and reject unsupported server invocation without desktop fallback.

## Capabilities

### New Capabilities

- `system-one-skills`: User-facing System One behavior supplied entirely by an extension through generic existing skills.
- `jev-system-one-provider`: Jev transport and domain validation inside the full System One extension, not a second extension or a core provider layer.

### Modified Capabilities

- `local-agent-extensions`: Generic skill-executor contributions, configuration, preparation/preview, execution and authority.
- `extension-authoring`: Generic public contracts, updated reference extension and an independently runnable full System One extension.
- `extension-packages`: Generic executor declarations and retained skill references after removal.

## Impact

- Rework unshipped slices: remove built-in System One variants, public domain contracts, desktop forms and specialized provider runners. Reuse generic safety fixes without retaining duplicate implementations.
- Create `extensions/system-one`, depending only on the public extension API. Jev is its initial backend; do not create a separate `extension-jev` package.
- Shared contracts, desktop skills/preview, extension host, sidecar and result materializer gain generic extension support only. Core production code must not import the System One package or branch on its identity, question types or settings keys.
- Preserve the existing ProseMirror schema and server-executor authority; update architecture and extension documentation.

## Non-goals

Built-in System One evaluation, a core System One provider layer, a separate Jev-only extension, extension-installed commands/skills, executable extension UI, live evaluation/search nodes, refresh/staleness controls, source-node scores, automatic reevaluation, invented explanations, composite evaluations, server extension hosting and automatic extension installation.
