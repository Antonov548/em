import type { ConsoleMessage, Page } from 'puppeteer'
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

/** Waits until every expected thought has a live Favorite marker. */
const waitForFavorites = (target: Page, expected: string[]): Promise<unknown> =>
  target.waitForFunction(
    expected => {
      const em = window.em as WindowEm
      const markerIds = em.getLexeme('=favorite')?.contexts || []
      const targetIds = new Set(
        markerIds.flatMap(markerId => {
          const marker = em.getThoughtById(markerId)
          return marker ? [marker.parentId] : []
        }),
      )
      return expected.every(value => {
        const thought = em.getThoughtByContext([value])
        return !!thought && targetIds.has(thought.id)
      })
    },
    { polling: 100, timeout: 30000 },
    expected,
  )

/** Moves one Favorite in the canonical hidden TreeCRDT sequence and drains persistence. */
const reorderFavorite = async (target: Page, value: string, afterValue: string | null): Promise<void> => {
  await target.evaluate(
    ({ afterValue, value }) => {
      const em = window.em as WindowEm
      const thought = em.getThoughtByContext([value])
      const afterThought = afterValue ? em.getThoughtByContext([afterValue]) : undefined
      if (!thought) throw new Error(`Favorite not found: ${value}`)
      if (afterValue && !afterThought) throw new Error(`Previous Favorite not found: ${afterValue}`)

      const favoriteTargetIds = (em.getLexeme('=favorite')?.contexts || []).flatMap(contextId => {
        const marker = em.getThoughtById(contextId)
        return marker ? [marker.parentId] : []
      })
      em.store.dispatch({ type: 'ensureFavoriteOrder', targetIds: favoriteTargetIds })
      em.store.dispatch({
        type: 'reorderFavorite',
        targetId: thought.id,
        afterTargetId: afterThought?.id || null,
      })
    },
    { afterValue, value },
  )
  await target.evaluate(() => (window.em as WindowEm).testHelpers.waitForThoughtspaceRuntimeIdle())
}

/** Returns the visible Favorites order without breadcrumbs. */
const getVisibleFavoriteOrder = (target: Page): Promise<string[]> =>
  target.evaluate(() =>
    Array.from(document.querySelectorAll('[data-testid="drag-and-drop-favorite"]'))
      .map(item =>
        Array.from(item.querySelectorAll('[data-thought-link]'))
          .find(link => !link.closest('[aria-label="context-breadcrumbs"]'))
          ?.textContent?.trim(),
      )
      .filter((value): value is string => !!value),
  )

/** Waits until the rendered Favorites list has the exact expected order. */
const waitForVisibleFavoriteOrder = (target: Page, expected: string[]): Promise<unknown> =>
  target.waitForFunction(
    expected => {
      const values = Array.from(document.querySelectorAll('[data-testid="drag-and-drop-favorite"]'))
        .map(item =>
          Array.from(item.querySelectorAll('[data-thought-link]'))
            .find(link => !link.closest('[aria-label="context-breadcrumbs"]'))
            ?.textContent?.trim(),
        )
        .filter((value): value is string => !!value)
      return JSON.stringify(values) === JSON.stringify(expected)
    },
    { polling: 100, timeout: 30000 },
    expected,
  )

/** Opens the sidebar if needed and waits for Favorites to render. */
const openFavorites = async (target: Page): Promise<void> => {
  await target.waitForSelector('[data-testid="sidebar"]')
  const open = await target.$eval('[data-testid="sidebar"]', sidebar => sidebar.getAttribute('aria-hidden') === 'false')
  if (!open) {
    await target.evaluate(() => (document.querySelector('[aria-label=menu]') as HTMLElement | null)?.click())
  }
  await target.waitForFunction(
    () => document.querySelector('[data-testid="sidebar"]')?.getAttribute('aria-hidden') === 'false',
    { polling: 100, timeout: 10000 },
  )
}

it('propagates exact Favorites order across SharedWorker tabs and reload', async () => {
  const peer = await page.browserContext().newPage()
  const runtimeErrors: string[] = []
  const phase = { current: 'peer initialization' }
  const stopCapturingRuntimeErrors = [
    captureRuntimeErrors(page, 'primary', runtimeErrors, phase),
    captureRuntimeErrors(peer, 'peer', runtimeErrors, phase),
  ]
  const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
  const values = ['alpha', 'beta', 'gamma', 'delta'].map(value => `${value}-${suffix}`)

  try {
    await peer.goto(page.url(), { waitUntil: 'load' })
    await waitForApp(peer)

    phase.current = 'Favorite import'
    await importText(page, values.map(value => `- ${value}\n  - =favorite\n    - true`).join('\n'))
    await Promise.all([waitForFavorites(page, values), waitForFavorites(peer, values)])

    phase.current = 'canonical Favorites reorder'
    const expectedOrder = [values[3], values[1], values[0], values[2]]
    for (const [index, value] of expectedOrder.entries()) {
      await reorderFavorite(page, value, index > 0 ? expectedOrder[index - 1] : null)
    }

    await Promise.all([openFavorites(page), openFavorites(peer)])
    await Promise.all([
      waitForVisibleFavoriteOrder(page, expectedOrder),
      waitForVisibleFavoriteOrder(peer, expectedOrder),
    ])
    expect(await getVisibleFavoriteOrder(page)).toEqual(expectedOrder)
    expect(await getVisibleFavoriteOrder(peer)).toEqual(expectedOrder)

    phase.current = 'concurrent Favorites reorder'
    await Promise.all([reorderFavorite(page, values[0], values[2]), reorderFavorite(peer, values[3], null)])
    await Promise.all([
      page.evaluate(() => (window.em as WindowEm).testHelpers.waitForThoughtspaceRuntimeIdle()),
      peer.evaluate(() => (window.em as WindowEm).testHelpers.waitForThoughtspaceRuntimeIdle()),
    ])
    const concurrentOrder = await getVisibleFavoriteOrder(page)
    expect([...concurrentOrder].sort()).toEqual([...values].sort())
    await waitForVisibleFavoriteOrder(peer, concurrentOrder)
    expect(await getVisibleFavoriteOrder(peer)).toEqual(concurrentOrder)

    phase.current = 'simultaneous reload'
    await Promise.all([page.reload({ waitUntil: 'load' }), peer.reload({ waitUntil: 'load' })])
    await Promise.all([waitForApp(page), waitForApp(peer)])
    await Promise.all([openFavorites(page), openFavorites(peer)])
    await Promise.all([
      waitForVisibleFavoriteOrder(page, concurrentOrder),
      waitForVisibleFavoriteOrder(peer, concurrentOrder),
    ])
    expect(runtimeErrors).toEqual([])
  } finally {
    stopCapturingRuntimeErrors.forEach(stop => stop())
    await peer.close().catch(() => undefined)
  }
})
