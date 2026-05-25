import PropertyRequired from '../@types/PropertyRequired'
import Thought from '../@types/Thought'

/** Legacy name. Compares render-relevant thought identity while ignoring compatibility rank metadata. */
const equalThoughtRanked = (a: PropertyRequired<Thought, 'value'>, b: PropertyRequired<Thought, 'value'>): boolean =>
  a === b || (a && b && a.value === b.value)

export default equalThoughtRanked
