/* eslint-disable import/prefer-default-export -- bridge module */
import type { MaterializationEvent } from '@treecrdt/interface/engine'
import type Index from '../../../@types/IndexType'
import type Lexeme from '../../../@types/Lexeme'
import type Thought from '../../../@types/Thought'
import type { ThoughtspaceMaterializationBridge } from '../../thoughtspace'
import { refreshAttributeChildrenFromChanges } from '../attributeChildren'
import thoughtspaceDb from '../thoughtspace'
import { getTreecrdtClient } from '../treecrdt'
import { withTreecrdtWriteBarrier } from '../writeBarrier'
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
): Promise<void> {
  if (event.changes.length === 0) return

  await refreshAttributeChildrenFromChanges(getTreecrdtClient(), event.changes)

  const snapshot = materialization.getSnapshot()
  const { deletedIds, thoughts, lexemeIndexUpdates } = await refreshThoughtsFromMaterializationChanges(
    event.changes,
    thoughtspaceDb,
    snapshot,
  )

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
    await materialization.apply({ thoughtIndexUpdates, lexemeIndexUpdates }, snapshot)
  }
}

/** Serializes materialization refreshes so overlapping async events cannot apply out of order. */
export function enqueueMaterializedThoughtsToStore(
  event: MaterializationEvent,
  materialization: ThoughtspaceMaterializationBridge,
): Promise<void> {
  pendingMaterializationEvents.push(event)

  return enqueueMaterializedThoughtsToStoreWork(async () => {
    if (pendingMaterializationEvents.length === 0) return

    // Serialize peer refreshes with the originating tab's complete persistence batch. Events received while waiting
    // for the cross-tab lock are coalesced so the app reads the final tree once instead of replaying intermediate UI
    // states from a multi-operation import.
    await withTreecrdtWriteBarrier(async () => {
      const events = pendingMaterializationEvents
      pendingMaterializationEvents = []
      await applyMaterializedThoughtsToStore(coalesceMaterializationEvents(events), materialization)
    })
  })
}
