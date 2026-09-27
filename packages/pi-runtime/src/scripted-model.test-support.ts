export { fauxAssistantMessage, fauxText, fauxToolCall, type Context, type FauxResponseStep } from '@earendil-works/pi-ai'
import { fauxProvider, InMemoryCredentialStore, type FauxResponseStep, type ModelsStoreEntry } from '@earendil-works/pi-ai'
import { ModelRuntime } from '@earendil-works/pi-coding-agent'

/** A Pi model runtime whose single model replies with scripted responses, for driving real sessions in tests. */
export async function scriptedModel(responses: FauxResponseStep[]) {
  const faux = fauxProvider()
  const entries = new Map<string, ModelsStoreEntry>()
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsStore: {
      read: async (providerId) => entries.get(providerId),
      write: async (providerId, entry) => { entries.set(providerId, entry) },
      delete: async (providerId) => { entries.delete(providerId) },
    },
    allowModelNetwork: false,
    refreshOnCreate: false,
  })
  modelRuntime.registerNativeProvider(faux.provider)
  faux.setResponses(responses)
  return { modelRuntime, model: faux.getModel(), faux }
}
