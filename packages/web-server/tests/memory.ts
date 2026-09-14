import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { setTimeout as delay } from 'node:timers/promises'

import { Runtimes } from '../src/accounts/runtime'

const main = async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'any-listen-memory-'))
  const baseline = Boolean(process.env.ACCOUNT_BASELINE_ROOT)
  const runtimes = new Runtimes(directory, path.join(process.env.ACCOUNT_BASELINE_ROOT ?? process.env.ACCOUNT_TEST_ROOT!, 'build/server/index.js'))
  const lag = monitorEventLoopDelay({ resolution: 10 })
  lag.enable()
  const sample = async (accounts: number) => {
    await delay(2000)
    const rss: number[] = []
    for (let i = 0; i < 5; i++) {
      global.gc?.()
      await delay(250)
      rss.push(process.memoryUsage().rss + (baseline ? runtimes.status().active.reduce((sum, runtime) => sum + runtime.rss, 0) : 0))
    }
    const status = runtimes.status()
    assert.equal(status.active.length, accounts)
    if (!baseline) {
      assert(status.active.every(runtime => runtime.process === process.pid))
      assert(status.database.workers <= 1 && status.sources.workers <= 1 && status.draftWorkers <= 1)
    } else assert(status.active.every(runtime => runtime.rss > 0))
    console.log(JSON.stringify({ accounts, rssMiB: +(rss.sort((a, b) => a - b)[2] / 1048576).toFixed(2),
      mainHeapMiB: +(process.memoryUsage().heapUsed / 1048576).toFixed(2),
      eventLoopP99Ms: +(lag.percentile(99) / 1e6).toFixed(2),
      databaseWorkers: status.database?.workers ?? accounts, sourceWorkers: status.sources?.workers ?? accounts,
      processes: baseline ? accounts + 1 : 1, startupMs: status.active.map(runtime => runtime.startupMs) }))
    lag.reset()
  }
  console.log(JSON.stringify({ baseline, node: process.version, platform: process.platform,
    workload: 'Empty online account services, including one administrator. No published scripts or playback. RSS includes all workers once; not a capacity benchmark.' }))
  try {
    await sample(0)
    for (let count = 1; count <= 10; count++) {
      await runtimes.get({ id: randomUUID(), username: `probe-${count}`, role: count === 1 ? 'admin' : 'user',
        disabled: 0, passwordHash: '', createdAt: Date.now() })
      if ([1, 3, 5, 10].includes(count)) await sample(count)
    }
    for (const id of [...runtimes.entries.keys()]) await runtimes.stop(id)
    await sample(0)
  } finally {
    lag.disable()
    await runtimes.close()
    await rm(directory, { recursive: true, force: true })
  }
}
void main().catch(error => { console.error(error); process.exitCode = 1 })
