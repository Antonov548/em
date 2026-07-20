import _ from 'lodash'
import type State from '../@types/State'
import type ThoughtId from '../@types/ThoughtId'
import type Thunk from '../@types/Thunk'
import { EM_TOKEN, FAVORITES_ORDER_TOKEN, FAVORITES_ORDER_VALUE } from '../constants'
import getNextRank from '../selectors/getNextRank'
import getPrevRank from '../selectors/getPrevRank'
import getThoughtById from '../selectors/getThoughtById'
import { registerActionMetadata } from '../util/actionMetadata.registry'
import favoriteOrderEntryId from '../util/favoriteOrderEntryId'
import createThought from './createThought'

interface Payload {
  targetIds?: ThoughtId[]
}

/** Lazily creates and validates the hidden common parent used for canonical Favorites ordering. */
export const ensureFavoriteOrderRoot = (state: State): State => {
  const root = getThoughtById(state, FAVORITES_ORDER_TOKEN)
  if (root) {
    if (root.parentId !== EM_TOKEN || root.value !== FAVORITES_ORDER_VALUE) {
      throw new Error(`Reserved Favorites order id collision: ${FAVORITES_ORDER_TOKEN}`)
    }
    return state
  }

  return createThought(state, {
    id: FAVORITES_ORDER_TOKEN,
    path: [EM_TOKEN],
    rank: getPrevRank(state, EM_TOKEN),
    value: FAVORITES_ORDER_VALUE,
  })
}

/** Lazily creates and validates the deterministic order entry for a favorited target. */
export const ensureFavoriteOrderEntry = (state: State, targetId: ThoughtId): State => {
  const stateWithRoot = ensureFavoriteOrderRoot(state)
  const entryId = favoriteOrderEntryId(targetId)
  const entry = getThoughtById(stateWithRoot, entryId)
  if (entry) {
    if (entry.parentId !== FAVORITES_ORDER_TOKEN || entry.value !== targetId) {
      throw new Error(`Reserved Favorite order entry id collision: ${entryId}`)
    }
    return stateWithRoot
  }

  return createThought(stateWithRoot, {
    id: entryId,
    path: [EM_TOKEN, FAVORITES_ORDER_TOKEN],
    rank: getNextRank(stateWithRoot, FAVORITES_ORDER_TOKEN),
    value: targetId,
  })
}

/** Ensures canonical Favorites-order nodes outside the undo history. */
const ensureFavoriteOrder = (state: State, { targetIds = [] }: Payload): State =>
  _.uniq(targetIds).reduce(ensureFavoriteOrderEntry, ensureFavoriteOrderRoot(state))

/** Action-creator for ensuring canonical Favorites-order nodes. */
export const ensureFavoriteOrderActionCreator =
  (payload: Payload = {}): Thunk =>
  dispatch =>
    dispatch({ type: 'ensureFavoriteOrder', ...payload })

export default _.curryRight(ensureFavoriteOrder)

registerActionMetadata('ensureFavoriteOrder', {
  undoable: false,
})
