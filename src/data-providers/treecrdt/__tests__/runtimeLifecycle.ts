import type { TreecrdtClient } from '@treecrdt/wa-sqlite'
import { EM_TOKEN } from '../../../constants'
import createTreecrdtThoughtspace from '../runtime'
import { enqueueMaterializedThoughtsToStoreWork } from '../sync/materializationQueue'
import { withTreecrdtWriteBarrier } from '../writeBarrier'

const { createTreecrdtClient } = vi.hoisted(() => ({
  createTreecrdtClient: vi.fn(),
}))

vi.mock('@treecrdt/wa-sqlite', async importOriginal => {
  const actual = await importOriginal<typeof import('@treecrdt/wa-sqlite')>()
  return { ...actual, createTreecrdtClient }
})

let createActualTreecrdtClient: (typeof import('@treecrdt/wa-sqlite'))['createTreecrdtClient']
let createdClients: TreecrdtClient[] = []

beforeAll(async () => {
  const actual = await vi.importActual<typeof import('@treecrdt/wa-sqlite')>('@treecrdt/wa-sqlite')
  createActualTreecrdtClient = actual.createTreecrdtClient
})

beforeEach(() => {
  createdClients = []
  createTreecrdtClient.mockImplementation(async options => {
    const client = await createActualTreecrdtClient(options)
    createdClients.push(client)
    return client
  })
})

afterEach(() => {
  createTreecrdtClient.mockReset()
})

/** Creates an isolated in-memory thoughtspace for lifecycle tests. */
const createTestThoughtspace = () =>
  createTreecrdtThoughtspace({
    client: { storage: 'memory', runtime: 'direct' },
    tabPolicy: 'multiple',
  })

const emptyUpdate = {
  thoughtIndexUpdates: {},
  lexemeIndexUpdates: {},
  lexemeIndexUpdatesOld: {},
  schemaVersion: 0,
}

it('rejects persistence started during a failing init with the same error', async () => {
  const initError = new Error('client init failed')
  let markClientCreationStarted!: () => void
  let rejectClientCreation!: () => void
  const clientCreationStarted = new Promise<void>(resolve => {
    markClientCreationStarted = resolve
  })
  createTreecrdtClient.mockImplementationOnce(
    () =>
      new Promise((_, reject) => {
        markClientCreationStarted()
        rejectClientCreation = () => reject(initError)
      }),
  )
  const thoughtspace = createTestThoughtspace()

  const initializing = thoughtspace.init()
  await clientCreationStarted
  const persistence = thoughtspace.persistPushQueueBatches([emptyUpdate])
  const initResult = expect(initializing).rejects.toBe(initError)
  const persistenceResult = expect(persistence).rejects.toBe(initError)

  rejectClientCreation()

  await initResult
  await persistenceResult
  await expect(thoughtspace.waitForIdle()).rejects.toBe(initError)
})

it('binds persistence called between drop and init to the next session', async () => {
  const thoughtspace = createTestThoughtspace()
  await thoughtspace.init()

  const dropping = thoughtspace.drop()
  const persistence = thoughtspace.persistPushQueueBatches([emptyUpdate])
  const initializing = thoughtspace.init()

  await Promise.all([dropping, persistence, initializing])
  await expect(thoughtspace.db.getThoughtById(EM_TOKEN)).resolves.toMatchObject({ id: EM_TOKEN })

  await thoughtspace.drop()
})

it('includes lifecycle-bound persistence in the idle barrier', async () => {
  const thoughtspace = createTestThoughtspace()
  await thoughtspace.init()

  let markClientCreationStarted!: () => void
  let releaseClientCreation!: () => void
  const clientCreationStarted = new Promise<void>(resolve => {
    markClientCreationStarted = resolve
  })
  const clientCreationGate = new Promise<void>(resolve => {
    releaseClientCreation = resolve
  })
  createTreecrdtClient.mockImplementationOnce(async options => {
    markClientCreationStarted()
    await clientCreationGate
    const client = await createActualTreecrdtClient(options)
    createdClients.push(client)
    return client
  })

  const dropping = thoughtspace.drop()
  const initializing = thoughtspace.init()
  const persistence = thoughtspace.persistPushQueueBatches([emptyUpdate])
  const idle = thoughtspace.waitForIdle()
  let idleSettled = false
  void idle
    .finally(() => {
      idleSettled = true
    })
    .catch(() => undefined)

  await clientCreationStarted
  await Promise.resolve()
  expect(idleSettled).toBe(false)

  releaseClientCreation()
  await Promise.all([dropping, initializing, persistence, idle])
  expect(idleSettled).toBe(true)

  await thoughtspace.drop()
})

it('drains persistence and materialization before dropping the client', async () => {
  const thoughtspace = createTestThoughtspace()
  await thoughtspace.init()

  const writeError = new Error('write failed')
  let markWriteStarted!: () => void
  let rejectWrite!: () => void
  let markMaterializationStarted!: () => void
  let releaseMaterialization!: () => void
  const writeStarted = new Promise<void>(resolve => {
    markWriteStarted = resolve
  })
  const materializationStarted = new Promise<void>(resolve => {
    markMaterializationStarted = resolve
  })
  const blockingWrite = withTreecrdtWriteBarrier(
    () =>
      new Promise<void>((_, reject) => {
        rejectWrite = () => reject(writeError)
        markWriteStarted()
      }),
  )
  const blockingWriteResult = expect(blockingWrite).rejects.toBe(writeError)
  const blockingMaterialization = enqueueMaterializedThoughtsToStoreWork(
    () =>
      new Promise<void>(resolve => {
        releaseMaterialization = resolve
        markMaterializationStarted()
      }),
  )
  await Promise.all([writeStarted, materializationStarted])

  const persistence = thoughtspace.persistPushQueueBatches([emptyUpdate])
  await Promise.resolve()
  const dropClient = vi.spyOn(createdClients[0], 'drop')
  const dropping = thoughtspace.drop()
  const droppingResult = expect(dropping).rejects.toBe(writeError)
  await Promise.resolve()
  await Promise.resolve()
  expect(dropClient).not.toHaveBeenCalled()

  rejectWrite()
  await blockingWriteResult
  await persistence
  await Promise.resolve()
  expect(dropClient).not.toHaveBeenCalled()

  releaseMaterialization()
  await blockingMaterialization
  await droppingResult
  expect(dropClient).toHaveBeenCalledTimes(1)
})

it('retains ownership when both drop and close fail and blocks unsafe reuse', async () => {
  const thoughtspace = createTestThoughtspace()
  await thoughtspace.init()

  const dropError = new Error('drop failed')
  const closeError = new Error('close failed')
  vi.spyOn(createdClients[0], 'drop').mockRejectedValue(dropError)
  vi.spyOn(createdClients[0], 'close').mockRejectedValueOnce(closeError)

  await expect(thoughtspace.drop()).rejects.toBe(dropError)
  await expect(thoughtspace.persistPushQueueBatches([emptyUpdate])).rejects.toBe(dropError)
  await expect(thoughtspace.init()).rejects.toThrow(
    'TreeCRDT client cleanup is incomplete. Retry drop before initialization.',
  )

  // drop still reports deletion failure, but the second close succeeds and releases ownership.
  await expect(thoughtspace.drop()).rejects.toBe(dropError)
  await expect(thoughtspace.init()).resolves.toEqual({ clientId: expect.any(String) })
  await thoughtspace.drop()
})
