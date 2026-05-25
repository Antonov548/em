import State from '../@types/State'
import ThoughtId from '../@types/ThoughtId'
import { compare, compareReasonable, compareReasonableDescending } from '../util/compareThought'
import { getAllChildrenSorted, isVisible } from './getChildren'
import getSortPreference from './getSortPreference'
import noteValue from './noteValue'
import thoughtToPath from './thoughtToPath'

/** Gets the index where a value would be inserted into the current sorted child order. */
const getSortedInsertIndex = (state: State, id: ThoughtId, value: string, created?: number): number => {
  const children = id ? getAllChildrenSorted(state, id) : []
  if (children.length === 0) return -1

  const sortPreference = getSortPreference(state, id)
  const isDescending = sortPreference.direction === 'Desc'

  // Handle Updated sorting
  if (sortPreference.type === 'Updated') {
    return -1
  }

  // Handle Created sorting (#3782)
  if (created && sortPreference.type === 'Created') {
    return children.findIndex(child =>
      isDescending ? compare(created, child.created) !== -1 : compare(child.created, created) !== -1,
    )
  }

  // Handle Note sorting
  if (sortPreference.type === 'Note') {
    const compareFn = isDescending ? compareReasonableDescending : compareReasonable
    // Only consider visible thoughts since attributes are always sorted to the beginning.
    // Otherwise this can result in incorrectly in the wrong place, inserting after =sort.
    const thoughtsVisible = children.filter(isVisible(state))
    return thoughtsVisible.findIndex(
      thought => compareFn(noteValue(state, thoughtToPath(state, thought.id)) ?? '', value) !== -1,
    )
  }

  // For alphabetical sorting
  return children.findIndex(child =>
    isDescending
      ? compareReasonableDescending(child.value, value) !== -1
      : compareReasonable(child.value, value) !== -1,
  )
}

/** Gets the sibling before a value inserted into the current sorted child order. */
export const getSortedAfterId = (state: State, id: ThoughtId, value: string, created?: number): ThoughtId | null => {
  const children = id ? getAllChildrenSorted(state, id) : []
  const sortPreference = getSortPreference(state, id)
  const index = getSortedInsertIndex(state, id, value, created)
  const sortedChildren = sortPreference.type === 'Note' ? children.filter(isVisible(state)) : children

  if (index === 0) return null
  return sortedChildren[index === -1 ? sortedChildren.length - 1 : index - 1]?.id ?? null
}

/** Calculates the rank for a given index in a sorted array of thoughts. */
const calculateRank = (thoughts: { rank: number }[], index: number): number => {
  // if there is no such child, return the rank of the last child + 1
  if (index === -1) {
    return (thoughts[thoughts.length - 1]?.rank || 0) + 1
  }
  // if the value is less than all children, return the rank of the first child - 1
  if (index === 0) {
    return thoughts[0].rank - 1
  }
  // otherwise, return the rank at the halfway point between the previous child and the next child
  return (thoughts[index - 1].rank + thoughts[index].rank) / 2
}

/** Gets the new rank of a value to be inserted into a sorted context.
 * If the sort preference is Created, then the created timestamp is the sort criteria instead.
 * This is currently optional to reflect the fact that most call sites do not need to call this function for newly-created thoughts.
 * Instead, they can assume that a newly-created thought goes at the end of the list if sort preference is Created (#3782).
 */
const getSortedRank = (state: State, id: ThoughtId, value: string, created?: number) => {
  const children = id ? getAllChildrenSorted(state, id) : []

  if (children.length === 0) return 0

  const sortPreference = getSortPreference(state, id)
  const thoughts = children.filter(thought => !state.cursor || thought.id !== state.cursor[state.cursor.length - 1])
  const index = getSortedInsertIndex(state, id, value, created)

  // Handle Updated sorting
  if (sortPreference.type === 'Updated') {
    const isDescending = sortPreference.direction === 'Desc'
    return isDescending ? thoughts[0].rank - 1 : (thoughts[thoughts.length - 1]?.rank || 0) + 1
  }

  // Handle Note sorting
  if (sortPreference.type === 'Note') {
    // Only consider visible thoughts since attributes are always sorted to the beginning.
    // Otherwise this can result in incorrectly in the wrong place, inserting after =sort.
    const thoughtsVisible = children.filter(isVisible(state))
    return calculateRank(thoughtsVisible, index)
  }

  return calculateRank(children, index)
}

export default getSortedRank
