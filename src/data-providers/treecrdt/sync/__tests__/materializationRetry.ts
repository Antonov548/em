import type { MaterializationEvent } from '@treecrdt/interface/engine'
import type Thought from '../../../../@types/Thought'
import type ThoughtId from '../../../../@types/ThoughtId'
import type Timestamp from '../../../../@types/Timestamp'
import type { ThoughtspaceMaterializationApplyResult, ThoughtspaceMaterializationBridge } from '../../../thoughtspace'
import { beginTreecrdtPersistenceIntent } from '../../writeBarrier'
import { enqueueMaterializedThoughtsToStore } from '../applyMaterializedThoughtsToStore'

const mocks = vi.hoisted(() => ({
  refreshAttributeChildrenFromChanges: vi.fn(async () => undefined),
  refreshThoughtsFromMaterializationChanges: vi.fn(),
  updateThoughts: vi.fn(async () => undefined),
}))

vi.mock('../../attributeChildren', () => ({
  refreshAttributeChildrenFromChanges: mocks.refreshAttributeChildrenFromChanges,
}))
vi.mock('../../thoughtspace', () => ({ default: { updateThoughts: mocks.updateThoughts } }))
vi.mock('../../treecrdt', () => ({ getTreecrdtClient: () => ({}) }))
vi.mock('../materializationThoughtUpdates', () => ({
  refreshThoughtsFromMaterializationChanges: mocks.refreshThoughtsFromMaterializationChanges,
}))

const thought: Thought = {
  id: 'thought' as ThoughtId,
  parentId: 'parent' as ThoughtId,
  value: 'value',
  rank: 0,
  childrenMap: {},
  created: 0 as Timestamp,
  lastUpdated: 0 as Timestamp,
  updatedBy: '',
}

const event: MaterializationEvent = {
  headSeq: 1,
  changes: [{ kind: 'payload', node: thought.id, payload: null }],
}

/** Creates a minimal bridge with a configurable atomic apply result. */
const bridge = (): ThoughtspaceMaterializationBridge => ({
  getSnapshot: () => ({ schemaVersion: 0, thoughtIndex: {}, lexemeIndex: {} }),
  apply: vi.fn((): ThoughtspaceMaterializationApplyResult => 'applied'),
})

beforeEach(() => {
  mocks.refreshAttributeChildrenFromChanges.mockClear()
  mocks.updateThoughts.mockClear()
  mocks.refreshThoughtsFromMaterializationChanges.mockReset()
  mocks.refreshThoughtsFromMaterializationChanges.mockResolvedValue({
    deletedIds: [],
    thoughts: [thought],
    lexemeIndexUpdates: {},
  })
})

it('waits for a pending local persistence intent before reading provider state', async () => {
  const finishPersistence = beginTreecrdtPersistenceIntent()
  const materialization = bridge()
  const pending = enqueueMaterializedThoughtsToStore(event, materialization)

  await Promise.resolve()
  expect(mocks.refreshThoughtsFromMaterializationChanges).not.toHaveBeenCalled()

  finishPersistence()
  await pending

  expect(mocks.refreshThoughtsFromMaterializationChanges).toHaveBeenCalledTimes(1)
  expect(materialization.apply).toHaveBeenCalledTimes(1)
})

it('rereads final provider state after an atomic Redux snapshot conflict', async () => {
  const materialization = bridge()
  vi.mocked(materialization.apply).mockReturnValueOnce('conflict').mockReturnValue('applied')

  await enqueueMaterializedThoughtsToStore(event, materialization)

  expect(mocks.refreshThoughtsFromMaterializationChanges).toHaveBeenCalledTimes(2)
  expect(materialization.apply).toHaveBeenCalledTimes(2)
})

it('retries when local persistence starts during the provider read', async () => {
  const materialization = bridge()
  mocks.refreshThoughtsFromMaterializationChanges.mockImplementationOnce(async () => {
    const finishPersistence = beginTreecrdtPersistenceIntent()
    setTimeout(finishPersistence, 0)
    return { deletedIds: [], thoughts: [thought], lexemeIndexUpdates: {} }
  })

  await enqueueMaterializedThoughtsToStore(event, materialization)

  expect(mocks.refreshThoughtsFromMaterializationChanges).toHaveBeenCalledTimes(2)
  expect(materialization.apply).toHaveBeenCalledTimes(1)
})

it('retains a failed event for the next materialization callback', async () => {
  const firstBridge = bridge()
  mocks.refreshThoughtsFromMaterializationChanges.mockRejectedValueOnce(new Error('transient read failure'))

  await expect(enqueueMaterializedThoughtsToStore(event, firstBridge)).rejects.toThrow('transient read failure')

  const secondBridge = bridge()
  await enqueueMaterializedThoughtsToStore({ ...event, headSeq: 2 }, secondBridge)

  expect(mocks.refreshThoughtsFromMaterializationChanges).toHaveBeenCalledTimes(2)
  expect(secondBridge.apply).toHaveBeenCalledTimes(1)
})
