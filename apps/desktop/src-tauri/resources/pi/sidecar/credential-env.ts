const MODEL_CREDENTIAL_ENVIRONMENT = [
  'AI_CHAT_PROVIDER', 'AI_CHAT_API_KEY', 'AI_CHAT_ACCOUNT_ID', 'AI_CHAT_MODEL_ID', 'AI_CHAT_OAUTH_EXPIRES',
  'OPENAI_API_KEY', 'OPENAI_ACCESS_TOKEN', 'ANTHROPIC_API_KEY',
]

export function scrubModelCredentialEnvironment(environment: NodeJS.ProcessEnv = process.env): void {
  for (const name of MODEL_CREDENTIAL_ENVIRONMENT) delete environment[name]
}
