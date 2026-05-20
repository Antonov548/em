import type Thought from '../../@types/Thought'
import type ThoughtId from '../../@types/ThoughtId'

export type TreecrdtPlacement = { type: 'first' } | { type: 'last' } | { type: 'after'; after: ThoughtId }

/** Returns true when a change needs a TreeCRDT payload op. */
export const hasTreecrdtPayloadChange = (existing: Thought, next: Thought): boolean =>
  existing.value !== next.value || existing.created !== next.created || existing.archived !== next.archived

/** Returns true when the requested placement differs from the current TreeCRDT sibling order. */
export const hasTreecrdtPlacementChange = (
  childIds: readonly string[],
  thoughtId: ThoughtId,
  placement: TreecrdtPlacement,
): boolean => {
  const currentIndex = childIds.indexOf(thoughtId)
  if (currentIndex < 0) return true

  if (placement.type === 'first') return currentIndex !== 0
  if (placement.type === 'last') return currentIndex !== childIds.length - 1

  return childIds[currentIndex - 1] !== placement.after
}
