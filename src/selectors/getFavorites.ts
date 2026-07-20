import type State from '../@types/State'
import type ThoughtId from '../@types/ThoughtId'
import { FAVORITES_ORDER_TOKEN } from '../constants'
import { getChildrenRanked } from './getChildren'
import { getLexeme } from './getLexeme'
import getThoughtById from './getThoughtById'

/** Returns Favorite marker ids in canonical TreeCRDT order. */
export const getFavoriteContextIds = (state: State): ThoughtId[] => {
  const contextIds = getLexeme(state, '=favorite')?.contexts || []
  const contextByTargetId = new Map<ThoughtId, ThoughtId>()

  for (const contextId of contextIds) {
    const marker = getThoughtById(state, contextId)
    if (!marker || !getThoughtById(state, marker.parentId) || contextByTargetId.has(marker.parentId)) continue
    contextByTargetId.set(marker.parentId, contextId)
  }

  const ordered: ThoughtId[] = []
  const seenTargets = new Set<ThoughtId>()
  for (const entry of getChildrenRanked(state, FAVORITES_ORDER_TOKEN)) {
    const targetId = entry.value as ThoughtId
    const contextId = contextByTargetId.get(targetId)
    if (!contextId || seenTargets.has(targetId)) continue
    ordered.push(contextId)
    seenTargets.add(targetId)
  }

  // Imported or partially materialized Favorites remain visible until their canonical entry arrives.
  for (const [targetId, contextId] of contextByTargetId) {
    if (!seenTargets.has(targetId)) ordered.push(contextId)
  }

  return ordered
}

/** Returns favorited target thought ids in canonical order. */
export const getFavoriteTargetIds = (state: State): ThoughtId[] =>
  getFavoriteContextIds(state).flatMap(contextId => {
    const marker = getThoughtById(state, contextId)
    return marker ? [marker.parentId] : []
  })

export default getFavoriteContextIds
