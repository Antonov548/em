import type { LocalWriteOptions, MaterializationEvent } from '@treecrdt/interface/engine'
import { tsid } from '../thoughtspaceSession'

let pendingTreecrdtWrite = Promise.resolve()
let pendingTreecrdtWriteError: unknown = null
let pendingTreecrdtWriteVersion = 0
let pendingTreecrdtPersistenceIntents = 0
let treecrdtPersistenceIntentEpoch = 0
let resolveTreecrdtPersistenceIntentsIdle: (() => void) | null = null
let treecrdtPersistenceIntentsIdle = Promise.resolve()
let localWriteCounter = 0

const localWriteSourceId =
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`

const localWriteIdPrefix = `em-local:${localWriteSourceId}:`

/** Serializes multi-statement TreeCRDT work across tabs that share an OPFS database. */
const withCrossTabTreecrdtLock = <T>(work: () => Promise<T>): Promise<T> => {
  const locks = typeof navigator === 'undefined' ? undefined : navigator.locks
  return locks?.request ? (locks.request(`em-treecrdt:${tsid}`, work) as Promise<T>) : work()
}

/**
 * Queues em -> TreeCRDT persistence work and exposes an idle barrier for materialization refreshes. The local queue
 * preserves same-tab ordering, while the document Web Lock keeps multi-statement app batches atomic across OPFS tabs.
 */
export function withTreecrdtWriteBarrier<T>(work: () => Promise<T>): Promise<T> {
  pendingTreecrdtWriteVersion += 1
  const run = pendingTreecrdtWrite.then(
    () => withCrossTabTreecrdtLock(work),
    () => withCrossTabTreecrdtLock(work),
  )
  pendingTreecrdtWrite = run.then(
    () => undefined,
    err => {
      pendingTreecrdtWriteError = err
    },
  )
  return run
}

/** Monotonically increases whenever TreeCRDT persistence work is queued. */
export const getTreecrdtWriteBarrierVersion = (): number => pendingTreecrdtWriteVersion

/** Waits until TreeCRDT persistence is idle, including work queued while waiting. */
export async function waitForTreecrdtWriteBarrier(): Promise<void> {
  let pending: Promise<void>
  do {
    pending = pendingTreecrdtWrite
    await pending
  } while (pending !== pendingTreecrdtWrite)

  if (pendingTreecrdtWriteError) {
    const err = pendingTreecrdtWriteError
    pendingTreecrdtWriteError = null
    throw err
  }
}

/**
 * Registers an app persistence call before its first await. Materialization uses this synchronous intent to avoid
 * reading SQLite while newer optimistic Redux state is queued behind its Web Lock.
 */
export function beginTreecrdtPersistenceIntent(): () => void {
  treecrdtPersistenceIntentEpoch += 1
  if (pendingTreecrdtPersistenceIntents === 0) {
    treecrdtPersistenceIntentsIdle = new Promise(resolve => {
      resolveTreecrdtPersistenceIntentsIdle = resolve
    })
  }
  pendingTreecrdtPersistenceIntents += 1

  let finished = false
  return () => {
    if (finished) return
    finished = true
    pendingTreecrdtPersistenceIntents -= 1
    if (pendingTreecrdtPersistenceIntents === 0) {
      resolveTreecrdtPersistenceIntentsIdle?.()
      resolveTreecrdtPersistenceIntentsIdle = null
    }
  }
}

/** Returns the current local persistence intent count and monotonic epoch. */
export const getTreecrdtPersistenceIntentState = (): { pending: number; epoch: number } => ({
  pending: pendingTreecrdtPersistenceIntents,
  epoch: treecrdtPersistenceIntentEpoch,
})

/** Waits until every app persistence intent registered so far has finished. */
export async function waitForTreecrdtPersistenceIntents(): Promise<void> {
  while (pendingTreecrdtPersistenceIntents > 0) {
    const pending = treecrdtPersistenceIntentsIdle
    await pending
  }
}

/** Creates local write metadata used to identify materialization events already applied optimistically by the app. */
export function createTreecrdtLocalWriteOptions(): LocalWriteOptions {
  localWriteCounter += 1
  return { writeId: `${localWriteIdPrefix}${localWriteCounter}` }
}

/** True when a materialization event was produced by this tab's own optimistic TreeCRDT write. */
export const isTreecrdtLocalMaterialization = (event: MaterializationEvent): boolean => {
  return (
    event.changes.length > 0 &&
    event.changes.every(change => {
      const writeIds = change.source?.writeIds
      return !!writeIds?.length && writeIds.every(writeId => writeId.startsWith(localWriteIdPrefix))
    })
  )
}

export default {
  beginTreecrdtPersistenceIntent,
  createTreecrdtLocalWriteOptions,
  getTreecrdtPersistenceIntentState,
  getTreecrdtWriteBarrierVersion,
  isTreecrdtLocalMaterialization,
  waitForTreecrdtPersistenceIntents,
  waitForTreecrdtWriteBarrier,
  withTreecrdtWriteBarrier,
}
