import _ from 'lodash'
import SortPreference from '../@types/SortPreference'
import State from '../@types/State'
import ThoughtId from '../@types/ThoughtId'

/** Compatibility action. Sort preferences are rendered by selectors; stored sibling order is not rewritten. */
const sort = (state: State, _id: ThoughtId, _sortPreference?: SortPreference): State => state

export default _.curryRight(sort, 2)
