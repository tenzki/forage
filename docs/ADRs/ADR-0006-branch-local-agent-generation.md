# ADR-0006: Run Skills as Branch-Local Agent Generation

- **Status:** Accepted
- **Date:** 2026-08-14
- **Deciders:** AI Chat project team
- **Supersedes:** None
- **Superseded by:** None

## Context

The product integrates AI into an outliner rather than presenting a separate chat surface. A user must be able to invoke a focused capability from any bullet, provide the surrounding branch as context, and retain generated material as ordinary outline content. Generation must not steal the selection or create an undo step for every streamed token.

Skills are configurable workflows assigned to agent profiles, but context selection remains one application-level rule rather than a per-skill setting.

## Decision Drivers

- Keep users in the outliner rather than switching to a chat panel.
- Make invocation discoverable but avoid false positives for slashes in prose or URLs.
- Make context predictable from command placement and visible stable-ID references.
- Clearly distinguish AI-authored content.
- Preserve coherent undo and cancellation behavior during streaming.
- Avoid coupling outline nodes to an external agent-session model.

## Considered Options

1. **Branch-local slash skills** — commands at the start of a bullet create AI child bullets using their ancestor path, parent branch, and explicit references.
2. **Separate chat panel** — converse with the model outside the outline and manually copy results.
3. **Autonomous whole-document agent** — allow the model to choose and mutate arbitrary outline locations.
4. **Inline replacement** — replace the invoking bullet directly with the generated response.

## Decision

We will **invoke skills through slash commands at the start of a bullet and write their output into AI-marked child bullets using the command's ancestor path, parent branch, and explicit stable-ID references** because **this makes both scope and output placement visible in the outline while keeping provenance and user control explicit**.

Selecting a command first completes `/skill ` so the user can add a prompt and internal links; Enter runs it. The full ancestor path and complete parent branch are local input, including collapsed descendants and excluding the invocation subtree and unrelated sibling subtrees of higher ancestors. A top-level command has no automatic local input. Structured references are the only way to add other branches. Preflight resolves missing targets, deduplicates overlap, and enforces a fixed blocking budget before output is inserted. The slash prefix is then removed without discarding link marks. Structured results become nested AI bullets under the prompt note. Streaming writes set `addToHistory: false`, allowing one undo to remove the generated branch.

## Consequences

### Positive

- Agent interaction remains spatially attached to the relevant note.
- Command placement and visible references define context without a separate conversation store.
- `nodeType: "ai"` makes provenance visible and persistent.
- Stream updates do not move the user's selection or flood undo history.
- Cancellation and failure states remain visible in the generated branch.

### Negative

- Branch context is plain text and loses rich formatting and metadata.
- Plain-text streaming fallback still depends on line parsing when structured output is unavailable.
- Referenced branches add context only when users insert explicit internal links.
- A single active generation policy limits concurrent work.
- Replacing slash-command text with the prompt removes the literal invocation from the note.

### Risks and Mitigations

- **Risk:** Mid-sentence slash characters open or execute commands unexpectedly.  
  **Mitigation:** Activate the menu only when the current bullet text begins with `/`.
- **Risk:** Stream transactions disrupt typing or selection.  
  **Mitigation:** Insert with `updateSelection: false`, identify the output by stable node ID, and keep stream writes out of history.
- **Risk:** Partial output is mistaken for complete output.  
  **Mitigation:** Show a placeholder while generating and write explicit `[cancelled]` or `[error: …]` content on termination.
- **Risk:** Large local or referenced branches exceed safe context limits.
  **Mitigation:** Block before generation when the fixed node or character budget is exceeded; never truncate silently.

## Option Analysis

### Option A: Branch-Local Slash Skills

**Advantages**

- Matches the tree-first product model.
- Invocation scope and output location are explicit.
- Requires no separate session database.

**Disadvantages**

- Command parsing and streaming must cooperate with editor transactions.
- Branch context is intentionally fixed rather than skill-configurable.

### Option B: Separate Chat Panel

**Advantages**

- Familiar conversational UI and independent message history.
- Streaming does not mutate the outline during generation.

**Disadvantages**

- Breaks the user's outliner flow.
- Requires copying or an additional insertion workflow to retain useful results.

### Option C: Autonomous Whole-Document Agent

**Advantages**

- Can reorganize and synthesize content across branches.
- Supports richer multi-step automation.

**Disadvantages**

- Much larger mutation and trust surface.
- Harder to preview, constrain, attribute, and undo safely.

### Option D: Inline Replacement

**Advantages**

- Compact output with no child structure.
- Straightforward for completion-style tasks.

**Disadvantages**

- Can overwrite the user's original note or mix authorship.
- Does not naturally represent multi-idea structured results.

## Implementation Notes

`src/components/Agent/SlashMenu.tsx` owns command detection, completion, preview, and invocation. `src/agent/context.ts` resolves the ancestor path, parent branch, and `internalLink` marks through stable node IDs. `src/agent/insertIntoEditor.ts` runs preflight, inserts the AI list, streams stable-ID replacements, and handles cancel/error states.

Broad agent-controlled document mutation still requires separate decisions about validation, permissions, and undo behavior.

## Validation

- Slashes outside the start of a bullet never open the menu.
- Keyboard selection and execution work without moving focus unexpectedly.
- The model receives a hierarchy-preserving local branch followed by separately labeled referenced branches.
- Missing references and oversized context block before an AI placeholder is created.
- Multi-line output creates one AI-marked bullet per non-empty line.
- The user can keep typing elsewhere during generation.
- Cancellation and provider errors produce visible terminal states.
- One undo removes the generated branch without undoing unrelated user typing.

## References

- `src/components/Agent/SlashMenu.tsx`
- `src/agent/skills.ts`
- `src/agent/insertIntoEditor.ts`
- `src/editor/extensions.ts`
- `src/style.css`
