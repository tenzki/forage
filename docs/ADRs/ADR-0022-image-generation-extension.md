# ADR-0022: Move Local Image Generation Into a Trusted Extension

- **Status:** Accepted
- **Date:** 2026-09-26
- **Supersedes:** ADR-0009's local credential ownership and built-in tool placement

Local image generation now belongs to `extensions/image-generation`, using the
Forage extension contract from ADR-0021. The package owns provider selection,
OpenAI Images API calls, Codex process management, and image-specific settings.
Its credentials are independent of the model running the outline agent: a scoped
extension API key or a local file-based Codex ChatGPT login.

Core adds a generic bounded raster tool result, not an image-provider service.
The host validates format and size, assigns an opaque run-local image ID, and
keeps bytes out of the model's tool result. Existing `emit_outline`, native
content-addressed storage, document nodes, undo, and synchronization remain the
application-owned output boundary.

`generate_image` is no longer a reserved local built-in. Normal source trust,
activation, global enablement, agent selection, collision checks, and run
snapshots apply. Existing saved selections remain, but fresh profiles do not
preselect an extension tool or create an image skill. Installing the extension
never grants tool permissions or installs skills.

The isolated Codex bridge remains read-only and ephemeral with external tools
disabled. It receives cached tokens over RPC and deletes its temporary home
on exit. It does not use Forage's model credentials or refresh the independent
Codex login. Keyring-only Codex logins require a file-based login for this path.

The optional server keeps its separate server-owned image implementation and
credential authority. It does not load, copy, or fall back to local extensions.
The obsolete Pi RPC bridge remains historical test material and is no longer
included in the native application bundle.

Validation covers compiled manifest registration, scoped credentials, provider
errors, concurrent calls, cancellation, malformed or oversized image output,
and image materialization through the real sidecar adapter. No paid generation
is needed for the offline suite.
