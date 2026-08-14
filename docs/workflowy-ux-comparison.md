# Workflowy UX research and comparison

**Research date:** 2026-08-14  
**Compared product:** the current `ai-chat` repository implementation  
**Scope:** Workflowy's public product site and official help documentation. This is a heuristic/product analysis, not an authenticated usability test.

## Executive summary

Workflowy's UX is not mainly defined by bullet styling. Its core is a consistent interaction model:

1. **One infinite document** removes filing decisions.
2. **Every bullet is simultaneously content, a container, and a navigable page.**
3. **Zoom, collapse, and scoped search control complexity without changing the underlying structure.**
4. **Inline editing keeps users in context.** Search results, mirrored nodes, panes, and AI output remain editable where they appear.
5. **Progressive disclosure preserves a quiet canvas.** Advanced actions live in hover menus, slash commands, keyboard shortcuts, the sidebar, and the command palette.
6. **Mouse and keyboard paths are both first-class.**

The current app has the right architectural foundation—one TipTap document, real nested list items, native undo/redo, local autosave—and a distinctive branch-aware AI workflow. However, its present UX implements only the first layer of an outliner. Zoom/hoist, collapse, breadcrumbs, search, drag reorder, structural move shortcuts, clickable bullet controls, and contextual node actions are absent from the current source.

The result looks Workflowy-like but does not yet reproduce Workflowy's essential **focus–navigate–restructure–find** loop. The highest-value next step is to complete that loop before adding Workflowy's broader feature set.

## 1. Workflowy's UX model

### 1.1 One object, many scales

Workflowy describes itself as a single infinite document with no folders or separate files. A bullet can behave as:

- a line of text;
- a task or note;
- the parent of an arbitrarily deep branch;
- a project or document when zoomed into;
- a stable destination for links, shortcuts, mirrors, sharing, and panes.

This reduces conceptual overhead. Users learn one object—the node—and reuse it at every scale instead of deciding whether something should be a page, folder, card, database row, or document.

### 1.2 Complexity is controlled through views, not filing

Workflowy gives users several reversible ways to reduce what is visible:

- **Collapse** folds a branch in place.
- **Zoom** makes a node the current page and hides everything outside it.
- **Breadcrumbs and Home** retain location and provide fast escape routes.
- **Search** filters either the entire document or the currently zoomed branch.
- **Sidebar and shortcuts** expose frequently used destinations and saved searches.
- **Panes** show multiple locations without duplicating content or losing the current place.

These mechanisms are central, not optional polish. Without them, an infinite tree becomes visually and cognitively unmanageable as it grows.

### 1.3 The interface is quiet but not action-poor

The default canvas stays focused on content. More capability appears only when requested:

- hovering a bullet exposes its menu;
- selecting text exposes formatting;
- typing `/` exposes context-sensitive actions;
- keyboard shortcuts support frequent operations;
- the command palette supports infrequent operations without requiring memorized hotkeys;
- the sidebar can be hidden for more writing space.

This is effective progressive disclosure: low visual noise for beginners, high operational depth for experienced users. Its tradeoff is discoverability; onboarding, visible hover states, and searchable commands are needed to teach the hidden interaction surface.

### 1.4 Keyboard and pointer interactions mirror each other

Core operations are available through both modes:

| Intent | Pointer path | Keyboard path |
|---|---|---|
| Add | plus/new-node controls | `Enter` |
| Nest | drag/reposition | `Tab` / `Shift+Tab` |
| Reorder | drag bullet | move shortcuts |
| Focus | click bullet | zoom shortcut |
| Hide detail | click disclosure arrow | expand/collapse shortcuts |
| Navigate | sidebar/breadcrumbs | Jump To and navigation shortcuts |
| Act on a node | bullet menu | slash command / command palette |

This makes the system approachable without limiting keyboard-heavy users.

### 1.5 Search is a working view, not a result page

Workflowy filters the document in real time and lets users edit directly in the filtered result set. Search can be scoped by zooming first, combined with tags, type, dates, and completion status, and saved as a live sidebar view.

The important UX principle is **preserving locality**: finding content does not move the user into a detached search screen where the result is merely a link.

### 1.6 Advanced features reuse the same node grammar

Workflowy adds capability without abandoning the outline:

- node types include todos, headings, paragraphs, quotes, numbered lists, and code blocks;
- child layouts include boards, dashboards, and tables;
- notes add secondary detail beneath a node;
- tags, dates, internal links, and backlinks connect or filter nodes;
- mirrors show the same live node in multiple contexts;
- templates copy reusable branch structures;
- panes show another live view of existing content.

This consistency is a major UX strength. New features generally transform, reference, or display nodes rather than introducing unrelated object models.

### 1.7 Workflowy AI remains inside the document

Workflowy currently exposes three AI modes:

- **Chat with Your Notes** across the account or scoped to the current page;
- **AI Nodes** that use nearby items as context and generate in the outline;
- **Quick Actions** such as summarize, find tasks, draft an outline, fix grammar, and shorten.

AI Nodes provide explicit **Accept**, **Reject**, and **Regenerate** controls. This makes generated changes provisional and keeps the user in control. Workflowy also separates broad retrieval/chat from local transformations, making the AI's context boundary legible.

### 1.8 Trust comes from reversibility and continuity

Workflowy autosaves and syncs across web, desktop, and mobile. Undo/redo, trash restoration, non-destructive collapse/zoom, pane continuity, and live mirrors reinforce the expectation that users can reorganize freely without losing work.

## 2. Current app implementation

This audit describes code currently present under `src/`; it deliberately does not rely on completion marks in planning documents.

### 2.1 What is implemented

- **One live TipTap/ProseMirror document** for the whole outline (`src/editor/OutlinerEditor.tsx`).
- **Real nested `bulletList` / `listItem` structure**, with one empty starting bullet (`src/editor/emptyDoc.ts`).
- **Inline editing**, normal list-item creation through TipTap, and `Tab` / `Shift+Tab` nesting (`src/editor/extensions.ts`).
- **Native ProseMirror undo/redo**, retained while Settings is shown because the editor remains mounted (`src/App.tsx`).
- **Stable UUID identity** for list items and an AI/user node type (`src/editor/extensions.ts`).
- **Minimal, centered writing canvas** with a 760 px maximum width (`src/style.css`).
- **Debounced local persistence** to an iCloud Drive JSON file after 600 ms (`src/persistence/outlineFile.ts`).
- **Anthropic BYOK settings**, stored through Tauri's store plugin (`src/components/Settings/SettingsPanel.tsx`).
- **Three AI slash skills**: research, brainstorm, and ask (`src/agent/skills.ts`).
- **Ancestor-based branch context**, streamed child bullets, stable generated IDs, visually distinct AI nodes, and single-step undo for a whole generation (`src/agent/insertIntoEditor.ts`).
- **Slash menu keyboard selection** with Up, Down, Enter, and Escape (`src/components/Agent/SlashMenu.tsx`).

### 2.2 What is not exposed in the current implementation

- Zoom/hoist and breadcrumbs.
- Branch collapse/expand controls or persisted collapse state.
- Search, scoped search, result navigation, or saved searches.
- Sidebar, Jump To, shortcuts, or navigation history.
- Clickable/hoverable bullet controls and a node context menu.
- Drag reorder/reparenting.
- Keyboard move-up/move-down commands.
- Node notes, todos, completion, headings as a user-facing node type, boards, or tables.
- Tags, dates, internal links/backlinks, mirrors, or templates.
- Trash and restore.
- Panes or multiple views of a branch.
- A general-purpose slash command or command palette; `/` only searches the three AI skills and only when node text starts with `/`.
- AI accept/reject/regenerate controls, visible cancellation, chat history, all-notes retrieval, or global AI chat.
- Visible save/sync state, persistence error UI, or conflict handling.
- Onboarding that teaches the hidden keyboard behavior.

TipTap's StarterKit supplies editing primitives beyond what the app visibly teaches or controls, but loading an editor extension is not equivalent to providing a discoverable product workflow.

## 3. Side-by-side comparison

| UX area | Workflowy | Current app | Assessment |
|---|---|---|---|
| Core mental model | One infinite document | One TipTap document | **Strong alignment** |
| Hierarchy | Infinite nesting | Real nested list items | **Strong alignment** |
| Create/edit inline | Inline; `Enter` creates a node | Inline; standard TipTap list behavior | **Aligned at the basic level** |
| Indent/outdent | Keyboard, menus, commands | `Tab` / `Shift+Tab` | **Basic parity** |
| Reorder/reparent | Drag, move shortcuts, Move To | Not implemented | **Critical gap** |
| Collapse/expand | Disclosure arrows; keyboard; expand/collapse all | Not implemented | **Critical gap** |
| Zoom/focus | Clickable bullets, shortcuts | Not implemented | **Critical gap** |
| Location awareness | Breadcrumbs, Home, history | Static app title only | **Critical gap** |
| Search | Live, editable, scoped, filterable, saveable | Not implemented | **Critical gap** |
| Navigation | Sidebar, starred items/searches, Jump To, shortcuts | Not implemented | **Major gap** |
| Bullet affordance | Bullet is a visible interaction target with hover menu | Bullet is a CSS pseudo-element with no interaction | **Major gap** |
| Undo/redo | Native interaction plus trash recovery | Native ProseMirror history | **Good foundation; no recovery UI** |
| Formatting | Rich inline and block formatting with visible selection UI | StarterKit loaded; no formatting UI | **Partially latent, not discoverable** |
| Node types | Todos, headings, paragraphs, lists, quotes, code, layouts | User/AI metadata only | **Large breadth gap; not all needed for v1** |
| Tags/links | Tags, dates, backlinks, links | Not implemented | **Deferred capability** |
| Reuse | Mirrors and templates | Not implemented | **Deferred capability** |
| Multiple contexts | Panes and mirrors remain live/editable | Single view only | **Deferred capability** |
| Slash interaction | General contextual action surface | Three AI skills only | **Focused differentiator, narrower grammar** |
| Local AI | AI Nodes use nearby context; quick actions; review controls | Ancestors as context; streamed AI children | **Promising differentiation** |
| Broad AI | All-notes/page chat with history and sources | Not implemented | **Workflowy is broader** |
| AI provenance | AI Node interaction model | Purple bullets and sparkle marker | **Current app is especially clear visually** |
| AI control | Accept, reject, regenerate | Auto-commits output; implicit cancellation only | **Control gap** |
| Persistence | Account sync across platforms | Local iCloud JSON autosave | **Different product strategy** |
| Save feedback | Automatic continuity across clients | No visible status or error state | **Trust gap** |
| Visual focus | Minimal content-first canvas | Minimal centered canvas | **Good alignment** |
| Progressive disclosure | Hover menus, slash, palette, hidden sidebar | Mostly absent rather than hidden | **Appearance aligns; capability does not yet** |
| Accessibility/discovery | Multiple visible and keyboard paths | Sparse controls; slash list has no explicit combobox/listbox semantics | **Needs focused review** |

## 4. Where the current app is stronger or more distinctive

### Branch-aware AI is the product's clearest differentiator

The current AI flow converts `/research …`, `/brainstorm …`, or `/ask …` into structured child bullets using the current ancestor path as context. Output streams into the outline without moving the user's caret, and one undo removes the whole generation. These are thoughtful outliner-native details rather than a generic chat panel attached to a notes app.

### AI authorship is immediately visible

Purple AI text, a purple bullet, and a sparkle suffix make provenance more visually explicit than ordinary content. This supports the requirement that users know what the agent wrote.

### The local-first architecture is simple and legible

A single JSON document in iCloud Drive avoids accounts, a hosted backend, and a custom sync service. Direct Anthropic requests with a user-provided key also keep infrastructure small. This is strategically different from Workflowy's multi-platform collaborative cloud product and should not be treated as a feature deficit by default.

### The single-editor architecture is appropriate

Keeping one ProseMirror document preserves structural editing and history in one transaction model. It is well suited to implementing Workflowy-like behavior without reintroducing per-node editors or an external undo stack.

## 5. Main UX risks

### 5.1 Visual resemblance may overstate functional readiness

The centered page, sparse header, and gray bullet dots signal “Workflowy-like,” but the dots cannot zoom, collapse, open menus, or initiate drag. Users familiar with outliners are likely to try those actions immediately.

### 5.2 The tree will not scale cognitively without focus tools

Infinite nesting is technically possible, but large outlines need collapse, zoom, breadcrumbs, and search. These are the mechanisms that make Workflowy's infinite document usable rather than merely large.

### 5.3 Core structural operations are incomplete

Indent/outdent alone is not enough for keyboard-driven organization. Users need to move a branch up/down, reorder by drag, and ideally move it to distant destinations without cut/paste.

### 5.4 Autosave failures are invisible

Load failures are logged and ignored; asynchronous save failures have no user-facing state. Local-first products need especially clear confidence signals because there is no server UI users can consult when something goes wrong.

### 5.5 Generated content is committed before review

The AI immediately creates child content. There is no visible cancel action and no accept/reject/regenerate step. Undo helps, but provisional UI would communicate agency better and reduce accidental retention of poor output.

### 5.6 The slash menu is too semantically narrow to become the main command surface

Workflowy uses `/` as a general node action vocabulary. In the current app it means only “run an AI skill.” That simplicity may be intentional, but future structural commands will need either a unified menu with categories or a separate command palette to avoid overlapping interaction models.

## 6. Recommended priorities

### P0 — Complete the core outliner loop

1. **Make bullets real controls.** Add hover/focus states, child-count/disclosure behavior, and a node action target rather than relying only on `::before` decoration.
2. **Add collapse/expand.** Preserve state separately from document content unless collapse is intentionally part of synced document state.
3. **Add zoom/hoist with breadcrumbs and Home.** Keep the single editor mounted and treat zoom as a view projection, not a separate editor/document.
4. **Add structural movement.** Support keyboard move-up/down and drag reorder/reparent for whole subtrees.
5. **Add live search.** Start with text search, branch scoping, keyboard result navigation, and edit-in-place behavior.

These five items deliver the interaction loop that makes Workflowy feel like Workflowy.

### P1 — Improve trust, control, and learnability

1. Show `Saving…`, `Saved`, and actionable save/load errors.
2. Add a visible generation state with **Cancel**, then **Accept / Regenerate / Remove** or an equivalent lightweight review flow.
3. Give the slash menu proper accessible combobox/listbox semantics and support both `Enter` and `Tab` selection if that matches the intended command grammar.
4. Add a compact first-run hint for `Enter`, `Tab`, `Shift+Tab`, zoom, and search.
5. Add a node menu so pointer users can discover keyboard-supported actions.

### P2 — Add only the Workflowy breadth that supports this product

Good candidates:

- todos and completion;
- note fields for secondary detail;
- tags and simple tag filtering;
- internal links;
- reusable prompt/skill templates;
- a general command palette.

Do not copy boards, tables, mirrors, calendars, collaboration, or panes merely for parity. Their value should be tested against the app's AI-first, personal, local-first positioning.

## 7. Product direction

The best direction is **not “Workflowy clone plus chat.”** It is:

> A focused, local-first outliner that adopts Workflowy's proven interaction grammar and makes branch-aware AI generation safer, clearer, and faster than a separate chat workflow.

Use Workflowy as the benchmark for navigation, hierarchy, focus, and reversibility. Differentiate through:

- explicit branch context;
- structured child generation;
- visible AI provenance;
- user-controlled generation and revision;
- local ownership of the outline and API credentials.

## 8. Verification performed

At the time of this audit:

- `npm test` passed: **2 test files, 8 tests**.
- `npm run build` passed.
- Vite reported only a bundle-size warning during the production build.

The existing tests cover editor preservation across Settings and AI insertion/history/caret behavior. They do not currently test zoom, collapse, search, drag, or structural movement because those interactions are not present in the current source.

## Sources

Official Workflowy sources, accessed 2026-08-14:

- [Workflowy product site](https://workflowy.com/)
- [Get started](https://workflowy.com/help/get-started)
- [Navigate around](https://workflowy.com/help/navigate-around)
- [Add, edit and format](https://workflowy.com/help/add-edit-format)
- [Search your notes](https://workflowy.com/help/search-your-notes)
- [Bullets](https://workflowy.com/help/bullets)
- [Hotkeys / keyboard shortcuts](https://workflowy.com/help/hotkeys)
- [Sidebar and navigation](https://workflowy.com/help/sidebar-navigation)
- [Slash command](https://workflowy.com/help/slash-command)
- [Change node types](https://workflowy.com/help/change-node-types)
- [Text and block formats](https://workflowy.com/help/text-block-formats)
- [Tags, dates, and backlinks](https://workflowy.com/help/organise-with-tags-dates-backlinks)
- [Mirrors and templates](https://workflowy.com/help/reuse-content-with-mirrors-templates)
- [Panes](https://workflowy.com/help/panes)
- [Use Workflowy AI](https://workflowy.com/help/use-workflowy-ai)
- [Command Palette](https://workflowy.com/help/command-palette)
- [2025 Year in Review](https://blog.workflowy.com/2025-year-in-review/)

Current app evidence:

- `src/App.tsx`
- `src/editor/OutlinerEditor.tsx`
- `src/editor/extensions.ts`
- `src/editor/emptyDoc.ts`
- `src/components/Agent/SlashMenu.tsx`
- `src/agent/insertIntoEditor.ts`
- `src/agent/skills.ts`
- `src/components/Settings/SettingsPanel.tsx`
- `src/persistence/outlineFile.ts`
- `src/style.css`
- `src/App.test.tsx`
- `src/agent/insertIntoEditor.test.ts`
