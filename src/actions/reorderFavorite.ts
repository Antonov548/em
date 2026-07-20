import _ from 'lodash'
import type Index from '../@types/IndexType'
import type State from '../@types/State'
import type Thought from '../@types/Thought'
import type ThoughtId from '../@types/ThoughtId'
import type Thunk from '../@types/Thunk'
import { FAVORITES_ORDER_TOKEN } from '../constants'
import { getChildrenRanked } from '../selectors/getChildren'
import { getFavoriteTargetIds } from '../selectors/getFavorites'
import getThoughtById from '../selectors/getThoughtById'
import { registerActionMetadata } from '../util/actionMetadata.registry'
import favoriteOrderEntryId from '../util/favoriteOrderEntryId'
import { ensureFavoriteOrderActionCreator as ensureFavoriteOrder } from './ensureFavoriteOrder'
import updateThoughts from './updateThoughts'

/** Moves one hidden Favorites-order entry and lets TreeCRDT resolve concurrent sequence edits. */
const reorderFavorite = (
  state: State,
  { targetId, afterTargetId }: { targetId: ThoughtId; afterTargetId: ThoughtId | null },
): State => {
  const entryId = favoriteOrderEntryId(targetId)
  const entry = getThoughtById(state, entryId)
  if (!entry) throw new Error(`Favorite order entry missing: ${entryId}`)

  const afterEntryId = afterTargetId ? favoriteOrderEntryId(afterTargetId) : null
  const siblings = getChildrenRanked(state, FAVORITES_ORDER_TOKEN).filter(child => child.id !== entryId)
  const afterIndex = afterEntryId ? siblings.findIndex(child => child.id === afterEntryId) : -1
  if (afterEntryId && afterIndex < 0) return state

  const previous = afterIndex >= 0 ? siblings[afterIndex] : undefined
  const next = siblings[afterIndex + 1]
  const rank = previous ? (next ? (previous.rank + next.rank) / 2 : previous.rank + 1) : next ? next.rank - 1 : 0

  const thoughtIndexUpdates: Index<Thought> = {
    [entryId]: {
      ...entry,
      rank,
    },
  }

  return updateThoughts(state, {
    thoughtIndexUpdates,
    lexemeIndexUpdates: {},
    movePlacements: { [entryId]: afterEntryId },
  })
}

/** Action-creator for moving a Favorite in its canonical TreeCRDT sequence. */
export const reorderFavoriteActionCreator =
  (payload: Parameters<typeof reorderFavorite>[1]): Thunk =>
  (dispatch, getState) => {
    dispatch(
      ensureFavoriteOrder({
        targetIds: _.uniq([...getFavoriteTargetIds(getState()), payload.targetId]),
      }),
    )
    return dispatch({ type: 'reorderFavorite', ...payload })
  }

export default _.curryRight(reorderFavorite)

registerActionMetadata('reorderFavorite', {
  undoable: true,
})
