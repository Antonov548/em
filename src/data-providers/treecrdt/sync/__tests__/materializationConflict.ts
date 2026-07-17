import type Lexeme from '../../../../@types/Lexeme'
import type Thought from '../../../../@types/Thought'
import type Timestamp from '../../../../@types/Timestamp'
import { hasMaterializationSnapshotConflict } from '../../../thoughtspace'

const thought = { id: 'thought', lastUpdated: 0 as Timestamp } as Thought
const lexeme = { contexts: ['thought'], lastUpdated: 0 as Timestamp } as Lexeme
const readSnapshot = {
  schemaVersion: 0,
  thoughtIndex: { thought },
  lexemeIndex: { lexeme },
}
const updates = {
  thoughtIndexUpdates: { thought },
  lexemeIndexUpdates: { lexeme },
}

it('accepts a materialization batch when all touched Redux objects still match its snapshot', () => {
  expect(hasMaterializationSnapshotConflict(updates, readSnapshot, readSnapshot)).toBe(false)
})

it('rejects the whole materialization batch after a touched thought changes', () => {
  expect(
    hasMaterializationSnapshotConflict(updates, readSnapshot, {
      ...readSnapshot,
      thoughtIndex: { thought: { ...thought } },
    }),
  ).toBe(true)
})

it('rejects the whole materialization batch after a touched lexeme changes', () => {
  expect(
    hasMaterializationSnapshotConflict(updates, readSnapshot, {
      ...readSnapshot,
      lexemeIndex: { lexeme: { ...lexeme } },
    }),
  ).toBe(true)
})
