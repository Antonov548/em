/* eslint-disable import/prefer-default-export -- bridge module */
import type { MaterializationEvent } from '@treecrdt/interface/engine'
import type Index from '../../../@types/IndexType'
import type Lexeme from '../../../@types/Lexeme'
import type Thought from '../../../@types/Thought'
import type { ThoughtspaceMaterializationApplyResult, ThoughtspaceMaterializationBridge } from '../../thoughtspace'
import { refreshAttributeChildrenFromChanges } from '../attributeChildren'
import thoughtspaceDb from '../thoughtspace'
import { getTreecrdtClient } from '../treecrdt'
import {
  getTreecrdtPersistenceIntentState,
  waitForTreecrdtPersistenceIntents,
  withTreecrdtWriteBarrier,
} from '../writeBarrier'
import { coalesceMaterializationEvents, enqueueMaterializedThoughtsToStoreWork } from './materializationQueue'
import { refreshThoughtsFromMaterializationChanges } from './materializationThoughtUpdates'

let pendingMaterializationEvents: MaterializationEvent[] = []

/** Persists lexemes that em derives locally from materialized TreeCRDT thoughts. */
const persistDerivedLexemeUpdates = async (
  lexemeIndexUpdates: Index<Lexeme | null>,
  schemaVersion: number,
): Promise<void> => {
  if (Object.keys(lexemeIndexUpdates).length === 0) return

  await thoughtspaceDb.updateThoughts({
    thoughtIndexUpdates: {},
    lexemeIndexUpdates,
    lexemeIndexUpdatesOld: {},
    schemaVersion,
  })
}

/**
 * After remote TreeCRDT ops are materialized into SQLite, refresh the app-facing thoughtspace in one batch.
 * This is used for cross-tab and server sync events; same-tab local writes are already applied optimistically.
 */
export async function applyMaterializedThoughtsToStore(
  event: MaterializationEvent,
  materialization: ThoughtspaceMaterializationBridge,
  canApply: () => boolean = () => true,
): Promise<ThoughtspaceMaterializationApplyResult> {
  if (event.changes.length === 0) return 'applied'

  await refreshAttributeChildrenFromChanges(getTreecrdtClient(), event.changes)

  const snapshot = materialization.getSnapshot()
  const { deletedIds, thoughts, lexemeIndexUpdates } = await refreshThoughtsFromMaterializationChanges(
    event.changes,
    thoughtspaceDb,
    snapshot,
  )

  if (!canApply()) return 'conflict'
  await persistDerivedLexemeUpdates(lexemeIndexUpdates, snapshot.schemaVersion)

  const thoughtIndexUpdates: Index<Thought | null> = {}

  for (const id of deletedIds) {
    thoughtIndexUpdates[id] = null
  }

  for (const latest of thoughts) {
    const thoughtInState = snapshot.thoughtIndex[latest.id]
    const parentInState = snapshot.thoughtIndex[latest.parentId]
    // Pending is not part of the TreeCRDT payload. Preserve the local UI flag until auth/sync handling owns it.
    const pending = thoughtInState?.pending || parentInState?.pending
    const latestWithPending = {
      ...latest,
      ...(pending ? { pending } : null),
    }

    thoughtIndexUpdates[latest.id] = latestWithPending
  }

  if (Object.keys(thoughtIndexUpdates).length > 0 || Object.keys(lexemeIndexUpdates).length > 0) {
    if (!canApply()) return 'conflict'
    return materialization.apply({ thoughtIndexUpdates, lexemeIndexUpdates }, snapshot)
  }

  return 'applied'
}

/** Serializes materialization refreshes so overlapping async events cannot apply out of order. */
export function enqueueMaterializedThoughtsToStore(
  event: MaterializationEvent,
  materialization: ThoughtspaceMaterializationBridge,
): Promise<void> {
  pendingMaterializationEvents.push(event)

  return enqueueMaterializedThoughtsToStoreWork(async () => {
    let retainedEvents: MaterializationEvent[] = []

    try {
      while (retainedEvents.length > 0 || pendingMaterializationEvents.length > 0) {
        retainedEvents.push(...pendingMaterializationEvents)
        pendingMaterializationEvents = []

        // Local Redux changes register a persistence intent synchronously. Drain them outside the Web Lock, then
        // require the intent epoch to remain unchanged throughout the provider read and atomic Redux snapshot check.
        await waitForTreecrdtPersistenceIntents()
        const intentEpoch = getTreecrdtPersistenceIntentState().epoch
        const coalescedEvent = coalesceMaterializationEvents(retainedEvents)

        const result = await withTreecrdtWriteBarrier(async (): Promise<ThoughtspaceMaterializationApplyResult> => {
          /** True while no local persistence started after this materialization attempt began. */
          const isPersistenceStable = () => {
            const intentState = getTreecrdtPersistenceIntentState()
            return intentState.pending === 0 && intentState.epoch === intentEpoch
          }

          if (!isPersistenceStable()) return 'conflict'
          return applyMaterializedThoughtsToStore(coalescedEvent, materialization, isPersistenceStable)
        })

        retainedEvents = result === 'applied' ? [] : [coalescedEvent]
      }
    } catch (error) {
      // Final-state refresh is idempotent. Retain failed events so the next callback retries them instead of silently
      // losing the only notification for a peer change; the original error still surfaces through the idle barrier.
      pendingMaterializationEvents = [...retainedEvents, ...pendingMaterializationEvents]
      throw error
    }
  })
}
