import _ from 'lodash'
import type Path from '../@types/Path'
import type State from '../@types/State'
import type Thunk from '../@types/Thunk'
import { FAVORITES_ORDER_TOKEN } from '../constants'
import findDescendant from '../selectors/findDescendant'
import { getChildrenRanked } from '../selectors/getChildren'
import getNextRank from '../selectors/getNextRank'
import getThoughtById from '../selectors/getThoughtById'
import { registerActionMetadata } from '../util/actionMetadata.registry'
import favoriteOrderEntryId from '../util/favoriteOrderEntryId'
import head from '../util/head'
import { ensureFavoriteOrderActionCreator as ensureFavoriteOrder } from './ensureFavoriteOrder'
import toggleAttribute from './toggleAttribute'
import updateThoughts from './updateThoughts'

/** Adds or removes a Favorite marker and its canonical ordering entry as one undoable action. */
const toggleFavorite = (state: State, { path }: { path: Path }): State => {
  const targetId = head(path)
  const markerId = findDescendant(state, targetId, '=favorite')

  if (!markerId) {
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

  // Keep inactive order entries as stable CRDT identities. The selector intersects them with live markers.
  return toggleAttribute(state, { path, values: ['=favorite', 'true'] })
}

/** Action-creator for toggling a Favorite and its canonical order entry. */
export const toggleFavoriteActionCreator =
  (payload: Parameters<typeof toggleFavorite>[1]): Thunk =>
  dispatch => {
    dispatch(ensureFavoriteOrder({ targetIds: [head(payload.path)] }))
    return dispatch({ type: 'toggleFavorite', ...payload })
  }

export default _.curryRight(toggleFavorite)

registerActionMetadata('toggleFavorite', {
  undoable: true,
})
