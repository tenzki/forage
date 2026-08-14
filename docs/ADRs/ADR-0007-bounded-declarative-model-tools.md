# ADR-0007: Expose Only Bounded Declarative Network Tools to the Model

- **Status:** Accepted
- **Date:** 2026-08-14
- **Deciders:** AI Chat project team
- **Supersedes:** None
- **Superseded by:** None

## Context

Research skills need current information, which language models cannot reliably provide from training data alone. The thin-shell architecture does not include Pi's general-purpose `bash` tool, a Node.js runtime, or a trusted extension process. Giving model output access to shell commands, arbitrary JavaScript, unrestricted URLs, or local files would create a security boundary far larger than the feature requires.

The application can instead expose native model tool definitions whose execution remains controlled by TypeScript and Tauri's static HTTP permissions.

## Decision Drivers

- Provide current web information and source retrieval.
- Preserve ADR-0001's frontend-only architecture.
- Grant no shell, filesystem, or arbitrary code execution to the model.
- Bound request duration, response size, and tool-call recursion.
- Let users explicitly enable or disable tools.
- Keep custom tools reviewable and constrained to approved origins.

## Considered Options

1. **Bounded declarative HTTP tools** — built-in tools and simple validated URL-template tools over a static allowlist.
2. **Shell-based skills** — let the model invoke scripts through a general command tool.
3. **Arbitrary JavaScript extensions** — load user code that registers and executes tools.
4. **Privileged Rust networking service** — validate and execute arbitrary network requests outside the webview.
5. **No tools** — rely entirely on model knowledge.

## Decision

We will **expose only bounded, explicitly enabled network tools with declarative schemas and controlled executors** because **research needs can be met without granting the model general code, filesystem, shell, or unrestricted network access**.

V1 includes `web_search`, `web_fetch`, and simple GET URL-template tools for statically approved HTTPS origins. Tool output is capped, requests time out, and a generation is limited to four tool rounds. Custom tool names, descriptions, templates, arguments, and origins are validated before execution.

## Consequences

### Positive

- Research can use current information and return sources.
- Model capabilities are visible and user-toggleable.
- The model receives JSON Schema definitions rather than implementation authority.
- Static Tauri capabilities provide a second origin restriction.
- Tool results use the same typed Pi AI message loop as model responses.

### Negative

- Custom integrations are limited to simple unauthenticated GET templates and approved origins.
- DuckDuckGo HTML parsing and the Jina Reader service are external dependencies.
- Static origin changes require an application capability update and release.
- The frontend cannot safely support every redirect, DNS, private-network, or secret-handling use case.
- Tool activity currently has limited user-facing observability.

### Risks and Mitigations

- **Risk:** A model attempts SSRF or access to local/private resources.  
  **Mitigation:** Fetch pages through the allowlisted reader service, reject literal private/local targets, and constrain custom tools to exact approved HTTPS origins.
- **Risk:** Tool responses consume excessive memory or model context.  
  **Mitigation:** Enforce request timeouts, result-count limits, output truncation, and a maximum tool-round count.
- **Risk:** Tool definitions or errors expose credentials.  
  **Mitigation:** Do not support secrets in v1 custom tools; never include credentials in definitions, arguments, results, or errors.
- **Risk:** Redirects or DNS resolution bypass frontend validation.  
  **Mitigation:** Do not widen custom tools to arbitrary origins; require a new ADR and hardened privileged network boundary for that capability.
- **Risk:** External result formats change.  
  **Mitigation:** Keep parsers isolated, test representative responses, and return explicit failures rather than fabricated results.

## Option Analysis

### Option A: Bounded Declarative HTTP Tools

**Advantages**

- Useful current-data access with a narrow permission model.
- Definitions can be validated, persisted, inspected, and disabled.
- Fits the existing frontend provider loop.

**Disadvantages**

- Supports fewer integrations than executable extensions.
- Requires explicit allowlist maintenance.

### Option B: Shell-Based Skills

**Advantages**

- Flexible and easy to extend with scripts and command-line programs.
- Closely resembles Pi's local skill mechanism.

**Disadvantages**

- Grants a broad command-execution capability disproportionate to web research.
- Introduces platform, quoting, output, and sandboxing concerns.

### Option C: Arbitrary JavaScript Extensions

**Advantages**

- Maximum flexibility and a familiar extension authoring model.
- Can implement authentication and complex workflows.

**Disadvantages**

- Executes trusted code in the application context.
- Requires signing, sandboxing, update, and compatibility policies.

### Option D: Privileged Rust Networking Service

**Advantages**

- Can perform DNS and redirect validation behind a narrow IPC contract.
- Could support arbitrary approved origins and secrets more safely.

**Disadvantages**

- Adds a custom backend boundary and substantial security-sensitive code.
- Not required for the curated v1 tool set.

### Option E: No Tools

**Advantages**

- Smallest network and security surface.
- No external parsers or services.

**Disadvantages**

- Research answers can be stale and lack verifiable sources.
- Undermines the intended research skill.

## Implementation Notes

`src/agent/tools.ts` owns tool definitions, validation, execution, timeout, and output bounds. `src/agent/client.ts` executes tool calls, appends `toolResult` messages, and limits rounds. `src/store/settingsStore.ts` persists enabled tool IDs and validated custom definitions. `src-tauri/capabilities/default.json` is the authoritative transport allowlist.

Do not add arbitrary origins, custom headers/secrets, POST bodies, imported OpenAPI operations, executable plugins, or local-resource tools without revisiting this security boundary.

## Validation

- Disabled tools are absent from model-visible definitions and cannot execute.
- Invalid names, empty arguments, non-HTTPS templates, and unapproved custom origins are rejected.
- Literal loopback, link-local, and private-network webpage targets are rejected.
- Requests time out and outputs truncate at documented bounds.
- A generation stops after the configured maximum tool rounds.
- Tauri denies network destinations absent from the static capability allowlist.
- Tests cover DuckDuckGo parsing, URL validation, custom tool validation, and tool-loop success and failure paths.

## References

- `src/agent/tools.ts`
- `src/agent/client.ts`
- `src/agent/tools.test.ts`
- `src/agent/client.test.ts`
- `src/store/settingsStore.ts`
- `src-tauri/capabilities/default.json`
- `docs/tools-architecture.md`
