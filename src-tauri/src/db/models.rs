use serde::{Deserialize, Serialize};
use specta::Type;

/// The four node types as a strict enum.
/// Stored as TEXT in SQLite via CHECK constraint.
/// Use `to_db_str()` / `from_db_str()` to guarantee exact string values.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum NodeType {
    Note,
    AgentResponse,
    Command,
    ChatMessage,
}

impl NodeType {
    /// Returns the exact string stored in the SQLite CHECK constraint.
    pub fn to_db_str(&self) -> &'static str {
        match self {
            NodeType::Note => "note",
            NodeType::AgentResponse => "agent_response",
            NodeType::Command => "command",
            NodeType::ChatMessage => "chat_message",
        }
    }

    /// Parses a string from the database back into NodeType.
    pub fn from_db_str(s: &str) -> Result<Self, String> {
        match s {
            "note" => Ok(NodeType::Note),
            "agent_response" => Ok(NodeType::AgentResponse),
            "command" => Ok(NodeType::Command),
            "chat_message" => Ok(NodeType::ChatMessage),
            other => Err(format!("Unknown node_type value: {}", other)),
        }
    }
}

/// A node in the outliner tree.
///
/// Mirrors all columns in the `nodes` table.
/// content and metadata are stored as TEXT JSON in SQLite and
/// deserialized to `serde_json::Value` in Rust.
///
/// NOTE: We do NOT derive sqlx::FromRow — instead we use manual `sqlx::query()`
/// with runtime string queries (not compile-time checked) per RESEARCH.md Pitfall 5.
/// The DB path is dynamic (resolved via app_data_dir at runtime), so compile-time
/// query checking is not applicable.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct Node {
    /// UUID v4 stored as TEXT(36)
    pub id: String,
    /// NULL for root nodes
    pub parent_id: Option<String>,
    /// Fractional index for sibling ordering, e.g. "a0", "a1V"
    pub position: String,
    /// TipTap/ProseMirror JSON document
    pub content: serde_json::Value,
    /// Stored as TEXT in SQLite; serialized via NodeType methods
    pub node_type: String,
    /// Boolean stored as INTEGER (0/1) in SQLite
    pub collapsed: bool,
    /// Which skill generated this node (nullable, used in Phase 4)
    pub skill_id: Option<String>,
    /// Generation metadata: model, tokens, original prompt, etc.
    pub metadata: Option<serde_json::Value>,
    /// ISO 8601 timestamp
    pub created_at: String,
    /// ISO 8601 timestamp
    pub updated_at: String,
}
