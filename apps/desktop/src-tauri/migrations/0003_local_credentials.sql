-- Local secrets (OpenAI API key, ChatGPT tokens, server device token) live beside the
-- outline in application data rather than in the OS keychain. See ADR-0014.
CREATE TABLE IF NOT EXISTS local_credentials (
    reference TEXT PRIMARY KEY NOT NULL,
    secret TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
