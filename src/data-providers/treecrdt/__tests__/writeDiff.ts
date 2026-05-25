import type Thought from '../../../@types/Thought'
import type ThoughtId from '../../../@types/ThoughtId'
import type Timestamp from '../../../@types/Timestamp'
import { hasTreecrdtPayloadChange, hasTreecrdtPlacementChange } from '../writeDiff'

const A_ID = 'a-id' as ThoughtId
const B_ID = 'b-id' as ThoughtId
const C_ID = 'c-id' as ThoughtId
const PARENT_ID = 'parent-id' as ThoughtId

/** Creates a minimal thought for write-diff tests. */
const thought = (overrides: Partial<Thought> = {}): Thought => ({
  id: A_ID,
  value: 'a',
  rank: 0,
  parentId: PARENT_ID,
  childrenMap: {},
  created: 1 as Timestamp,
  lastUpdated: 2 as Timestamp,
  updatedBy: 'client-a',
  ...overrides,
})

describe('hasTreecrdtPayloadChange', () => {
  it('ignores rank, parent, children, and metadata-only updates', () => {
    const existing = thought()

    expect(
      hasTreecrdtPayloadChange(
        existing,
        thought({
          rank: 1,
          parentId: 'other-parent-id' as ThoughtId,
          childrenMap: { [B_ID]: B_ID },
          lastUpdated: 3 as Timestamp,
          updatedBy: 'client-b',
        }),
      ),
    ).toBe(false)
  })

  it('detects persisted payload changes', () => {
    const existing = thought()

    expect(hasTreecrdtPayloadChange(existing, thought({ value: 'b' }))).toBe(true)
    expect(hasTreecrdtPayloadChange(existing, thought({ created: 3 as Timestamp }))).toBe(true)
    expect(hasTreecrdtPayloadChange(existing, thought({ archived: 3 as Timestamp }))).toBe(true)
  })
})

describe('hasTreecrdtPlacementChange', () => {
  it('ignores placements that already match the current sibling order', () => {
    const childIds = [A_ID, B_ID, C_ID]

    expect(hasTreecrdtPlacementChange(childIds, A_ID, { type: 'first' })).toBe(false)
    expect(hasTreecrdtPlacementChange(childIds, B_ID, { type: 'after', after: A_ID })).toBe(false)
    expect(hasTreecrdtPlacementChange(childIds, C_ID, { type: 'last' })).toBe(false)
  })

  it('detects placements that would change sibling order or parent', () => {
    const childIds = [A_ID, B_ID, C_ID]

    expect(hasTreecrdtPlacementChange(childIds, B_ID, { type: 'first' })).toBe(true)
    expect(hasTreecrdtPlacementChange(childIds, C_ID, { type: 'after', after: A_ID })).toBe(true)
    expect(hasTreecrdtPlacementChange(childIds, 'missing-id' as ThoughtId, { type: 'after', after: A_ID })).toBe(true)
  })
})
