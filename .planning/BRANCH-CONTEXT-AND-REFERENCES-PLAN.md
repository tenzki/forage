# Plan: Local Branch Context + Explicit Node References

## Status

Implemented after integrating the rebased branch's stable internal-link references.

## Goal

Replace configurable context strategies with one predictable rule:

```text
agent context = local input branch + explicitly referenced nodes
```

Command placement determines the local input. Structured node references are the only way to add context from elsewhere in the outline. Prompt wording must not implicitly change context selection.

## User Model

### Research or expand a topic

```text
Battery technology
├─ Existing observation
└─ /research recent developments
```

The local input is the `Battery technology` branch, excluding the command node.

### Summarize sibling notes

```text
Project findings
├─ Finding A
├─ Finding B
├─ Finding C
└─ /summarize
```

Because the command is a child of `Project findings`, the complete parent branch provides all sibling notes and their descendants.

### Add context from elsewhere

```text
Battery technology
└─ /compare with [[Hydrogen technology]]
```

The agent receives the local `Battery technology` branch plus the structured reference to `Hydrogen technology`. References are resolved by the editor's reference model, not inferred by the LLM from prompt text.

## Context Semantics

### Local input branch

1. The local context includes the full ancestor path from the top-level branch to the invocation node's parent `listItem`.
2. Include the immediate parent and all of its descendants in document order, including collapsed descendants.
3. Exclude the active invocation node and anything nested beneath it.
4. Do not include unrelated sibling subtrees attached to higher ancestors; only the ancestor path and complete immediate-parent branch are automatic.
5. A top-level command has no local input branch; it uses its prompt and explicit references only.

### Explicit references

1. Reuse the reference implementation from the branch being rebased onto; do not create a second reference parser or node identity system.
2. Resolve references through stable node IDs rather than matching mutable display text at generation time.
3. Preserve the existing reference feature's node-versus-subtree semantics unless product review after the rebase determines that references should consistently include complete referenced branches.
4. Keep referenced inputs separate and labeled so hierarchy from unrelated branches is never accidentally merged.
5. Order referenced inputs by their first appearance in the command.
6. Deduplicate repeated references and any referenced nodes already present in the local input branch.
7. Treat deleted or unresolved references as an explicit preflight error.
8. Prompt prose must not activate special context words such as “siblings,” “parent,” or “depth.” Only structured references affect additional context.

### Serialization

Send context as distinct, hierarchy-preserving sections:

```text
Local branch:
- Battery technology
  - Existing observation

Referenced nodes:
[Hydrogen technology]
- Hydrogen technology
  - Storage challenges
```

Requirements:

- Preserve outline indentation and document order.
- Keep local and referenced inputs distinguishable.
- Never flatten unrelated branches into one list.
- Exclude the invocation command from serialized context.
- Include AI-authored nodes unless a future product-level rule changes this globally.
- Apply a fixed application safety budget for nodes and characters.
- Block with a clear error when over budget; do not silently truncate or summarize context.

## Context Preview

While a valid slash command is focused:

- Highlight the local input branch with one subtle background color.
- Highlight explicitly referenced nodes with a second color.
- Mark the invocation node separately to show that it is excluded.
- Include collapsed descendants in resolution even though they are not visible.
- Show an explicit visual error for unresolved references or oversized context.
- Clear decorations on blur, generation start, view changes, or invalid command state.
- Keep decorations ephemeral: they must never enter TipTap content, persistence, or undo history.

## Settings Simplification

Remove context configuration from persisted skills and the skill editor:

- Context presets
- Anchor selection
- Ancestor selectors
- Descendant depth controls
- Sibling direction/subtree controls
- AI/empty/invocation filters
- Per-skill node and character budgets
- Truncate/block controls

A skill should return to describing workflow behavior:

- Slash command label
- Description
- Instructions
- Assigned agent

Context is determined consistently by command placement and explicit references, not by hidden skill configuration.

## Implementation Plan After Rebase

### 1. Inventory the rebased reference feature

- Locate its TipTap node/mark representation, stable-ID storage, autocomplete, parsing, and resolver.
- Confirm whether a reference currently means node-only or node-plus-descendants.
- Confirm how renamed and deleted targets are handled.
- Identify how references are represented separately from plain prompt text.
- Add integration around that implementation rather than duplicating it.

### 2. Remove the current strategy model

- Remove `SkillContextStrategy`, presets, anchors, selectors, filters, and per-skill budgets from `src/agent/definitions.ts`.
- Remove strategy cloning and validation.
- Remove `SkillContextSettings` from the skill form.
- Accept persisted skills containing the obsolete field and discard it safely during loading.
- Remove obsolete settings styles and tests.

### 3. Implement local branch resolution

Create a focused resolver that accepts the document and invocation node ID and returns:

- Local branch root ID, if one exists
- Ordered local node records with depth
- Invocation exclusion metadata
- Deterministic serialized local context

The resolver must operate on the ProseMirror document rather than rendered DOM, so collapsed content remains available.

### 4. Integrate explicit references

- Resolve structured references from the invocation using the rebased feature.
- Convert resolved targets into labeled context records.
- Deduplicate overlaps using stable node IDs.
- Fail preflight on unresolved references.
- Preserve reference appearance order.

### 5. Build and validate the combined context

- Combine local input first, then referenced inputs.
- Enforce fixed node and character limits.
- Return structured metadata for preview and diagnostics alongside serialized text.
- Pass the combined value to Pi as `Selected outline context` without asking the model to discover context from the prompt.

### 6. Simplify preview decorations

- Replace strategy-based preview resolution with combined local-branch/reference resolution.
- Add distinct local and referenced decoration classes.
- Preserve invocation and error styling.
- Ensure reference edits refresh the preview immediately.

### 7. Update generation flow

- Resolve and validate combined context before inserting the output placeholder.
- Keep output insertion under the invocation node unless addressed by a separate output-placement change.
- Preserve structured `emit_outline` insertion and single-step undo behavior.
- Ensure failed preflight does not create an AI placeholder.

### 8. Update documentation

- Document command placement as the context mechanism.
- Document references as the only external-context mechanism.
- Remove descriptions of configurable context strategies from ADR-0008, `CLAUDE.md`, `.planning/PROJECT.md`, and `.planning/ROADMAP.md`.

## Test Plan

### Local branch

- A command under a leaf sends the full ancestor path through the parent node.
- A command under a populated branch sends the ancestor path, parent, and all parent descendants.
- Sibling notes and nested descendants are included.
- The invocation node and its descendants are excluded.
- Collapsed descendants are included.
- A top-level command has no automatic local branch.

### References

- One cross-branch reference is added after local context.
- Multiple references preserve command appearance order.
- Duplicate references are serialized once.
- A reference overlapping local context is not duplicated.
- Renaming a referenced node does not break its stable target.
- A deleted or unresolved reference blocks generation visibly.

### Safety and UX

- Oversized context blocks rather than truncates silently.
- Prompt words such as “siblings” do not change context.
- Local and referenced nodes receive different ephemeral decorations.
- Decorations clear on blur and generation.
- Preview transactions do not affect persistence or undo history.
- Generation still inserts nested structured output atomically.

## Acceptance Criteria

- Users can predict input solely from command placement and visible references.
- Skills contain no context-selection configuration.
- A child command receives its full ancestor path and complete parent branch automatically.
- Cross-branch context comes only from structured references.
- The exact included nodes are visible while composing the command.
- Context hierarchy is preserved and bounded without silent truncation.
- Existing structured generation and undo behavior remain intact.

## Out of Scope

- Manual click-to-select context
- Natural-language context interpretation
- Per-invocation depth modifiers
- Per-skill context selector configuration
- Automatic semantic search for related notes
- Output placement or replacement controls
