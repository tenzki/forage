import imageGenerationManifest from './image-generation/forage.extension.json'
import referenceManifest from './reference/forage.extension.json'
import systemOneManifest from './system-one/forage.extension.json'
import sources from './supplied.json'

interface SuppliedManifest { id: string; name: string; description: string }

const manifests: Record<string, SuppliedManifest> = {
  'image-generation': imageGenerationManifest,
  reference: referenceManifest,
  'system-one': systemOneManifest,
}

export interface SuppliedExtension { key: string; manifest: SuppliedManifest; prerequisites: string }

export const suppliedExtensions: SuppliedExtension[] = sources.map(({ key, directory, prerequisites }) => {
  const manifest = manifests[directory]
  if (!manifest) throw new Error(`Supplied extension "${key}" has no manifest for extensions/${directory}.`)
  return { key, manifest, prerequisites }
})
