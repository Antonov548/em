import type { Operation } from '@treecrdt/interface'
import { type ClientOptions, type RuntimeMode, type TreecrdtClient, createTreecrdtClient } from '@treecrdt/wa-sqlite'
import type { DataProvider } from '../DataProvider'
import { initPermissionsStore } from '../permissionsStore'
import type {
  ThoughtspaceAccessResult,
  ThoughtspaceRuntime,
  ThoughtspaceRuntimeInitOptions,
  ThoughtspaceStorage,
} from '../thoughtspace'
import { clientIdReady, tsid } from '../thoughtspaceSession'
import acquireTreecrdtSessionLock from './sessionLock'
import { createTreecrdtWebSocketSync } from './sync'
import { getMaterializedThoughtsToStoreVersion, waitForMaterializedThoughtsToStore } from './sync/materializationQueue'
import createTreecrdtDataProvider from './thoughtspace'
import { getTreecrdtWriteBarrierVersion, waitForTreecrdtWriteBarrier, withTreecrdtWriteBarrier } from './writeBarrier'

type PersistTreecrdtBatch = Parameters<DataProvider['updateThoughts']>[0] & {
  local?: boolean
}

/** App-level TreeCRDT client configuration. Omit it to use persistent browser defaults. */
export type TreecrdtClientConfig = Readonly<{
  storage: ThoughtspaceStorage
  runtime: RuntimeMode
  docId?: string
}>

type MultipleTabTreecrdtClientConfig = TreecrdtClientConfig &
  Readonly<{
    storage: 'memory'
    runtime: 'direct'
  }>

/** TreeCRDT client settings and em's supported tab-access policies. */
export type TreecrdtRuntimeConfig =
  | Readonly<{
      client?: TreecrdtClientConfig
      tabPolicy: 'single'
    }>
  | Readonly<{
      client: MultipleTabTreecrdtClientConfig
      tabPolicy: 'multiple'
    }>

/** One app-scoped TreeCRDT thoughtspace with its bound data provider and lifecycle. */
export interface TreecrdtThoughtspace extends ThoughtspaceRuntime {
  readonly db: DataProvider
}

const TREECRDT_IDLE_TIMEOUT = 30000

/** Rejects if provider idle work never settles. */
const withIdleTimeout = (promise: Promise<void>): Promise<void> => {
  let timeoutId: ReturnType<typeof setTimeout> | undefined

  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        reject(new Error(`TreeCRDT idle wait timed out after ${TREECRDT_IDLE_TIMEOUT}ms`))
      }, TREECRDT_IDLE_TIMEOUT)
    }),
  ]).finally(() => {
    if (timeoutId) clearTimeout(timeoutId)
  })
}

/** Converts the app client id to TreeCRDT's 32-byte replica id. */
const clientIdToReplicaId = (clientId: string): Uint8Array =>
  clientId.length === 44
    ? Uint8Array.from(atob(clientId), c => c.charCodeAt(0))
    : (() => {
        const bytes = new TextEncoder().encode(clientId)
        const replicaId = new Uint8Array(32)
        replicaId.set(bytes.subarray(0, 32))
        return replicaId
      })()

/** Converts em client settings to the full TreeCRDT client options. */
export const getTreecrdtClientOptions = (config?: TreecrdtClientConfig): ClientOptions => {
  const storage = config?.storage ?? 'persistent'

  return {
    storage:
      storage === 'memory'
        ? { type: 'memory' }
        : {
            type: 'opfs',
            filename: `/treecrdt-em-${tsid}.db`,
            fallback: 'throw',
          },
    runtime: { type: config?.runtime ?? (storage === 'memory' ? 'direct' : 'dedicated-worker') },
    docId: config?.docId ?? tsid,
  }
}

/**
 * Waits until both local writes and materialization refreshes are stable.
 *
 * The app creates one active thoughtspace per browser realm, so these shared queues intentionally serialize its one
 * Redux integration pipeline. Client, session, persistence, and WebSocket ownership remain factory-local.
 */
const waitForStableIdle = async (): Promise<void> => {
  let writeVersion: number
  let materializationVersion: number
  let firstError: unknown

  do {
    writeVersion = getTreecrdtWriteBarrierVersion()
    materializationVersion = getMaterializedThoughtsToStoreVersion()
    const results = await Promise.allSettled([waitForTreecrdtWriteBarrier(), waitForMaterializedThoughtsToStore()])
    firstError ??= results.find(result => result.status === 'rejected')?.reason
  } while (
    writeVersion !== getTreecrdtWriteBarrierVersion() ||
    materializationVersion !== getMaterializedThoughtsToStoreVersion()
  )

  if (firstError) throw firstError
}

/** Creates one TreeCRDT client owner and its bound app thoughtspace. */
export const createTreecrdtThoughtspace = ({
  client: clientConfig,
  tabPolicy,
}: TreecrdtRuntimeConfig): TreecrdtThoughtspace => {
  const storage = clientConfig?.storage ?? 'persistent'
  const workerRuntime = clientConfig?.runtime ?? 'dedicated-worker'

  if (tabPolicy === 'multiple' && (storage !== 'memory' || workerRuntime !== 'direct')) {
    throw new Error('Multiple-tab TreeCRDT access requires in-memory storage with the direct runtime.')
  }

  type InitResult = { clientId: string }

  let client: TreecrdtClient | null = null
  let unsubscribeMaterialization: (() => void) | null = null
  let lifecycleTail: Promise<void> = Promise.resolve()
  let latestLifecycle: Promise<unknown> = lifecycleTail
  let initPromise: Promise<InitResult> | null = null
  let dropPromise: Promise<void> | null = null
  let persistenceVersion = 0
  const pendingPersistence = new Map<number, Promise<void>>()
  const persistenceErrors = new Map<number, unknown>()
  const provider = createTreecrdtDataProvider()
  const websocketSync = createTreecrdtWebSocketSync()

  /** Applies em's tab policy before the TreeCRDT client is opened. */
  const acquireAccess = async (): Promise<ThoughtspaceAccessResult> => {
    if (tabPolicy === 'multiple') return { status: 'acquired' }

    const lockStatus = await acquireTreecrdtSessionLock()

    return lockStatus === 'acquired'
      ? { status: 'acquired' }
      : {
          status: 'blocked',
          reason: lockStatus === 'unavailable' ? 'already-open' : 'unsupported',
        }
  }

  /** Waits for factory-local persistence calls registered through the requested version. */
  const waitForPersistenceThrough = async (version: number): Promise<void> => {
    const pending = [...pendingPersistence]
      .filter(([persistenceId]) => persistenceId <= version)
      .map(([, promise]) => promise)
    await Promise.allSettled(pending)

    const failure = [...persistenceErrors].find(([persistenceId]) => persistenceId <= version)
    for (const persistenceId of persistenceErrors.keys()) {
      if (persistenceId <= version) persistenceErrors.delete(persistenceId)
    }
    if (failure) throw failure[1]
  }

  /** Drains local persistence first, then the shared write/materialization pipeline even if either reports an error. */
  const waitForRuntimeWorkThrough = async (version: number): Promise<void> => {
    let firstError: unknown

    try {
      await waitForPersistenceThrough(version)
    } catch (error) {
      firstError = error
    }
    try {
      await waitForStableIdle()
    } catch (error) {
      firstError ??= error
    }

    if (firstError) throw firstError
  }

  /** Waits until no newer factory-local persistence was registered while the current snapshot drained. */
  const waitForRuntimeIdle = async (): Promise<void> => {
    let firstError: unknown
    let version: number

    do {
      version = persistenceVersion
      try {
        await waitForRuntimeWorkThrough(version)
      } catch (error) {
        firstError ??= error
      }
    } while (version !== persistenceVersion)

    if (firstError) throw firstError
  }

  /** Stops ingress, drains captured work, and releases all resources owned by this thoughtspace. */
  const dropClient = async (persistenceVersionAtDrop: number): Promise<void> => {
    const errors: unknown[] = []
    /** Records cleanup failures without skipping later owned resources. */
    const captureError = async (work: () => void | Promise<unknown>): Promise<void> => {
      try {
        await work()
      } catch (error) {
        errors.push(error)
      }
    }

    provider.resetSession(new Error('TreeCRDT session dropped before initialization.'))

    const unsubscribe = unsubscribeMaterialization
    unsubscribeMaterialization = null
    const clientToDrop = client

    await captureError(websocketSync.stop)
    await captureError(() => unsubscribe?.())
    await captureError(() => withIdleTimeout(waitForRuntimeWorkThrough(persistenceVersionAtDrop)))
    // Writes already running during the first stop may have produced buffered local ops.
    await captureError(websocketSync.stop)

    let clientReleased = clientToDrop === null
    if (clientToDrop) {
      try {
        await clientToDrop.drop()
        clientReleased = true
      } catch (error) {
        errors.push(error)
        try {
          await clientToDrop.close()
          clientReleased = true
        } catch (closeError) {
          errors.push(closeError)
        }
      }
    }

    if (clientReleased && client === clientToDrop) client = null
    if (errors.length > 0) throw errors[0]
  }

  /** Serializes teardown after any preceding initialization. */
  const drop = (): Promise<void> => {
    if (dropPromise) return dropPromise

    initPromise = null
    const persistenceVersionAtDrop = persistenceVersion
    const promise = lifecycleTail.then(() => dropClient(persistenceVersionAtDrop))
    dropPromise = promise
    latestLifecycle = promise
    lifecycleTail = promise.then(
      () => undefined,
      () => undefined,
    )
    void promise.catch(() => {
      if (dropPromise === promise) dropPromise = null
    })
    return promise
  }

  const db: DataProvider = { ...provider.db, clear: drop }

  /** Binds each persistence call to the exact session ordered before it and tracks it before any async wait. */
  const persistPushQueueBatches = (batches: readonly PersistTreecrdtBatch[]): Promise<void> => {
    persistenceVersion += 1
    const persistenceId = persistenceVersion
    const precedingLifecycle = latestLifecycle
    const persistence = (async () => {
      await precedingLifecycle
      const sessionDb = await provider.waitForSession()

      return withTreecrdtWriteBarrier(async () => {
        for (const batch of batches) {
          const { local: isLocal, ...updates } = batch
          const maybeOps = await sessionDb.updateThoughts(updates)
          if (isLocal && Array.isArray(maybeOps) && maybeOps.length > 0) {
            void websocketSync.pushLocalOps(maybeOps as readonly Operation[])
          }
        }
      })
    })()

    const trackedPersistence = persistence.then(
      () => {
        pendingPersistence.delete(persistenceId)
      },
      error => {
        pendingPersistence.delete(persistenceId)
        persistenceErrors.set(persistenceId, error)
        throw error
      },
    )
    pendingPersistence.set(persistenceId, trackedPersistence)
    void trackedPersistence.catch(() => undefined)
    return trackedPersistence
  }

  /** Opens and binds one client. Lifecycle serialization provides retryable single-flight behavior. */
  const initializeClient = async (options?: ThoughtspaceRuntimeInitOptions): Promise<InitResult> => {
    let nextClient: TreecrdtClient | null = null
    let nextUnsubscribeMaterialization: (() => void) | null = null

    try {
      if (client) throw new Error('TreeCRDT client cleanup is incomplete. Retry drop before initialization.')
      const clientId = await clientIdReady
      await initPermissionsStore()
      nextClient = await createTreecrdtClient(getTreecrdtClientOptions(clientConfig))
      nextUnsubscribeMaterialization = await provider.bindSession(
        nextClient,
        clientIdToReplicaId(clientId),
        options?.materialization,
      )
      await websocketSync.tryStartFromEnv(nextClient)

      client = nextClient
      unsubscribeMaterialization = nextUnsubscribeMaterialization
      return { clientId }
    } catch (error) {
      provider.resetSession(error)
      nextUnsubscribeMaterialization?.()
      await nextClient?.close()
      throw error
    }
  }

  /** Coalesces adjacent init calls and preserves their order relative to drop. */
  const init = (options?: ThoughtspaceRuntimeInitOptions): Promise<InitResult> => {
    if (initPromise) return initPromise

    dropPromise = null
    const promise = lifecycleTail.then(() => initializeClient(options))
    initPromise = promise
    latestLifecycle = promise
    lifecycleTail = promise.then(
      () => undefined,
      () => undefined,
    )
    void promise.catch(() => {
      if (initPromise === promise) initPromise = null
    })
    return promise
  }

  return {
    db,
    acquireAccess,
    init,
    drop,
    waitForIdle: (): Promise<void> => withIdleTimeout(waitForRuntimeIdle()),
    persistPushQueueBatches,
  }
}

export default createTreecrdtThoughtspace
