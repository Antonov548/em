import _ from 'lodash'
import SimplePath from '../@types/SimplePath'
import State from '../@types/State'
import { registerActionMetadata } from '../util/actionMetadata.registry'

/** Obsolete compatibility action. Sibling order is now stored as relative TreeCRDT placement, not renormalized ranks. */
const rerank = (state: State, _simplePath: SimplePath): State => state

export default _.curryRight(rerank)

// Register this action's metadata
registerActionMetadata('rerank', {
  undoable: false,
})
