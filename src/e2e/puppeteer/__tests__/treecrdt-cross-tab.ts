import type { ConsoleMessage, Page } from 'puppeteer'
import { HOME_TOKEN } from '../../../constants'
import type { WindowEm } from '../../../initialize'
import { page } from '../session'
import { usePersistentTreecrdtStorage } from '../setup'

vi.setConfig({ testTimeout: 120000, hookTimeout: 60000 })

usePersistentTreecrdtStorage({ runtime: 'auto' })

const persistenceErrorPattern =
  /sqlite3_open_v2|SQL logic error|Thoughtspace persistence failed|TreeCRDT materialized UI sync failed/i

/** Waits until the app's test boundary is available after navigation. */
const waitForApp = async (target: Page): Promise<void> => {
  await target.waitForFunction(
    () => typeof (window.em as Partial<WindowEm> | undefined)?.testHelpers?.waitForInitialized === 'function',
    { polling: 100 },
  )
  await target.evaluate(() => (window.em as WindowEm).testHelpers.waitForInitialized())
}

/** Imports through em's normal action pipeline and drains local TreeCRDT persistence. */
const importText = async (target: Page, text: string): Promise<void> => {
  await target.evaluate(
    (homeToken, text) => (window.em as WindowEm).testHelpers.importToContext([homeToken], text),
    HOME_TOKEN,
    text,
  )
  await target.evaluate(() => (window.em as WindowEm).testHelpers.waitForThoughtspaceRuntimeIdle())
}

/** Waits for a thought to be connected through the exact Redux hierarchy. */
const waitForContext = (target: Page, context: string[]): Promise<unknown> =>
  target.waitForFunction(
    context => Boolean((window.em as WindowEm).getThoughtByContext(context)),
    {
      polling: 100,
      timeout: 15000,
    },
    context,
  )

/** Waits for both the Redux hierarchy and rendered thought, using timers because background-tab animation frames pause. */
const waitForThought = (target: Page, value: string): Promise<unknown> =>
  target.waitForFunction(
    value =>
      Boolean((window.em as WindowEm).getThoughtByContext([value])) &&
      Array.from(document.querySelectorAll('[data-editable]')).some(element => element.textContent === value),
    { polling: 100, timeout: 15000 },
    value,
  )

/** Reads a parent's direct children in rendered TreeCRDT order. */
const getChildValues = (target: Page, parent: string): Promise<string[]> =>
  target.evaluate(
    parent => (window.em as WindowEm).getAllChildrenAsThoughts([parent]).map(thought => thought.value),
    parent,
  )

/** Records browser failures that otherwise only appear as console output. */
const captureRuntimeErrors = (target: Page, label: string, errors: string[]): void => {
  target.on('pageerror', error =>
    errors.push(`${label} pageerror: ${error instanceof Error ? error.message : String(error)}`),
  )
  target.on('console', (message: ConsoleMessage) => {
    if (message.type() === 'error' && persistenceErrorPattern.test(message.text())) {
      errors.push(`${label} console: ${message.text()}`)
    }
  })
}

it('keeps auto OPFS tabs converged across simultaneous writes and reload', async () => {
  const peer = await page.browserContext().newPage()
  const runtimeErrors: string[] = []
  captureRuntimeErrors(page, 'page A', runtimeErrors)
  captureRuntimeErrors(peer, 'page B', runtimeErrors)

  const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const fromA = `cross-tab-a-${suffix}`
  const fromAFirstChild = `cross-tab-a-first-child-${suffix}`
  const fromASecondChild = `cross-tab-a-second-child-${suffix}`
  const fromB = `cross-tab-b-${suffix}`
  const simultaneousA = `cross-tab-simultaneous-a-${suffix}`
  const simultaneousB = `cross-tab-simultaneous-b-${suffix}`
  const afterReload = `cross-tab-after-reload-${suffix}`
  const persistedValues = [fromA, fromB, simultaneousA, simultaneousB]
  const nestedContexts = [
    [fromA, fromAFirstChild],
    [fromA, fromASecondChild],
  ]

  try {
    await importText(page, `- ${fromA}\n  - ${fromAFirstChild}\n  - ${fromASecondChild}`)

    await peer.goto(page.url(), { waitUntil: 'load' })
    await waitForApp(peer)
    await waitForThought(peer, fromA)
    await Promise.all(nestedContexts.map(context => waitForContext(peer, context)))
    expect(await getChildValues(peer, fromA)).toEqual([fromAFirstChild, fromASecondChild])

    await importText(peer, fromB)
    await waitForThought(page, fromB)

    await Promise.all([importText(page, simultaneousA), importText(peer, simultaneousB)])
    await Promise.all([waitForThought(page, simultaneousB), waitForThought(peer, simultaneousA)])

    await Promise.all([page.reload({ waitUntil: 'load' }), peer.reload({ waitUntil: 'load' })])
    await Promise.all([waitForApp(page), waitForApp(peer)])
    await Promise.all(persistedValues.flatMap(value => [waitForThought(page, value), waitForThought(peer, value)]))
    await Promise.all(nestedContexts.flatMap(context => [waitForContext(page, context), waitForContext(peer, context)]))
    expect(await getChildValues(page, fromA)).toEqual([fromAFirstChild, fromASecondChild])
    expect(await getChildValues(peer, fromA)).toEqual([fromAFirstChild, fromASecondChild])

    await importText(peer, afterReload)
    await waitForThought(page, afterReload)
  } finally {
    await peer.close().catch(() => undefined)
    expect(runtimeErrors).toEqual([])
  }
})
