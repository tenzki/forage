-- Migration: 0002_search_and_editing.sql
-- Phase 3: Search and Editing infrastructure.
-- Creates: content_text column, FTS5 search table, undo history tables, and node tags table.

-- ─── FTS5 Full-Text Search ────────────────────────────────────────────────────

-- Add extracted plain text column for FTS5 indexing.
-- Frontend extracts text from ProseMirror JSON and passes it alongside content updates.
ALTER TABLE nodes ADD COLUMN content_text TEXT NOT NULL DEFAULT '';

-- FTS5 virtual table (external content mode, synced via triggers).
-- Uses nodes.rowid (INTEGER) not nodes.id (UUID TEXT) for the join.
CREATE VIRTUAL TABLE nodes_fts USING fts5(
    content_text,
    content='nodes',
    content_rowid='rowid',
    tokenize='unicode61'
);

-- Sync trigger: INSERT
CREATE TRIGGER nodes_fts_ai AFTER INSERT ON nodes BEGIN
    INSERT INTO nodes_fts(rowid, content_text) VALUES (new.rowid, new.content_text);
END;

-- Sync trigger: DELETE
CREATE TRIGGER nodes_fts_ad AFTER DELETE ON nodes BEGIN
    INSERT INTO nodes_fts(nodes_fts, rowid, content_text) VALUES ('delete', old.rowid, old.content_text);
END;

-- Sync trigger: UPDATE
CREATE TRIGGER nodes_fts_au AFTER UPDATE ON nodes BEGIN
    INSERT INTO nodes_fts(nodes_fts, rowid, content_text) VALUES ('delete', old.rowid, old.content_text);
    INSERT INTO nodes_fts(rowid, content_text) VALUES (new.rowid, new.content_text);
END;

-- ─── Undo/Redo History ────────────────────────────────────────────────────────

CREATE TABLE undo_history (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    operation   TEXT NOT NULL CHECK (operation IN ('text_edit', 'create', 'delete', 'move', 'indent', 'outdent')),
    node_id     TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    before_json TEXT NOT NULL,
    after_json  TEXT NOT NULL,
    group_key   TEXT,           -- NULL = standalone; timestamp bucket for text edit grouping
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE TABLE undo_pointer (
    id       INTEGER PRIMARY KEY CHECK (id = 1),
    position INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO undo_pointer VALUES (1, 0);

-- ─── Node Tags ────────────────────────────────────────────────────────────────

CREATE TABLE node_tags (
    node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    tag     TEXT NOT NULL,
    PRIMARY KEY (node_id, tag)
);

CREATE INDEX idx_node_tags_tag ON node_tags (tag);
