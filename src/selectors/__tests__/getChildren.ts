import newThought from '../../actions/newThought'
import toggleHiddenThoughts from '../../actions/toggleHiddenThoughts'
import { HOME_TOKEN } from '../../constants'
import { getChildren, getChildrenRanked, getChildrenSorted } from '../../selectors/getChildren'
import initialState from '../../util/initialState'
import reducerFlow from '../../util/reducerFlow'

describe('get visible children', () => {
  it('when showHiddenThoughts is off', () => {
    const steps = [newThought('a'), newThought('=b')]

    const stateNew = reducerFlow(steps)(initialState())

    expect(getChildren(stateNew, HOME_TOKEN)).toMatchObject([{ value: 'a' }])
  })

  it('when showHiddenThoughts is off', () => {
    const steps = [newThought('a'), newThought('=b'), toggleHiddenThoughts]

    const stateNew = reducerFlow(steps)(initialState())

    expect(getChildren(stateNew, HOME_TOKEN)).toMatchObject([{ value: 'a' }, { value: '=b' }])
  })
})

describe('manual child order', () => {
  it('uses childOrder instead of rank when no sort preference is active', () => {
    const state = reducerFlow([newThought('a'), newThought('b'), newThought('c')])(initialState())
    const [a, b, c] = getChildrenRanked(state, HOME_TOKEN)
    const stateWithTreeOrder = {
      ...state,
      thoughts: {
        ...state.thoughts,
        childOrder: {
          ...state.thoughts.childOrder,
          [HOME_TOKEN]: [c.id, a.id, b.id],
        },
      },
    }

    expect(getChildrenRanked(stateWithTreeOrder, HOME_TOKEN).map(child => child.value)).toEqual(['c', 'a', 'b'])
    expect(getChildrenSorted(stateWithTreeOrder, HOME_TOKEN).map(child => child.value)).toEqual(['c', 'a', 'b'])
  })
})
