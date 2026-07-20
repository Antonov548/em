import type { ConsoleMessage, Page } from 'puppeteer'
import type ThoughtId from '../../../@types/ThoughtId'
import { FAVORITES_ORDER_TOKEN, HOME_TOKEN } from '../../../constants'
import type { WindowEm } from '../../../initialize'
import { page } from '../session'
import { usePersistentTreecrdtStorage } from '../setup'

vi.setConfig({ testTimeout: 120000, hookTimeout: 60000 })

usePersistentTreecrdtStorage({ runtime: 'shared-worker' })

const runtimeErrorPattern =
  /sqlite3_open_v2|SQL logic error|database is locked|Thoughtspace persistence failed|TreeCRDT|Cycle detected|Circular path found/i

/** Records browser failures with the active stress phase so timeouts retain their underlying cause. */
const captureRuntimeErrors = (target: Page, label: string, errors: string[], phase: { current: string }): void => {
  target.on('pageerror', error => {
    const message = `${label} during ${phase.current} pageerror: ${error instanceof Error ? error.message : String(error)}`
    errors.push(message)
    console.info(message)
  })
  target.on('console', (message: ConsoleMessage) => {
    if ((message.type() === 'error' || message.type() === 'warn') && runtimeErrorPattern.test(message.text())) {
      const text = `${label} during ${phase.current} console: ${message.text()}`
      errors.push(text)
      console.info(text)
    }
  })
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

/** Toggles only a root thought's marker so this phase isolates normalized lexeme membership. */
const toggleFavoriteAttribute = async (target: Page, value: string): Promise<void> => {
  await target.evaluate(value => {
    const em = window.em as WindowEm
    const thought = em.getThoughtByContext([value])
    if (!thought) throw new Error(`Thought not found: ${value}`)
    em.store.dispatch({ type: 'toggleAttribute', path: [thought.id], values: ['=favorite', 'true'] })
  }, value)
  await target.evaluate(() => (window.em as WindowEm).testHelpers.waitForThoughtspaceRuntimeIdle())
}

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

/** Waits until Redux and SQLite contain exactly the expected favorite membership, ignoring concurrent insertion order. */
const waitForFavoriteMembers = (target: Page, expected: string[]): Promise<unknown> =>
  target.waitForFunction(
    async expected => {
      const em = window.em as WindowEm
      const reduxIds = em.getLexeme('=favorite')?.contexts || []
      const persistedIds = (await em.testHelpers.getLexemeFromThoughtspace('=favorite'))?.contexts || []
      /** Maps =favorite attribute ids to sorted favorited parent values. */
      const resolveValues = (ids: ThoughtId[]) =>
        ids
          .map(id => {
            const attribute = em.getThoughtById(id)
            const favorite = attribute ? em.getThoughtById(attribute.parentId) : undefined
            return favorite?.value || null
          })
          .sort()
      const sortedExpected = [...expected].sort()
      return (
        JSON.stringify(resolveValues(reduxIds)) === JSON.stringify(sortedExpected) &&
        JSON.stringify(resolveValues(persistedIds)) === JSON.stringify(sortedExpected)
      )
    },
    { polling: 100, timeout: 30000 },
    expected,
  )

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

/** Captures the rendered order and hidden TreeCRDT order projection when live propagation stalls. */
const getFavoriteOrderDiagnostics = (target: Page) =>
  target.evaluate(async favoritesOrderToken => {
    const em = window.em as WindowEm
    const root = em.getThoughtById(favoritesOrderToken)
    const childIds = root ? Object.values(root.childrenMap) : []
    const reduxEntries = childIds.map(id => {
      const entry = em.getThoughtById(id)
      return entry ? { id: entry.id, rank: entry.rank, targetId: entry.value } : { id, missing: true }
    })

    const modulePath = '/src/data-providers/treecrdt/treecrdt.ts'
    // Keep this import in the browser execution context; Vitest otherwise rewrites imports inside `page.evaluate`.
    const { getTreecrdtClient } = (await window.eval(
      `import(${JSON.stringify(modulePath)})`,
    )) as typeof import('../../../data-providers/treecrdt/treecrdt')
    const client = getTreecrdtClient()
    const providerChildIds = await client.tree.children(favoritesOrderToken)
    const providerEntries = await Promise.all(
      providerChildIds.map(async id => {
        const payload = await client.tree.getPayload(id)
        const decoded = payload ? (JSON.parse(new TextDecoder().decode(payload)) as { value?: string }) : undefined
        return { id, targetId: decoded?.value || null }
      }),
    )

    return {
      providerEntries,
      reduxChildMapOrder: reduxEntries,
      reduxRankOrder: [...reduxEntries].sort(
        (a, b) => ('rank' in a ? (a.rank ?? Infinity) : Infinity) - ('rank' in b ? (b.rank ?? Infinity) : Infinity),
      ),
      visible: Array.from(document.querySelectorAll('[data-testid="drag-and-drop-favorite"]'))
        .map(item =>
          Array.from(item.querySelectorAll('[data-thought-link]'))
            .find(link => !link.closest('[aria-label="context-breadcrumbs"]'))
            ?.textContent?.trim(),
        )
        .filter((value): value is string => !!value),
    }
  }, FAVORITES_ORDER_TOKEN)

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

it('preserves concurrent lexeme membership and exact Favorites order across SharedWorker tabs', async () => {
  const peer = await page.browserContext().newPage()
  const runtimeErrors: string[] = []
  const phase = { current: 'peer initialization' }
  captureRuntimeErrors(page, 'primary', runtimeErrors, phase)
  captureRuntimeErrors(peer, 'peer', runtimeErrors, phase)
  const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
  const values = ['alpha', 'beta', 'gamma', 'delta', 'epsilon'].map(value => `${value}-${suffix}`)

  try {
    console.info('Cross-tab lexemes: initialize peer')
    await peer.goto(page.url(), { waitUntil: 'load' })
    await waitForApp(peer)

    // Independent tabs add memberships to the same =favorite lexeme concurrently. A normalized membership table must
    // retain every context instead of allowing one whole-row write to replace the other tab's contexts array.
    phase.current = 'concurrent membership additions'
    console.info('Cross-tab lexemes: concurrent membership additions')
    await Promise.all([
      importText(page, `- ${values[0]}\n  - =favorite\n    - true\n- ${values[1]}\n  - =favorite\n    - true`),
      importText(peer, `- ${values[2]}\n  - =favorite\n    - true\n- ${values[3]}\n  - =favorite\n    - true`),
    ])
    await Promise.all([
      waitForFavoriteMembers(page, values.slice(0, 4)),
      waitForFavoriteMembers(peer, values.slice(0, 4)),
    ])

    // Exercise opposite membership mutations concurrently: remove one context while another tab adds a new one.
    phase.current = 'concurrent membership removal and addition'
    console.info('Cross-tab lexemes: concurrent membership removal and addition')
    await Promise.all([
      toggleFavoriteAttribute(page, values[0]),
      importText(peer, `- ${values[4]}\n  - =favorite\n    - true`),
    ])
    const remaining = values.slice(1)
    await Promise.all([waitForFavoriteMembers(page, remaining), waitForFavoriteMembers(peer, remaining)])

    // Arrange an intentionally non-alphabetical order through the hidden TreeCRDT sequence action. Drag-and-drop
    // gesture mechanics have dedicated coverage; this test isolates persistence and cross-tab order propagation.
    phase.current = 'canonical Favorites reorder'
    console.info('Cross-tab lexemes: canonical Favorites reorder')
    const expectedOrder = [values[3], values[1], values[4], values[2]]
    for (const [index, value] of expectedOrder.entries()) {
      const afterValue = index > 0 ? expectedOrder[index - 1] : null
      console.info(`Cross-tab lexemes: move ${value} after ${afterValue || 'start'}`)
      await reorderFavorite(page, value, afterValue)
    }

    await openFavorites(page)
    await waitForVisibleFavoriteOrder(page, expectedOrder)
    expect(await getVisibleFavoriteOrder(page)).toEqual(expectedOrder)

    // Membership is an unordered normalized set; the separate TreeCRDT Favorites sequence must propagate the exact
    // display order live to the second tab and survive cold hydration.
    phase.current = 'live Favorites order propagation'
    console.info('Cross-tab lexemes: live Favorites order propagation')
    await openFavorites(peer)
    let livePeerDiagnostics: Awaited<ReturnType<typeof getFavoriteOrderDiagnostics>> | undefined
    try {
      await waitForVisibleFavoriteOrder(peer, expectedOrder)
    } catch {
      livePeerDiagnostics = await getFavoriteOrderDiagnostics(peer)
      console.info(`Cross-tab lexemes: peer before reload ${JSON.stringify(livePeerDiagnostics)}`)
    }

    phase.current = 'simultaneous reload'
    console.info('Cross-tab lexemes: simultaneous reload')
    await Promise.all([page.reload({ waitUntil: 'load' }), peer.reload({ waitUntil: 'load' })])
    await Promise.all([waitForApp(page), waitForApp(peer)])
    await Promise.all([waitForFavoriteMembers(page, remaining), waitForFavoriteMembers(peer, remaining)])
    await Promise.all([openFavorites(page), openFavorites(peer)])
    await Promise.all([
      waitForVisibleFavoriteOrder(page, expectedOrder),
      waitForVisibleFavoriteOrder(peer, expectedOrder),
    ])
    console.info('Cross-tab lexemes: simultaneous reload passed')
    expect(runtimeErrors).toEqual([])
    if (livePeerDiagnostics) {
      throw new Error(
        `Live peer Favorites order did not converge before reload: ${JSON.stringify(livePeerDiagnostics)}`,
      )
    }
  } finally {
    await peer.close().catch(() => undefined)
  }
})
