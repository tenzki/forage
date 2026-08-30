# Capture to Inbox with Apple Shortcuts

The initial system share workflow uses Apple's Shortcuts app and Forage's authenticated Notes API. Forage does not bundle its own macOS share extension, so this workflow does not require Xcode or an additional signed `.appex` target.

It does require Forage server mode and a network-reachable HTTPS server. The desktop app may be closed; the server must be running.

## Create a limited API token

Create a dedicated token whose only permission is creating notes:

```bash
npm run tokens --workspace @forage/server -- create \
  --kind api --name apple-shortcuts --scope notes:create
```

Save the displayed secret immediately. The server stores only its SHA-256 hash. Anyone who can inspect the Shortcut can read the token, so do not reuse a device token or broader credential; revoke this token if the Shortcut or device is shared.

## Build the Shortcut

In Shortcuts on macOS:

1. Create a new shortcut named **Save to Forage**.
2. Open its Details and enable **Show in Share Sheet**.
3. Limit accepted input to **Text** and **URLs**. If there is no input, configure the Shortcut to stop with an error.
4. Convert **Shortcut Input** to text. You may use a Text action to combine a page title, URL, and selected text; the final value must be non-empty and at most 100,000 characters.
5. Generate one UUID and keep it in a variable named `Idempotency Key` for the entire run.
6. Add a URL action containing `https://YOUR-FORAGE-SERVER/api/v1/notes`.
7. Add **Get Contents of URL**, choose `POST`, and configure:
   - `Authorization`: `Bearer YOUR_NOTES_TOKEN`
   - `Idempotency-Key`: the generated UUID variable
   - Request Body: JSON
   - `text`: the converted Shortcut input
   - Optional `source`: a Dictionary whose `application` value is `Apple Shortcuts`
8. Show a success notification only after **Get Contents of URL** returns successfully. Let request errors remain visible instead of claiming the capture was saved.

Apple documents that a Shortcut can receive input from the macOS share sheet and that **Get Contents of URL** exposes a JSON request body for `POST` requests. The first use may require enabling Shortcuts under System Settings → Privacy & Security → Extensions → Sharing.

## Delivery behavior

When `parentId` is omitted, the server resolves the node currently carrying the canonical `inbox` role. Renaming or reordering Inbox does not affect routing. The new child is ordinary outline content and can be edited, nested, moved, linked, or trashed normally.

`Idempotency-Key` is mandatory. Repeating the exact request with the same key returns the original result; reusing that key with changed content returns `409 Conflict`. Generate the key once near the start of the Shortcut and reuse that variable if the workflow contains an explicit retry branch.

The API accepts plain text only. Empty text, HTML, ProseMirror JSON, nested children, attachments, and text over 100,000 characters are rejected. The optional `source` dictionary accepts up to 20 string fields; keys are limited to 100 characters and values to 2,000 characters.

There is no local fallback in this initial workflow. If the server is unavailable, the Shortcut fails and no note is queued on the Mac. A local-only capture boundary can be designed separately if it becomes necessary.

Apple references: [Run a Shortcut from another app](https://support.apple.com/guide/shortcuts-mac/launch-a-shortcut-from-another-app-apd163eb9f95/mac), [input types](https://support.apple.com/guide/shortcuts-mac/input-types-apd7644168e1/mac), and [POST JSON with Get Contents of URL](https://support.apple.com/en-au/guide/shortcuts-mac/apd58d46713f/mac).
