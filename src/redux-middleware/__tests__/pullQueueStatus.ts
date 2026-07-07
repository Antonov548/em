import { UnknownAction } from 'redux'
import Dispatch from '../../@types/Dispatch'
import Path from '../../@types/Path'
import State from '../../@types/State'
import Thought from '../../@types/Thought'
import ThoughtId from '../../@types/ThoughtId'
import Thunk from '../../@types/Thunk'
import Timestamp from '../../@types/Timestamp'
import { HOME_TOKEN, ROOT_PARENT_ID } from '../../constants'
import pullQueueMiddleware from '../../redux-middleware/pullQueue'
import syncStatusStore from '../../stores/syncStatus'

const pullMock = vi.hoisted(() => {
  const resolvers: (() => void)[] = []
  const pullActionCreator = vi.fn(
    () => async (): Promise<Thought[]> =>
      new Promise<Thought[]>(resolve => {
        resolvers.push(() => resolve([]))
      }),
  )

  return { pullActionCreator, resolvers }
})

vi.mock('../../actions/pull', () => ({
  pullActionCreator: pullMock.pullActionCreator,
}))

vi.mock('../../actions/pullAncestors', () => ({
  pullAncestorsActionCreator: vi.fn(() => async () => []),
}))

vi.mock('../../data-providers/thoughtspace', () => ({
  default: {
    getLexemeById: vi.fn(async () => undefined),
  },
}))

vi.mock('../../selectors/getChildren', () => ({
  getChildren: vi.fn(() => []),
}))

vi.mock('../../selectors/getContexts', () => ({
  default: vi.fn(() => []),
}))

vi.mock('../../selectors/getThoughtById', () => ({
  default: vi.fn((_state: State, id: ThoughtId): Thought => {
    const now = 0 as Timestamp
    return {
      id,
      value: id,
      rank: 0,
      parentId: ROOT_PARENT_ID,
      childrenMap: {},
      created: now,
      lastUpdated: now,
      updatedBy: '',
      pending: true,
    }
  }),
}))

vi.mock('../../selectors/isContextViewActive', () => ({
  default: vi.fn(() => false),
}))

vi.mock('../../selectors/thoughtToPath', () => ({
  default: vi.fn(() => []),
}))

type PullQueueMiddlewareApi = Parameters<typeof pullQueueMiddleware>[0]

/** Minimal state needed by pullQueueMiddleware. */
const stateWithCursor = (thoughtId: ThoughtId): State =>
  ({
    cursor: [HOME_TOKEN, thoughtId] as Path,
    cursorInitialized: true,
    expanded: {},
  }) as State

/** Flushes the debounced pull queue update. */
const flushPullQueueDebounce = async () => {
  await vi.advanceTimersByTimeAsync(10)
  await Promise.resolve()
}

/** Lets async middleware continuations run after a mocked pull resolves. */
const settlePull = async () => {
  await Promise.resolve()
  await Promise.resolve()
}

beforeEach(() => {
  vi.useFakeTimers()
  pullMock.pullActionCreator.mockClear()
  pullMock.resolvers.length = 0
  syncStatusStore.update({ isPulling: false })
})

afterEach(() => {
  vi.useRealTimers()
  syncStatusStore.update({ isPulling: false })
})

it('keeps isPulling true until overlapping pulls have all finished', async () => {
  let state = stateWithCursor('a' as ThoughtId)

  /** Reads the mutable test state used by the middleware. */
  const getState = () => state

  const dispatch = ((actionOrActions: UnknownAction | Thunk | (UnknownAction | Thunk | null)[] | null) => {
    if (Array.isArray(actionOrActions)) {
      return actionOrActions.map(action => (action ? dispatch(action) : undefined))
    }

    return typeof actionOrActions === 'function' ? actionOrActions(dispatch, getState) : undefined
  }) as Dispatch & PullQueueMiddlewareApi['dispatch']

  const next = vi.fn()
  const dispatchThroughPullQueue = pullQueueMiddleware({ getState, dispatch })(next)

  dispatchThroughPullQueue({ type: 'first action' })
  await flushPullQueueDebounce()

  expect(pullMock.pullActionCreator).toHaveBeenCalledTimes(1)
  expect(syncStatusStore.getState().isPulling).toBe(true)

  state = stateWithCursor('b' as ThoughtId)
  dispatchThroughPullQueue({ type: 'second action' })
  await flushPullQueueDebounce()

  expect(pullMock.pullActionCreator).toHaveBeenCalledTimes(2)
  expect(syncStatusStore.getState().isPulling).toBe(true)

  pullMock.resolvers[0]()
  await settlePull()

  expect(syncStatusStore.getState().isPulling).toBe(true)

  pullMock.resolvers[1]()
  await settlePull()

  expect(syncStatusStore.getState().isPulling).toBe(false)
})
