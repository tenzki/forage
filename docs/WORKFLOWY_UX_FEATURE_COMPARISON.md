# Workflowy UX and Feature Comparison

## Scope and method

This is a source-level audit of the current app against Workflowy's public help documentation.

**Workflowy sources reviewed**

- [Get started](https://workflowy.com/help/get-started)
- The linked "Using Workflowy" guides: [navigation](https://workflowy.com/help/navigate-around), [editing/formatting](https://workflowy.com/help/add-edit-format), [search](https://workflowy.com/help/search-your-notes), [node types](https://workflowy.com/help/change-node-types), [tags/dates/backlinks](https://workflowy.com/help/organise-with-tags-dates-backlinks), [mirrors/templates](https://workflowy.com/help/reuse-content-with-mirrors-templates), [collaboration](https://workflowy.com/help/share-collaborate), [calendar](https://workflowy.com/help/plan-with-calendar), [personalization](https://workflowy.com/help/personalize-workflowy), [integrations/API](https://workflowy.com/help/connect-other-apps-api), and [AI](https://workflowy.com/help/use-workflowy-ai)
- The linked feature references for [bullets](https://workflowy.com/help/bullets), [bullet types](https://workflowy.com/help/bullet-types), [advanced search](https://workflowy.com/help/search), [boards](https://workflowy.com/help/boards), [tables](https://workflowy.com/help/tables), [panes](https://workflowy.com/help/panes), [files](https://workflowy.com/help/files-images), [comments](https://workflowy.com/help/fractal-comments), [slash commands](https://workflowy.com/help/slash-command), [command palette](https://workflowy.com/help/command-palette), [shortcuts](https://workflowy.com/help/shortcuts), [sidebar](https://workflowy.com/help/sidebar-navigation), and [export](https://workflowy.com/help/exporting)

Account administration, billing, and productivity-method tutorials are excluded unless they expose a product capability. This is a snapshot of the documentation at the time of the audit, not a claim about Workflowy's undocumented behavior.

**Current-app evidence reviewed**

- `src/editor/OutlinerEditor.tsx`
- `src/editor/extensions.ts`
- `src/editor/outlinerUi.ts`
- `src/editor/outlineModel.ts`
- `src/components/Outliner/OutlinerChrome.tsx`
- `src/components/Agent/SlashMenu.tsx`
- `src/agent/insertIntoEditor.ts`
- `src/agent/skills.ts`
- `src/components/Settings/SettingsPanel.tsx`
- `src/persistence/outlineFile.ts`
- tests and package configuration

This comparison follows the implementation, not stale planning checkboxes. The current source now includes hashtag decorations and autocomplete, cross-parent drag re-nesting, persistent shortcuts, and a collapsible navigation sidebar.

### Status legend

- **Supported** — the current app has the core Workflowy behavior.
- **Partial** — a narrower version exists, or underlying editor support exists without the complete UX.
- **Missing** — no current implementation was found.
- **Different / advantage** — the current app offers a distinct capability not described as part of the comparable Workflowy UX.

## Executive summary

The current app already has a credible **core outliner**: one document, nested bullets, inline editing, zoom/hoist, breadcrumbs, persistent branch collapse, undo/redo, basic keyboard restructuring, basic search, autosave, and AI-generated child bullets.

The biggest gaps are not the tree itself. They are the systems Workflowy layers around the tree:

1. **Batch actions and deeper safety:** multi-select and undo integration for soft-delete/restore remain; item actions, cross-parent movement, duplication, Trash, and restore are now implemented.
2. **Retrieval and navigation:** true in-place outline filtering, advanced operators, tags, dates, sidebar, starring, saved searches, shortcuts, and panes.
3. **Richer nodes:** notes, todos/completion, headings and other first-class node types, files, internal links, and backlinks.
4. **Alternate views and reuse:** boards, tables, calendar, mirrors, and templates.
5. **Sharing and platform:** collaboration, comments, mobile/web capture, import/export, integrations, and multi-platform sync.
6. **AI breadth:** account-wide chat, page/subtree context, chat history, accept/reject/regenerate, transformations, and AI-driven structural actions.

The app's clearest differentiation is its **bring-your-own Codex/OpenAI setup with streaming outline-native skills, web tools, custom public GET tools, cancellation, and one-step undo behavior**.

---

## Detailed comparison

### 1. Core document and bullet model

| Capability | Workflowy UX | Current app | Status |
|---|---|---|---|
| One infinite document | One account-wide list; no folders or separate files | One TipTap/ProseMirror document persisted as `tree.json` | **Supported** |
| Bullet as universal unit | Every note, task, idea, or project starts as a node/bullet | Every outline item is a ProseMirror `listItem` with a stable UUID | **Supported** |
| Infinite nesting | Bullets can nest to arbitrary depth | Real nested `bulletList`/`listItem` structure; Tab indents | **Supported** |
| Add sibling | Enter creates a node at the same level | StarterKit list editing provides Enter behavior | **Supported** |
| Indent/outdent | Tab / Shift+Tab | Explicit keymap uses `sinkListItem` / `liftListItem` | **Supported** |
| Inline editing | Edit any item directly in place | One live contenteditable document | **Supported** |
| Stable node identity | Nodes remain addressable across navigation and integrations | UUID `nodeId` is assigned to every list item and de-duplicated | **Supported** |
| Select multiple items | Mouse/keyboard multi-select enables batch actions | No bullet multi-select model or action UI | **Missing** |
| Item/bullet menu | Hovering a bullet exposes type, move, duplicate, delete, share, export, etc. | Bullet actions expose collapse, Move To, duplicate, copy link, and Trash; broader type/share/export actions remain absent | **Partial** |
| Duplicate branch | Duplicate a node and descendants; optional `#copy` marker | Action menu duplicates the complete subtree with fresh stable IDs | **Supported** |
| Delete branch action | Explicit item action and keyboard command | Action menu moves the complete branch to persisted Trash | **Supported** |
| Trash and restore | Deleted items can be found and restored from Trash | Persisted Trash supports restore to the original parent/root fallback and confirmed permanent deletion | **Supported** |
| Count words/nodes | Command palette can count content in a subtree | No count action | **Missing** |

### 2. Focus, navigation, and visibility

| Capability | Workflowy UX | Current app | Status |
|---|---|---|---|
| Zoom/hoist into a node | Click a bullet to make it the focused page | Click the bullet dot to hide everything outside that branch | **Supported** |
| Breadcrumb navigation | Click any ancestor crumb to zoom back out | Home plus clickable ancestor/current-node breadcrumbs | **Supported** |
| Home navigation | Home button/shortcut returns to root | Home breadcrumb returns to root | **Supported** |
| Keyboard zoom in/out | Dedicated zoom shortcuts | No zoom keyboard shortcuts | **Missing** |
| Back/forward navigation history | Page/pane history supports backward and forward navigation | Zoom state has no navigation history | **Missing** |
| Collapse/expand a branch | Arrow hides or reveals descendants | Per-parent collapse control; state is stored in the document | **Supported** |
| Expand/collapse all | Menu and double-click behavior operate over a whole level/subtree | No expand-all or collapse-all action | **Missing** |
| Sidebar tree | Collapsible sidebar shows Home tree and enables navigation/editing | Collapsible sidebar provides Home and node/tag/search shortcuts; Settings and Trash open in the main panel without hiding the sidebar | **Supported** |
| Create/move from sidebar | Add children or drag nodes to remote branches in sidebar | Nodes can be dragged onto the sidebar to create navigation shortcuts; structural editing remains in the outline | **Partial** |
| Star nodes | Pin frequently used nodes in the sidebar | Nodes can be pinned, removed, and reordered as persistent sidebar shortcuts | **Supported** |
| Star/save searches | Save a live filtered view with a custom name | Queries can be named, scoped, persisted, reordered, and reopened from the sidebar | **Supported** |
| Custom text shortcuts | Assign codes to nodes/searches and use them in Jump To | Persistent node and tag shortcuts exist, without user-defined text codes | **Partial** |
| Jump To | Cmd/Ctrl+K finds and navigates to any node | Cmd/Ctrl+K opens substring search and selecting a result zooms to it | **Partial** |
| Multiple panes | Independently navigate/edit several branches side by side | One editor view only | **Missing** |
| Zen/full-width modes | Commands hide chrome or expand writing width | No view modes | **Missing** |

### 3. Moving and restructuring

| Capability | Workflowy UX | Current app | Status |
|---|---|---|---|
| Move sibling up/down | Keyboard or drag reorders an item with descendants | Alt+Up/Down moves the current branch among siblings | **Supported** |
| Drag reorder within a parent | Drag a bullet before/after siblings | Bullet dots drag before/after siblings | **Supported** |
| Drag re-parent/re-nest | Drag anywhere, including beneath another parent | Three-way before/inside/after drop semantics support cross-parent moves and prevent cycles | **Supported** |
| Move To / Move Here | Search for a destination anywhere in the document | Accessible destination and placement picker is available from each bullet's actions | **Supported** |
| Move to child | Move a node beneath a chosen node | Move To supports placing the complete subtree inside any valid destination | **Supported** |
| Move entire subtree atomically | Descendants move with their parent | Same-parent movement replaces the complete list item, including descendants | **Supported** |
| Sort children | A–Z, Z–A, creation date, and match-based sorting | No sorting actions | **Missing** |
| Default insertion priority | A parent can place incoming items at the top or bottom by default | No per-parent insertion preference | **Missing** |
| Undo/redo structure and text | Native undo/redo | Native ProseMirror history covers text and structure | **Supported** |

### 4. Search and retrieval

| Capability | Workflowy UX | Current app | Status |
|---|---|---|---|
| Real-time text search | Filters the document as the user types | Case-insensitive substring result list updates as the user types | **Partial** |
| Edit directly in search results | Matching nodes remain editable in their surrounding outline | Contextual result rows provide inline text editing plus a separate Open action | **Supported** |
| Search current branch | Search is scoped to the currently zoomed page | Zoomed search defaults to the branch and can opt into all-outline search | **Supported** |
| Global search | Search the whole account/document | “Search all outline” covers the one document | **Supported** |
| Search result context | Results expose location/ancestors | Each result displays its ancestor breadcrumb path | **Supported** |
| Match highlighting | Matching text is visibly emphasized | Inline decoration highlights exact substring matches | **Supported** |
| Keyboard result navigation | Navigate and choose without leaving the keyboard | Up/Down/Enter/Escape are supported | **Supported** |
| Fuzzy/partial matching | Workflowy documents fuzzy partial matching | Literal substring only | **Partial** |
| Boolean/exact operators | AND, OR, NOT, quoted exact phrases | No query parser | **Missing** |
| Hierarchical/nested search | `ancestor > descendant` queries | No hierarchy operator | **Missing** |
| Type/property search | `is:`, `has:`, `text:`, `highlight:`, `changed:`, `in:note:` | No property index or operators | **Missing** |
| Tag/date/range search | Search tags, natural-language dates, and ranges | Clickable hashtag filtering is supported; date recognition and ranges remain absent | **Partial** |
| Completion-status search | Filter open/completed todos | Search supports `is:todo`, `is:open`, and `is:complete`, with discoverable filter controls | **Supported** |
| Search notes and attachments | Notes/files participate in search | Secondary node notes participate in search and highlighting; attachments remain absent | **Partial** |

### 5. Text formatting and node types

The current editor loads TipTap StarterKit 3.20.5. That gives underlying schema/commands for bold, italic, underline, strike, inline code, links, headings, blockquote, code block, ordered list, and horizontal rule. However, the app exposes no formatting toolbar, node menu, generic slash commands, or type-specific search. Block transforms are therefore classified as partial rather than equivalent Workflowy node-type UX.

| Capability | Workflowy UX | Current app | Status |
|---|---|---|---|
| Bold / italic / inline code | Selection toolbar, keyboard shortcuts, and markdown behavior | StarterKit marks and standard shortcuts/input rules | **Supported** |
| Underline / strikethrough | Selection toolbar and shortcuts | Both marks are exposed through an active-state formatting bubble menu | **Supported** |
| External links | Paste/autolink URLs or apply a URL to selected text | Autolinking plus validated create/remove-link controls are available from the formatting bubble menu | **Supported** |
| Text color/highlight | Selection toolbar with remembered color | No color or highlight extension/UI | **Missing** |
| Headings H1–H3 | First-class item types with menus, slash commands, and search | Heading extension exists, but no reliable outliner node-type conversion UX | **Partial** |
| Paragraph node | Hide bullet while preserving item behavior | No paragraph-style item action | **Missing** |
| Quote block | First-class type and markdown shortcut | Blockquote extension exists, but no app-level conversion UX | **Partial** |
| Code block | First-class type preserving whitespace | CodeBlock extension exists, but no app-level conversion UX | **Partial** |
| Divider | First-class type / markdown shortcut | HorizontalRule extension exists, but no app-level action | **Partial** |
| Numbered list | Auto-numbered item type | OrderedList extension exists; no Workflowy-style type control | **Partial** |
| Todo/checkbox | Toggle item type, complete, and hide/show completed | Cmd/Ctrl+Enter cycles bullet → open todo → completed todo → bullet; todos can also be changed by checkbox, searched by status, and globally hidden/shown | **Supported** |
| Per-node note field | Secondary styled text below a node; Shift+Enter focuses it | Editable secondary notes live inside each list item, support Shift+Enter, and follow branch operations and undo | **Supported** |
| Markdown typing | Converts heading, quote, task, divider, and inline syntax | StarterKit provides some input rules; task syntax is unsupported and block behavior is not productized | **Partial** |
| Markdown/HTML/plain-text paste | Converts imported structure and formatting | Browser/TipTap paste handles basic rich/plain content; no audited import mapping | **Partial** |
| Formatting selection toolbar | Floating widget appears on selection | A selection bubble exposes bold, italic, underline, strike, inline code, and validated links | **Supported** |
| Mixed node/layout types | Any branch can mix bullets, todos, headings, boards, etc. | User nodes are visually one bullet type; only `user` vs `ai` metadata differs | **Missing** |

### 6. Tags, dates, links, and knowledge connections

| Capability | Workflowy UX | Current app | Status |
|---|---|---|---|
| `#` tags | Parsed, suggested, clickable, searchable pills | Hashtags remain persisted plain text while decorations provide suggestions, pill styling, and click-to-filter behavior | **Supported** |
| `@` tags/mentions | Tags users and can notify collaborators | `@text` remains ordinary text | **Missing** |
| Tag colors | One color assignment updates every occurrence | No tag model | **Missing** |
| Date recognition | Numeric and natural-language text becomes a date pill | Dates remain ordinary text | **Missing** |
| Date picker / `!!` | Calendar picker, ranges, common dates | No date picker | **Missing** |
| Date display preferences | Custom format and start-of-week setting | No date settings | **Missing** |
| Internal links | `[[` picker links to existing or newly created nodes | No internal link picker or node-link mark | **Missing** |
| Backlinks | Target node lists every incoming internal link | No backlink index | **Missing** |
| Copy node link | Stable link to an exact node | Action menu copies a hash link and the app resolves it to zoom/select the stable node | **Supported** |
| External URL embeds | YouTube, Loom, X/Twitter and other supported media render inline | No embed extension | **Missing** |
| Deep links | `workflowy://` opens exact nodes in native apps | No custom URL scheme/deep-link routing | **Missing** |

### 7. Reuse and alternate views

| Capability | Workflowy UX | Current app | Status |
|---|---|---|---|
| Mirrors/live copies | The same node can appear and update in multiple locations | Strict tree model; no shared node references | **Missing** |
| Mirror destination picker | Mirror From/Here/To/Today/Date | No mirror model | **Missing** |
| View/detach mirrors | Inspect occurrences and turn one into an independent copy | No mirror model | **Missing** |
| Templates | Tag a branch as `#template` and insert fresh copies | No template registry/insertion | **Missing** |
| Board/Kanban layout | Children become columns and grandchildren become cards | No alternate layout | **Missing** |
| Board card/column drag and resize | Visual card movement and resizable columns | No board UI | **Missing** |
| Dashboard layout | Children appear as overview panels | No dashboard UI | **Missing** |
| Table layout | Children become rows/cells with keyboard navigation | No table UI/model | **Missing** |
| Table row/column operations | Add, move, resize, duplicate, and delete | No table UI | **Missing** |
| Presentation mode | Outline becomes title/slides/bullets | No presentation mode | **Missing** |

### 8. Calendar, capture, files, import, and export

| Capability | Workflowy UX | Current app | Status |
|---|---|---|---|
| Daily calendar/daily notes | Automatic node for each day with Today navigation | No calendar/daily-note system | **Missing** |
| Found Dates | Date-tagged items appear as live calendar references | No dates, mirrors, or calendar | **Missing** |
| Move/mirror to date | Commands reschedule one or multiple items | No calendar destinations | **Missing** |
| Quick Capture | OS-wide shortcut captures text/links without opening the app | No global capture window/shortcut | **Missing** |
| Mobile Quick Add / Share To | Capture from iOS/Android share sheets | No mobile app | **Missing** |
| Email to a node | Unique approved-sender email addresses create items | No inbound email | **Missing** |
| Files and images | Drag/drop upload, preview, resize, download | No attachment node or storage flow | **Missing** |
| Inline PDF preview | Open and scroll PDFs within the outline | No file preview | **Missing** |
| Image/file OCR | Command can extract text from an image | No attachment or OCR support | **Missing** |
| Export a branch | Formatted text, plain text, Markdown, or OPML | No export UI | **Missing** |
| Export all / backup | Export the account in portable formats | Raw `tree.json` exists in iCloud, but no user-facing backup/export flow | **Partial** |
| Print | Dedicated action/system shortcut | No app print action | **Missing** |
| Readwise/Kindle imports | Structured highlight import/sync | No imports | **Missing** |
| Zapier/API integrations | External systems can create/read/update nodes | No public node API or Zapier integration | **Missing** |
| Public API for agents | API supports create/update/move/complete/search and more | No external API server | **Missing** |
| MCP/CLI connector | External AI tools can operate on the outline | No MCP server or CLI | **Missing** |

### 9. Slash commands and command discovery

| Capability | Workflowy UX | Current app | Status |
|---|---|---|---|
| Slash menu | `/` exposes formatting, type, date, move, mirror, share, file, template, and AI actions | Start-of-bullet slash menu exposes todo, completion, bullet, note, and AI commands | **Partial** |
| Slash anywhere after a space | Commands can be invoked at the start or after whitespace | Deliberately start-of-bullet only | **Missing** |
| Keyboard selection | Filter, use arrows, Enter/Tab, Escape | Matching AI skills support arrows, Enter/Tab, and Escape | **Supported** |
| Generic item actions via slash | Delete, duplicate, move, sort, share, export, etc. | Todo completion/opening and note actions are available; move/delete/share/export remain menu-only or absent | **Partial** |
| Type/format slash actions | Todo, heading, paragraph, quote, code, board, table, etc. | `/todo`, `/done`, `/open`, `/bullet`, and `/note` are supported; richer block types remain absent | **Partial** |
| Command palette | Search and execute the full action set from one palette | No command palette; Cmd+K is outline search | **Missing** |
| Shortcut reference/help panel | In-app learnable keyboard shortcut panel | No shortcut help | **Missing** |
| Customizable hotkeys | Command palette exposes custom hotkey configuration | Hardcoded shortcuts only | **Missing** |

### 10. Sharing and collaboration

| Capability | Workflowy UX | Current app | Status |
|---|---|---|---|
| Share any subtree | Secret link or email invite exposes only that node and descendants | No sharing service | **Missing** |
| Permissions | View, Edit, or Full Access/Admin | Single local user only | **Missing** |
| Shared-state indicator | Blue halo marks shared nodes | No share state | **Missing** |
| Real-time collaboration | Multiple invited users edit shared content | No collaboration transport | **Missing** |
| Mentions/notifications | `@user` notifies or assigns | No users or notifications | **Missing** |
| Fractal comments | Infinitely nestable discussion threads attached to nodes | No comment model | **Missing** |
| Comment drafts/unread/read state | Draft persistence, counters, filters, navigation | No comment state | **Missing** |

### 11. Personalization, platform, and persistence

| Capability | Workflowy UX | Current app | Status |
|---|---|---|---|
| Automatic save | No save button | Debounced save after 600 ms plus `beforeunload` flush | **Supported** |
| Local persistence | Desktop content remains available locally | One JSON file in iCloud Drive | **Supported** |
| Cross-device sync | Web, desktop, iOS, and Android stay synced | Relies on macOS iCloud Drive; no app-level merge/conflict UX | **Partial** |
| Offline/local-first operation | Desktop app can keep working locally | Outline editing is local; AI and external tools require network | **Supported** |
| Web app | Full browser client | No hosted web app; Vite browser mode lacks Tauri persistence/settings | **Missing** |
| Mobile apps | Native iOS and Android UX | Not available | **Missing** |
| Themes | Preset light/dark themes and custom themes | One fixed visual theme | **Missing** |
| Fonts | User-selectable fonts including monospace | Fixed system font stack | **Missing** |
| Appearance controls | Link style, emoji style, image size, full width, embeds | No appearance settings | **Missing** |
| Daily change summaries | Optional email digest summarizes the previous day's account changes | No email summary service | **Missing** |
| Experimental/Labs features | User-controlled feature toggles | No feature-flag UI | **Missing** |
| Account/security UX | Sign-in, account, MFA, sharing identity | No app account system; only AI provider credentials | **Missing** |
| AI provider settings | Workflowy AI is bundled for Pro | User can choose ChatGPT subscription or OpenAI API key and model | **Different / advantage** |

### 12. AI comparison

| Capability | Workflowy UX | Current app | Status |
|---|---|---|---|
| Chat with all notes | Account-wide retrieval, answers, connections, and supporting notes | No account-wide AI chat/retrieval UI | **Missing** |
| Chat about current page | Chat can focus on the current node and its whole subtree | `/ask` is one-shot and receives ancestor/current-item text, not descendants | **Partial** |
| Persistent chat history | Start, revisit, continue, and delete chats | No chat session/history model | **Missing** |
| AI node in the outline | Prompt near content and generate in place | Skills insert streaming child bullets that use normal bullet styling after generation | **Supported** |
| Nearby/page context | AI node uses nearby items; focused chat can use a whole page | Context is ancestors from outermost to current bullet only | **Partial** |
| Accept/reject/regenerate | Explicit controls gate or retry generated output | Output is inserted immediately; undo removes it, Stop cancels it | **Partial** |
| Prepared transformations | Summarize, find tasks, draft outline, fix grammar, shorten | Research, brainstorm, and ask skills instead | **Different** |
| Structured outline generation | AI can draft/transform outline content | One generated line becomes one child bullet | **Supported** |
| Streaming output | AI generation visibly progresses | Deltas stream into stable AI child bullets | **Supported** |
| Cancellation and failure state | AI node controls include response management | Stop button aborts; `[cancelled]` / `[error: …]` remains in place | **Supported** |
| Undo-safe generation | Generated changes participate safely in document editing | Streaming writes stay out of history; one undo removes the generation | **Supported** |
| AI provenance styling | Workflowy has an AI Node type | `nodeType: 'ai'` is retained internally, but completed output has no visible AI marker | **Missing** |
| Web research tools | Not described as a configurable Workflowy AI UX in reviewed pages | Built-in DuckDuckGo search and Jina page fetch can be enabled | **Different / advantage** |
| Custom agent tools | Workflowy exposes API/MCP routes for external agents | Users can configure approved public GET endpoints as Codex tools | **Different / advantage** |
| Agent can restructure existing tree | API/MCP agents can create, update, move, complete, delete, and search | In-app agent only appends/replaces its generated child list | **Missing** |
| Bring-your-own model/auth | Workflowy AI is an account feature | ChatGPT OAuth or OpenAI API key, with model selection | **Different / advantage** |

---

## Recommended parity priorities

### P0 — Make the core outliner trustworthy

1. **Implemented:** Cross-parent drag/re-nesting and an accessible Move To picker with cycle prevention.
2. **Implemented:** Explicit node actions for delete branch, duplicate, move, collapse, and copy link.
3. **Implemented:** Persisted Trash with restore, root fallback, and confirmed permanent deletion.
4. **Implemented:** Contextual search results with direct inline editing and a separate Open action.
5. **Implemented:** Visible load/save errors with retry/dismiss behavior; failed saves retain pending content.

### P1 — Highest-value Workflowy power features

1. **Implemented:** First-class todos/completion, including hide/show completed and completion search.
2. **Implemented:** Tags with click-to-filter plus named, scoped, saved sidebar searches.
3. **Implemented:** Node notes for secondary detail without adding visual tree depth.
4. **Implemented:** Sidebar + Jump To for large-outline navigation.
5. **Implemented:** Formatting bubble menu for the editor capabilities already present in StarterKit.
6. **Internal links/backlinks** only if the product is ready to evolve from a strict tree toward linked knowledge.

### P2 — Differentiate around AI rather than clone every layout

1. Expand context from ancestors-only to an explicit scope: current item, subtree, page, or whole outline.
2. Add AI actions that fit this product: summarize branch, extract tasks, rewrite, expand, and organize preview.
3. Add accept/reject/regenerate and a visible provenance/history model.
4. Let users invoke safe structural agent tools with confirmation and undo.
5. Add account-wide semantic retrieval only after basic search/tag navigation is solid.

### Defer unless validated

Boards, tables, calendar, collaboration, comments, mobile apps, public APIs, MCP, and presentations are large product surfaces. They should not be treated as automatic parity requirements for a focused AI outliner.

## Bottom line

The app supports the Workflowy interaction loop of **write → nest → focus → collapse → find**, but not yet Workflowy's broader loop of **type/annotate → connect → save views → reuse → share → access everywhere**. The strongest route is to close the trust and navigation gaps first, then use the app's agent/tool architecture as the differentiator rather than pursuing exhaustive Workflowy parity immediately.
