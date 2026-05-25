import Index from './IndexType'
import Lexeme from './Lexeme'
import Thought from './Thought'
import ThoughtId from './ThoughtId'

interface ThoughtIndices {
  /** Manual sibling order projection. TreeCRDT is authoritative when populated. */
  childOrder: Index<ThoughtId[]>
  thoughtIndex: Index<Thought>
  lexemeIndex: Index<Lexeme>
}

export default ThoughtIndices
