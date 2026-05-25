import Index from '../@types/IndexType'
import State from '../@types/State'
import Thought from '../@types/Thought'
import ThoughtId from '../@types/ThoughtId'

/** Returns child ids from a thought's childrenMap without applying a rank-based ordering. */
const getChildrenMapChildIds = (thoughtIndex: Index<Thought>, parentId: ThoughtId): ThoughtId[] => {
  const parent = thoughtIndex[parentId]
  if (!parent) return []

  return Object.values(parent.childrenMap || {})
    .map(childId => thoughtIndex[childId])
    .filter((thought): thought is Thought => !!thought && thought.parentId === parentId)
    .map(thought => thought.id)
}

/** Filters stale ids from a child order projection and appends any missing children in childrenMap order. */
export const normalizeChildOrder = (
  thoughtIndex: Index<Thought>,
  parentId: ThoughtId,
  childOrder?: ThoughtId[],
): ThoughtId[] => {
  const parent = thoughtIndex[parentId]
  if (!parent) return []

  const childIds = new Set(Object.values(parent.childrenMap || {}))
  const seen = new Set<ThoughtId>()
  const ordered = (childOrder || []).filter(childId => {
    const valid = childIds.has(childId) && thoughtIndex[childId]?.parentId === parentId && !seen.has(childId)
    if (valid) seen.add(childId)
    return valid
  })

  const missing = getChildrenMapChildIds(thoughtIndex, parentId).filter(childId => !seen.has(childId))
  return [...ordered, ...missing]
}

/** Returns the manual child order, falling back to childrenMap order if no explicit order exists yet. */
export const getManualChildOrder = (state: State, parentId: ThoughtId): ThoughtId[] => {
  const childOrder = state.thoughts.childOrder?.[parentId]
  return childOrder
    ? normalizeChildOrder(state.thoughts.thoughtIndex, parentId, childOrder)
    : getChildrenMapChildIds(state.thoughts.thoughtIndex, parentId)
}

/** Applies a TreeCRDT-style placement to an ordered child id array. */
export const applyTreePlacement = (
  childOrder: ThoughtId[],
  thoughtId: ThoughtId,
  afterId: ThoughtId | null,
): ThoughtId[] => {
  const withoutThought = childOrder.filter(childId => childId !== thoughtId)
  if (afterId === null) return [thoughtId, ...withoutThought]

  const afterIndex = withoutThought.indexOf(afterId)
  if (afterIndex === -1) return [...withoutThought, thoughtId]

  return [...withoutThought.slice(0, afterIndex + 1), thoughtId, ...withoutThought.slice(afterIndex + 1)]
}

/** Converts an ordered child id list to per-child TreeCRDT after placements. */
export const childOrderToTreePlacements = (childOrder: ThoughtId[]): Index<ThoughtId | null> =>
  childOrder.reduce<Index<ThoughtId | null>>((acc, childId, i) => {
    acc[childId] = i === 0 ? null : childOrder[i - 1]
    return acc
  }, {})

/** Derives the next child order projection from Redux updates and explicit TreeCRDT placements. */
export const updateChildOrder = ({
  childOrderUpdates,
  state,
  thoughtIndex,
  thoughtIndexUpdates,
  treePlacements,
}: {
  childOrderUpdates?: Index<ThoughtId[]>
  state: State
  thoughtIndex: Index<Thought>
  thoughtIndexUpdates: Index<Thought | null>
  treePlacements?: Index<ThoughtId | null>
}): Index<ThoughtId[]> => {
  const childOrder: Index<ThoughtId[]> = { ...(state.thoughts.childOrder || {}) }
  const affectedParents = new Set<ThoughtId>()

  Object.entries(childOrderUpdates || {}).forEach(([parentId, order]) => {
    childOrder[parentId] = normalizeChildOrder(thoughtIndex, parentId as ThoughtId, order)
    affectedParents.add(parentId as ThoughtId)
  })

  Object.entries(thoughtIndexUpdates).forEach(([id, thought]) => {
    const previous = state.thoughts.thoughtIndex[id]
    if (previous) affectedParents.add(previous.parentId)
    if (thought) {
      affectedParents.add(thought.parentId)
      affectedParents.add(thought.id)
    }
  })

  Object.entries(treePlacements || {}).forEach(([id, afterId]) => {
    const thoughtId = id as ThoughtId
    const thought = thoughtIndex[thoughtId]
    if (!thought) return

    const parentId = thought.parentId
    const baseOrder = normalizeChildOrder(thoughtIndex, parentId, childOrder[parentId])
    childOrder[parentId] = applyTreePlacement(baseOrder, thoughtId, afterId)
    affectedParents.add(parentId)
  })

  for (const parentId of affectedParents) {
    if (childOrder[parentId]) {
      childOrder[parentId] = normalizeChildOrder(thoughtIndex, parentId, childOrder[parentId])
    }
  }

  return childOrder
}

export default getManualChildOrder
