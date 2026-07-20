import contextToThoughtId from '../../selectors/contextToThoughtId'
import getThoughtById from '../../selectors/getThoughtById'
import initialState from '../../util/initialState'
import reducerFlow from '../../util/reducerFlow'
import newThought from '../newThought'
import updateThoughts from '../updateThoughts'

it('accepts an equal-timestamp rank refresh when the thought is unchanged since the provider snapshot', () => {
  const state = reducerFlow([newThought('A')])(initialState())
  const id = contextToThoughtId(state, ['A'])!
  const authoritativeReconcileSnapshot = state.thoughts.thoughtIndex
  const thoughtAtRead = authoritativeReconcileSnapshot[id]
  const providerRefresh = {
    ...thoughtAtRead,
    rank: thoughtAtRead.rank + 1,
  }

  expect(providerRefresh.lastUpdated).toBe(thoughtAtRead.lastUpdated)
  expect(getThoughtById(state, id)).toBe(thoughtAtRead)

  const reconciled = updateThoughts({
    thoughtIndexUpdates: { [id]: providerRefresh },
    lexemeIndexUpdates: {},
    authoritativeReconcileSnapshot,
    local: false,
    remote: false,
  })(state)

  expect(getThoughtById(reconciled, id)).toBe(providerRefresh)
  expect(getThoughtById(reconciled, id)?.rank).toBe(providerRefresh.rank)
})

it('rejects an equal-timestamp rank refresh after an intervening local update changes the thought', () => {
  const state = reducerFlow([newThought('A')])(initialState())
  const id = contextToThoughtId(state, ['A'])!
  const authoritativeReconcileSnapshot = state.thoughts.thoughtIndex
  const thoughtAtRead = authoritativeReconcileSnapshot[id]
  const localUpdate = {
    ...thoughtAtRead,
    rank: thoughtAtRead.rank + 1,
  }
  const stateAfterLocalUpdate = updateThoughts({
    thoughtIndexUpdates: { [id]: localUpdate },
    lexemeIndexUpdates: {},
    local: true,
    remote: false,
  })(state)
  const currentThought = getThoughtById(stateAfterLocalUpdate, id)!
  const staleProviderRefresh = {
    ...thoughtAtRead,
    rank: thoughtAtRead.rank + 2,
  }

  expect(currentThought).not.toBe(thoughtAtRead)
  expect(staleProviderRefresh.lastUpdated).toBe(currentThought.lastUpdated)

  const reconciled = updateThoughts({
    thoughtIndexUpdates: { [id]: staleProviderRefresh },
    lexemeIndexUpdates: {},
    authoritativeReconcileSnapshot,
    local: false,
    remote: false,
  })(stateAfterLocalUpdate)

  expect(getThoughtById(reconciled, id)).toBe(currentThought)
  expect(getThoughtById(reconciled, id)?.rank).toBe(localUpdate.rank)
  expect(reconciled.pushQueue.at(-1)?.thoughtIndexUpdates).not.toHaveProperty(id)
})
