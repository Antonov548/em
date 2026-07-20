import type Lexeme from '../../../@types/Lexeme'
import type Thought from '../../../@types/Thought'
import type ThoughtId from '../../../@types/ThoughtId'
import type Timestamp from '../../../@types/Timestamp'
import { HOME_TOKEN } from '../../../constants'
import hashThought from '../../../util/hashThought'
import type { DataProvider } from '../../DataProvider'
import { applyLexemeUpdate, deleteAllLexemes, getLexemeById, upsertLexeme } from '../lexemes'
import { refreshThoughtsFromMaterializationChanges } from '../sync/materializationThoughtUpdates'
import { getTreecrdtClient, initTreecrdt } from '../treecrdt'

const KEY = 'shared-lexeme'
const A_ID = '00000000000000000000000000000101' as ThoughtId
const B_ID = '00000000000000000000000000000102' as ThoughtId
const C_ID = '00000000000000000000000000000103' as ThoughtId
const D_ID = '00000000000000000000000000000104' as ThoughtId

/** Creates a Lexeme with deterministic metadata for membership tests. */
const lexeme = (contexts: ThoughtId[], lastUpdated = 1): Lexeme => ({
  contexts,
  created: 1 as Timestamp,
  lastUpdated: lastUpdated as Timestamp,
  updatedBy: 'test',
})

beforeEach(async () => {
  await initTreecrdt()
  await deleteAllLexemes(getTreecrdtClient())
})

afterEach(async () => {
  await deleteAllLexemes(getTreecrdtClient())
})

it('preserves disjoint context additions made from the same stale lexeme snapshot', async () => {
  const client = getTreecrdtClient()
  const original = lexeme([A_ID])
  await upsertLexeme(client, KEY, original)

  await Promise.all([
    applyLexemeUpdate(client, KEY, lexeme([A_ID, B_ID], 2), original),
    applyLexemeUpdate(client, KEY, lexeme([A_ID, C_ID], 3), original),
  ])

  expect([...(await getLexemeById(client, KEY))!.contexts].sort()).toEqual([A_ID, B_ID, C_ID].sort())
})

it('stores one owner when concurrent lexemes claim the same context', async () => {
  const client = getTreecrdtClient()

  await Promise.all([
    applyLexemeUpdate(client, 'lexeme-b', lexeme([A_ID], 2), undefined),
    applyLexemeUpdate(client, 'lexeme-c', lexeme([A_ID], 3), undefined),
  ])

  const owners = await Promise.all([getLexemeById(client, 'lexeme-b'), getLexemeById(client, 'lexeme-c')])

  expect(owners.filter(owner => owner?.contexts.includes(A_ID))).toHaveLength(1)
})

it('does not revive a concurrent removal while adding a different context', async () => {
  const client = getTreecrdtClient()
  const original = lexeme([A_ID, B_ID])
  await upsertLexeme(client, KEY, original)

  await Promise.all([
    applyLexemeUpdate(client, KEY, lexeme([B_ID], 2), original),
    applyLexemeUpdate(client, KEY, lexeme([A_ID, B_ID, C_ID], 3), original),
  ])

  expect([...(await getLexemeById(client, KEY))!.contexts].sort()).toEqual([B_ID, C_ID].sort())
})

it('does not erase unobserved persisted contexts when deleting a missing Redux lexeme', async () => {
  const client = getTreecrdtClient()
  const persisted = lexeme([A_ID, B_ID])
  await upsertLexeme(client, KEY, persisted)

  await applyLexemeUpdate(client, KEY, null, undefined)

  expect(await getLexemeById(client, KEY)).toEqual(persisted)
})

it('preserves a concurrently persisted context when a stale materialization removes its last known context', async () => {
  const client = getTreecrdtClient()
  const value = 'shared value'
  const key = hashThought(value)
  const stale = lexeme([A_ID], 1)
  const persisted = lexeme([A_ID, B_ID], 2)
  const deletedThought: Thought = {
    id: A_ID,
    value,
    rank: 0,
    parentId: HOME_TOKEN,
    childrenMap: {},
    created: 1 as Timestamp,
    lastUpdated: 2 as Timestamp,
    updatedBy: 'peer',
  }
  const db: DataProvider = {
    clear: async () => undefined,
    getLexemeById: id => getLexemeById(client, id),
    getLexemesByIds: ids => Promise.all(ids.map(id => getLexemeById(client, id))),
    getThoughtById: async () => undefined,
    getThoughtsByIds: async ids => ids.map(() => undefined),
    updateThoughts: async () => undefined,
    freeThought: async () => undefined,
    freeLexeme: async () => undefined,
  }
  await upsertLexeme(client, key, persisted)

  const refresh = await refreshThoughtsFromMaterializationChanges(
    [{ kind: 'delete', node: A_ID, parentBefore: HOME_TOKEN }],
    db,
    {
      schemaVersion: 0,
      thoughtIndex: { [A_ID]: deletedThought },
      lexemeIndex: { [key]: stale },
    },
  )

  expect(refresh.lexemeIndexUpdatesOld[key]).toEqual(stale)
  expect(refresh.lexemeIndexUpdates[key]).toBeNull()

  await applyLexemeUpdate(client, key, refresh.lexemeIndexUpdates[key], refresh.lexemeIndexUpdatesOld[key])

  expect((await getLexemeById(client, key))?.contexts).toEqual([B_ID])
})

it('round-trips an authoritative context order exactly', async () => {
  const client = getTreecrdtClient()
  const original = lexeme([A_ID, B_ID, C_ID, D_ID])
  await upsertLexeme(client, KEY, original)

  const reordered = lexeme([D_ID, B_ID, A_ID, C_ID], 2)
  await applyLexemeUpdate(client, KEY, reordered, original)

  expect((await getLexemeById(client, KEY))?.contexts).toEqual(reordered.contexts)
})
