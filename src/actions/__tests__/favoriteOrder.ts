import type Path from '../../@types/Path'
import type ThoughtId from '../../@types/ThoughtId'
import createThought from '../../actions/createThought'
import { ensureFavoriteOrderActionCreator as ensureFavoriteOrder } from '../../actions/ensureFavoriteOrder'
import { importTextActionCreator as importText } from '../../actions/importText'
import reorderFavorite, { reorderFavoriteActionCreator } from '../../actions/reorderFavorite'
import toggleFavoriteReducer, { toggleFavoriteActionCreator as toggleFavorite } from '../../actions/toggleFavorite'
import { undoActionCreator as undo } from '../../actions/undo'
import { FAVORITES_ORDER_TOKEN } from '../../constants'
import { thoughtspaceRuntime } from '../../data-providers/thoughtspace'
import contextToPath from '../../selectors/contextToPath'
import { getChildrenRanked } from '../../selectors/getChildren'
import { getFavoriteTargetIds } from '../../selectors/getFavorites'
import getThoughtById from '../../selectors/getThoughtById'
import store from '../../stores/app'
import contextToThought from '../../test-helpers/contextToThought'
import initStore from '../../test-helpers/initStore'
import favoriteOrderEntryId from '../../util/favoriteOrderEntryId'

beforeEach(initStore)

/** Returns the path and id of a root thought by value. */
const getTarget = (value: string): { id: ThoughtId; path: Path } => {
  const state = store.getState()
  const thought = contextToThought(state, [value])!
  const path = contextToPath(state, [value])!
  return { id: thought.id, path }
}

/** Imports root thoughts used by a Favorites-order test. */
const importTargets = (...values: string[]) => {
  store.dispatch(
    importText({
      text: values.map(value => `- ${value}`).join('\n'),
    }),
  )
  return values.map(getTarget)
}

it('keeps a stable entry id and moves a re-added Favorite to the end', () => {
  const [a, b] = importTargets('A', 'B')
  const entryA = favoriteOrderEntryId(a.id)
  const entryB = favoriteOrderEntryId(b.id)

  store.dispatch(toggleFavorite({ path: a.path }))
  store.dispatch(toggleFavorite({ path: b.path }))

  expect(getFavoriteTargetIds(store.getState())).toEqual([a.id, b.id])
  expect(getChildrenRanked(store.getState(), FAVORITES_ORDER_TOKEN).map(entry => entry.id)).toEqual([entryA, entryB])

  store.dispatch(toggleFavorite({ path: a.path }))

  // The inactive entry is retained, but is filtered out because A no longer has a live marker.
  expect(getThoughtById(store.getState(), entryA)?.value).toBe(a.id)
  expect(getFavoriteTargetIds(store.getState())).toEqual([b.id])

  store.dispatch(toggleFavorite({ path: a.path }))

  expect(getFavoriteTargetIds(store.getState())).toEqual([b.id, a.id])
  expect(getChildrenRanked(store.getState(), FAVORITES_ORDER_TOKEN).map(entry => entry.id)).toEqual([entryB, entryA])
  expect(getThoughtById(store.getState(), entryA)?.value).toBe(a.id)
})

it('removes every duplicate marker created by concurrent Favorite additions', () => {
  const [a] = importTargets('A')
  store.dispatch(toggleFavorite({ path: a.path }))

  const duplicateMarkerId = '00000000000000000000000000000fa1' as ThoughtId
  const duplicateValueId = '00000000000000000000000000000fa2' as ThoughtId
  const stateWithDuplicateMarker = createThought({
    id: duplicateMarkerId,
    path: a.path,
    rank: 1,
    value: '=favorite',
  })(store.getState())
  const stateWithDuplicateValue = createThought({
    id: duplicateValueId,
    path: [...a.path, duplicateMarkerId] as Path,
    rank: 0,
    value: 'true',
  })(stateWithDuplicateMarker)

  expect(getChildrenRanked(stateWithDuplicateValue, a.id).filter(child => child.value === '=favorite')).toHaveLength(2)
  expect(getFavoriteTargetIds(stateWithDuplicateValue)).toEqual([a.id])

  const removed = toggleFavoriteReducer({ path: a.path })(stateWithDuplicateValue)

  expect(getChildrenRanked(removed, a.id).filter(child => child.value === '=favorite')).toEqual([])
  expect(getFavoriteTargetIds(removed)).toEqual([])
})

it('preserves non-undoable order infrastructure added after the action being undone', () => {
  const [a, b] = importTargets('A', 'B')
  const entryA = favoriteOrderEntryId(a.id)
  const entryB = favoriteOrderEntryId(b.id)

  store.dispatch(toggleFavorite({ path: a.path }))
  store.dispatch(ensureFavoriteOrder({ targetIds: [b.id] }))

  expect(getThoughtById(store.getState(), FAVORITES_ORDER_TOKEN)).toBeDefined()
  expect(getThoughtById(store.getState(), entryB)).toBeDefined()

  store.dispatch(undo())

  expect(getFavoriteTargetIds(store.getState())).toEqual([])
  expect(getThoughtById(store.getState(), FAVORITES_ORDER_TOKEN)).toBeDefined()
  expect(getThoughtById(store.getState(), entryA)).toBeDefined()
  expect(getThoughtById(store.getState(), entryB)).toBeDefined()
})

it('undoes a reorder and persists explicit TreeCRDT placements in both directions', () => {
  const [a, b, c] = importTargets('A', 'B', 'C')
  const entryA = favoriteOrderEntryId(a.id)
  const entryB = favoriteOrderEntryId(b.id)
  const entryC = favoriteOrderEntryId(c.id)

  store.dispatch(toggleFavorite({ path: a.path }))
  store.dispatch(toggleFavorite({ path: b.path }))
  store.dispatch(toggleFavorite({ path: c.path }))

  const reorderedState = reorderFavorite({ targetId: c.id, afterTargetId: null })(store.getState())
  expect(reorderedState.pushQueue.at(-1)?.movePlacements).toMatchObject({ [entryC]: null })

  const persistSpy = vi.spyOn(thoughtspaceRuntime, 'persistPushQueueBatches').mockResolvedValue(undefined)
  try {
    store.dispatch(reorderFavoriteActionCreator({ targetId: c.id, afterTargetId: null }))

    expect(getFavoriteTargetIds(store.getState())).toEqual([c.id, a.id, b.id])
    expect(persistSpy.mock.calls.flatMap(([batches]) => batches).at(-1)?.movePlacements).toMatchObject({
      [entryC]: null,
    })

    persistSpy.mockClear()
    store.dispatch(undo())

    expect(getFavoriteTargetIds(store.getState())).toEqual([a.id, b.id, c.id])
    expect(persistSpy.mock.calls.flatMap(([batches]) => batches).at(-1)?.movePlacements).toMatchObject({
      [entryA]: null,
      [entryB]: entryA,
      [entryC]: entryB,
    })
  } finally {
    persistSpy.mockRestore()
  }
})

it('falls back to live imported markers before order entries are materialized', () => {
  store.dispatch(
    importText({
      text: `
        - A
          - =favorite
        - B
          - =favorite
      `,
    }),
  )

  const a = getTarget('A')
  const b = getTarget('B')

  expect(getThoughtById(store.getState(), FAVORITES_ORDER_TOKEN)).toBeUndefined()
  expect(getFavoriteTargetIds(store.getState())).toEqual([a.id, b.id])
})

it('appends a new Favorite after imported markers without existing order entries', () => {
  store.dispatch(
    importText({
      text: `
        - A
          - =favorite
        - B
          - =favorite
        - C
      `,
    }),
  )

  const a = getTarget('A')
  const b = getTarget('B')
  const c = getTarget('C')
  store.dispatch(toggleFavorite({ path: c.path }))

  expect(getFavoriteTargetIds(store.getState())).toEqual([a.id, b.id, c.id])
})
