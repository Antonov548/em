import type Index from '../@types/IndexType'
import type Lexeme from '../@types/Lexeme'
import type Thought from '../@types/Thought'
import type { DataProvider } from './DataProvider'
import { treecrdtRuntime } from './treecrdt/runtime'
import treecrdtDb from './treecrdt/thoughtspace'
import { withTreecrdtWriteBarrier } from './treecrdt/writeBarrier'

export type PersistThoughtspaceBatch = Parameters<DataProvider['updateThoughts']>[0] & {
  local?: boolean
}

export type ThoughtspaceMaterializationSnapshot = {
  schemaVersion: number
  thoughtIndex: Index<Thought>
  lexemeIndex: Index<Lexeme>
}

export type ThoughtspaceMaterializedUpdates = {
  thoughtIndexUpdates: Index<Thought | null>
  lexemeIndexUpdates: Index<Lexeme | null>
}

export type ThoughtspaceMaterializationApplyResult = 'applied' | 'conflict'

export type ThoughtspaceMaterializationBridge = {
  getSnapshot: () => ThoughtspaceMaterializationSnapshot
  apply: (
    updates: ThoughtspaceMaterializedUpdates,
    readSnapshot: ThoughtspaceMaterializationSnapshot,
  ) => ThoughtspaceMaterializationApplyResult | Promise<ThoughtspaceMaterializationApplyResult>
}

/** True when any thought or lexeme in a materialization batch changed in Redux after its provider snapshot. */
export const hasMaterializationSnapshotConflict = (
  updates: ThoughtspaceMaterializedUpdates,
  readSnapshot: ThoughtspaceMaterializationSnapshot,
  currentSnapshot: ThoughtspaceMaterializationSnapshot,
): boolean =>
  Object.keys(updates.thoughtIndexUpdates).some(
    id => currentSnapshot.thoughtIndex[id] !== readSnapshot.thoughtIndex[id],
  ) ||
  Object.keys(updates.lexemeIndexUpdates).some(
    key => currentSnapshot.lexemeIndex[key] !== readSnapshot.lexemeIndex[key],
  )

export type ThoughtspaceRuntimeInitOptions = {
  materialization?: ThoughtspaceMaterializationBridge
}

/** App-facing lifecycle interface for the active thoughtspace implementation. */
export interface ThoughtspaceRuntime {
  init: (options?: ThoughtspaceRuntimeInitOptions) => Promise<{ clientId: string }>
  drop: () => Promise<unknown>
  waitForIdle: () => Promise<void>
  persistPushQueueBatches: (batches: readonly PersistThoughtspaceBatch[]) => Promise<void>
}

/**
 * The active data provider backing the current app thoughtspace. Public SQLite reads join the same queue as writes so
 * a dedicated worker in one tab cannot read the shared OPFS database through another tab's transaction. Internal
 * TreeCRDT materialization uses the raw provider while already holding this barrier.
 */
export const db: DataProvider = {
  ...treecrdtDb,
  clear: () => withTreecrdtWriteBarrier(() => treecrdtDb.clear()),
  getLexemeById: key => withTreecrdtWriteBarrier(() => treecrdtDb.getLexemeById(key)),
  getLexemesByContextId: id => withTreecrdtWriteBarrier(() => treecrdtDb.getLexemesByContextId!(id)),
  getLexemesByIds: keys => withTreecrdtWriteBarrier(() => treecrdtDb.getLexemesByIds(keys)),
  getThoughtById: id => withTreecrdtWriteBarrier(() => treecrdtDb.getThoughtById(id)),
  getThoughtsByIds: ids => withTreecrdtWriteBarrier(() => treecrdtDb.getThoughtsByIds(ids)),
  updateThoughts: updates => withTreecrdtWriteBarrier(() => treecrdtDb.updateThoughts(updates)),
  updateLexemeIndex: lexemeIndex => withTreecrdtWriteBarrier(() => treecrdtDb.updateLexemeIndex!(lexemeIndex)),
}

/** The active thoughtspace runtime implementation. */
export const thoughtspaceRuntime: ThoughtspaceRuntime = treecrdtRuntime

export default db
