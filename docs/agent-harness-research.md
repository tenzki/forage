# Agent harness research: practices from Pi, Flue, and production agent systems

**Research date:** 2026-08-14  
**Target:** the current `ai-chat` Tauri outliner  
**Scope:** agent-harness architecture, context, tools, sessions, durability, security, observability, and evaluation. Sources are primarily official Pi, Flue, Anthropic, and OpenAI documentation.

## Executive summary

The current app already contains the beginning of a harness: it selects a skill, builds branch context, calls a model, streams output, supports abort signals, and materializes results into the outline. It is not yet a general agent harness because it has no model-driven tool loop, durable run lifecycle, event/trace model, context compaction, or behavioral eval suite.

The most useful lessons are:

1. **Keep the core small and make capabilities composable.** Pi deliberately uses a minimal prompt and tool set; Flue builds larger production features around similarly explicit primitives.
2. **Treat context as a finite product resource.** Build the smallest high-signal context for each run, disclose skills and references only when needed, and preserve prompt-cache-stable prefixes.
3. **Design tools as an agent-computer interface, not as raw API wrappers.** Give each tool a distinct purpose, strict schema, concise output, actionable errors, abort support, and application-bound authorization.
4. **Separate the durable record from the model's current context.** Keep complete history/provenance, but send only the active branch and selected summaries to the model.
5. **Represent a generation as a lifecycle, not just streamed text.** A run needs an ID, status, timestamps, model/skill provenance, cancellation, errors, and a terminal outcome.
6. **Make actions reversible and crash-legible.** On restart, an unfinished run should become `interrupted`, not remain as an unexplained `…` bullet.
7. **Instrument before adding autonomy.** Capture model turns, tool calls, latency, usage, cancellation, and failures separately from user-visible notes.
8. **Build evals around outcomes and realistic traces.** Unit-test deterministic code; use a separate live-model suite for skill selection, context use, output quality, and tool behavior.
9. **Add multi-agent, MCP, broad model support, and production durability only when a measured need appears.** They are not good v1 defaults for this local-first app.
10. **Do not reintroduce the discarded Pi sidecar architecture.** Borrow Pi and Flue's design patterns while keeping the current direct TypeScript/Anthropic path for v1.

The most immediate product issue is that `/research` currently has **no retrieval tool**. It can synthesize model knowledge, but it cannot investigate current sources or provide verifiable citations. Either rename it to reflect that limitation or give it a narrow search/fetch capability before claiming research.

---

## 1. What an agent harness owns

A useful definition synthesized from the sources is:

> An agent harness is the runtime around a model that decides what the model sees, what actions it can take, how actions execute, how work is recorded, and how the system recovers, stops, and is evaluated.

A complete harness commonly owns:

- **Input:** prompts, signals, attachments, and queued user steering.
- **Context:** instructions, active conversation branch, retrieved data, skills, memory, and compaction.
- **Model runtime:** provider/model selection, streaming, retries, usage, and aborts.
- **Tools:** schemas, validation, execution, progress, authorization, and error results.
- **Agent loop:** model call → tool calls → tool results → next model call → terminal answer.
- **Sessions:** identity, branch history, provenance, and persistence.
- **Durability:** accepted work, interruption recovery, idempotency, and terminal outcomes.
- **Presentation:** streamed text and structured UI data without coupling UI state to provider events.
- **Operations:** traces, metrics, errors, privacy controls, and eval artifacts.

The model is therefore only one component. Flue expresses this as an agent made from an **LLM, harness, and specialized context**. Pi demonstrates that the harness can still remain small.

---

## 2. Current app baseline

The present implementation is intentionally simple:

- `src/agent/skills.ts` defines three hardcoded prompt-based skills.
- `src/components/Agent/SlashMenu.tsx` selects a skill when a bullet begins with `/`.
- `src/agent/insertIntoEditor.ts` gathers enclosing list-item text, inserts an AI child, streams text into bullets, and preserves ProseMirror undo behavior.
- `src/agent/client.ts` performs one direct Anthropic Messages call with streaming and an `AbortSignal`.
- `src/persistence/outlineFile.ts` persists the whole TipTap document to one iCloud JSON file.
- `src/store/settingsStore.ts` stores the user's Anthropic key with Tauri's store plugin.

This already provides five harness responsibilities:

1. command routing;
2. context construction;
3. model invocation;
4. streaming/cancellation plumbing;
5. output projection into the product's native tree.

Important gaps relative to a fuller harness:

- There is no tool-use loop, so the model cannot retrieve or act.
- The context builder includes enclosing bullets only; it does not include siblings despite the stated requirement, and the current prompt can be duplicated as both context and task.
- A generation has no stable run record or explicit status beyond text such as `[cancelled]`.
- Cancellation exists internally but has no clear user-facing cancel control for the active run.
- Errors are converted into bullet text and swallowed by the generation promise, which makes operational failure hard to observe.
- No token, cost, latency, stop-reason, or provider diagnostics are recorded.
- A crash can leave a placeholder or partial answer without an `interrupted` state.
- `/research` has no live retrieval or citation path.
- Existing tests validate editor insertion mechanics, not model-driven behavior.

---

## 3. Cross-source best practices

### 3.1 Start with the simplest system that works

Anthropic recommends beginning with a single model call or a simple composable workflow and adding agentic complexity only when it improves measured outcomes. Pi applies the same philosophy to a coding harness: a small system prompt and a few familiar tools are sufficient for strong performance. Flue is more featureful, but its agent function still explicitly composes only the capabilities that agent needs.

**Implication for this app:** keep direct Anthropic streaming for v1. Do not add a general orchestration framework merely because the product can be described as a harness. Add a real agent loop only for skills that need tools or iterative verification.

### 3.2 Treat context as a limited attention budget

Anthropic's context-engineering guidance recommends the smallest high-signal token set that can produce the desired behavior. More context can cause “context rot,” where recall and reasoning degrade even before a hard context limit is reached.

Useful patterns across Pi and Flue:

- Keep system instructions clear, direct, and at the right level of specificity.
- Keep stable instructions and tool definitions stable to preserve provider prompt caching.
- Retrieve additional information just in time instead of injecting everything up front.
- Use identifiers—node IDs, paths, links, query handles—to retrieve detail on demand.
- Make skills progressively disclosed: expose a short name/description first and load full instructions only after selection.
- Compact old conversation history while retaining recent turns and critical decisions.
- Keep persistent notes outside the active context when work spans many turns.

**Implication for this app:** branch structure is an excellent context selector, but context needs an explicit policy. A request should distinguish:

```text
Stable instructions
Selected skill instructions
Ancestor path (outer → parent)
Current node/task
Optional sibling or child evidence
Optional retrieved sources
Recent run history or summary, only when continuing a conversation
```

Avoid flattening the entire branch into one undifferentiated user string. Cap each section and record what was omitted.

### 3.3 Make skill routing explicit and progressively disclosed

Pi and Flue both support the open Agent Skills format. The model sees a skill's short description and loads its full instructions only when needed. Flue emphasizes that the description carries the routing decision and should say both **what** the skill does and **when** to use it.

For this app, slash selection already makes routing explicit, so progressive disclosure is not important for the three v1 skills. It becomes useful when custom skills arrive:

- store each skill as a versioned definition rather than a growing TypeScript array;
- separate metadata, instructions, output mode, allowed capabilities, and supporting resources;
- validate names and descriptions;
- persist the skill ID/version on generated content;
- adopt `SKILL.md` compatibility only in v2, when portability has actual value.

### 3.4 Tools are model-facing product APIs

Anthropic reports spending more effort on tool design than on the overall prompt in some agent systems. Pi's tools are deliberately few and familiar. Flue adds production contracts around typed inputs, errors, cancellation, progress logs, authorization, and durable side effects.

A good tool should:

- perform one distinct, high-value action;
- have an unambiguous name and description;
- say when it should and should not be used;
- validate a strict top-level input schema;
- return concise, semantically meaningful data;
- support filtering, pagination, range selection, or truncation;
- return actionable validation and runtime errors to the model;
- accept and propagate `AbortSignal`;
- expose progress separately from the model-visible result;
- bind credentials and authorization in application code, not model arguments;
- use idempotency keys for external side effects.

Prefer `search_sources(query)` over `list_everything()`, and prefer a domain action such as `fetch_source(url)` over a generic arbitrary HTTP tool unless unrestricted networking is truly required.

**First useful tool for this app:** a constrained research capability that searches and fetches sources, returning title, URL, publication date when available, and short relevant excerpts. Generated claims should retain source references that can be rendered as child nodes or metadata.

### 3.5 Separate model content, UI detail, and operational telemetry

Pi tools can return model-facing content separately from structured UI details. Flue similarly separates conversation data parts from model-visible text, and separates the product conversation stream from its operational runtime event stream.

This prevents three common problems:

- the UI parsing unstructured tool text;
- the model paying tokens for presentation-only data;
- private prompts and tool payloads leaking into telemetry by default.

**Implication for this app:** do not make bracketed strings such as `[error: …]` the source of truth. Keep a structured run state and render it into the outline. A research result should be able to carry structured citations even if the visible bullet remains plain text.

### 3.6 Sessions should preserve full history while context follows one branch

Pi stores sessions as append-only JSONL entries linked by `id` and `parentId`. The complete tree remains available, while only the active path—plus compaction and branch summaries—is rebuilt for the model. This cleanly separates audit history from working context.

The app's outline tree and a model session tree should **not** be forced into a 1:1 mapping; that coupling was already rejected during the re-platform. The reusable principle is narrower:

- keep node identity stable;
- associate each generation with a source node and output nodes;
- record a parent run only when a user explicitly continues or regenerates a prior run;
- build context from product semantics at call time;
- preserve abandoned/regenerated output as normal outline history or through native undo, not hidden provider session state.

### 3.7 Every run needs a terminal lifecycle

Pi exposes streaming, turn, tool, retry, compaction, abort, and settled events. Flue goes further with an accepted-work contract: admitted work eventually becomes `completed`, `failed`, or `aborted`, and interruption recovery is based on durable evidence.

A local personal app does not need Flue's distributed lease system, but it does need explicit states:

```ts
type RunStatus =
  | 'queued'
  | 'streaming'
  | 'completed'
  | 'cancelled'
  | 'failed'
  | 'interrupted'
```

Recommended invariants:

- each run has a stable `runId`;
- output nodes store provenance (`runId`, skill, model, status);
- cancellation is idempotent;
- every started run reaches one terminal status;
- app startup converts persisted non-terminal runs to `interrupted`;
- retries create traceable attempts rather than silently replacing failures;
- partial output is preserved when useful and clearly marked.

### 3.8 Durability means more than saving conversation text

Flue separates:

- conversation durability;
- accepted-submission durability;
- persistent state;
- sandbox/workspace durability;
- external side effects.

A durable conversation does not make files or API actions durable. For side effects, Flue uses named durable steps and still requires idempotency because execution can be at least once.

**Implication for this app:** the v1 problem is smaller but real. The outline should be written atomically where supported (temporary file + replace, with a recoverable backup), and in-progress generations need persisted status. If tools later perform external writes, every effectful tool needs a stable idempotency key derived from the run/tool-call identity.

### 3.9 Give autonomy the narrowest safe environment

Pi is intentionally unrestricted by default and recommends external sandboxing when that is not acceptable. Flue makes sandbox attachment explicit and recommends the narrowest environment that supports the task. It distinguishes an in-memory virtual shell, an unrestricted local host shell, and remote isolated sandboxes.

For this app:

- do not add filesystem or shell tools for research/brainstorming;
- add narrow application tools before general execution tools;
- never expose the full process environment to a model-directed shell;
- keep API credentials outside tool arguments and model context;
- validate URLs and restrict protocols/hosts if a fetch tool is added;
- treat fetched pages and note content as untrusted prompt-injection sources;
- require explicit user confirmation before destructive or externally visible actions;
- keep Tauri capability scopes minimal.

The current Anthropic key is stored in a plugin-store JSON file, not an OS credential vault. Before broader distribution, evaluate macOS Keychain or an appropriate Tauri secure-storage option. At minimum, ensure keys never enter the outline, logs, traces, error bullets, exports, or test fixtures.

### 3.10 Observability should mirror the agent lifecycle

Pi and Flue expose typed events for model and tool activity. Flue recommends two surfaces:

- a **conversation/product stream** for render-ready user content;
- a **runtime/operational stream** for model requests, tool execution, errors, latency, and usage.

For a local-first app, an external telemetry service is unnecessary by default. A privacy-preserving local run record is enough:

- run/attempt IDs;
- source node and skill ID/version;
- model and stop reason;
- start/end timestamps and latency;
- token/cache/cost usage when available;
- tool names and outcomes, with arguments/results omitted or redacted by default;
- completion/cancellation/error/interruption status.

Do not record prompts, branch content, reasoning, tool payloads, or API keys without a deliberate user-facing privacy policy.

### 3.11 Evaluate behavior, not only deterministic plumbing

Anthropic and Flue distinguish ordinary tests from live-model evals:

- unit tests cover parsers, context selection, schemas, tools, persistence, and editor projection;
- evals run the complete model/harness behavior and assert on outcomes;
- traces help explain failures;
- deterministic graders are preferred where possible;
- model graders are useful for subjective qualities but need human calibration;
- multiple trials are needed for nondeterministic behavior;
- test both when a behavior should happen and when it should not.

A practical initial suite for this app:

| Layer | Example checks |
|---|---|
| Unit | exact ancestor/sibling context policy; prompt not duplicated; output parser; citation mapping; abort propagation; status transitions |
| Integration with mocked stream | partial deltas, provider error, cancellation, app close/restart, two runs, undo, selection stability |
| Live-model regression | `/ask` answers from supplied branch facts; `/brainstorm` produces varied concise ideas; `/research` uses retrieval and cites sources |
| Negative cases | slash in the middle of text does not trigger; research does not invent citations; ask does not use a tool unnecessarily |
| Metrics | pass rate, retries, latency, input/output tokens, tool errors, citation coverage |

Start with 10–20 real tasks and failures. Keep live evals in a separate command and do not run them as part of the fast unit-test suite.

### 3.12 Subagents are a context-isolation technique, not a default feature

Flue uses subagents for focused work with fresh contexts and returns only the final answer to the parent. Anthropic recommends them when parallel exploration or context isolation creates measurable value. Pi deliberately leaves them out of the core because hidden delegation harms observability and context transfer can be poor.

For this app, subagents are not a v1 priority. Consider them only when research tasks demonstrably need independent searches or specialist review. If added:

- give each child a self-contained task;
- expose its transcript or at least its sources and outcome;
- cap delegation depth and concurrency;
- isolate child context from the parent;
- return a compact, structured result;
- evaluate whether it beats one agent with good tools.

---

## 4. Pi and Flue: what each contributes

### Pi

Pi is most useful as a reference for a **minimal, inspectable harness**:

- small stable system prompt and familiar tool set;
- direct event-streaming agent loop;
- model/provider abstraction and abort support;
- separate tool content and UI detail;
- tree-structured, documented, append-only sessions;
- active-branch context construction;
- compaction and branch summarization;
- skills for on-demand instructions;
- extension hooks around input, context, model turns, tools, and sessions;
- SDK for same-process Node integration and RPC for process isolation.

The applicable lesson is not “embed Pi again.” It is to define a small set of explicit primitives and make the full interaction observable.

### Flue

Flue is built on Pi and is most useful as a reference for a **production agent runtime**:

- agent functions that re-render capabilities from current state;
- composable hooks for model, tools, skills, state, sandboxes, and lifecycle;
- durable submissions and terminal outcomes;
- persisted state with explicit commit semantics;
- narrow, typed, cancellable tools;
- idempotent durable steps for side effects;
- separate conversation and runtime event surfaces;
- local, HTTP, CI, and hosted deployment surfaces;
- sandbox isolation and explicit environment attachment;
- eval patterns over public agent interfaces.

Most of this is beyond the current product's needs. The valuable near-term ideas are lifecycle state, typed tools, authorization boundaries, structured UI data, and eval design.

### Comparison for this project

| Concern | Current app | Pi pattern | Flue pattern | Recommended use |
|---|---|---|---|---|
| Core loop | One Anthropic call | Tool-calling loop | Durable tool-calling loop | Keep one call for simple skills; add a small loop only for tool-based skills |
| Context | Enclosing bullets flattened into prompt | Active branch + context hooks + compaction | Re-rendered instructions/resources/state | Introduce a dedicated, tested context builder |
| Skills | Hardcoded TS prompts | Agent Skills, on demand | Agent Skills, progressively disclosed | Keep hardcoded v1; adopt versioned skill definitions in v2 |
| Tools | None | Minimal familiar tools | Typed, abortable, durable, authorized tools | Add only constrained search/fetch first |
| Sessions | Outline file only | Append-only tree session | Durable conversation stream + submissions | Add lightweight run provenance; do not map every node to a provider session |
| UI stream | Text written directly to bullets | Events + model/UI split | Conversation data parts + runtime events | Add an internal run event layer and structured node metadata |
| Recovery | Outline autosave | Persisted sessions, retries | Accepted-work recovery | Mark unfinished local runs interrupted; atomic file saves |
| Observability | Console errors | Lifecycle/tool/model events | Runtime stream and exporters | Local metadata/diagnostics, private by default |
| Security | BYO key, no tools | Full access unless externally sandboxed | Explicit sandbox and app-bound authorization | Stay tool-minimal; secure key storage; strict fetch boundaries |
| Evals | Editor unit tests | Sessions/events enable trace inspection | Vitest live-agent evals | Separate deterministic tests and live-model evals |
| Deployment | Local Tauri webview | Node SDK/RPC/CLI | Node/Cloudflare/CI server framework | Neither framework is needed for v1 |

---

## 5. Recommended architecture for this app

The following is a design direction, not a recommendation to refactor immediately.

### 5.1 Introduce a provider-independent run boundary

Keep provider code behind one interface so editor code does not depend on Anthropic stream events:

```ts
interface HarnessRequest {
  runId: string
  skill: SkillDefinition
  context: BranchContext
  prompt: string
}

type HarnessEvent =
  | { type: 'run_started'; runId: string; timestamp: number }
  | { type: 'text_delta'; runId: string; text: string }
  | { type: 'tool_started'; runId: string; callId: string; name: string }
  | { type: 'tool_finished'; runId: string; callId: string; isError: boolean }
  | { type: 'run_finished'; runId: string; usage?: Usage }
  | { type: 'run_failed'; runId: string; message: string }
  | { type: 'run_cancelled'; runId: string }
```

The editor projection consumes these events and updates nodes. The Anthropic adapter produces them. This creates a clean seam for tests, future tools, or a future provider without adding a sidecar.

### 5.2 Make branch context a typed artifact

```ts
interface BranchContext {
  ancestors: Array<{ nodeId: string; text: string }>
  current: { nodeId: string; text: string }
  siblings?: Array<{ nodeId: string; text: string }>
  children?: Array<{ nodeId: string; text: string }>
  continuation?: { runId: string; summary: string }
}
```

Each skill declares which fields it needs and their budgets. For example, `/ask` may use ancestors + selected children, while `/brainstorm` may use only ancestors + current. This is more predictable than one shared flattened context string.

### 5.3 Store provenance as metadata, not visible syntax

Generated nodes should be able to carry:

```ts
interface AgentProvenance {
  runId: string
  skillId: string
  skillVersion: number
  model: string
  status: RunStatus
  createdAt: number
  completedAt?: number
  sourceNodeId: string
  citations?: Array<{ title: string; url: string }>
}
```

Only useful content belongs in the bullet text. Status badges, source affordances, retry/cancel controls, and errors can render from metadata.

### 5.4 Add tools only through a strict registry

A minimal tool contract should include schema validation, abort propagation, and separate model/UI outputs. Do not expose raw `fetch`, shell, filesystem, or arbitrary Tauri commands to the model.

### 5.5 Keep persistence boundaries explicit

The TipTap document remains the outline's source of truth. A small local run log or node metadata can record lifecycle/provenance. If a separate log is introduced, it must not become a second undo stack or a competing tree model.

---

## 6. Prioritized recommendations

### P0 — before calling the current feature a reliable harness

1. **Correct the `/research` contract.** Add constrained retrieval with citations, or rename it so it does not imply live investigation.
2. **Extract and test a branch-context policy.** Decide whether each skill receives ancestors, current node, siblings, children, or prior AI output; remove prompt duplication.
3. **Add structured run lifecycle and provenance.** Stable run IDs, terminal statuses, model/skill metadata, and an `interrupted` recovery rule.
4. **Expose cancellation in the UI.** Keep partial output, make cancel obvious, and distinguish cancellation from provider failure.
5. **Separate failures from visible text.** Preserve a readable error state but also return/emit a structured failed outcome.
6. **Create a small live-model regression suite.** Start with realistic branch-context and skill-output cases; track latency and tokens.
7. **Review secret storage before distribution.** Keep the key out of outline data and diagnostics; evaluate OS-backed storage.

### P1 — when adding genuinely agentic skills

1. Add a small model/tool loop with bounded tools and explicit stopping/cancellation behavior.
2. Create a typed tool registry with validation, concise outputs, actionable errors, and authorization bound in application code.
3. Keep structured citations and UI payloads separate from model-visible text.
4. Persist run attempts and mark non-terminal attempts interrupted after restart.
5. Add local trace inspection for model turns and tools, with content redacted by default.
6. Version skill definitions and support per-skill context/tool/output policies.
7. Make outline writes atomic and recoverable where Tauri/iCloud semantics allow it.

### P2 — only after usage validates the need

1. Custom `SKILL.md` import/export compatible with the Agent Skills standard.
2. Multi-provider support, potentially using a browser-compatible provider abstraction rather than the full Pi coding-agent SDK.
3. Conversation continuation, summaries, and compaction for long-running branches.
4. Subagents for parallel research or independent review, with visible traces and strict limits.
5. Sandboxed shell/filesystem capabilities for coding or data-work skills.
6. A hosted/durable runtime such as Flue if the product becomes multi-user, event-driven, server-hosted, or requires accepted-work recovery across process loss.

### Explicit non-recommendations for v1

- Do not restore the Node sidecar or 1:1 Pi-session mapping.
- Do not adopt Flue solely to wrap the current three one-shot skills.
- Do not add MCP before a small set of native tools proves insufficient.
- Do not add general shell/filesystem access for note-taking skills.
- Do not add subagents as a generic “quality” feature without eval evidence.
- Do not create a second external undo/history system alongside ProseMirror.

---

## 7. Suggested decision rule for Pi or Flue later

Use **patterns only** while the app remains a local Tauri outliner with direct browser-compatible model calls.

Consider **Pi's SDK** if the architecture later accepts a Node runtime and needs an embedded, inspectable multi-provider agent session with custom UI. Use Pi RPC only when process isolation or a non-Node host justifies the extra seam.

Consider **Flue** if the product later needs addressable long-lived agents behind HTTP or CI, durable accepted work, crash recovery, persistent agent state, hosted sandboxes, or event-driven dispatch. Flue solves a server/runtime problem that the current local-first app intentionally does not have.

Consider a smaller provider abstraction before either framework if the only new requirement is switching between Anthropic and another provider.

---

## 8. Sources

### Pi

- [Pi homepage](https://pi.dev/) — minimal harness philosophy, modes, sessions, context engineering, and extensibility.
- [Pi documentation overview](https://pi.dev/docs)
- [Pi SDK](https://pi.dev/docs/latest/sdk) — session lifecycle, events, tools, model runtime, and embedding.
- [Pi sessions](https://pi.dev/docs/latest/sessions) and [session format](https://pi.dev/docs/latest/session-format) — append-only tree history and active-branch context.
- [Pi compaction](https://pi.dev/docs/latest/compaction) — compaction and branch summarization.
- [Pi extensions](https://pi.dev/docs/latest/extensions) — lifecycle, context, model, and tool interception.
- [Pi skills](https://pi.dev/docs/latest/skills) — on-demand capability instructions.
- [Pi security](https://pi.dev/docs/latest/security) — trust and sandbox boundaries.
- Mario Zechner, [“What I learned building an opinionated and minimal coding agent”](https://mariozechner.at/posts/2025-11-30-pi-coding-agent/) — minimal prompts/tools, observability, aborts, structured tool results, and framework philosophy.

### Flue

- [Flue homepage](https://flueframework.com/)
- [Why Flue?](https://flueframework.com/docs/guide/why-flue/) — harness-first, dynamic, durable, open design.
- [Agents](https://flueframework.com/docs/guide/building-agents/) and [Agent Hooks](https://flueframework.com/docs/guide/agent-hooks/) — agent composition, persistent state, events, and structured UI data.
- [Tools](https://flueframework.com/docs/guide/tools/) — typed tools, aborts, authorization, harness tools, and durable steps.
- [Skills](https://flueframework.com/docs/guide/skills/) — Agent Skills format and progressive disclosure.
- [Sandboxes](https://flueframework.com/docs/guide/sandboxes/) — narrow environments, virtual/local/remote isolation, and credential handling.
- [Durability](https://flueframework.com/docs/guide/durability/) — submissions, recovery, terminal outcomes, and idempotency.
- [Observability](https://flueframework.com/docs/guide/observability/) — conversation vs runtime events, usage, traces, and privacy.
- [Evals](https://flueframework.com/docs/guide/evals/) — deterministic tests, live-agent evals, traces, and judges.
- [Database](https://flueframework.com/docs/guide/database/) — canonical streams, accepted submissions, and persistence boundaries.
- [Subagents](https://flueframework.com/docs/guide/subagents/) — fresh-context delegation and inheritance rules.

### General agent-engineering guidance

- Anthropic, [“Building effective agents”](https://www.anthropic.com/engineering/building-effective-agents) — simple composable patterns, agent/workflow distinction, tool design, and sandboxed testing.
- Anthropic, [“Effective context engineering for AI agents”](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) — attention budget, just-in-time retrieval, compaction, notes, and subagents.
- Anthropic, [“Writing effective tools for agents — with agents”](https://www.anthropic.com/engineering/writing-tools-for-agents) — distinct tools, schemas, concise results, errors, and tool evals.
- Anthropic, [“Effective harnesses for long-running agents”](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents) — incremental progress, persistent artifacts, clean checkpoints, and end-to-end verification.
- Anthropic, [“Demystifying evals for AI agents”](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents) — tasks/trials/traces/outcomes, grader selection, isolation, and eval maintenance.
- OpenAI, [“Evaluate agent workflows”](https://developers.openai.com/api/docs/guides/agent-evals) — trace grading first, then repeatable datasets and eval runs.

## Research caveats

- Pi and Flue are evolving quickly; API details should be checked against the installed version before implementation.
- Flue's documentation reviewed here was updated in July 2026 and describes Flue 2.x behavior.
- Vendor guidance is useful but reflects each vendor's architecture and product incentives. Recommendations above are filtered through this repository's local-first, single-document, no-sidecar constraints.
- This document is an architectural/product analysis, not a framework benchmark or a live reliability test.
