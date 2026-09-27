## 1. Shared MCP host

- [x] 1.1 Add bounded browser-safe MCP contracts, stable tool identity and inventory validation; verify contract tests.
- [x] 1.2 Add the official MCP client dependency and shared stdio/HTTP discovery and execution host; verify fixture-server tests for discovery, schemas, authorization, errors, cancellation, and cleanup.
- [x] 1.3 Preserve runtime tool input schemas and error results through the Pi adapter; verify adapter tests.

## 2. Desktop connections

- [x] 2.1 Add a credential-free discovery sidecar and native packaging permissions; verify subprocess discovery tests and sidecar build.
- [x] 2.2 Add device-local connection metadata and vault-backed configuration, import/connect/refresh/disable/remove, and changed-tool deauthorization; verify store tests.
- [x] 2.3 Add MCP Settings and agent tool selection; verify UI tests for arbitrary configuration, errors, and independent enablement.
- [x] 2.4 Admit MCP inventory and execute authorized tools in local runs, including secret resolution and cleanup; verify local runner and sidecar tests.

## 3. Backend connections

- [x] 3.1 Add operator-owned MCP configuration with environment secret references and startup discovery; verify configuration and inventory tests.
- [x] 3.2 Expose authenticated sanitized inventory through the native transport and Settings; verify authorization and response tests.
- [x] 3.3 Integrate backend MCP admission, schemas, per-run connections and cleanup; verify worker execution tests.
- [x] 3.4 Disable automatic turn replay for MCP-enabled local and backend runs, including lease recovery; verify retry tests.

## 4. Integration and documentation

- [x] 4.1 Document desktop and backend setup, runner installation, header authentication, compatibility limits and external effects; update the architecture map and ADR.
- [x] 4.2 Run OpenSpec validation, targeted tests, TypeScript checks, sidecar build and relevant Rust checks; record results and limitations in verification.md.

## 5. Connection experience

- [x] 5.1 Add URL/token and launch-command forms with optional credential fields; keep JSON import as an advanced option.
- [x] 5.2 Automatically resolve the active execution environment in MCP Settings and the agent tool picker, with no fallback on backend errors.
- [x] 5.3 Verify form submission, command parsing, credential clearing, automatic routing and retry; update setup documentation and verification results.

## 6. Discover existing connections

- [x] 6.1 Read bounded user-level MCP configuration from Codex, Claude Desktop, Claude Code, Cursor and VS Code; return sanitized candidates without executing commands.
- [x] 6.2 Deduplicate exact definitions, identify unsupported configurations and missing credentials, and reject source changes at import time.
- [x] 6.3 Add Found on your computer and explicit Connect, retain advanced setup, and allow reviewed tools to be assigned to agents in the same flow.
- [x] 6.4 Verify scanner, source/bundled management IPC, import persistence, permission grants, active-mode UI routing and the installed Pen configuration; update documentation.
