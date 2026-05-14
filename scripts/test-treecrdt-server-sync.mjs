import { deriveOpRefV0 } from '@treecrdt/sync-protocol'
import { treecrdtSyncV0ProtobufCodec } from '@treecrdt/sync-protocol/protobuf'
import { spawn } from 'node:child_process'
import net from 'node:net'
import process from 'node:process'
import puppeteer from 'puppeteer'
import { startWebSocketSyncServer } from '@treecrdt/sync-server-core'

const HOME_TOKEN = '00000000000000000000000000000001'
const EM_TOKEN = '00000000000000000000000000000002'

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

const bytesKey = bytes => Buffer.from(bytes).toString('hex')

const opRefFor = (docId, op) =>
  deriveOpRefV0(docId, {
    replica: op.meta.id.replica,
    counter: op.meta.id.counter,
  })

class MemorySyncBackend {
  constructor(docId) {
    this.docId = docId
    this.ops = []
    this.opsByRef = new Map()
  }

  async maxLamport() {
    return BigInt(this.ops.reduce((max, op) => Math.max(max, Number(op.meta.lamport || 0)), 0))
  }

  async listOpRefs() {
    return this.ops.map(op => opRefFor(this.docId, op))
  }

  async getOpsByOpRefs(opRefs) {
    return opRefs.map(ref => this.opsByRef.get(bytesKey(ref))).filter(Boolean)
  }

  async applyOps(ops) {
    for (const op of ops) {
      const ref = opRefFor(this.docId, op)
      const key = bytesKey(ref)
      if (this.opsByRef.has(key)) continue
      this.opsByRef.set(key, op)
      this.ops.push(op)
    }
  }
}

async function getFreePort() {
  const server = net.createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address !== 'object') throw new Error('Could not allocate a local port')
  const { port } = address
  await new Promise(resolve => server.close(resolve))
  return port
}

async function waitForPort(port, timeoutMs = 30_000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const ok = await new Promise(resolve => {
      const socket = net.connect(port, '127.0.0.1')
      socket.once('connect', () => {
        socket.destroy()
        resolve(true)
      })
      socket.once('error', () => resolve(false))
    })
    if (ok) return
    await delay(100)
  }
  throw new Error(`Timed out waiting for port ${port}`)
}

async function waitForHttpOk(url, timeoutMs = 60_000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url)
      if (response.ok) return
    } catch {
      // keep polling until Vite is ready to serve the app
    }
    await delay(250)
  }
  throw new Error(`Timed out waiting for ${url}`)
}

async function waitUntil(label, fn, timeoutMs = 45_000) {
  const started = Date.now()
  let last
  while (Date.now() - started < timeoutMs) {
    try {
      last = await fn()
      if (last) return last
    } catch (err) {
      last = err instanceof Error ? err.message : String(err)
    }
    await delay(250)
  }
  throw new Error(`${label} timed out. Last result: ${JSON.stringify(last)}`)
}

function attachBrowserDiagnostics(page, label, errors) {
  page.on('pageerror', err => errors.push(`${label} pageerror: ${err.stack || err.message}`))
  page.on('console', msg => {
    if (['error', 'warn'].includes(msg.type())) errors.push(`${label} console.${msg.type()}: ${msg.text()}`)
  })
}

async function pageTreecrdtOpCount(page) {
  return page.evaluate(async () => {
    const client = globalThis.em?.treecrdtClient?.()
    return client ? (await client.ops.all()).length : null
  })
}

async function waitForAppReady(page, label) {
  return waitUntil(
    `${label} app ready`,
    () =>
      page.evaluate(
        (HOME_TOKEN, EM_TOKEN) => {
          const state = globalThis.em?.testHelpers?.getState?.()
          if (!state || state.isLoading || !state.cursorInitialized) return false
          const client = globalThis.em?.treecrdtClient?.()
          if (!client) return false
          const home = state.thoughts.thoughtIndex[HOME_TOKEN]
          const em = state.thoughts.thoughtIndex[EM_TOKEN]
          return {
            docId: client.docId,
            homeChildren: Object.keys(home?.childrenMap || {}).length,
            emChildren: Object.keys(em?.childrenMap || {}).length,
          }
        },
        HOME_TOKEN,
        EM_TOKEN,
      ),
    60_000,
  )
}

async function waitForThoughtAndLexeme(page, label, value) {
  return waitForContextAndLexeme(page, label, [value], value)
}

async function waitForContextAndLexeme(page, label, context, value) {
  return waitUntil(
    `${label} thought ${context.join(' > ')}`,
    () =>
      page.evaluate(({ context: ctx, value: v }) => {
        const lexeme = globalThis.em?.getLexeme?.(v)
        const thought = globalThis.em?.getThoughtByContext?.(ctx)
        return lexeme && thought
          ? {
              contexts: lexeme.contexts.length,
              thoughtId: thought.id,
            }
          : false
      }, { context, value }),
    45_000,
  )
}

async function installSqlDiagnostics(page) {
  await page.evaluate(() => {
    const client = globalThis.em?.treecrdtClient?.()
    const runner = client?.runner
    if (!runner || runner.__treecrdtSyncE2eSqlDiagnostics) return
    runner.__treecrdtSyncE2eSqlDiagnostics = true
    const exec = runner.exec.bind(runner)
    runner.exec = async sql => {
      try {
        return await exec(sql)
      } catch (err) {
        console.error(`TreeCRDT SQL exec failed: ${String(sql).slice(0, 500)} :: ${err?.message || String(err)}`)
        throw err
      }
    }
    const getText = runner.getText.bind(runner)
    runner.getText = async (sql, params) => {
      try {
        return await getText(sql, params)
      } catch (err) {
        console.error(
          `TreeCRDT SQL getText failed: ${String(sql).slice(0, 500)} params=${JSON.stringify(params)} :: ${
            err?.message || String(err)
          }`,
        )
        throw err
      }
    }
  })
}

async function main() {
  const docs = new Map()
  const syncServer = await startWebSocketSyncServer({
    host: '127.0.0.1',
    port: 0,
    codec: treecrdtSyncV0ProtobufCodec,
    docs: {
      async open(docId) {
        let backend = docs.get(docId)
        if (!backend) {
          backend = new MemorySyncBackend(docId)
          docs.set(docId, backend)
        }
        return {
          backend,
          peerOptions: {
            maxCodewords: 100_000,
            maxOpsPerBatch: 2_000,
            deriveOpRef: (op, ctx) =>
              deriveOpRefV0(ctx.docId, {
                replica: op.meta.id.replica,
                counter: op.meta.id.counter,
              }),
          },
        }
      },
    },
  })

  const vitePort = await getFreePort()
  const vite = spawn('corepack', ['yarn', 'vite', '--host', '127.0.0.1', '--port', String(vitePort)], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      VITE_TREECRDT_SYNC_BASE_URL: `ws://127.0.0.1:${syncServer.port}/sync`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  const viteOutput = []
  vite.stdout.on('data', chunk => viteOutput.push(chunk.toString()))
  vite.stderr.on('data', chunk => viteOutput.push(chunk.toString()))

  let browser
  try {
    await waitForPort(vitePort)
    await waitForHttpOk(`http://127.0.0.1:${vitePort}/`)

    browser = await puppeteer.launch({
      headless: true,
      args: ['--ignore-certificate-errors', '--no-sandbox'],
    })

    const docId = `server-sync-${Date.now()}`
    const url = `http://127.0.0.1:${vitePort}/?share=${docId}`
    const errors = []
    const contextA = await browser.createBrowserContext()
    const contextB = await browser.createBrowserContext()
    const pageA = await contextA.newPage()
    const pageB = await contextB.newPage()
    pageA.setDefaultNavigationTimeout(90_000)
    pageB.setDefaultNavigationTimeout(90_000)
    attachBrowserDiagnostics(pageA, 'A', errors)
    attachBrowserDiagnostics(pageB, 'B', errors)

    await pageA.goto(url, { waitUntil: 'domcontentloaded' })
    await pageB.goto(url, { waitUntil: 'domcontentloaded' })

    const readyA = await waitForAppReady(pageA, 'A')
    const readyB = await waitForAppReady(pageB, 'B')
    console.info('A ready', JSON.stringify(readyA))
    console.info('B ready', JSON.stringify(readyB))
    await installSqlDiagnostics(pageA)
    await installSqlDiagnostics(pageB)
    const initialServerOps = docs.get(docId)?.ops.length || 0

    const parentA = `server sync parent A ${Date.now()}`
    await pageA.evaluate(value => globalThis.em.testHelpers.importToContext(value), parentA)
    await waitForThoughtAndLexeme(pageA, 'A local parent', parentA)
    const serverOpsAfterAParent = await waitUntil(
      'server received A parent ops',
      () => Promise.resolve((docs.get(docId)?.ops.length || 0) > initialServerOps && docs.get(docId)?.ops.length),
      10_000,
    ).catch(async err => {
      throw new Error(
        `${err instanceof Error ? err.message : String(err)}; pageA ops=${await pageTreecrdtOpCount(pageA)}; pageB ops=${await pageTreecrdtOpCount(pageB)}; browser logs=${errors.join('\n')}`,
      )
    })
    console.info('Server ops after A parent import', serverOpsAfterAParent)
    await waitForThoughtAndLexeme(pageB, 'B from A parent', parentA).catch(async err => {
      throw new Error(
        `${err instanceof Error ? err.message : String(err)}; serverOps=${docs.get(docId)?.ops.length || 0}; pageA ops=${await pageTreecrdtOpCount(pageA)}; pageB ops=${await pageTreecrdtOpCount(pageB)}; browser logs=${errors.join('\n')}`,
      )
    })
    console.info('B saw A parent import', parentA)

    const childA = `server sync child A ${Date.now()}`
    await pageA.evaluate(
      ({ parent, child }) => globalThis.em.testHelpers.importToContext([parent], child, { preventInline: true }),
      { parent: parentA, child: childA },
    )
    await waitForContextAndLexeme(pageA, 'A local child', [parentA, childA], childA)
    const serverOpsAfterAChild = await waitUntil(
      'server received A child ops',
      () =>
        Promise.resolve((docs.get(docId)?.ops.length || 0) > serverOpsAfterAParent && docs.get(docId)?.ops.length),
      10_000,
    )
    console.info('Server ops after A child import', serverOpsAfterAChild)
    await waitForContextAndLexeme(pageB, 'B from A child', [parentA, childA], childA)
    console.info('B saw A child import', childA)

    const childB = `server sync child B ${Date.now()}`
    await pageB.evaluate(
      ({ parent, child }) => globalThis.em.testHelpers.importToContext([parent], child, { preventInline: true }),
      { parent: parentA, child: childB },
    )
    await waitForContextAndLexeme(pageB, 'B local child', [parentA, childB], childB)
    await waitForContextAndLexeme(pageA, 'A from B child', [parentA, childB], childB)
    console.info('A saw B child import', childB)

    if (errors.length > 0) {
      throw new Error(`Browser errors:\n${errors.join('\n')}`)
    }

    console.info('TreeCRDT server sync e2e passed')
  } catch (err) {
    console.error(viteOutput.join('').slice(-4000))
    throw err
  } finally {
    await browser?.close().catch(() => undefined)
    vite.kill('SIGTERM')
    await syncServer.close()
  }
}

main().catch(err => {
  console.error(err)
  process.exitCode = 1
})
