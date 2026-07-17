import type { MaterializationEvent } from '@treecrdt/interface/engine'

let materializedThoughtsToStoreQueue = Promise.resolve()
let materializedThoughtsToStoreError: unknown = null
let materializedThoughtsToStoreVersion = 0

/** Coalesces cross-source callbacks in authoritative TreeCRDT head order. */
export function coalesceMaterializationEvents(events: readonly MaterializationEvent[]): MaterializationEvent {
  const ordered = [...events].sort((a, b) => a.headSeq - b.headSeq)
  return {
    headSeq: ordered.at(-1)?.headSeq ?? 0,
    changes: ordered.flatMap(event => event.changes),
  }
}

/** Serializes materialization refresh work and records failures for the idle barrier. */
export function enqueueMaterializedThoughtsToStoreWork(work: () => Promise<void>): Promise<void> {
  materializedThoughtsToStoreVersion += 1
  const apply = materializedThoughtsToStoreQueue.then(work)
  materializedThoughtsToStoreQueue = apply.catch(err => {
    materializedThoughtsToStoreError = err
  })
  return apply
}

/** Monotonically increases whenever materialization refresh work is queued. */
export const getMaterializedThoughtsToStoreVersion = (): number => materializedThoughtsToStoreVersion

/** Waits for queued materialization refreshes to finish and surfaces the first refresh error. */
export async function waitForMaterializedThoughtsToStore(): Promise<void> {
  let pending: Promise<void>
  do {
    pending = materializedThoughtsToStoreQueue
    await pending
  } while (pending !== materializedThoughtsToStoreQueue)

  if (materializedThoughtsToStoreError) {
    const err = materializedThoughtsToStoreError
    materializedThoughtsToStoreError = null
    throw err
  }
}

export default {
  coalesceMaterializationEvents,
  enqueueMaterializedThoughtsToStoreWork,
  getMaterializedThoughtsToStoreVersion,
  waitForMaterializedThoughtsToStore,
}
