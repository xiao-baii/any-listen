import { setTimeout as delay } from 'node:timers/promises'
import type { ExtensionSeriveTypes } from '@any-listen/app/modules/worker/utils'

// The supported loader reports asynchronous LX initialization through this stable log marker.
// Fail closed on unknown loader behavior; package evaluation alone is not readiness.
export const verifyExtensions = async (
  service: Pick<ExtensionSeriveTypes, 'getLocalExtensionList' | 'getExtensionConfigValues'>,
  startupLogs: string[]
) => {
  const extensions = await service.getLocalExtensionList()
  for (const extension of extensions) {
    if (extension.enabled && !extension.loaded) throw new Error(`Extension failed: ${extension.id}`)
  }
  if (!extensions.find((e) => e.id === 'lx-api-source-loader')?.enabled) return
  const config = await service.getExtensionConfigValues('lx-api-source-loader', ['enabledScripts', 'importedScriptSources'])
  const infos = config.importedScriptSources as Array<{ id: string; name: string }>
  const names = (config.enabledScripts as string[]).map((id) => infos.find((info) => info.id === id)?.name)
  if (!names.length || names.some((name) => !name || /[\r\n]/.test(name)) || new Set(names).size !== names.length)
    throw new Error('Enabled scripts must have distinct nonempty names')
  for (let attempt = 0; attempt < 180; attempt++) {
    const logs = startupLogs.join('\n')
    if (names.every((name) => logs.includes(`[${name}]Init successfully:`))) return
    await delay(250)
  }
  throw new Error('LX scripts did not report successful initialization within 45 seconds')
}
