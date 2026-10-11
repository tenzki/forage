ALTER TABLE agent_provider_credentials DROP CONSTRAINT agent_provider_credentials_provider_check;
ALTER TABLE agent_provider_credentials ADD CONSTRAINT agent_provider_credentials_provider_check
  CHECK (provider IN ('openai-codex', 'openai', 'anthropic', 'openrouter', 'opencode-go', 'supadata', 'image-provider'));
ALTER TABLE agent_compute_profiles DROP CONSTRAINT agent_compute_profiles_provider_check;
ALTER TABLE agent_compute_profiles ADD CONSTRAINT agent_compute_profiles_provider_check
  CHECK (provider IN ('openai-codex', 'openai', 'anthropic', 'openrouter', 'opencode-go'));
