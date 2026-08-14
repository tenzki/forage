# ADR-0006: Run Skills as Branch-Local Agent Generation

- **Status:** Accepted
- **Date:** 2026-08-14
- **Deciders:** AI Chat project team
- **Supersedes:** None
- **Superseded by:** None

## Context

The product integrates AI into an outliner rather than presenting a separate chat surface. A user must be able to invoke a focused capability from any bullet, provide the surrounding branch as context, and retain generated material as ordinary outline content. Generation must not steal the selection or create an undo step for every streamed token.

The v1 skill set is intentionally small and built into the application. Configurable skill definitions are deferred.

## Decision Drivers

- Keep users in the outliner rather than switching to a chat panel.
- Make invocation discoverable but avoid false positives for slashes in prose or URLs.
- Use branch ancestry as relevant, bounded context.
- Clearly distinguish AI-authored content.
- Preserve coherent undo and cancellation behavior during streaming.
- Avoid coupling outline nodes to an external agent-session model.

## Considered Options

1. **Branch-local slash skills** — commands at the start of a bullet create AI child bullets using ancestor context.
2. **Separate chat panel** — converse with the model outside the outline and manually copy results.
3. **Autonomous whole-document agent** — allow the model to choose and mutate arbitrary outline locations.
4. **Inline replacement** — replace the invoking bullet directly with the generated response.

## Decision

We will **invoke hardcoded v1 skills through slash commands at the start of a bullet and stream their output into AI-marked child bullets using enclosing branch context** because **this makes AI output part of the outline while keeping scope, provenance, and user control explicit**.

Selecting a command first completes `/skill ` so the user can add context; Enter runs it. The command text is replaced by the clean prompt note. Output lines become sibling AI bullets under that note. The initial child insertion is the generation's history event; subsequent streamed replacements set `addToHistory: false`, allowing one undo to remove the generated branch.

## Consequences

### Positive

- Agent interaction remains spatially attached to the relevant note.
- Existing ancestor text provides context without a separate conversation store.
- `nodeType: "ai"` makes provenance visible and persistent.
- Stream updates do not move the user's selection or flood undo history.
- Cancellation and failure states remain visible in the generated branch.

### Negative

- Branch context is plain text and loses rich formatting and metadata.
- One-line-per-bullet output depends on prompt compliance and line parsing.
- Hardcoded skills require a code release to change.
- A single active generation policy limits concurrent work.
- Replacing slash-command text with the prompt removes the literal invocation from the note.

### Risks and Mitigations

- **Risk:** Mid-sentence slash characters open or execute commands unexpectedly.  
  **Mitigation:** Activate the menu only when the current bullet text begins with `/`.
- **Risk:** Stream transactions disrupt typing or selection.  
  **Mitigation:** Insert with `updateSelection: false`, identify the output by stable node ID, and keep stream writes out of history.
- **Risk:** Partial output is mistaken for complete output.  
  **Mitigation:** Show a placeholder while generating and write explicit `[cancelled]` or `[error: …]` content on termination.
- **Risk:** Large ancestor branches exceed useful context limits.  
  **Mitigation:** Continue using only enclosing list-item text and introduce explicit context budgeting before adding descendants or the whole document.

## Option Analysis

### Option A: Branch-Local Slash Skills

**Advantages**

- Matches the tree-first product model.
- Invocation scope and output location are explicit.
- Requires no separate session database.

**Disadvantages**

- Command parsing and streaming must cooperate with editor transactions.
- The branch context strategy is intentionally simple.

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

`src/components/Agent/SlashMenu.tsx` owns command detection, completion, and invocation. `src/agent/skills.ts` is the v1 skill registry. `src/agent/insertIntoEditor.ts` extracts branch context, inserts the AI list, streams stable-ID replacements, and handles cancel/error states.

Custom skill configuration and broad agent-controlled document mutation require separate decisions about validation, permissions, and undo behavior.

## Validation

- Slashes outside the start of a bullet never open the menu.
- Keyboard selection and execution work without moving focus unexpectedly.
- The model receives enclosing bullet text in outer-to-inner order.
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
