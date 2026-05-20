import type { Operation } from '@treecrdt/interface'
import type Index from '../../@types/IndexType'
import type Lexeme from '../../@types/Lexeme'
import type Thought from '../../@types/Thought'
import type ThoughtId from '../../@types/ThoughtId'
import type Timestamp from '../../@types/Timestamp'
import { EM_TOKEN, GLOBAL_ROOT_TOKEN, ROOT_PARENT_ID, SETTINGS_TOKEN, SETTINGS_VALUE } from '../../constants'
import hashThought from '../../util/hashThought'
import type { DataProvider } from '../DataProvider'
import {
  deleteAllLexemes,
  deleteLexeme as deleteLexemeRow,
  ensureLexemesSchema,
  getLexemeById as getLexemeByIdSql,
  getLexemesByIds as getLexemesByIdsSql,
  upsertLexeme,
} from './lexemes'
import { decodeThoughtPayload, encodeThoughtPayload } from './payload'
import { SYSTEM_ROOT_THOUGHT_IDS } from './systemThoughtIds'
import { dropTreecrdt, getTreecrdtClient } from './treecrdt'
import { createTreecrdtLocalWriteOptions } from './writeBarrier'
import type { TreecrdtPlacement } from './writeDiff'
import { hasTreecrdtPayloadChange, hasTreecrdtPlacementChange } from './writeDiff'

let replicaId: Uint8Array | null = null
let initialized = false
let initReadyResolve: (() => void) | null = null
let initReady = new Promise<void>(resolve => {
  initReadyResolve = resolve
})

/** Resets the provider readiness barrier used by writes that race startup. */
const resetInitReady = (): void => {
  initialized = false
  initReady = new Promise<void>(resolve => {
    initReadyResolve = resolve
  })
}

/** Marks provider init complete so queued writes can safely use the TreeCRDT client. */
const resolveInitReady = (): void => {
  initialized = true
  initReadyResolve?.()
  initReadyResolve = null
}

/** Waits for `init` to finish before writes touch the TreeCRDT client. */
const waitForInitReady = async (): Promise<Uint8Array> => {
  if (!initialized) {
    await initReady
  }
  if (!replicaId) throw new Error('TreeCRDT DataProvider: init not called')
  return replicaId
}

/** Session replica identity (passed to `init`); minted ops use this for correct CRDT attribution. */
export function getThoughtspaceReplicaId(): Uint8Array {
  if (!replicaId) throw new Error('TreeCRDT DataProvider: init not called')
  return replicaId
}

/** Fetches a thought by ID from the tree. */
const getThoughtById = async (id: ThoughtId): Promise<Thought | undefined> => {
  const client = getTreecrdtClient()

  const payloadBytes = await client.tree.getPayload(id)
  if (payloadBytes === null) return undefined

  const payload = decodeThoughtPayload(payloadBytes)

  const parentIdRaw = await client.tree.parent(id)
  const parentId: ThoughtId = parentIdRaw === null ? (ROOT_PARENT_ID as ThoughtId) : (parentIdRaw as ThoughtId)
  const siblingIds = parentIdRaw === null ? [] : await client.tree.children(parentIdRaw)
  const rank = parentIdRaw === null ? 0 : Math.max(0, siblingIds.indexOf(id))

  const childIds = await client.tree.children(id)
  const childrenMap: Index<ThoughtId> = {}
  for (const cid of childIds) {
    childrenMap[cid] = cid as ThoughtId
  }

  const thought: Thought = {
    id,
    value: payload.value,
    rank,
    created: payload.created as Timestamp,
    lastUpdated: payload.lastUpdated as Timestamp,
    updatedBy: payload.updatedBy,
    parentId,
    childrenMap,
    ...(payload.archived !== undefined && { archived: payload.archived as Timestamp }),
  }

  return thought
}

/** Fetches multiple thoughts by IDs. */
const getThoughtsByIds = (ids: ThoughtId[]): Promise<(Thought | undefined)[]> => Promise.all(ids.map(getThoughtById))

/** Converts em's root parent id to TreeCRDT's global root id. */
const treeParentId = (id: ThoughtId): ThoughtId => (id === ROOT_PARENT_ID ? GLOBAL_ROOT_TOKEN : id)

/** Resolves caller-provided TreeCRDT placement. */
const getTreecrdtPlacement = async (
  thoughtId: ThoughtId,
  thought: Thought,
  treePlacements?: Index<ThoughtId | null>,
): Promise<TreecrdtPlacement> => {
  const client = getTreecrdtClient()
  const parentId = treeParentId(thought.parentId)

  if (!treePlacements || !Object.prototype.hasOwnProperty.call(treePlacements, thoughtId)) {
    throw new Error(`TreeCRDT write for ${thoughtId} requires explicit placement.`)
  }

  const afterId = treePlacements[thoughtId]
  if (afterId === null) return { type: 'first' }
  if (afterId === thoughtId) throw new Error(`TreeCRDT write for ${thoughtId} cannot be placed after itself.`)

  const childIds = await client.tree.children(parentId)
  if (!childIds.includes(afterId)) {
    throw new Error(`TreeCRDT write for ${thoughtId} references missing sibling ${afterId}.`)
  }

  return { type: 'after', after: afterId }
}

/** Applies thought index updates and TreeCRDT placements to the tree. */
const updateThoughts = async ({
  thoughtIndexUpdates,
  lexemeIndexUpdates,
  treePlacements,
}: {
  thoughtIndexUpdates: Index<Thought | null>
  lexemeIndexUpdates: Index<Lexeme | null>
  lexemeIndexUpdatesOld: Index<Lexeme | undefined>
  schemaVersion: number
  treePlacements?: Index<ThoughtId | null>
}): Promise<readonly Operation[]> => {
  const activeReplicaId = await waitForInitReady()
  const client = getTreecrdtClient()
  const ops: Operation[] = []

  for (const [id, lexeme] of Object.entries(lexemeIndexUpdates)) {
    if (lexeme === null) {
      await deleteLexemeRow(client, id)
    } else {
      await upsertLexeme(client, id, lexeme)
    }
  }

  const updates: Index<Thought> = {}
  const deletes: ThoughtId[] = []

  for (const [id, thought] of Object.entries(thoughtIndexUpdates)) {
    const thoughtId = id as ThoughtId
    if (thought === null) {
      deletes.push(thoughtId)
    } else {
      updates[thoughtId] = thought
    }
  }

  for (const id of deletes) {
    ops.push(await client.local.delete(activeReplicaId, id, createTreecrdtLocalWriteOptions()))
  }

  for (const [id, thought] of Object.entries(updates)) {
    const thoughtId = id as ThoughtId
    const payloadBytes = encodeThoughtPayload({
      value: thought.value,
      created: thought.created,
      lastUpdated: thought.lastUpdated,
      updatedBy: thought.updatedBy,
      ...(thought.archived !== undefined && { archived: thought.archived }),
    })

    const exists = await client.tree.exists(thoughtId)
    const parentId = treeParentId(thought.parentId)

    if (!exists) {
      const placement = await getTreecrdtPlacement(thoughtId, thought, treePlacements)
      ops.push(
        await client.local.insert(
          activeReplicaId,
          parentId,
          thoughtId,
          placement,
          payloadBytes,
          createTreecrdtLocalWriteOptions(),
        ),
      )
    } else {
      const existing = await getThoughtById(thoughtId)
      if (!existing) continue

      const parentChanged = existing.parentId !== thought.parentId
      const hasPlacement = thoughtId in (treePlacements || {})
      const placement =
        parentChanged || hasPlacement ? await getTreecrdtPlacement(thoughtId, thought, treePlacements) : null
      const orderChanged =
        !!placement && hasTreecrdtPlacementChange(await client.tree.children(parentId), thoughtId, placement)

      if (placement && (parentChanged || orderChanged)) {
        ops.push(
          await client.local.move(activeReplicaId, thoughtId, parentId, placement, createTreecrdtLocalWriteOptions()),
        )
      }

      if (hasTreecrdtPayloadChange(existing, thought)) {
        ops.push(
          await client.local.payload(activeReplicaId, thoughtId, payloadBytes, createTreecrdtLocalWriteOptions()),
        )
      }
    }
  }

  return ops
}

/** No-op for freeing a thought. */
const freeThought = async (_id: ThoughtId): Promise<void> => {
  // no-op
}

/** Removes a lexeme row from SQLite. */
const freeLexeme = async (key: string): Promise<void> => {
  const client = getTreecrdtClient()
  await deleteLexemeRow(client, key)
}

/** Clears all thoughts by dropping storage and closing the client. */
const clear = async (): Promise<void> => {
  if (!replicaId) {
    throw new Error('TreeCRDT DataProvider: init not called')
  }

  await dropTreecrdt()
  replicaId = null
  resetInitReady()
}

/** Loads a lexeme by hash key from database. */
const getLexemeById = async (key: string): Promise<Lexeme | undefined> => {
  const client = getTreecrdtClient()
  return getLexemeByIdSql(client, key)
}

/** Loads lexemes for hash keys in parallel order. */
const getLexemesByIds = async (keys: string[]): Promise<(Lexeme | undefined)[]> => {
  const client = getTreecrdtClient()
  return getLexemesByIdsSql(client, keys)
}

/** Replaces all stored lexemes. Required by DataProvider conformance tests. */
const updateLexemeIndex = async (lexemeIndex: Index<Lexeme>): Promise<void> => {
  const client = getTreecrdtClient()
  await deleteAllLexemes(client)
  for (const [id, lexeme] of Object.entries(lexemeIndex)) {
    await upsertLexeme(client, id, lexeme)
  }
}

const ROOT_PAYLOAD = encodeThoughtPayload({
  value: GLOBAL_ROOT_TOKEN,
  created: 0,
  lastUpdated: 0,
  updatedBy: '',
})

/** Initializes the thoughtspace with the given replica ID. */
export const init = async (replicaIdArg: Uint8Array): Promise<void> => {
  replicaId = replicaIdArg

  const client = getTreecrdtClient()
  await ensureLexemesSchema(client)
  // Ensure root has payload so getThoughtById can use the generic path
  await client.local.payload(replicaIdArg, GLOBAL_ROOT_TOKEN, ROOT_PAYLOAD, createTreecrdtLocalWriteOptions())
  for (const id of SYSTEM_ROOT_THOUGHT_IDS) {
    if (!(await client.tree.exists(id))) {
      const now = Date.now()
      await client.local.insert(
        replicaId,
        GLOBAL_ROOT_TOKEN,
        id,
        { type: 'last' },
        encodeThoughtPayload({
          value: id,
          created: now,
          lastUpdated: now,
          updatedBy: '',
        }),
        createTreecrdtLocalWriteOptions(),
      )
    }
  }

  let settingsId: ThoughtId | null = null
  for (const childId of await client.tree.children(EM_TOKEN)) {
    const payloadBytes = await client.tree.getPayload(childId)
    if (!payloadBytes) continue
    const payload = decodeThoughtPayload(payloadBytes)
    if (payload.value === SETTINGS_VALUE) {
      settingsId = childId as ThoughtId
      break
    }
  }

  if (
    !settingsId &&
    (await client.tree.exists(SETTINGS_TOKEN)) &&
    (await client.tree.parent(SETTINGS_TOKEN)) === EM_TOKEN
  ) {
    settingsId = SETTINGS_TOKEN
  }

  if (!settingsId) {
    const now = Date.now()
    await client.local.insert(
      replicaId,
      EM_TOKEN,
      SETTINGS_TOKEN,
      { type: 'last' },
      encodeThoughtPayload({
        value: SETTINGS_VALUE,
        created: now,
        lastUpdated: now,
        updatedBy: '',
      }),
      createTreecrdtLocalWriteOptions(),
    )
    settingsId = SETTINGS_TOKEN
  }

  if (settingsId) {
    const now = Date.now()
    await upsertLexeme(client, hashThought(SETTINGS_VALUE), {
      contexts: [settingsId],
      created: now as Timestamp,
      lastUpdated: now as Timestamp,
      updatedBy: '',
    })
  }

  resolveInitReady()
}

/** TreeCRDT data provider for thoughtspace. */
const thoughtspaceDataProvider: DataProvider<[Uint8Array]> = {
  name: 'treecrdt',
  init,
  clear,
  getLexemeById,
  getLexemesByIds,
  getThoughtById,
  getThoughtsByIds,
  updateThoughts,
  freeThought,
  freeLexeme,
  updateLexemeIndex,
}

export default thoughtspaceDataProvider
