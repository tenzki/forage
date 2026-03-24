-- Migration: 0001_initial_schema.sql
-- Creates the nodes table — the universal data structure for the entire app.
-- UUID PK, adjacency list, fractional-index ordering, node_type CHECK constraint.

CREATE TABLE IF NOT EXISTS nodes (
    id          TEXT PRIMARY KEY NOT NULL,           -- UUID v4 as TEXT(36)
    parent_id   TEXT REFERENCES nodes(id) ON DELETE CASCADE,  -- NULL = root node
    position    TEXT NOT NULL,                       -- fractional index e.g. "a0", "a1V"
    content     TEXT NOT NULL DEFAULT '{}',          -- TipTap/ProseMirror JSON
    node_type   TEXT NOT NULL DEFAULT 'note'
                CHECK (node_type IN ('note','agent_response','command','chat_message')),
    collapsed   INTEGER NOT NULL DEFAULT 0,          -- SQLite boolean (0 = false, 1 = true)
    skill_id    TEXT,                                -- nullable FK placeholder for Phase 4
    metadata    TEXT,                                -- JSON: generation metadata, original prompt
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

-- Primary query pattern: fetch children ordered by position
CREATE INDEX IF NOT EXISTS idx_nodes_parent_position
    ON nodes (parent_id, position);

-- Phase 3 filtering by node type
CREATE INDEX IF NOT EXISTS idx_nodes_node_type
    ON nodes (node_type);

-- Enforce referential integrity
PRAGMA foreign_keys = ON;
