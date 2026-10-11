export const mcpText = (value: string, limit = 8000) => value.slice(0, limit).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '')

export function mcpSettingsError(cause: unknown, fallback = 'MCP operation failed. Check the connection and try again.') {
  const message = cause instanceof Error ? cause.message : ''
  if (message === 'MCP: Review and save access in Settings before using this server.') return message.slice(5)
  if (/^MCP: (Sign in again to use this server\.|This server does not support this public-client sign-in setup\.|Sign-in was denied\. Try again when you are ready\.|Sign-in expired\. Start a new sign-in request\.|Sign-in failed\. Check the server setup and try again\.|Authorization service is unavailable\. Retry explicitly\.)$/.test(message)) return message.slice(5)
  if (/Authentication failed/i.test(message)) return 'Authentication failed. Check the required headers or environment credentials and retry.'
  if (/unsupported.*inventory/i.test(message)) return 'The server returned an unsupported or oversized tool inventory. Check the server and refresh.'
  if (/changed|removed|Unexpected credential fields/i.test(message)) return 'This connection changed or was removed. Scan again or refresh its tools before reviewing access.'
  if (/already (exists|imported)/i.test(message)) return 'This connection is already imported, or its name is in use. Use a different name for a distinct configuration.'
  if (/existing agent/i.test(message)) return 'Choose an existing agent. The selected agent may have been removed.'
  if (/64 tools|fewer tools/i.test(message)) return 'At most 64 tools can be enabled or assigned to an agent. Select fewer tools.'
  if (/32 MCP/i.test(message)) return 'At most 32 MCP connections are supported.'
  if (/server name/i.test(message)) return 'Enter a server name of up to 80 characters.'
  if (/credential fields|configuration size|size limit/i.test(message)) return 'Check the required credential fields and configuration size.'
  if (/mcpServers JSON|HTTPS|Invalid HTTP headers/i.test(message)) return 'Check the configuration. Use command/args/env or url/headers; remote URLs require HTTPS and credentials belong in headers, not the URL.'
  if (/Authorization header/i.test(message)) return 'Use either the access token or an Authorization header.'
  if (/unique name/i.test(message)) return 'Each credential or environment variable must have a unique name.'
  if (/Give each credential/i.test(message)) return 'Give each credential or environment variable a name.'
  if (/quotation mark/i.test(message)) return 'Close the quotation mark in the launch command.'
  if (/incomplete escape/i.test(message)) return 'The command ends with an incomplete escape.'
  if (/shell operators|environment variables below/i.test(message)) return 'Use literal command arguments. Add environment variables in their fields; shell operators and expansion are not supported.'
  if (/launch command/i.test(message)) return 'Enter the server’s launch command.'
  if (/timed out/i.test(message)) return 'MCP connection timed out. Check the server configuration and retry.'
  if (/Node.js|Command not found/i.test(message)) return 'Could not start MCP discovery. Install the required runtime or executable and retry.'
  if (/publish/i.test(message)) return 'Access was saved on this device, but could not be published to the server. Retry Save access or repair Connection.'
  return fallback
}
