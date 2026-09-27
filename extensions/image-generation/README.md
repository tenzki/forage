# Image Generation extension

This package owns the local `generate_image` tool, its OpenAI Images API adapter,
and its isolated Codex app-server adapter. It uses its own credentials and never
reads Forage's model credentials. The optional server retains its separate,
server-owned image capability; it does not load this package.

## Build and enable

```bash
pnpm --filter @forage/extension-image-generation build
pnpm --filter @forage/extension-image-generation typecheck
pnpm --filter @forage/extension-image-generation test
```

In Settings → Extensions, install the absolute path to `extensions/image-generation`,
review the source, and enable it. Select a provider in its configuration:

- **Codex ChatGPT login** uses the file-based login at `$CODEX_HOME/auth.json`
  (default `~/.codex/auth.json`). Run `codex -c 'cli_auth_credentials_store="file"' login`
  if a file-based ChatGPT login is unavailable. Keyring-only logins are not read.
  Codex 0.148.0+ must be on `PATH`. The extension reads the cached access token
  and account ID and passes them over stdin to an isolated ephemeral app-server;
  it does not load the user's Codex configuration, tools, or plugins. Forage does
  not refresh this independent login: if its access token has expired, renew the
  Codex login and retry. Generation uses subscription limits.
- **OpenAI API key** uses the extension's **OpenAI API key** secret setting,
  stored through Forage's scoped native credential store. Generation uses API billing.

Enable **Generate images** globally and select it for the desired agent. Create
an LLM skill with a label such as `/image`, require `generate_image`, and use:

> Call generate_image once for the requested visual. In emit_outline, return an
> optional caption as a text node followed by a separate image-only node with
> the returned imageId and accessible imageAlt.

Installation never creates or authorizes an agent or skill. Existing saved image
skills and tool selections retain `generate_image`; they become usable locally
once this extension is explicitly installed, trusted, enabled, and configured.
New profiles do not include an image skill or preselected image tool.

## Result boundary

The extension returns `{ image: { mediaType, base64, alt } }`. The generic host
checks the raster signature, canonical base64, and 5 MiB byte limit, stores it in
the run's image registry, and returns only an opaque `imageId` to the model.
`emit_outline` resolves that ID through the existing image-only outline path.
The native asset store still owns hashing, durable bytes, and synchronization;
removing the extension does not affect existing images.

One successful image is allowed per run; concurrent calls are rejected before
provider work. Failed attempts can be retried. The host independently permits
only one retained raster result per run across all extension tools. Cancellation
is passed to providers, and cancelled output is not retained.

Tests use fake provider responses and a fake Codex process, with no paid requests,
real credential reads, or device installation changes. The manifest test loads
the built package through the real extension host.

Codex authentication behavior follows the [official App Server authentication
contract](https://learn.chatgpt.com/docs/app-server#auth-endpoints) and
[login-cache documentation](https://learn.chatgpt.com/docs/auth#login-caching).
