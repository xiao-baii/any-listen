import { setTimeout as delay } from 'node:timers/promises'

import { workers } from '@any-listen/app/modules/worker'

// The supported loader reports asynchronous LX initialization through this stable log marker.
// Fail closed on unknown loader behavior; package evaluation alone is not readiness.
export const verifyManagedExtensions = async () => {
  const extensions = await workers.extensionService.getLocalExtensionList()
  for (const id of ['online-metadata', 'lx-api-source-loader']) {
    const extension = extensions.find((e) => e.id === id)
    if (!extension || (extension.enabled && !extension.loaded)) throw new Error(`Managed extension failed: ${id}`)
  }
  if (!extensions.find((e) => e.id === 'lx-api-source-loader')!.enabled) return
  const config = await workers.extensionService.getExtensionConfigValues('lx-api-source-loader', [
    'enabledScripts',
    'importedScriptSources',
  ])
  const infos = config.importedScriptSources as Array<{ id: string; name: string }>
  const names = (config.enabledScripts as string[]).map((id) => infos.find((info) => info.id === id)?.name)
  if (!names.length || names.some((name) => !name || /[\r\n]/.test(name)) || new Set(names).size !== names.length)
    throw new Error('Enabled scripts must have distinct nonempty names')
  for (let attempt = 0; attempt < 180; attempt++) {
    const logs = (await workers.extensionService.getExtensionLastLogs('lx-api-source-loader')).map((l) => l.logs).join('\n')
    if (names.every((name) => logs.includes(`[${name}]Init successfully:`))) return
    await delay(250)
  }
  throw new Error('LX scripts did not report successful initialization within 45 seconds')
}
