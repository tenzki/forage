# Forage extension API

`@forage/extension-api` is the standalone authoring contract for trusted local Forage extensions. It has no dependency on Pi, React, Tauri, the desktop app or the server.

Every extension has one `forage.extension.json` contract containing reverse-DNS identity, ordinary semantic package `version`, a confined entry path, and static tool/hook/setting/executor declarations. There are no API or manifest version discriminators and no negotiation or legacy loader. Inventory inspects the manifest without importing code; after trust and enablement, runtime registrations must match it semantically, independent of object property order.

Tools keep the bounded JSON Schema, progress, structured logging, cancellation and text/JSON result contract. Settings are `string`, `multiline`, `number`, `boolean`, `select` or `secret`; plaintext secrets remain in device-local credential storage.

## Generic skill executors

An optional `contributes.executors` entry declares a stable ID, display metadata, whether an empty invocation prompt is allowed, and a bounded configuration form. Forms support text, multiline text, finite numbers, booleans, choices, bounded object/repeated-group fields and conditional branches. Unsupported fields, executable UI and excessive size/depth fail closed.

```json
{
  "executors": [{
    "id": "label_notes",
    "name": "Label notes",
    "description": "Formats selected notes.",
    "allowEmptyPrompt": true,
    "configuration": {
      "fields": [{ "key": "prefix", "label": "Prefix", "type": "text" }]
    }
  }]
}
```

The entry registers the same declaration and three phases:

```ts
import { defineExtension } from '@forage/extension-api'

export default defineExtension((forage) => {
  forage.registerSkillExecutor({
    id: 'label_notes',
    name: 'Label notes',
    description: 'Formats selected notes.',
    allowEmptyPrompt: true,
    configuration: { fields: [{ key: 'prefix', label: 'Prefix', type: 'text' }] },
    async validateConfiguration() { return { valid: true } },
    async prepare(input) {
      const selectedNodeIds = input.context.roots.map(({ id }) => id)
      return { selectedNodeIds, requestedReferenceIds: selectedNodeIds, annotations: [], data: {} }
    },
    async execute(input) {
      return { nodes: input.plan.selectedNodeIds.map((nodeId) => ({
        type: 'text',
        segments: [{ type: 'internal-reference', nodeId, label: nodeId }],
      })) }
    },
  })
})
```

Validation and preparation receive declared non-secret settings, cancellation and logging, but no secrets. Preparation receives one immutable, application-resolved context tree and returns requested input/reference IDs, generic preview annotations and bounded non-secret data. The host validates every ID, applies its own reference authority and pins that exact plan. Execution receives the pinned context/configuration/plan plus scoped declared secrets and returns bounded ordinary text/reference output. It does not require an LLM session or run unrelated hooks.

Installing, trusting or enabling an extension never creates a skill or slash command. It only makes an executor available for explicit selection in a user-created skill. Extensions cannot add React/HTML, editor behavior, navigation, commands or direct outline writes. Local paths, trust, settings and secrets remain device-local; portable skill references/configuration have independent revisions, and server execution never falls back to desktop code.

Keep a feature's domain model and provider adapter inside its extension. Core does
not gain a new execution discriminator, domain unions, selection policy, or
formatter for each executor. A full evaluation feature, for example, owns its
questions, candidate rules, transport, answer validation, filtering, ordering,
and text/reference formatting while the host remains generic. Returned output
is static ordinary content and must not rely on extension code during reopen,
replay, navigation, or undo/redo.

See the [reference extension](../../extensions/reference/README.md) for the build and local-development loop.
