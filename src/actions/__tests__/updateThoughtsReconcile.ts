import contextToThoughtId from '../../selectors/contextToThoughtId'
import initialState from '../../util/initialState'
import reducerFlow from '../../util/reducerFlow'
import newThought from '../newThought'
import updateThoughts from '../updateThoughts'

it('applies an authoritative lexeme delta without erasing an intervening local membership', () => {
  const stateAtRead = reducerFlow([newThought('A')])(initialState())
  const idA = contextToThoughtId(stateAtRead, ['A'])!
  const key = Object.keys(stateAtRead.thoughts.lexemeIndex).find(key =>
    stateAtRead.thoughts.lexemeIndex[key].contexts.includes(idA),
  )!
  const lexemeAtRead = stateAtRead.thoughts.lexemeIndex[key]
  const idB = '000000000000000000000000000000b0' as typeof idA
  const lexemeAfterLocalAdd = { ...lexemeAtRead, contexts: [...lexemeAtRead.contexts, idB] }
  const stateAfterLocalAdd = {
    ...stateAtRead,
    thoughts: {
      ...stateAtRead.thoughts,
      lexemeIndex: { ...stateAtRead.thoughts.lexemeIndex, [key]: lexemeAfterLocalAdd },
    },
  }

  const reconciled = updateThoughts({
    thoughtIndexUpdates: {},
    lexemeIndexUpdates: { [key]: null },
    authoritativeLexemeReconcileSnapshot: stateAtRead.thoughts.lexemeIndex,
    authoritativeLexemeIndexUpdatesOld: { [key]: lexemeAtRead },
    local: false,
    remote: false,
  })(stateAfterLocalAdd)

  expect(reconciled.thoughts.lexemeIndex[key]?.contexts).toEqual([idB])
  expect(reconciled.pushQueue.at(-1)?.lexemeIndexUpdates[key]?.contexts).toEqual([idB])
})
