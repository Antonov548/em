import _ from 'lodash'
import type Path from '../@types/Path'
import type State from '../@types/State'
import type Thunk from '../@types/Thunk'
import { FAVORITES_ORDER_TOKEN } from '../constants'
import { getChildrenRanked } from '../selectors/getChildren'
import { getFavoriteTargetIds } from '../selectors/getFavorites'
import getNextRank from '../selectors/getNextRank'
import getThoughtById from '../selectors/getThoughtById'
import { registerActionMetadata } from '../util/actionMetadata.registry'
import favoriteOrderEntryId from '../util/favoriteOrderEntryId'
import head from '../util/head'
import deleteThought from './deleteThought'
import { ensureFavoriteOrderActionCreator as ensureFavoriteOrder } from './ensureFavoriteOrder'
import toggleAttribute from './toggleAttribute'
import updateThoughts from './updateThoughts'

/** Adds or removes a Favorite marker and its canonical ordering entry as one undoable action. */
const toggleFavorite = (state: State, { path }: { path: Path }): State => {
  const targetId = head(path)
  const markers = getChildrenRanked(state, targetId).filter(child => child.value === '=favorite')

  if (markers.length === 0) {
    const entryId = favoriteOrderEntryId(targetId)
    const entry = getThoughtById(state, entryId)
    if (!entry) throw new Error(`Favorite order entry missing: ${entryId}`)

    const siblings = getChildrenRanked(state, FAVORITES_ORDER_TOKEN)
    const stateWithEntryAtEnd =
      siblings.at(-1)?.id === entryId
        ? state
        : updateThoughts(state, {
            thoughtIndexUpdates: {
              [entryId]: {
                ...entry,
                rank: getNextRank(state, FAVORITES_ORDER_TOKEN),
              },
            },
            lexemeIndexUpdates: {},
            movePlacements: {
              [entryId]: siblings.filter(sibling => sibling.id !== entryId).at(-1)?.id ?? null,
            },
          })

    return toggleAttribute(stateWithEntryAtEnd, { path, values: ['=favorite', 'true'] })
  }

  // Concurrent tabs can independently create duplicate marker subtrees. Remove every live marker so one
  // unfavorite operation has set semantics. Keep the inactive order entry as a stable CRDT identity.
  return markers.reduce(
    (stateNew, marker) => deleteThought(stateNew, { pathParent: path, thoughtId: marker.id }),
    state,
  )
}

/** Action-creator for toggling a Favorite and its canonical order entry. */
export const toggleFavoriteActionCreator =
  (payload: Parameters<typeof toggleFavorite>[1]): Thunk =>
  (dispatch, getState) => {
    const targetId = head(payload.path)
    dispatch(ensureFavoriteOrder({ targetIds: _.uniq([...getFavoriteTargetIds(getState()), targetId]) }))
    return dispatch({ type: 'toggleFavorite', ...payload })
  }

export default _.curryRight(toggleFavorite)

registerActionMetadata('toggleFavorite', {
  undoable: true,
})
