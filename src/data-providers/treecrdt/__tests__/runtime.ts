import { EM_TOKEN } from '../../../constants'
import createTreecrdtThoughtspace, { type TreecrdtRuntimeConfig } from '../runtime'

const { mockAcquireTreecrdtSessionLock, mockCreateTreecrdtClient } = vi.hoisted(() => ({
  mockAcquireTreecrdtSessionLock: vi.fn(),
  mockCreateTreecrdtClient: vi.fn(),
}))

vi.mock('../sessionLock', () => ({ default: mockAcquireTreecrdtSessionLock }))
vi.mock('@treecrdt/wa-sqlite', async importOriginal => {
  const actual = await importOriginal<typeof import('@treecrdt/wa-sqlite')>()
  return { ...actual, createTreecrdtClient: mockCreateTreecrdtClient }
})

type TreecrdtModule = typeof import('@treecrdt/wa-sqlite')

let createRealTreecrdtClient!: TreecrdtModule['createTreecrdtClient']

const emptyUpdates = {
  thoughtIndexUpdates: {},
  lexemeIndexUpdates: {},
  lexemeIndexUpdatesOld: {},
  schemaVersion: 0,
}

/** Creates the standard in-memory thoughtspace used by lifecycle tests. */
const createMemoryThoughtspace = (docId?: string) => {
  const config: TreecrdtRuntimeConfig = {
    client: {
      storage: 'memory',
      runtime: 'direct',
      ...(docId === undefined ? {} : { docId }),
    },
    tabPolicy: 'multiple',
  }

  return createTreecrdtThoughtspace(() => config)
}

beforeAll(async () => {
  const actual = await vi.importActual<TreecrdtModule>('@treecrdt/wa-sqlite')
  createRealTreecrdtClient = actual.createTreecrdtClient
})

beforeEach(() => {
  mockCreateTreecrdtClient.mockImplementation(createRealTreecrdtClient)
})

afterEach(() => {
  mockAcquireTreecrdtSessionLock.mockReset()
  mockCreateTreecrdtClient.mockReset()
})

it.each([
  ['acquired', { status: 'acquired' }],
  ['unavailable', { status: 'blocked', reason: 'already-open' }],
  ['unsupported', { status: 'blocked', reason: 'unsupported' }],
] as const)('maps the %s session-lock status to thoughtspace access', async (lockStatus, access) => {
  mockAcquireTreecrdtSessionLock.mockResolvedValue(lockStatus)
  const treecrdtThoughtspace = createTreecrdtThoughtspace(() => ({ tabPolicy: 'single' }))

  await expect(treecrdtThoughtspace.acquireAccess()).resolves.toEqual(access)
  expect(mockAcquireTreecrdtSessionLock).toHaveBeenCalledWith()
})

it('does not require a session lock when multiple tabs are allowed', async () => {
  const config: TreecrdtRuntimeConfig = {
    client: { storage: 'memory', runtime: 'direct' },
    tabPolicy: 'multiple',
  }
  const treecrdtThoughtspace = createTreecrdtThoughtspace(() => config)

  await expect(treecrdtThoughtspace.acquireAccess()).resolves.toEqual({ status: 'acquired' })
  expect(mockAcquireTreecrdtSessionLock).not.toHaveBeenCalled()
})

it('rejects unsupported multiple-tab client settings at both async startup boundaries', async () => {
  // Pre-bootstrap configuration crosses a JavaScript boundary, so retain the runtime guard in addition to the type.
  // @ts-expect-error Persistent dedicated-worker storage is incompatible with multiple-tab access.
  const invalidConfig: TreecrdtRuntimeConfig = {
    client: { storage: 'persistent', runtime: 'dedicated-worker' },
    tabPolicy: 'multiple',
  }
  const treecrdtThoughtspace = createTreecrdtThoughtspace(() => invalidConfig)

  await expect(treecrdtThoughtspace.acquireAccess()).rejects.toThrow(
    'Multiple-tab TreeCRDT access requires in-memory storage with the direct runtime.',
  )
  const queuedWriteExpectation = expect(treecrdtThoughtspace.db.updateThoughts(emptyUpdates)).rejects.toThrow(
    'Multiple-tab TreeCRDT access requires in-memory storage with the direct runtime.',
  )
  await expect(treecrdtThoughtspace.init()).rejects.toThrow(
    'Multiple-tab TreeCRDT access requires in-memory storage with the direct runtime.',
  )
  await queuedWriteExpectation
  expect(mockAcquireTreecrdtSessionLock).not.toHaveBeenCalled()
  expect(mockCreateTreecrdtClient).not.toHaveBeenCalled()
})

it('maps em persistent storage to TreeCRDT OPFS client options', async () => {
  const stopAfterOptions = new Error('stop after capturing client options')
  mockCreateTreecrdtClient.mockRejectedValueOnce(stopAfterOptions)
  const config: TreecrdtRuntimeConfig = {
    client: {
      storage: 'persistent',
      runtime: 'dedicated-worker',
      docId: 'persistent-doc',
    },
    tabPolicy: 'single',
  }
  const treecrdtThoughtspace = createTreecrdtThoughtspace(() => config)

  await expect(treecrdtThoughtspace.init()).rejects.toBe(stopAfterOptions)
  expect(mockCreateTreecrdtClient).toHaveBeenCalledWith({
    storage: {
      type: 'opfs',
      filename: expect.any(String),
      fallback: 'throw',
    },
    runtime: { type: 'dedicated-worker' },
    docId: 'persistent-doc',
  })
})

it('snapshots configuration once without opening the client before init', async () => {
  const config = {
    client: { storage: 'memory' as const, runtime: 'direct' as const, docId: 'memory-doc' },
    tabPolicy: 'multiple' as const,
  }
  const resolveConfig = vi.fn(() => config)
  const treecrdtThoughtspace = createTreecrdtThoughtspace(resolveConfig)

  expect(resolveConfig).not.toHaveBeenCalled()
  expect(mockCreateTreecrdtClient).not.toHaveBeenCalled()
  await treecrdtThoughtspace.acquireAccess()
  expect(resolveConfig).toHaveBeenCalledTimes(1)
  expect(mockCreateTreecrdtClient).not.toHaveBeenCalled()

  config.client.docId = 'changed-doc'
  await treecrdtThoughtspace.init()
  expect(resolveConfig).toHaveBeenCalledTimes(1)
  expect(mockCreateTreecrdtClient).toHaveBeenCalledTimes(1)
  expect(mockCreateTreecrdtClient).toHaveBeenCalledWith({
    storage: { type: 'memory' },
    runtime: { type: 'direct' },
    docId: 'memory-doc',
  })

  await treecrdtThoughtspace.drop()
})

it('coalesces concurrent initialization into one client', async () => {
  const treecrdtThoughtspace = createMemoryThoughtspace()
  const firstInit = treecrdtThoughtspace.init()
  const secondInit = treecrdtThoughtspace.init()

  await expect(Promise.all([firstInit, secondInit])).resolves.toHaveLength(2)
  expect(mockCreateTreecrdtClient).toHaveBeenCalledTimes(1)

  await treecrdtThoughtspace.drop()
})

it('serializes an in-flight init, drop, and following init', async () => {
  let releaseClient!: () => void
  let markClientStarted!: () => void
  const clientStarted = new Promise<void>(resolve => {
    markClientStarted = resolve
  })
  const clientReleased = new Promise<void>(resolve => {
    releaseClient = resolve
  })
  mockCreateTreecrdtClient.mockImplementationOnce(async options => {
    markClientStarted()
    await clientReleased
    return createRealTreecrdtClient(options)
  })

  const treecrdtThoughtspace = createMemoryThoughtspace()
  const firstInit = treecrdtThoughtspace.init()
  await clientStarted
  const drop = treecrdtThoughtspace.drop()
  const secondInit = treecrdtThoughtspace.init()

  expect(mockCreateTreecrdtClient).toHaveBeenCalledTimes(1)

  releaseClient()
  await Promise.all([firstInit, drop, secondInit])

  expect(mockCreateTreecrdtClient).toHaveBeenCalledTimes(2)
  await expect(treecrdtThoughtspace.db.getThoughtById(EM_TOKEN)).resolves.toMatchObject({ id: EM_TOKEN })

  await treecrdtThoughtspace.drop()
})

it('rejects queued startup writes when initialization fails and uses a fresh gate on retry', async () => {
  const initError = new Error('client initialization failed')
  mockCreateTreecrdtClient.mockRejectedValueOnce(initError)

  const treecrdtThoughtspace = createMemoryThoughtspace()
  const queuedWrite = treecrdtThoughtspace.db.updateThoughts(emptyUpdates)
  const queuedWriteExpectation = expect(queuedWrite).rejects.toBe(initError)

  await expect(treecrdtThoughtspace.init()).rejects.toBe(initError)
  await queuedWriteExpectation

  await treecrdtThoughtspace.init()
  await expect(treecrdtThoughtspace.db.updateThoughts(emptyUpdates)).resolves.toEqual([])
  await treecrdtThoughtspace.drop()
})

it('rejects writes queued before each settled drop and creates a fresh gate for init', async () => {
  const treecrdtThoughtspace = createMemoryThoughtspace()

  const firstWrite = treecrdtThoughtspace.db.updateThoughts(emptyUpdates)
  const firstWriteExpectation = expect(firstWrite).rejects.toThrow(
    'TreeCRDT client binding cleared before initialization.',
  )
  await Promise.all([treecrdtThoughtspace.drop(), firstWriteExpectation])

  const secondWrite = treecrdtThoughtspace.db.updateThoughts(emptyUpdates)
  const secondWriteExpectation = expect(secondWrite).rejects.toThrow(
    'TreeCRDT client binding cleared before initialization.',
  )
  await Promise.all([treecrdtThoughtspace.drop(), secondWriteExpectation])

  await treecrdtThoughtspace.init()
  await expect(treecrdtThoughtspace.db.updateThoughts(emptyUpdates)).resolves.toEqual([])
  await treecrdtThoughtspace.drop()
})

it('discards a terminal client when drop reports an error', async () => {
  const client = await createRealTreecrdtClient({
    storage: { type: 'memory' },
    runtime: { type: 'direct' },
  })
  const dropError = new Error('client drop failed')
  const originalDrop = client.drop.bind(client)
  // Model wa-sqlite 0.4: drop may report an error after making the client terminal.
  vi.spyOn(client, 'drop').mockImplementationOnce(async () => {
    await originalDrop()
    throw dropError
  })
  const close = vi.spyOn(client, 'close')
  mockCreateTreecrdtClient.mockResolvedValueOnce(client)

  const treecrdtThoughtspace = createMemoryThoughtspace()
  await treecrdtThoughtspace.init()
  await expect(treecrdtThoughtspace.drop()).rejects.toBe(dropError)
  expect(() => treecrdtThoughtspace.db.getThoughtById('missing' as never)).toThrow(
    'TreeCRDT DataProvider: init not called',
  )
  expect(close).not.toHaveBeenCalled()

  await expect(treecrdtThoughtspace.init()).resolves.toEqual({ clientId: expect.any(String) })
  await treecrdtThoughtspace.drop()
})
