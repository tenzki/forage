# Forage extension API

`@forage/extension-api` is the host-independent authoring contract for trusted local Forage extensions. It contains TypeScript types, version constants, and `defineExtension`; it has no dependency on Pi, React, Tauri, the desktop app, or the server. The package is private to this workspace in v1, so publishing and third-party distribution are not yet promised.

## Manifest and entry point

Every extension root must contain `forage.extension.json`. Manifest version `1` and API version `"1"` are the only supported versions:

```json
{
  "$schema": "https://forage.app/schemas/extension-manifest-v1.json",
  "manifestVersion": 1,
  "id": "dev.example.word-tools",
  "name": "Word tools",
  "version": "1.0.0",
  "description": "Example local text tools.",
  "entry": "./dist/index.js",
  "apiVersion": "1",
  "contributes": {
    "tools": [
      {
        "id": "word_count",
        "name": "Word count",
        "description": "Count whitespace-delimited words."
      }
    ],
    "hooks": ["run:start", "run:end"],
    "settings": []
  }
}
```

The reverse-DNS extension ID, semantic version, confined `./` entry path, tool IDs, hooks, and settings are validated before code is loaded. Runtime registrations must exactly match the manifest. Managed npm and Git packages use built JavaScript; explicitly registered local development sources may use TypeScript through Forage's pinned loader.

An entry default-exports a setup callback:

```ts
import { defineExtension } from '@forage/extension-api'

export default defineExtension((forage) => {
  forage.registerTool({
    id: 'word_count',
    name: 'Word count',
    description: 'Count whitespace-delimited words.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', maxLength: 20_000 } },
      required: ['text'],
      additionalProperties: false,
    },
    async execute(input, context) {
      context.signal.throwIfAborted()
      const text = String((input as { text: string }).text)
      context.reportProgress({ message: 'Counting', completed: 1, total: 1 })
      return { json: { words: text.match(/\S+/gu)?.length ?? 0 } }
    },
  })
})
```

## V1 contributions and contexts

V1 supports tools plus `run:start` and `run:end` hooks. Tool schemas use a bounded JSON Schema subset: objects with `additionalProperties: false`, strings, finite numbers/integers, booleans, and bounded arrays. A tool returns either `{ text: string }` or `{ json: ExtensionJsonValue }`; the host validates and bounds results, progress, and structured logs.

Execution contexts provide:

- an `AbortSignal` that tools and hooks must honor;
- read-only declared non-secret `settings` and declared `secrets`;
- bounded progress reporting for tools;
- structured logging for tools and hooks.

Settings are declared in the manifest as `string`, `multiline`, `number`, `boolean`, `select`, or `secret`. Forage renders the controls. Non-secret values stay in device-local extension configuration; secret plaintext stays behind the native credential boundary. Setup/validation receives neither model credentials nor secret values.

Extensions cannot contribute React/HTML, navigation, slash commands, editor commands, model providers, direct outline mutations, shell tools, or Pi objects. The application-owned `emit_outline` tool remains the only structured document-output boundary.

## Trust and authorization

The API is a compatibility boundary, not a sandbox. Once a user reviews, trusts, and enables an extension, its Node.js code runs with the local sidecar process permissions and can access local files, processes, and networks. Manifest inspection does not import the entry, but a manifest does not constrain trusted code after activation.

Installation, trust/enablement, configuration, and model tool authorization are separate decisions. Enabling a source may run setup and declared hooks; it never globally enables its tools or adds them to an agent. A tool reaches the model only when current executor support, global policy, agent selection, and run policy all allow it.

Extensions are local-only in v1. Server runs do not receive local paths, code, trust, settings, secrets, or snapshots and never fall back to desktop execution.

## Compatibility policy

Manifest and API versions evolve independently. Forage keeps an unsupported manifest inspectable but unavailable, and fails closed when static declarations differ from runtime registrations. A compatible extension may continue unchanged when the internal agent engine changes because Pi is only a private adapter behind this contract. Any future API version, richer contribution surface, lifecycle-script support, or sandbox claim requires an explicit contract change.

See the [reference extension](../extensions/README.md) for a complete build and local-development loop.
