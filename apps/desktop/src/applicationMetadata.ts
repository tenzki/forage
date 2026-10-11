import { getVersion } from '@tauri-apps/api/app'
import { isTauri } from '@tauri-apps/api/core'
import application from '../package.json'

export async function applicationVersion(): Promise<string> {
  return isTauri() ? getVersion() : `${application.version} (development)`
}
