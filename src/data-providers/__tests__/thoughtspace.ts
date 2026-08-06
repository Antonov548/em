import type { PreloadedEmWindow } from '../../@types'
import type { DataProvider } from '../DataProvider'
import type { TreecrdtRuntimeConfig } from '../treecrdt/runtime'

const mocks = vi.hoisted(() => {
  const thoughtspace = {
    db: {} as DataProvider,
    acquireAccess: vi.fn().mockResolvedValue({ status: 'acquired' }),
    init: vi.fn().mockResolvedValue({ clientId: 'test-client' }),
    drop: vi.fn().mockResolvedValue(undefined),
    waitForIdle: vi.fn().mockResolvedValue(undefined),
    persistPushQueueBatches: vi.fn().mockResolvedValue(undefined),
  }

  return { createTreecrdtThoughtspace: vi.fn((_: () => unknown) => thoughtspace), thoughtspace }
})

vi.mock('../treecrdt/runtime', () => ({ default: mocks.createTreecrdtThoughtspace }))

const initialEm = window.em

beforeEach(() => {
  Reflect.deleteProperty(window, 'em')
  vi.resetModules()
  vi.clearAllMocks()
})

afterEach(() => {
  window.em = initialEm
  vi.resetModules()
})

it('supplies persistent single-tab configuration when no preload exists', async () => {
  const { thoughtspaceRuntime } = await import('../thoughtspace')

  expect(thoughtspaceRuntime).toBe(mocks.thoughtspace)
  const resolveConfig = mocks.createTreecrdtThoughtspace.mock.calls[0][0]

  expect(resolveConfig).toEqual(expect.any(Function))
  expect(resolveConfig()).toEqual({ tabPolicy: 'single' })
})

it('defers reading injected TreeCRDT configuration until the runtime resolves it', async () => {
  const treecrdt: TreecrdtRuntimeConfig = {
    client: {
      storage: 'memory',
      runtime: 'direct',
      docId: 'test-doc',
    },
    tabPolicy: 'multiple',
  }
  const getTreecrdt = vi.fn(() => treecrdt)
  const preloadedWindow = window as unknown as PreloadedEmWindow
  const preloadedEm = {} as NonNullable<PreloadedEmWindow['em']>
  Object.defineProperty(preloadedEm, 'treecrdt', { get: getTreecrdt })
  preloadedWindow.em = preloadedEm
  await import('../thoughtspace')

  expect(getTreecrdt).not.toHaveBeenCalled()
  const resolveConfig = mocks.createTreecrdtThoughtspace.mock.calls[0][0]

  expect(resolveConfig()).toBe(treecrdt)
  expect(getTreecrdt).toHaveBeenCalledTimes(1)
})
