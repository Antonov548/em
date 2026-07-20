import type { ConsoleMessage, Page } from 'puppeteer'
import type ThoughtId from '../../../@types/ThoughtId'
import { HOME_TOKEN } from '../../../constants'
import type { WindowEm } from '../../../initialize'
import { page } from '../session'
import { usePersistentTreecrdtStorage } from '../setup'

vi.setConfig({ testTimeout: 120000, hookTimeout: 60000 })

;(usePersistentTreecrdtStorage as (options?: { runtime?: string }) => void)({ runtime: 'shared-worker' })

const runtimeErrorPattern =
  /sqlite3_open_v2|SQL logic error|database is locked|Thoughtspace persistence failed|TreeCRDT|Cycle detected|Circular path found/i

/** Records browser failures with the active stress phase so timeouts retain their underlying cause. */
const captureRuntimeErrors = (
  target: Page,
  label: string,
  errors: string[],
  phase: { current: string },
): (() => void) => {
  /** Records an uncaught page error. */
  const onPageError = (error: unknown) => {
    const message = `${label} during ${phase.current} pageerror: ${error instanceof Error ? error.message : String(error)}`
    errors.push(message)
    console.info(message)
  }
  /** Records relevant console errors and warnings. */
  const onConsole = (message: ConsoleMessage) => {
    if ((message.type() === 'error' || message.type() === 'warn') && runtimeErrorPattern.test(message.text())) {
      const text = `${label} during ${phase.current} console: ${message.text()}`
      errors.push(text)
      console.info(text)
    }
  }
  target.on('pageerror', onPageError)
  target.on('console', onConsole)

  return () => {
    target.off('pageerror', onPageError)
    target.off('console', onConsole)
  }
}

/** Waits for a newly opened or reloaded tab to finish app initialization. */
const waitForApp = async (target: Page): Promise<void> => {
  await target.waitForFunction(
    () => typeof (window.em as Partial<WindowEm> | undefined)?.testHelpers?.waitForInitialized === 'function',
    { polling: 100 },
  )
  await target.evaluate(() => (window.em as WindowEm).testHelpers.waitForInitialized())
}

/** Imports through em's action pipeline and drains local persistence. */
const importText = async (target: Page, text: string): Promise<void> => {
  await target.evaluate(
    (homeToken, text) => (window.em as WindowEm).testHelpers.importToContext([homeToken], text),
    HOME_TOKEN,
    text,
  )
  await target.evaluate(() => (window.em as WindowEm).testHelpers.waitForThoughtspaceRuntimeIdle())
}

/** Toggles one root thought's marker and drains local persistence. */
const toggleAttribute = async (target: Page, value: string, attribute: string): Promise<void> => {
  await target.evaluate(
    ({ attribute, value }) => {
      const em = window.em as WindowEm
      const thought = em.getThoughtByContext([value])
      if (!thought) throw new Error(`Thought not found: ${value}`)
      em.store.dispatch({ type: 'toggleAttribute', path: [thought.id], values: [attribute, 'true'] })
    },
    { attribute, value },
  )
  await target.evaluate(() => (window.em as WindowEm).testHelpers.waitForThoughtspaceRuntimeIdle())
}

/** Waits until Redux and SQLite contain exactly the expected marker membership. */
const waitForLexemeMembers = (target: Page, attribute: string, expected: string[]): Promise<unknown> =>
  target.waitForFunction(
    async (attribute, expected) => {
      const em = window.em as WindowEm
      const reduxIds = em.getLexeme(attribute)?.contexts || []
      const persistedIds = (await em.testHelpers.getLexemeFromThoughtspace(attribute))?.contexts || []
      /** Maps attribute ids to sorted marked parent values. */
      const resolveValues = (ids: ThoughtId[]) =>
        ids
          .map(id => {
            const marker = em.getThoughtById(id)
            const target = marker ? em.getThoughtById(marker.parentId) : undefined
            return target?.value || null
          })
          .sort()
      const sortedExpected = [...expected].sort()
      return (
        JSON.stringify(resolveValues(reduxIds)) === JSON.stringify(sortedExpected) &&
        JSON.stringify(resolveValues(persistedIds)) === JSON.stringify(sortedExpected)
      )
    },
    { polling: 100, timeout: 30000 },
    attribute,
    expected,
  )

it('preserves concurrent lexeme membership across SharedWorker tabs and reload', async () => {
  const peer = await page.browserContext().newPage()
  const runtimeErrors: string[] = []
  const phase = { current: 'peer initialization' }
  const stopCapturingRuntimeErrors = [
    captureRuntimeErrors(page, 'primary', runtimeErrors, phase),
    captureRuntimeErrors(peer, 'peer', runtimeErrors, phase),
  ]
  const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
  const attribute = `=cross-tab-${suffix}`
  const values = ['alpha', 'beta', 'gamma', 'delta', 'epsilon'].map(value => `${value}-${suffix}`)

  try {
    await peer.goto(page.url(), { waitUntil: 'load' })
    await waitForApp(peer)

    phase.current = 'concurrent membership additions'
    await Promise.all([
      importText(page, `- ${values[0]}\n  - ${attribute}\n    - true\n- ${values[1]}\n  - ${attribute}\n    - true`),
      importText(peer, `- ${values[2]}\n  - ${attribute}\n    - true\n- ${values[3]}\n  - ${attribute}\n    - true`),
    ])
    await Promise.all([
      waitForLexemeMembers(page, attribute, values.slice(0, 4)),
      waitForLexemeMembers(peer, attribute, values.slice(0, 4)),
    ])

    phase.current = 'concurrent membership removal and addition'
    await Promise.all([
      toggleAttribute(page, values[0], attribute),
      importText(peer, `- ${values[4]}\n  - ${attribute}\n    - true`),
    ])
    const remaining = values.slice(1)
    await Promise.all([
      waitForLexemeMembers(page, attribute, remaining),
      waitForLexemeMembers(peer, attribute, remaining),
    ])

    phase.current = 'simultaneous reload'
    await Promise.all([page.reload({ waitUntil: 'load' }), peer.reload({ waitUntil: 'load' })])
    await Promise.all([waitForApp(page), waitForApp(peer)])
    await Promise.all([
      waitForLexemeMembers(page, attribute, remaining),
      waitForLexemeMembers(peer, attribute, remaining),
    ])
    expect(runtimeErrors).toEqual([])
  } finally {
    stopCapturingRuntimeErrors.forEach(stop => stop())
    await peer.close().catch(() => undefined)
  }
})
