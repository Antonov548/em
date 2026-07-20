import contextToThoughtId from '../../selectors/contextToThoughtId'
import hashThought from '../../util/hashThought'
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

it('does not leave a concurrently reassigned context in two lexemes', () => {
  const stateAtRead = reducerFlow([newThought('A')])(initialState())
  const id = contextToThoughtId(stateAtRead, ['A'])!
  const unloadedId = '000000000000000000000000000000d0' as typeof id
  const keyA = hashThought('A')
  const keyB = hashThought('B')
  const keyC = hashThought('C')
  const thoughtAtRead = stateAtRead.thoughts.thoughtIndex[id]
  const lexemeA = stateAtRead.thoughts.lexemeIndex[keyA]
  const lexemeB = {
    ...lexemeA,
    contexts: [id, unloadedId],
    lastUpdated: (lexemeA.lastUpdated + 1) as typeof lexemeA.lastUpdated,
  }
  const lexemeC = { ...lexemeA, contexts: [id], lastUpdated: (lexemeA.lastUpdated + 2) as typeof lexemeA.lastUpdated }
  const thoughtB = { ...thoughtAtRead, value: 'B', lastUpdated: lexemeB.lastUpdated }
  const thoughtC = { ...thoughtAtRead, value: 'C', lastUpdated: lexemeC.lastUpdated }
  const stateAfterLocalReassignment = {
    ...stateAtRead,
    thoughts: {
      ...stateAtRead.thoughts,
      thoughtIndex: { ...stateAtRead.thoughts.thoughtIndex, [id]: thoughtC },
      lexemeIndex: { [keyC]: lexemeC },
    },
  }

  const reconciled = updateThoughts({
    thoughtIndexUpdates: { [id]: thoughtB },
    lexemeIndexUpdates: { [keyA]: null, [keyB]: lexemeB },
    authoritativeLexemeReconcileSnapshot: stateAtRead.thoughts.lexemeIndex,
    authoritativeLexemeIndexUpdatesOld: { [keyA]: lexemeA, [keyB]: undefined },
    local: false,
    remote: false,
  })(stateAfterLocalReassignment)

  expect(reconciled.thoughts.thoughtIndex[id].value).toBe('C')
  expect(reconciled.thoughts.lexemeIndex[keyB]?.contexts).toEqual([unloadedId])
  expect(reconciled.thoughts.lexemeIndex[keyC]?.contexts).toEqual([id])
  expect(reconciled.pushQueue.at(-1)?.lexemeIndexUpdates[keyB]?.contexts).toEqual([unloadedId])
})

it('removes the losing local owner when the authoritative reassignment wins', () => {
  const stateAtRead = reducerFlow([newThought('A')])(initialState())
  const id = contextToThoughtId(stateAtRead, ['A'])!
  const keyA = hashThought('A')
  const keyB = hashThought('B')
  const keyC = hashThought('C')
  const thoughtAtRead = stateAtRead.thoughts.thoughtIndex[id]
  const lexemeA = stateAtRead.thoughts.lexemeIndex[keyA]
  const lexemeC = { ...lexemeA, contexts: [id], lastUpdated: (lexemeA.lastUpdated + 1) as typeof lexemeA.lastUpdated }
  const lexemeB = { ...lexemeA, contexts: [id], lastUpdated: (lexemeA.lastUpdated + 2) as typeof lexemeA.lastUpdated }
  const thoughtC = { ...thoughtAtRead, value: 'C', lastUpdated: lexemeC.lastUpdated }
  const thoughtB = { ...thoughtAtRead, value: 'B', lastUpdated: lexemeB.lastUpdated }
  const stateAfterLocalReassignment = {
    ...stateAtRead,
    thoughts: {
      ...stateAtRead.thoughts,
      thoughtIndex: { ...stateAtRead.thoughts.thoughtIndex, [id]: thoughtC },
      lexemeIndex: { [keyC]: lexemeC },
    },
  }

  const reconciled = updateThoughts({
    thoughtIndexUpdates: { [id]: thoughtB },
    lexemeIndexUpdates: { [keyA]: null, [keyB]: lexemeB },
    authoritativeLexemeReconcileSnapshot: stateAtRead.thoughts.lexemeIndex,
    authoritativeLexemeIndexUpdatesOld: { [keyA]: lexemeA, [keyB]: undefined },
    local: false,
    remote: false,
  })(stateAfterLocalReassignment)

  expect(reconciled.thoughts.thoughtIndex[id].value).toBe('B')
  expect(reconciled.thoughts.lexemeIndex[keyB]?.contexts).toEqual([id])
  expect(reconciled.thoughts.lexemeIndex[keyC]).toBeUndefined()
  expect(reconciled.pushQueue.at(-1)?.lexemeIndexUpdates[keyC]).toBeNull()
})
