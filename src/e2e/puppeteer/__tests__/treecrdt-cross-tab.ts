import type { ConsoleMessage, Page } from 'puppeteer'
import { HOME_TOKEN } from '../../../constants'
import type { WindowEm } from '../../../initialize'
import { page } from '../session'
import { usePersistentTreecrdtStorage } from '../setup'

vi.setConfig({ testTimeout: 180000, hookTimeout: 60000 })

// The cast keeps the file runnable in the TDD workflow, which copies it onto a base whose helper ignores options.
;(usePersistentTreecrdtStorage as (options?: { runtime?: 'auto' }) => void)({ runtime: 'auto' })

const TAB_COUNT = 4
const PATH_SEPARATOR = '\u001f'
const persistenceErrorPattern =
  /sqlite3_open_v2|SQL logic error|database is locked|Thoughtspace persistence failed|TreeCRDT materialized UI sync failed|TreeCRDT idle wait timed out|Cycle detected in parent chain|Circular path found/i

type Fixture = {
  absentValues: string[]
  branches: Record<string, string[]>
  lanes: Record<string, string[]>
  paths: string[][]
  sharedValue: string
  suffix: string
}

type FixtureSnapshot = {
  absentLexemes: Record<string, { persisted: string[]; redux: string[] }>
  branches: Record<string, string[]>
  contextIds: Record<string, string>
  lanes: Record<string, string[]>
  lexemes: Record<string, { persisted: string[]; redux: string[] }>
  rootRanked: { rank: number; value: string }[]
  rootTreeOrder: string[]
  sharedParentContexts: string[]
}

/** Serializes a context for deterministic object keys and comparisons. */
const pathKey = (context: string[]): string => context.join(PATH_SEPARATOR)

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

/** Exercises Redux and persisted lexeme reads while other tabs are writing. */
const readBurst = (target: Page, values: string[]): Promise<void> =>
  target.evaluate(
    async ({ homeToken, values }) => {
      const em = window.em as WindowEm
      for (let i = 0; i < 5; i++) {
        em.getAllChildrenAsThoughts([homeToken])
        for (const value of values) {
          em.getThoughtByContext([value])
          em.getLexeme(value)
          await em.testHelpers.getLexemeFromThoughtspace(value)
        }
        await new Promise(resolve => setTimeout(resolve, 0))
      }
    },
    { homeToken: HOME_TOKEN, values },
  )

/** Edits through em's normal reducer/persistence pipeline and waits for the renamed lexeme to persist. */
const editThought = async (target: Page, value: string, suffix: string): Promise<string> => {
  const valueNew = `${value}${suffix}`
  await target.evaluate(
    ({ value, valueNew }) => {
      const em = window.em as WindowEm
      const thought = em.getThoughtByContext([value])
      if (!thought) throw new Error(`Thought not found: ${value}`)
      em.store.dispatch({
        type: 'editThought',
        oldValue: value,
        newValue: valueNew,
        path: [thought.id],
      })
    },
    { value, valueNew },
  )
  await target.waitForFunction(
    valueNew => Boolean((window.em as WindowEm).getThoughtByContext([valueNew])),
    { polling: 100, timeout: 30000 },
    valueNew,
  )
  await target.waitForFunction(
    async valueNew =>
      Boolean((await (window.em as WindowEm).testHelpers.getLexemeFromThoughtspace(valueNew))?.contexts.length),
    { polling: 100, timeout: 30000 },
    valueNew,
  )
  return valueNew
}

/** Deletes an exact context through em's normal reducer and persistence pipeline. */
const deleteContext = async (target: Page, context: string[]): Promise<void> => {
  await target.evaluate(
    ({ context, homeToken }) => {
      const em = window.em as WindowEm
      const path = context.map((_, index) => {
        const prefix = context.slice(0, index + 1)
        const thought = em.getThoughtByContext(prefix)
        if (!thought) throw new Error(`Cannot delete missing context: ${prefix.join(' / ')}`)
        return thought.id
      })
      em.store.dispatch({
        type: 'deleteThought',
        pathParent: path.length === 1 ? [homeToken] : path.slice(0, -1),
        thoughtId: path.at(-1),
      })
    },
    { context, homeToken: HOME_TOKEN },
  )
  await target.evaluate(() => (window.em as WindowEm).testHelpers.waitForThoughtspaceRuntimeIdle())
}

/** Opens each buffered branch so em pulls descendants beyond its normal cold-start depth. */
const loadNestedBranches = async (target: Page, fixture: Fixture): Promise<void> => {
  for (const [encodedParent, childValues] of Object.entries(fixture.branches)) {
    const parentContext = encodedParent.split(PATH_SEPARATOR)
    await target.waitForFunction(
      parentContext => Boolean((window.em as WindowEm).getThoughtByContext(parentContext)),
      { polling: 100, timeout: 30000 },
      parentContext,
    )
    await target.evaluate(parentContext => {
      const em = window.em as WindowEm
      const path = parentContext.map((_, index) => {
        const context = parentContext.slice(0, index + 1)
        const thought = em.getThoughtByContext(context)
        if (!thought) throw new Error(`Cannot open missing context: ${context.join(' / ')}`)
        return thought.id
      })
      em.store.dispatch({ type: 'setCursor', path })
    }, parentContext)

    await Promise.all(
      childValues.map(value =>
        target.waitForFunction(
          ({ parentContext, value }) => Boolean((window.em as WindowEm).getThoughtByContext([...parentContext, value])),
          { polling: 100, timeout: 30000 },
          { parentContext, value },
        ),
      ),
    )
  }

  await target.evaluate(() => (window.em as WindowEm).store.dispatch({ type: 'setCursor', path: null }))
}

/** Waits until every expected thought and its bidirectional Redux/SQLite lexeme index agree. */
const waitForFixture = (target: Page, fixture: Fixture): Promise<unknown> =>
  target.waitForFunction(
    async ({ absentValues, paths }) => {
      const em = window.em as WindowEm
      const idsByValue: Record<string, string[]> = {}

      for (const context of paths) {
        const thought = em.getThoughtByContext(context)
        if (!thought) return false
        const value = context.at(-1)!
        idsByValue[value] = [...(idsByValue[value] || []), thought.id]
      }

      for (const [value, ids] of Object.entries(idsByValue)) {
        const expected = [...ids].sort()
        const redux = [...(em.getLexeme(value)?.contexts || [])].sort()
        const persisted = [...((await em.testHelpers.getLexemeFromThoughtspace(value))?.contexts || [])].sort()
        if (JSON.stringify(redux) !== JSON.stringify(expected)) return false
        if (JSON.stringify(persisted) !== JSON.stringify(expected)) return false
      }

      for (const value of absentValues) {
        if ((em.getLexeme(value)?.contexts.length || 0) !== 0) return false
        if (((await em.testHelpers.getLexemeFromThoughtspace(value))?.contexts.length || 0) !== 0) return false
      }

      return true
    },
    { polling: 100, timeout: 45000 },
    { absentValues: fixture.absentValues, paths: fixture.paths },
  )

/** Captures partial context and lexeme state when convergence times out. */
const getFixtureDiagnostics = (target: Page, fixture: Fixture): Promise<unknown> =>
  target.evaluate(
    async ({ absentValues, pathSeparator, paths }) => {
      const em = window.em as WindowEm
      const contextIds: Record<string, string | null> = {}
      const idsByValue: Record<string, string[]> = {}
      for (const context of paths) {
        const thought = em.getThoughtByContext(context)
        contextIds[context.join(pathSeparator)] = thought?.id || null
        if (thought) {
          const value = context.at(-1)!
          idsByValue[value] = [...(idsByValue[value] || []), thought.id]
        }
      }

      const lexemes: Record<string, { expected: string[]; persisted: string[]; redux: string[] }> = {}
      for (const [value, expected] of Object.entries(idsByValue)) {
        lexemes[value] = {
          expected: [...expected].sort(),
          redux: [...(em.getLexeme(value)?.contexts || [])].sort(),
          persisted: [...((await em.testHelpers.getLexemeFromThoughtspace(value))?.contexts || [])].sort(),
        }
      }

      const absentLexemes = Object.fromEntries(
        await Promise.all(
          absentValues.map(async value => [
            value,
            {
              redux: [...(em.getLexeme(value)?.contexts || [])].sort(),
              persisted: [...((await em.testHelpers.getLexemeFromThoughtspace(value))?.contexts || [])].sort(),
            },
          ]),
        ),
      )

      return {
        absentValues,
        absentLexemes,
        contextIds,
        lexemes,
      }
    },
    { absentValues: fixture.absentValues, pathSeparator: PATH_SEPARATOR, paths: fixture.paths },
  )

/** Captures the fixture's hierarchy, sibling order, ranks, and lexeme indexes from one tab. */
const getFixtureSnapshot = (target: Page, fixture: Fixture): Promise<FixtureSnapshot> =>
  target.evaluate(
    async ({ absentValues, branches, homeToken, lanes, pathSeparator, paths, sharedValue, suffix }) => {
      const em = window.em as WindowEm
      const contextIds: Record<string, string> = {}
      const expectedIdsByValue: Record<string, string[]> = {}

      for (const context of paths) {
        const thought = em.getThoughtByContext(context)
        if (!thought) throw new Error(`Missing context: ${context.join(' / ')}`)
        contextIds[context.join(pathSeparator)] = thought.id
        const value = context.at(-1)!
        expectedIdsByValue[value] = [...(expectedIdsByValue[value] || []), thought.id]
      }

      const lexemes: FixtureSnapshot['lexemes'] = {}
      for (const value of Object.keys(expectedIdsByValue)) {
        lexemes[value] = {
          redux: [...(em.getLexeme(value)?.contexts || [])].sort(),
          persisted: [...((await em.testHelpers.getLexemeFromThoughtspace(value))?.contexts || [])].sort(),
        }
      }

      const absentLexemes: FixtureSnapshot['absentLexemes'] = {}
      for (const value of absentValues) {
        absentLexemes[value] = {
          redux: [...(em.getLexeme(value)?.contexts || [])].sort(),
          persisted: [...((await em.testHelpers.getLexemeFromThoughtspace(value))?.contexts || [])].sort(),
        }
      }

      return {
        absentLexemes,
        branches: Object.fromEntries(
          Object.keys(branches).map(branchContext => [
            branchContext,
            em.getAllChildrenAsThoughts(branchContext.split(pathSeparator)).map(thought => thought.value),
          ]),
        ),
        contextIds,
        lanes: Object.fromEntries(
          Object.keys(lanes).map(lane => [lane, em.getAllChildrenAsThoughts([lane]).map(thought => thought.value)]),
        ),
        lexemes,
        rootRanked: em
          .getAllChildrenRankedByContext([homeToken])
          .filter(thought => thought.value.includes(suffix))
          .map(thought => ({ rank: thought.rank, value: thought.value })),
        rootTreeOrder: em
          .getAllChildrenAsThoughts([homeToken])
          .filter(thought => thought.value.includes(suffix))
          .map(thought => thought.value),
        sharedParentContexts: em
          .getLexemeContexts(sharedValue)
          .map(context => context.join(pathSeparator))
          .sort(),
      }
    },
    {
      absentValues: fixture.absentValues,
      branches: fixture.branches,
      homeToken: HOME_TOKEN,
      lanes: fixture.lanes,
      pathSeparator: PATH_SEPARATOR,
      paths: fixture.paths,
      sharedValue: fixture.sharedValue,
      suffix: fixture.suffix,
    },
  )

/** Requires every tab and the persisted lexeme table to represent the exact same fixture. */
const expectFixtureConverged = async (targets: Page[], fixture: Fixture): Promise<void> => {
  await Promise.all(
    targets.map(target => target.evaluate(() => (window.em as WindowEm).testHelpers.waitForThoughtspaceRuntimeIdle())),
  )
  await Promise.all(
    targets.map(async (target, index) => {
      try {
        await waitForFixture(target, fixture)
      } catch (error) {
        const diagnostics = await getFixtureDiagnostics(target, fixture)
        throw new Error(`Tab ${index + 1} did not converge: ${JSON.stringify(diagnostics)}`, { cause: error })
      }
    }),
  )
  const snapshots = await Promise.all(targets.map(target => getFixtureSnapshot(target, fixture)))
  const canonical = snapshots[0]

  for (const snapshot of snapshots) {
    expect(snapshot.rootTreeOrder).toEqual(canonical.rootTreeOrder)
    expect(snapshot.rootRanked).toEqual(canonical.rootRanked)
    expect(snapshot.lanes).toEqual(fixture.lanes)
    expect(snapshot.branches).toEqual(fixture.branches)
    expect(snapshot.absentLexemes).toEqual(
      Object.fromEntries(fixture.absentValues.map(value => [value, { persisted: [], redux: [] }])),
    )

    const expectedSharedParentContexts = Object.entries(fixture.lanes)
      .filter(([, children]) => children.includes(fixture.sharedValue))
      .map(([lane]) => pathKey([lane]))
      .sort()
    expect(snapshot.sharedParentContexts).toEqual(expectedSharedParentContexts)

    const expectedIdsByValue: Record<string, string[]> = {}
    for (const context of fixture.paths) {
      const value = context.at(-1)!
      const id = snapshot.contextIds[pathKey(context)]
      expectedIdsByValue[value] = [...(expectedIdsByValue[value] || []), id]
    }
    for (const [value, ids] of Object.entries(expectedIdsByValue)) {
      const expected = [...ids].sort()
      expect(snapshot.lexemes[value]).toEqual({ persisted: expected, redux: expected })
    }
  }
}

/** Records browser failures that otherwise only appear as console output. */
const captureRuntimeErrors = (target: Page, label: string, errors: string[], phase: { current: string }): void => {
  target.on('pageerror', error =>
    errors.push(
      `${label} during ${phase.current} pageerror: ${error instanceof Error ? error.message : String(error)}`,
    ),
  )
  target.on('console', (message: ConsoleMessage) => {
    if ((message.type() === 'error' || message.type() === 'warn') && persistenceErrorPattern.test(message.text())) {
      errors.push(`${label} during ${phase.current} console: ${message.text()}`)
    }
  })
}

it('keeps four auto OPFS tabs converged through concurrent reads, edits, and reloads', async () => {
  const peers: Page[] = []
  const runtimeErrors: string[] = []
  const phase = { current: 'auto initialization' }
  captureRuntimeErrors(page, 'tab 1', runtimeErrors, phase)

  const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const lanes = Array.from({ length: TAB_COUNT }, (_, index) => `lane-${index + 1}-${suffix}`)
  const sharedValue = `shared-${suffix}`
  const uniqueValues = lanes.map((_, index) => `unique-${index + 1}-${suffix}`)
  const branches = lanes.map((_, index) => `branch-${index + 1}-${suffix}`)
  const leaves = lanes.map((_, index) => `leaf-${index + 1}-${suffix}`)
  const editableValues = lanes.map((_, index) => `editable-${index + 1}-${suffix}`)
  const fixture: Fixture = {
    absentValues: [],
    branches: Object.fromEntries(branches.map((branch, index) => [pathKey([lanes[index], branch]), [leaves[index]]])),
    lanes: Object.fromEntries(lanes.map((lane, index) => [lane, [sharedValue, uniqueValues[index], branches[index]]])),
    paths: lanes.flatMap((lane, index) => [
      [lane],
      [lane, sharedValue],
      [lane, uniqueValues[index]],
      [lane, branches[index]],
      [lane, branches[index], leaves[index]],
      [editableValues[index]],
    ]),
    sharedValue,
    suffix,
  }

  try {
    for (let index = 1; index < TAB_COUNT; index++) {
      const peer = await page.browserContext().newPage()
      peers.push(peer)
      captureRuntimeErrors(peer, `tab ${index + 1}`, runtimeErrors, phase)
    }

    await Promise.all(peers.map(peer => peer.goto(page.url(), { waitUntil: 'load' })))
    await Promise.all(peers.map(waitForApp))
    const targets = [page, ...peers]

    const runtimeConfig = await Promise.all(
      targets.map(target =>
        target.evaluate(() => {
          const em = window.em as WindowEm
          const testHelpers = em.testHelpers as typeof em.testHelpers & {
            getTreecrdtClientInfo?: () => { runtime: string; storage: string }
          }
          return {
            configuredRuntime: localStorage.getItem('treecrdtRuntime'),
            configuredStorage: localStorage.getItem('treecrdtStorage'),
            hasWebLocks: typeof navigator.locks?.request === 'function',
            resolved: testHelpers.getTreecrdtClientInfo?.(),
          }
        }),
      ),
    )
    expect(runtimeConfig).toEqual(
      Array.from({ length: TAB_COUNT }, () => ({
        configuredRuntime: 'auto',
        configuredStorage: 'opfs',
        hasWebLocks: true,
        resolved: { runtime: 'dedicated-worker', storage: 'opfs' },
      })),
    )

    phase.current = 'initial concurrent imports and reads'
    console.info(`Cross-tab stress: ${phase.current}`)
    const initialImports = targets.map((target, index) =>
      importText(
        target,
        `- ${lanes[index]}\n  - ${sharedValue}\n  - ${uniqueValues[index]}\n  - ${branches[index]}\n    - ${leaves[index]}\n- ${editableValues[index]}`,
      ),
    )
    await Promise.all([
      ...initialImports,
      ...targets.map(target => readBurst(target, [sharedValue, ...lanes, ...uniqueValues])),
    ])
    await expectFixtureConverged(targets, fixture)

    // Three tabs edit distinct existing thoughts while the fourth repeatedly reads Redux and SQLite.
    phase.current = 'concurrent edits and reads'
    console.info(`Cross-tab stress: ${phase.current}`)
    const editSuffix = '-edited'
    const editedValues = await Promise.all([
      ...targets.slice(0, 3).map((target, index) => editThought(target, editableValues[index], editSuffix)),
      readBurst(targets[3], [sharedValue, ...editableValues]).then(() => editableValues[3]),
    ])
    fixture.absentValues.push(...editableValues.slice(0, 3))
    fixture.paths = fixture.paths.map(context => {
      const editableIndex = editableValues.indexOf(context[0])
      return editableIndex >= 0 && editableIndex < 3 ? [editedValues[editableIndex]] : context
    })
    await expectFixtureConverged(targets, fixture)

    // Delete two different contexts concurrently, including one of four shared-lexeme contexts.
    phase.current = 'concurrent deletes and reads'
    console.info(`Cross-tab stress: ${phase.current}`)
    await Promise.all([
      deleteContext(targets[0], [editableValues[3]]),
      deleteContext(targets[3], [lanes[3], sharedValue]),
      readBurst(targets[1], [sharedValue, editableValues[3]]),
      readBurst(targets[2], [sharedValue, editableValues[3]]),
    ])
    fixture.absentValues.push(editableValues[3])
    fixture.paths = fixture.paths.filter(
      context =>
        pathKey(context) !== pathKey([editableValues[3]]) && pathKey(context) !== pathKey([lanes[3], sharedValue]),
    )
    fixture.lanes[lanes[3]] = fixture.lanes[lanes[3]].filter(value => value !== sharedValue)
    await expectFixtureConverged(targets, fixture)

    // Reload half the tabs while the other half writes, then reverse the roles.
    for (let round = 0; round < 2; round++) {
      phase.current = `rolling reload and write round ${round + 1}`
      console.info(`Cross-tab stress: ${phase.current}`)
      const reloading = round === 0 ? targets.slice(0, 2) : targets.slice(2)
      const writing = round === 0 ? targets.slice(2) : targets.slice(0, 2)
      const rollingValues = writing.map((_, index) => `rolling-${round + 1}-${index + 1}-${suffix}`)
      const rollingChildren = rollingValues.map((_, index) => `rolling-child-${round + 1}-${index + 1}-${suffix}`)
      fixture.paths.push(...rollingValues.flatMap((value, index) => [[value], [value, rollingChildren[index]]]))

      await Promise.all([
        ...reloading.map(async target => {
          await target.reload({ waitUntil: 'load' })
          await waitForApp(target)
        }),
        ...writing.map((target, index) =>
          importText(target, `- ${rollingValues[index]}\n  - ${rollingChildren[index]}`),
        ),
      ])
      await Promise.all(reloading.map(target => loadNestedBranches(target, fixture)))
      await expectFixtureConverged(targets, fixture)
    }

    // Two simultaneous all-tab reloads prove cold hydration, not only live event propagation.
    for (let round = 0; round < 2; round++) {
      phase.current = `simultaneous reload round ${round + 1}`
      console.info(`Cross-tab stress: ${phase.current}`)
      await Promise.all(targets.map(target => target.reload({ waitUntil: 'load' })))
      await Promise.all(targets.map(waitForApp))
      await Promise.all(targets.map(target => loadNestedBranches(target, fixture)))
      await expectFixtureConverged(targets, fixture)
    }

    // Every tab can still write after repeated reloads and fan the result out to every other tab.
    phase.current = 'post-reload concurrent writes'
    console.info(`Cross-tab stress: ${phase.current}`)
    const finalValues = targets.map((_, index) => `post-reload-${index + 1}-${suffix}`)
    fixture.paths.push(...finalValues.map(value => [value]))
    await Promise.all(targets.map((target, index) => importText(target, `- ${finalValues[index]}`)))
    await expectFixtureConverged(targets, fixture)
  } finally {
    await Promise.all(peers.map(peer => peer.close().catch(() => undefined)))
  }

  expect(runtimeErrors).toEqual([])
})
