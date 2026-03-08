import type Index from '../../@types/IndexType'
import type Lexeme from '../../@types/Lexeme'
import type Thought from '../../@types/Thought'
import type ThoughtId from '../../@types/ThoughtId'
import type Timestamp from '../../@types/Timestamp'
import type { DataProvider } from '../DataProvider'
import { getTreecrdtClient } from './treecrdt'
import { HOME_TOKEN, ROOT_PARENT_ID } from '../../constants'

export type ThoughtPayload = {
  value: string
  rank: number
  created: number
  lastUpdated: number
  updatedBy: string
  archived?: number
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export function encodeThoughtPayload(payload: ThoughtPayload): Uint8Array {
  return encoder.encode(JSON.stringify(payload))
}

export function decodeThoughtPayload(bytes: Uint8Array): ThoughtPayload {
  return JSON.parse(decoder.decode(bytes)) as ThoughtPayload
}

let replicaId: Uint8Array | null = null

const getThoughtById = async (id: ThoughtId): Promise<Thought | undefined> => {
  const client = getTreecrdtClient()

  const payloadBytes = await client.tree.getPayload(id)
  if (payloadBytes === null) return undefined

  const payload = decodeThoughtPayload(payloadBytes)

  const parentIdRaw = await client.tree.parent(id)
  const parentId: ThoughtId = parentIdRaw === null ? (ROOT_PARENT_ID as ThoughtId) : (parentIdRaw as ThoughtId)

  const childIds = await client.tree.children(id)
  const childrenMap: Index<ThoughtId> = {}
  for (const cid of childIds) {
    childrenMap[cid] = cid as ThoughtId
  }

  const thought: Thought = {
    id,
    value: payload.value,
    rank: payload.rank,
    created: payload.created as Timestamp,
    lastUpdated: payload.lastUpdated as Timestamp,
    updatedBy: payload.updatedBy,
    parentId,
    childrenMap,
    ...(payload.archived !== undefined && { archived: payload.archived as Timestamp }),
  }

  return thought
}

const getThoughtsByIds = (ids: ThoughtId[]): Promise<(Thought | undefined)[]> =>
  Promise.all(ids.map(getThoughtById))

const updateThoughts = async ({
  thoughtIndexUpdates,
}: {
  thoughtIndexUpdates: Index<Thought | null>
  lexemeIndexUpdates: Index<Lexeme | null>
  lexemeIndexUpdatesOld: Index<Lexeme | undefined>
  schemaVersion: number
}): Promise<void> => {
  if (!replicaId) throw new Error('TreeCRDT DataProvider: init not called')

  const client = getTreecrdtClient()

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
    await client.local.delete(replicaId, id)
  }

  for (const [id, thought] of Object.entries(updates)) {
    const thoughtId = id as ThoughtId
    const payloadBytes = encodeThoughtPayload({
      value: thought.value,
      rank: thought.rank,
      created: thought.created,
      lastUpdated: thought.lastUpdated,
      updatedBy: thought.updatedBy,
      ...(thought.archived !== undefined && { archived: thought.archived }),
    })

    const exists = await client.tree.exists(thoughtId)

    if (!exists) {
      await client.local.insert(
        replicaId,
        thought.parentId === ROOT_PARENT_ID ? HOME_TOKEN : thought.parentId,
        thoughtId,
        { type: 'last' },
        payloadBytes
      )
    } else {
      const existing = await getThoughtById(thoughtId)
      if (!existing) continue

      if (existing.parentId !== thought.parentId) {
        await client.local.move(
          replicaId,
          thoughtId,
          thought.parentId === ROOT_PARENT_ID ? HOME_TOKEN : thought.parentId,
          { type: 'last' }
        )
      }

      const payloadChanged =
        existing.value !== thought.value ||
        existing.rank !== thought.rank ||
        existing.created !== thought.created ||
        existing.lastUpdated !== thought.lastUpdated ||
        existing.updatedBy !== thought.updatedBy ||
        existing.archived !== thought.archived

      if (payloadChanged) {
        await client.local.payload(replicaId, thoughtId, payloadBytes)
      }
    }
  }
}

const freeThought = async (_id: ThoughtId): Promise<void> => {
  // no-op
}

const freeLexeme = async (_key: string): Promise<void> => {
  // no-op
}

const clear = async (): Promise<void> => {
  if (!replicaId) throw new Error('TreeCRDT DataProvider: init not called')

  const client = getTreecrdtClient()

  async function deleteSubtree(parentId: string): Promise<void> {
    const children = await client.tree.children(parentId)
    for (const childId of children) {
      await deleteSubtree(childId)
      await client.local.delete(replicaId!, childId)
    }
  }

  await deleteSubtree(HOME_TOKEN)
}

const getLexemeById = async (_key: string): Promise<Lexeme | undefined> => undefined

const getLexemesByIds = async (keys: string[]): Promise<(Lexeme | undefined)[]> =>
  Promise.resolve(keys.map(() => undefined))

export const init = (replicaIdArg: Uint8Array): void => {
  replicaId = replicaIdArg
}

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
}

export default thoughtspaceDataProvider
