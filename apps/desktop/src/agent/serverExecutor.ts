import { invoke as tauriInvoke } from '@tauri-apps/api/core'
import { z } from 'zod'
import {
  agentActivityPageSchema,
  agentConfigurationPublishRequestSchema,
  agentConfigurationResponseSchema,
  agentRunAdmissionResponseSchema,
  agentRunDetailSchema,
  agentRunListResponseSchema,
  agentRunRetryResponseSchema,
  apiKeyEnrollmentRequestSchema,
  automationPolicyPublishRequestSchema,
  credentialMetadataSchema,
  deviceAuthorizationStartResponseSchema,
  deviceAuthorizationStatusSchema,
} from '@forage/protocol'
import { runInputSchema, type ActivityEvent, type RunInput, type RunStatus } from '@forage/agent-runtime'

type RunDetail = z.infer<typeof agentRunDetailSchema>
type ActivityPage = z.infer<typeof agentActivityPageSchema>
type InvokeFunction = (command: string, arguments_?: Record<string, unknown>) => Promise<unknown>

export interface ServerAgentTransport {
  invoke(input: RunInput): Promise<z.infer<typeof agentRunAdmissionResponseSchema>>
  run(runId: string): Promise<RunDetail>
  activity(runId: string, afterSequence: number, limit?: number): Promise<ActivityPage>
  cancel(runId: string): Promise<void>
  retry(runId: string): Promise<z.infer<typeof agentRunRetryResponseSchema>>
}

export class TauriServerAgentTransport implements ServerAgentTransport {
  constructor(private readonly invokeNative: InvokeFunction = (command, arguments_) => tauriInvoke(command, arguments_)) {}

  async configuration() {
    return agentConfigurationResponseSchema.parse(await this.invokeNative('server_agent_configuration'))
  }
  async publishConfiguration(request: unknown) {
    const parsed = agentConfigurationPublishRequestSchema.parse(request)
    return agentConfigurationResponseSchema.parse(await this.invokeNative('server_agent_publish_configuration', { request: parsed }))
  }
  async automation(): Promise<unknown> { return this.invokeNative('server_agent_automation') }
  async publishAutomation(request: unknown): Promise<unknown> {
    return this.invokeNative('server_agent_publish_automation', { request: automationPolicyPublishRequestSchema.parse(request) })
  }
  async enrollApiKey(request: unknown) {
    return credentialMetadataSchema.parse(await this.invokeNative('server_agent_enroll_api_key', { request: apiKeyEnrollmentRequestSchema.parse(request) }))
  }
  async startDeviceAuthorization() {
    return deviceAuthorizationStartResponseSchema.parse(await this.invokeNative('server_agent_start_device_authorization'))
  }
  async pollDeviceAuthorization(authorizationId: string) {
    return deviceAuthorizationStatusSchema.parse(await this.invokeNative('server_agent_poll_device_authorization', { authorizationId }))
  }
  async credential(credentialId: string) {
    return credentialMetadataSchema.parse(await this.invokeNative('server_agent_credential', { credentialId }))
  }
  async disconnectCredential(credentialId: string) {
    return credentialMetadataSchema.parse(await this.invokeNative('server_agent_disconnect_credential', { credentialId }))
  }
  async invoke(input: RunInput) {
    const parsed = runInputSchema.parse(input)
    return agentRunAdmissionResponseSchema.parse(await this.invokeNative('server_agent_invoke', {
      request: {
        sourceNodeId: parsed.source.nodeId,
        targetParentId: parsed.target.parentId,
        skillId: parsed.skill.id,
        prompt: parsed.prompt,
        configurationRevision: parsed.configurationRevision,
        credentialRef: parsed.credentialRef,
      },
      idempotencyKey: parsed.runId,
    }))
  }
  async runs(cursor?: string, limit = 50, status?: RunStatus) {
    return agentRunListResponseSchema.parse(await this.invokeNative('server_agent_runs', { cursor, limit, status }))
  }
  async run(runId: string) {
    return agentRunDetailSchema.parse(await this.invokeNative('server_agent_run', { runId }))
  }
  async activity(runId: string, afterSequence: number, limit = 100) {
    return agentActivityPageSchema.parse(await this.invokeNative('server_agent_activity', { runId, afterSequence, limit }))
  }
  async cancel(runId: string): Promise<void> { await this.invokeNative('server_agent_cancel', { runId }) }
  async retry(runId: string) {
    return agentRunRetryResponseSchema.parse(await this.invokeNative('server_agent_retry', { runId }))
  }
}

export interface ServerExecutionHandle {
  runId: string
  completion: Promise<RunDetail>
  cancel: () => Promise<void>
}

export interface ServerInvocationOptions { onActivity?: (event: ActivityEvent) => void | Promise<void> }

export class ServerAgentExecutor {
  private readonly pollMs: number
  private readonly delay: (milliseconds: number) => Promise<void>
  constructor(
    private readonly transport: ServerAgentTransport,
    options: { pollMs?: number; delay?: (milliseconds: number) => Promise<void> } = {},
  ) {
    this.pollMs = Math.max(0, options.pollMs ?? 1_000)
    this.delay = options.delay ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)))
  }

  async invoke(rawInput: RunInput, options: ServerInvocationOptions = {}): Promise<ServerExecutionHandle> {
    const input = runInputSchema.parse(rawInput)
    if (input.executionMode !== 'server') throw new Error('ServerAgentExecutor accepts only server execution snapshots.')
    const admitted = await this.transport.invoke(input)
    return this.handle(admitted.runId, options)
  }

  async retry(runId: string, options: ServerInvocationOptions = {}): Promise<ServerExecutionHandle> {
    const retried = await this.transport.retry(runId)
    return this.handle(retried.runId, options)
  }

  observe(runId: string, afterSequence: number, limit = 100): Promise<ActivityPage> {
    return this.transport.activity(runId, afterSequence, limit)
  }

  run(runId: string): Promise<RunDetail> { return this.transport.run(runId) }
  cancel(runId: string): Promise<void> { return this.transport.cancel(runId) }

  private handle(runId: string, options: ServerInvocationOptions): ServerExecutionHandle {
    return { runId, completion: this.waitForTerminal(runId, options), cancel: () => this.cancel(runId) }
  }

  private async waitForTerminal(runId: string, options: ServerInvocationOptions): Promise<RunDetail> {
    let sequence = 0
    for (;;) {
      const activity = await this.transport.activity(runId, sequence, 100)
      for (const event of activity.events) {
        sequence = Math.max(sequence, event.sequence)
        await options.onActivity?.(event)
      }
      const run = await this.transport.run(runId)
      if (run.status === 'completed') return run
      if (['failed', 'cancelled', 'interrupted'].includes(run.status)) {
        throw new ServerAgentExecutionError(run)
      }
      await this.delay(this.pollMs)
    }
  }
}

export class ServerAgentExecutionError extends Error {
  constructor(public readonly run: RunDetail) {
    super(run.error?.message ?? `Server agent run ${run.status}.`)
    this.name = 'ServerAgentExecutionError'
  }
}
