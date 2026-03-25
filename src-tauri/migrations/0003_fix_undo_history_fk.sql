-- Migration: 0003_fix_undo_history_fk.sql
-- Remove FOREIGN KEY constraint from undo_history.node_id.
-- The FK caused cascade deletes (losing redo entries when nodes were deleted)
-- and PRAGMA foreign_keys=OFF workarounds failed with connection pools.
-- Undo history entries for deleted nodes are harmless — undo just skips them.

CREATE TABLE undo_history_new (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    operation   TEXT NOT NULL CHECK (operation IN ('text_edit', 'create', 'delete', 'move', 'indent', 'outdent')),
    node_id     TEXT NOT NULL,
    before_json TEXT NOT NULL,
    after_json  TEXT NOT NULL,
    group_key   TEXT,
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

INSERT INTO undo_history_new SELECT * FROM undo_history;

DROP TABLE undo_history;

ALTER TABLE undo_history_new RENAME TO undo_history;

-- Reset undo pointer to 0 since old history may be inconsistent
UPDATE undo_pointer SET position = 0 WHERE id = 1;
