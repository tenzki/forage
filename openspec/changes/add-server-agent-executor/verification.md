# Verification Evidence

This map ties every normative scenario in the change to automated evidence. Provider tests use injected fake HTTP responses; PostgreSQL evidence uses the disposable `TEST_DATABASE_URL` database described below. The owner-approved live-provider smoke test remains a separate, intentionally unchecked task.

## Agent execution

| Scenario | Automated evidence |
| --- | --- |
| Invoke a local skill | `apps/desktop/src/agent/localExecutor.test.ts` — durable local success; `apps/desktop/src/App.test.tsx` — slash-command regression |
| Server is unavailable for a server-mode run | `apps/desktop/src/agent/serverExecutor.test.ts` — rejects admission without local fallback |
| Recover an expired server lease | `apps/server/src/agentStore.test.ts` and `apps/server/src/postgres.test.ts` — lease expiry and competing claims |
| Restart during local execution | `apps/desktop/src-tauri/tests/event_store_tests.rs` — startup interruption preserves history |
| Edit a skill after admission | `apps/server/src/serverRunner.test.ts` and `apps/server/src/agentStore.test.ts` — execution uses immutable input/definition snapshots |
| Skill requires an unavailable transcript tool | `packages/agent-runtime/src/runtime.test.ts` — required-tool preflight rejection |
| Model asks for an unauthorized tool | `packages/agent-runtime/src/runtime.test.ts` — unauthorized call rejection |
| Refresh server ChatGPT authentication | `apps/server/src/credentialService.test.ts` and `apps/server/src/postgres.test.ts` — serialized refresh rotation |
| Use an OpenAI API key | `apps/server/src/credentialService.test.ts` and `apps/server/src/serverModel.test.ts` |
| Refresh is revoked | `apps/server/src/credentialService.test.ts` — one refresh and `authentication_required` transition |
| Complete headless device authorization | `apps/server/src/credentialService.test.ts` and `apps/server/src/app.test.ts` |
| Disconnect a credential | `apps/server/src/credentialService.test.ts` and `apps/server/src/app.test.ts` |
| Cancel during a tool call | `packages/agent-runtime/src/runtime.test.ts`, `apps/server/src/serverRunner.test.ts`, and `apps/server/src/postgres.test.ts` |
| Retry a failed run after configuration changes | `apps/server/src/agentStore.test.ts` and `apps/server/src/app.test.ts` — linked retry creates a new immutable run |
| Completion transaction is retried | `apps/server/src/postgres.test.ts` — exactly-once result identity |
| Target is no longer live | `apps/server/src/postgres.test.ts` — cancellation wins and no result is materialized |
| Poll activity after reconnecting | `apps/desktop/src/agent/serverExecutor.test.ts` and `apps/desktop/src/components/Settings/ServerAgentSettings.test.tsx` |
| External capture token reads runs | `apps/server/src/app.test.ts` — `notes:create` cannot access agent resources |

## Inbox automation

| Scenario | Automated evidence |
| --- | --- |
| Match an Inbox capture | `apps/server/src/app.test.ts` and `apps/server/src/postgres.test.ts` |
| Capture outside Inbox | `apps/server/src/app.test.ts` |
| Match a YouTube policy | `apps/server/src/automation.test.ts` and `apps/server/src/app.test.ts` |
| Multiple policies repeat a skill | `apps/server/src/automation.test.ts` and `apps/server/src/app.test.ts` |
| Disabled policy matches | `apps/server/src/automation.test.ts` |
| Classify an ambiguous capture | `apps/server/src/automation.test.ts` and `apps/server/src/serverModel.test.ts` — named dispatcher agent, no tools, bounded output |
| Dispatcher invents a skill | `apps/server/src/automation.test.ts` — invented IDs are discarded |
| Publish with stale revision | `apps/server/src/agentStore.test.ts` and `apps/server/src/app.test.ts` |
| Edit policy after capture | `apps/server/src/agentStore.test.ts` — admitted snapshot retains policy/configuration identity |
| Complete link enrichment | `apps/server/src/serverRunner.test.ts` and `apps/server/src/postgres.test.ts` |
| User moves the capture | `apps/server/src/postgres.test.ts` — stable target ID and latest outline revision |
| Retry the Notes API request | `apps/server/src/app.test.ts` and `apps/server/src/postgres.test.ts` |
| Agent output enters the Inbox subtree | `apps/server/src/app.test.ts` — only `notes_api` canonical-Inbox captures admit automation |
| No automation profile exists | `apps/server/src/app.test.ts` |
| Enrichment provider fails | `apps/server/src/serverRunner.test.ts` plus note-preservation assertions in `apps/server/src/app.test.ts` |

## Notes API

| Scenario | Automated evidence |
| --- | --- |
| Observe a created note on a desktop | `apps/server/src/app.test.ts` and `apps/desktop/src/sync/syncEngine.test.ts` |
| Admit eligible automation atomically | `apps/server/src/postgres.test.ts` |
| Automation admission cannot be persisted | `apps/server/src/postgres.test.ts` transaction rollback coverage |

## Server-synchronized outlines

| Scenario | Automated evidence |
| --- | --- |
| Synchronize completed agent output | `apps/server/src/postgres.test.ts`, `packages/domain/src/envelope.test.ts`, and `apps/desktop/src/sync/syncEngine.test.ts` |
| Desktop is editing concurrently | `apps/server/src/postgres.test.ts` — commit uses the latest locked revision |
| Connected client is too old | `apps/server/src/app.test.ts` — compatibility status/minimum client negotiation |
| Client receives an unknown agent event | `apps/desktop/src/sync/syncEngine.test.ts` — event rejected without advancing acknowledgement |

## Source content tools

| Scenario | Automated evidence |
| --- | --- |
| Normalize a known YouTube URL | `apps/server/src/sourceUrl.test.ts` |
| URL resolves to a private address | `apps/server/src/sourceUrl.test.ts` |
| Read an X status link | `apps/server/src/serverTools.test.ts` and `apps/server/src/sourceUrl.test.ts` |
| Reader follows a disallowed redirect | `apps/server/src/serverTools.test.ts` |
| Transcript is immediately available | `apps/server/src/transcript.test.ts` |
| Transcript requires asynchronous polling | `apps/server/src/transcript.test.ts` |
| Video has no available transcript | `apps/server/src/transcript.test.ts` |
| Source contains instructions for the agent | `packages/agent-runtime/src/runtime.test.ts` and `apps/server/src/serverTools.test.ts` |
| Provider error contains its API key | `apps/server/src/credentialCrypto.test.ts`, `apps/server/src/transcript.test.ts`, and `apps/server/src/serverModel.test.ts` |
| Cancel transcript polling | `apps/server/src/transcript.test.ts` |
| Reader returns rate limiting | `apps/server/src/serverTools.test.ts` and failure classification in `apps/server/src/serverRunner.test.ts` |

## Verification commands

- Full TypeScript/component suite: `npm test`
- Workspace boundary suite: `npm run test:workspace`
- Production TypeScript builds: `npm run build`
- Rust suite: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`
- Real PostgreSQL suite: `TEST_DATABASE_URL=postgres://forage:forage@127.0.0.1:55437/forage_test npm test -- apps/server/src/postgres.test.ts`
- Strict proposal validation: `npx openspec validate add-server-agent-executor --strict`
