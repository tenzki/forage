# macOS server service templates

These files run the optional API server as a per-user `launchd` service. They are operational templates for a dedicated server checkout; they are not bundled into the Forage desktop application.

The service runner starts the Podman machine and isolated PostgreSQL Compose project, applies idempotent migrations, and then replaces itself with the Node server process. `launchd` restarts the runner after a failure.

## Interactive installation

From the server checkout, run:

```bash
./ops/macos/server/install.zsh
```

The installer logs each action and asks for the stable instance ID, API port, PostgreSQL port, and asset directory when creating a new environment. It uses the non-deliverable owner placeholder `owner@forage.invalid`, generates the database password and credential-encryption key without printing them, offers to install Podman and its Compose provider through Homebrew when necessary, initializes and starts the Podman machine, installs dependencies when missing, starts PostgreSQL, applies migrations, bootstraps a new database, installs or reloads the `launchd` job, and waits for the API readiness check.

On an existing installation it reuses the external environment and database. It does not bootstrap another owner or rotate secrets. Bootstrap credentials appear only in the terminal on the first run and are never copied to the service log.

Stop the API service and its PostgreSQL container without stopping the shared Podman machine:

```bash
./ops/macos/server/stop-server.zsh
```

The database volume is retained. Run `install.zsh` again to start the database, apply any pending migrations, and load the API service.

## Manual installation

Complete the initial database migration and owner bootstrap in [the server guide](../../../docs/server-backend.md) before installing the service. The bootstrap credentials are displayed only once.

Create the runtime directories:

```bash
mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs/Forage Server"
chmod 700 ops/macos/server/run-server.zsh
```

Copy `com.forage.server.plist.template` to `~/Library/LaunchAgents/com.forage.server.plist` and replace every placeholder:

| Placeholder | Example |
| --- | --- |
| `__FORAGE_HOME__` | `/Users/alice` |
| `__FORAGE_SERVER_ROOT__` | `/Users/alice/Services/forage-server` |
| `__FORAGE_SERVER_ENV_FILE__` | `/Users/alice/.config/forage-server/server.env` |
| `__FORAGE_LOG_DIR__` | `/Users/alice/Library/Logs/Forage Server` |
| `__FORAGE_SERVICE_PATH__` | Absolute command search path containing Node, pnpm, and Podman |

The generated plist contains paths but no secrets. Keep the real environment file outside the checkout with mode `0600`.

Validate and load the generated job:

```bash
plutil -lint "$HOME/Library/LaunchAgents/com.forage.server.plist"
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.forage.server.plist"
launchctl kickstart -k "gui/$(id -u)/com.forage.server"
```

Inspect or restart it with:

```bash
launchctl print "gui/$(id -u)/com.forage.server"
launchctl kickstart -k "gui/$(id -u)/com.forage.server"
tail -f "$HOME/Library/Logs/Forage Server/stderr.log"
```

For a manual API-only stop that leaves PostgreSQL running, unload the job:

```bash
launchctl bootout "gui/$(id -u)/com.forage.server"
```

After changing the template, regenerate the installed plist, validate it, and bootstrap the job again.
