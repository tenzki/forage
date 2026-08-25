// One-time migration from the pre-Forage "ai-chat" identity.
//
// Two locations carry user data under the old name:
//   1. The iCloud outline folder:  …/com~apple~CloudDocs/AIChat → …/Forage
//   2. The plugin-store settings file (Codex credentials, agents, skills):
//      …/Application Support/com.ai-chat.app/settings.json → com.forage.app/
//
// Each step runs only when the new location is missing and the old one
// exists, so it is a no-op on repeat launches. Failures are logged but never
// block startup: data stays at the old location and is not overwritten.

import { copyFile, exists, mkdir, rename } from '@tauri-apps/plugin-fs'
import { appDataDir, homeDir, join } from '@tauri-apps/api/path'

const LEGACY_ICLOUD_REL = 'Library/Mobile Documents/com~apple~CloudDocs/AIChat'
const FORAGE_ICLOUD_REL = 'Library/Mobile Documents/com~apple~CloudDocs/Forage'
const LEGACY_SETTINGS_REL = 'Library/Application Support/com.ai-chat.app/settings.json'
const SETTINGS_FILE = 'settings.json'

async function migrateOutlineFolder(): Promise<void> {
  const home = await homeDir()
  const oldDir = await join(home, LEGACY_ICLOUD_REL)
  const newDir = await join(home, FORAGE_ICLOUD_REL)
  if (await exists(newDir)) return
  if (!(await exists(oldDir))) return
  await rename(oldDir, newDir)
}

async function migrateSettingsFile(): Promise<void> {
  const home = await homeDir()
  const newSettings = await join(await appDataDir(), SETTINGS_FILE)
  if (await exists(newSettings)) return
  const oldSettings = await join(home, LEGACY_SETTINGS_REL)
  if (!(await exists(oldSettings))) return
  await mkdir(await appDataDir(), { recursive: true })
  await copyFile(oldSettings, newSettings)
}

/** Runs both migrations before outline/settings loading. Never throws. */
export async function migrateLegacyIdentity(): Promise<void> {
  try {
    await migrateOutlineFolder()
  } catch (error) {
    console.error('[migration] could not move the iCloud outline folder:', error)
  }
  try {
    await migrateSettingsFile()
  } catch (error) {
    console.error('[migration] could not move the settings file:', error)
  }
}
