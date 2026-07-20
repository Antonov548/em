import type ThoughtId from '../../../@types/ThoughtId'
import type Timestamp from '../../../@types/Timestamp'
import { EM_TOKEN, SETTINGS_TOKEN, SETTINGS_VALUE } from '../../../constants'
import hashThought from '../../../util/hashThought'
import { applyLexemeUpdate } from '../lexemes'
import { encodeThoughtPayload } from '../payload'
import treecrdtThoughtspace, { createIndexedChildrenMap, init as initTreecrdtThoughtspace } from '../thoughtspace'
import { getTreecrdtClient, initTreecrdt } from '../treecrdt'

const TEST_REPLICA_ID = new Uint8Array(32).fill(1)

/** Initializes an isolated in-memory TreeCRDT client and thoughtspace for unit tests. */
const initTestThoughtspace = async (replicaId: Uint8Array = TEST_REPLICA_ID): Promise<void> => {
  await initTreecrdt()
  await initTreecrdtThoughtspace(replicaId)
}

const PIN_ID = '00000000000000000000000000000101' as ThoughtId
const FALSE_ID = '00000000000000000000000000000102' as ThoughtId
const PIN_DUPLICATE_ID = '00000000000000000000000000000103' as ThoughtId
const PARENT_ID = '00000000000000000000000000000110' as ThoughtId
const OTHER_PARENT_ID = '00000000000000000000000000000111' as ThoughtId
const THOUGHT_A_ID = '00000000000000000000000000000112' as ThoughtId
const THOUGHT_Y_ID = '00000000000000000000000000000113' as ThoughtId
const THOUGHT_B_ID = '00000000000000000000000000000114' as ThoughtId
const THOUGHT_X_ID = '00000000000000000000000000000115' as ThoughtId

/** Creates a minimal thought fixture for provider-level ordering tests. */
const thought = (id: ThoughtId, parentId: ThoughtId, value: string, rank: number) => ({
  id,
  parentId,
  value,
  rank,
  childrenMap: {},
  created: 1 as Timestamp,
  lastUpdated: 1 as Timestamp,
  updatedBy: 'test',
})

/** Persists thoughts through the real TreeCRDT data provider. */
const persistThoughts = (
  thoughts: ReturnType<typeof thought>[],
  movePlacements?: Record<ThoughtId, ThoughtId | null>,
) =>
  treecrdtThoughtspace.updateThoughts({
    thoughtIndexUpdates: Object.fromEntries(thoughts.map(thought => [thought.id, thought])),
    lexemeIndexUpdates: {},
    lexemeIndexUpdatesOld: {},
    schemaVersion: 0,
    movePlacements,
  })

beforeEach(async () => {
  await treecrdtThoughtspace.clear()
})

afterEach(async () => {
  await treecrdtThoughtspace.clear()
})

it('seeds fixed system thoughts in the TreeCRDT provider', async () => {
  await initTestThoughtspace()

  const em = await treecrdtThoughtspace.getThoughtById(EM_TOKEN)
  expect(em?.childrenMap[SETTINGS_TOKEN]).toBe(SETTINGS_TOKEN)

  const settings = await treecrdtThoughtspace.getThoughtById(SETTINGS_TOKEN)
  expect(settings).toMatchObject({
    id: SETTINGS_TOKEN,
    parentId: EM_TOKEN,
    value: SETTINGS_VALUE,
  })

  const settingsLexeme = await treecrdtThoughtspace.getLexemeById(hashThought(SETTINGS_VALUE))
  expect(settingsLexeme?.contexts).toEqual([SETTINGS_TOKEN])
})

it('does not delete persisted lexemes when freeing cache', async () => {
  await initTestThoughtspace()

  const settingsKey = hashThought(SETTINGS_VALUE)
  await treecrdtThoughtspace.freeLexeme(settingsKey)

  const settingsLexeme = await treecrdtThoughtspace.getLexemeById(settingsKey)
  expect(settingsLexeme?.contexts).toEqual([SETTINGS_TOKEN])
})

it('does not require an initialized TreeCRDT client when freeing lexeme cache', async () => {
  await expect(treecrdtThoughtspace.freeLexeme(hashThought('missing'))).resolves.toBeUndefined()
})

it('keeps the normalized Lexeme owner aligned with the final interleaved TreeCRDT payload', async () => {
  const replicaId = new Uint8Array(32).fill(1)
  await initTestThoughtspace(replicaId)
  const client = getTreecrdtClient()
  const id = THOUGHT_A_ID
  const thoughtA = thought(id, EM_TOKEN, 'A', 0)
  await persistThoughts([thoughtA])

  const lexemeA = (await treecrdtThoughtspace.getLexemeById(hashThought('A')))!
  const thoughtB = { ...thoughtA, value: 'B', lastUpdated: 2 as Timestamp }
  const thoughtC = { ...thoughtA, value: 'C', lastUpdated: 3 as Timestamp }
  const lexemeB = { ...lexemeA, lastUpdated: thoughtB.lastUpdated }
  const lexemeC = { ...lexemeA, lastUpdated: thoughtC.lastUpdated }

  // Valid interleaving of two tabs: their derived-index requests arrive before their payload requests,
  // while B's payload arrives last. The materialized payload must remain the single source of ownership.
  await applyLexemeUpdate(client, hashThought('A'), null, lexemeA)
  await applyLexemeUpdate(client, hashThought('B'), lexemeB, undefined)
  await applyLexemeUpdate(client, hashThought('A'), null, lexemeA)
  await applyLexemeUpdate(client, hashThought('C'), lexemeC, undefined)
  await client.local.payload(replicaId, id, encodeThoughtPayload(thoughtC))
  await client.local.payload(replicaId, id, encodeThoughtPayload(thoughtB))

  expect((await treecrdtThoughtspace.getThoughtById(id))?.value).toBe('B')
  expect((await treecrdtThoughtspace.getLexemeById(hashThought('B')))?.contexts).toContain(id)
  expect((await treecrdtThoughtspace.getLexemeById(hashThought('C')))?.contexts ?? []).not.toContain(id)
})

it('does not revive a tombstoned context from a stale Lexeme update and restores it from TreeCRDT', async () => {
  await initTestThoughtspace()
  const client = getTreecrdtClient()
  const persistedThought = thought(THOUGHT_A_ID, EM_TOKEN, 'A', 0)
  await persistThoughts([persistedThought])

  const key = hashThought(persistedThought.value)
  const persistedLexeme = (await treecrdtThoughtspace.getLexemeById(key))!

  await client.runner.exec(`UPDATE tree_nodes SET tombstone = 1 WHERE node = unhex('${THOUGHT_A_ID}')`)
  expect(await treecrdtThoughtspace.getLexemeById(key)).toBeUndefined()

  await applyLexemeUpdate(client, key, persistedLexeme, undefined)
  expect(await treecrdtThoughtspace.getLexemeById(key)).toBeUndefined()

  await client.runner.exec(`UPDATE tree_nodes SET tombstone = 0 WHERE node = unhex('${THOUGHT_A_ID}')`)
  expect((await treecrdtThoughtspace.getLexemeById(key))?.contexts).toEqual([THOUGHT_A_ID])
})

it('clears and restores Lexeme ownership when the winning payload is malformed', async () => {
  await initTestThoughtspace()
  const client = getTreecrdtClient()
  const persistedThought = thought(THOUGHT_A_ID, EM_TOKEN, 'A', 0)
  await persistThoughts([persistedThought])

  const key = hashThought(persistedThought.value)
  await client.local.payload(TEST_REPLICA_ID, THOUGHT_A_ID, new TextEncoder().encode('{'))
  expect(await treecrdtThoughtspace.getLexemeById(key)).toBeUndefined()

  await client.local.payload(TEST_REPLICA_ID, THOUGHT_A_ID, encodeThoughtPayload(persistedThought))
  expect((await treecrdtThoughtspace.getLexemeById(key))?.contexts).toEqual([THOUGHT_A_ID])
})

it('uses indexed attribute values as childrenMap keys without changing TreeCRDT node ids', async () => {
  const valueById = {
    [PIN_ID]: '=pin',
    [PIN_DUPLICATE_ID]: '=pin',
  }

  const childrenMap = createIndexedChildrenMap([PIN_ID, PIN_DUPLICATE_ID, FALSE_ID], valueById)

  expect(childrenMap['=pin']).toBe(PIN_ID)
  expect(childrenMap[PIN_DUPLICATE_ID]).toBe(PIN_DUPLICATE_ID)
  expect(childrenMap[FALSE_ID]).toBe(FALSE_ID)
  expect(childrenMap.false).toBeUndefined()
  expect(Object.values(childrenMap)).toEqual([PIN_ID, PIN_DUPLICATE_ID, FALSE_ID])
})

it('falls back to rank placement when explicit afterId is stale', async () => {
  await initTestThoughtspace(new Uint8Array(32).fill(1))

  await persistThoughts([thought(PARENT_ID, EM_TOKEN, 'parent', 0), thought(OTHER_PARENT_ID, EM_TOKEN, 'other', 1)])
  await persistThoughts([thought(THOUGHT_A_ID, PARENT_ID, 'a', 0)])
  await persistThoughts([thought(THOUGHT_Y_ID, PARENT_ID, 'y', 1)])
  await persistThoughts([thought(THOUGHT_B_ID, PARENT_ID, 'b', 2)])
  await persistThoughts([thought(THOUGHT_X_ID, PARENT_ID, 'x', 3)])

  await persistThoughts([thought(THOUGHT_Y_ID, OTHER_PARENT_ID, 'y', 0)], {
    [THOUGHT_Y_ID]: null,
  })

  await expect(
    persistThoughts([thought(THOUGHT_X_ID, PARENT_ID, 'x', 1)], {
      [THOUGHT_X_ID]: THOUGHT_Y_ID,
    }),
  ).resolves.toBeDefined()

  await expect(getTreecrdtClient().tree.children(PARENT_ID)).resolves.toEqual([
    THOUGHT_A_ID,
    THOUGHT_X_ID,
    THOUGHT_B_ID,
  ])
})
