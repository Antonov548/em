import type Index from '../../../../@types/IndexType'
import type Lexeme from '../../../../@types/Lexeme'
import type Thought from '../../../../@types/Thought'
import type ThoughtId from '../../../../@types/ThoughtId'
import type Timestamp from '../../../../@types/Timestamp'
import { HOME_TOKEN, ROOT_PARENT_ID } from '../../../../constants'
import hashThought from '../../../../util/hashThought'
import initialState from '../../../../util/initialState'
import type { DataProvider } from '../../../DataProvider'
import { refreshThoughtsFromMaterializationChanges } from '../materializationThoughtUpdates'

const A_ID = 'a-id' as ThoughtId
const B_ID = 'b-id' as ThoughtId
const C_ID = 'c-id' as ThoughtId
const LEFT_ID = 'left-id' as ThoughtId
const RIGHT_ID = 'right-id' as ThoughtId

/** Creates a childrenMap that preserves the provided insertion order for Object.values. */
const childrenMap = (children: ThoughtId[]): Index<ThoughtId> =>
  Object.fromEntries(children.map(childId => [childId, childId]))

/** Creates a minimal Thought for materialization projection tests. */
const thought = (
  id: ThoughtId,
  value: string,
  rank: number,
  parentId: ThoughtId,
  children: ThoughtId[] = [],
): Thought => ({
  id,
  value,
  rank,
  parentId,
  childrenMap: childrenMap(children),
  created: 0 as Timestamp,
  lastUpdated: 0 as Timestamp,
  updatedBy: '',
})

/** Creates the minimal thoughtspace provider surface needed by refreshThoughtsFromMaterializationChanges. */
const fakeProvider = (thoughts: Index<Thought>, lexemes: Index<Lexeme> = {}): DataProvider => ({
  clear: async () => undefined,
  getLexemeById: async key => lexemes[key],
  getLexemesByContextId: async id =>
    Object.fromEntries(Object.entries(lexemes).filter(([, lexeme]) => lexeme.contexts.includes(id))),
  getLexemesByIds: async keys => keys.map(key => lexemes[key]),
  getThoughtById: async (id: ThoughtId) => thoughts[id],
  getThoughtsByIds: async ids => ids.map(id => thoughts[id]),
  updateThoughts: async () => undefined,
  freeThought: async () => undefined,
  freeLexeme: async () => undefined,
})

/** Converts test state to the provider-facing materialization snapshot. */
const materializationSnapshot = (state: ReturnType<typeof initialState>) => ({
  schemaVersion: state.schemaVersion,
  thoughtIndex: state.thoughts.thoughtIndex,
  lexemeIndex: state.thoughts.lexemeIndex,
})

it('projects TreeCRDT sibling order into compatibility ranks', async () => {
  const oldParent = thought(HOME_TOKEN, HOME_TOKEN, 0, ROOT_PARENT_ID, [A_ID, B_ID, C_ID])
  const newParent = thought(HOME_TOKEN, HOME_TOKEN, 0, ROOT_PARENT_ID, [C_ID, A_ID, B_ID])
  const thoughtA = thought(A_ID, 'a', 0, HOME_TOKEN)
  const thoughtB = thought(B_ID, 'b', 1, HOME_TOKEN)
  const thoughtC = thought(C_ID, 'c', 2, HOME_TOKEN)
  const state = {
    ...initialState(),
    thoughts: {
      thoughtIndex: {
        [HOME_TOKEN]: oldParent,
        [A_ID]: thoughtA,
        [B_ID]: thoughtB,
        [C_ID]: thoughtC,
      },
      lexemeIndex: {},
    },
  }

  const result = await refreshThoughtsFromMaterializationChanges(
    [{ kind: 'move', node: C_ID, parentBefore: HOME_TOKEN, parentAfter: HOME_TOKEN }],
    fakeProvider({
      [HOME_TOKEN]: newParent,
      [A_ID]: thoughtA,
      [B_ID]: thoughtB,
      [C_ID]: thoughtC,
    }),
    materializationSnapshot(state),
  )

  const updates = Object.fromEntries(result.thoughts.map(nextThought => [nextThought.id, nextThought]))

  expect(Object.values(updates[HOME_TOKEN].childrenMap)).toEqual([C_ID, A_ID, B_ID])
  expect(updates[C_ID].rank).toBe(0)
  expect(updates[A_ID].rank).toBe(1)
  expect(updates[B_ID].rank).toBe(2)
})

it('does not project TreeCRDT internal root for a top-level insert', async () => {
  const globalRoot = thought(ROOT_PARENT_ID, 'internal-root', 0, ROOT_PARENT_ID, [HOME_TOKEN])
  const home = thought(HOME_TOKEN, HOME_TOKEN, 0, ROOT_PARENT_ID, [A_ID])
  const thoughtA = thought(A_ID, 'a', 0, HOME_TOKEN)
  const state = {
    ...initialState(),
    thoughts: {
      thoughtIndex: { [HOME_TOKEN]: thought(HOME_TOKEN, HOME_TOKEN, 0, ROOT_PARENT_ID) },
      lexemeIndex: {},
    },
  }

  const result = await refreshThoughtsFromMaterializationChanges(
    [{ kind: 'insert', node: A_ID, parentAfter: HOME_TOKEN, payload: null }],
    fakeProvider({
      [ROOT_PARENT_ID]: globalRoot,
      [HOME_TOKEN]: home,
      [A_ID]: thoughtA,
    }),
    materializationSnapshot(state),
  )

  expect(result.thoughts.map(nextThought => nextThought.id)).not.toContain(ROOT_PARENT_ID)
})

it('projects TreeCRDT sibling order for both parents after a cross-parent move', async () => {
  const oldLeft = thought(LEFT_ID, 'left', 0, HOME_TOKEN, [A_ID, B_ID])
  const oldRight = thought(RIGHT_ID, 'right', 1, HOME_TOKEN, [C_ID])
  const newLeft = thought(LEFT_ID, 'left', 0, HOME_TOKEN, [B_ID])
  const newRight = thought(RIGHT_ID, 'right', 1, HOME_TOKEN, [C_ID, A_ID])
  const thoughtAOld = thought(A_ID, 'a', 0, LEFT_ID)
  const thoughtANew = thought(A_ID, 'a', 1, RIGHT_ID)
  const thoughtB = thought(B_ID, 'b', 1, LEFT_ID)
  const thoughtC = thought(C_ID, 'c', 0, RIGHT_ID)
  const state = {
    ...initialState(),
    thoughts: {
      thoughtIndex: {
        [LEFT_ID]: oldLeft,
        [RIGHT_ID]: oldRight,
        [A_ID]: thoughtAOld,
        [B_ID]: thoughtB,
        [C_ID]: thoughtC,
      },
      lexemeIndex: {},
    },
  }

  const result = await refreshThoughtsFromMaterializationChanges(
    [{ kind: 'move', node: A_ID, parentBefore: LEFT_ID, parentAfter: RIGHT_ID }],
    fakeProvider({
      [LEFT_ID]: newLeft,
      [RIGHT_ID]: newRight,
      [A_ID]: thoughtANew,
      [B_ID]: thoughtB,
      [C_ID]: thoughtC,
    }),
    materializationSnapshot(state),
  )

  const updates = Object.fromEntries(result.thoughts.map(nextThought => [nextThought.id, nextThought]))

  expect(Object.values(updates[LEFT_ID].childrenMap)).toEqual([B_ID])
  expect(Object.values(updates[RIGHT_ID].childrenMap)).toEqual([C_ID, A_ID])
  expect(updates[B_ID].rank).toBe(0)
  expect(updates[C_ID].rank).toBe(0)
  expect(updates[A_ID]).toMatchObject({
    parentId: RIGHT_ID,
    rank: 1,
  })
})

it('keeps a restored thought when coalesced changes include an earlier delete', async () => {
  const restoredParent = thought(HOME_TOKEN, HOME_TOKEN, 0, ROOT_PARENT_ID, [A_ID])
  const restoredThought = thought(A_ID, 'a', 0, HOME_TOKEN)
  const state = {
    ...initialState(),
    thoughts: {
      thoughtIndex: {
        [HOME_TOKEN]: thought(HOME_TOKEN, HOME_TOKEN, 0, ROOT_PARENT_ID),
      },
      lexemeIndex: {},
    },
  }

  const result = await refreshThoughtsFromMaterializationChanges(
    [
      { kind: 'delete', node: A_ID, parentBefore: HOME_TOKEN },
      { kind: 'restore', node: A_ID, parentAfter: HOME_TOKEN, payload: null },
    ],
    fakeProvider({
      [HOME_TOKEN]: restoredParent,
      [A_ID]: restoredThought,
    }),
    materializationSnapshot(state),
  )

  expect(result.deletedIds).not.toContain(A_ID)
  expect(result.thoughts).toEqual(expect.arrayContaining([restoredParent, restoredThought]))
})

it('uses final provider state when a stale delete event arrives after a restore', async () => {
  const restoredParent = thought(HOME_TOKEN, HOME_TOKEN, 0, ROOT_PARENT_ID, [A_ID])
  const restoredThought = thought(A_ID, 'a', 0, HOME_TOKEN)
  const state = {
    ...initialState(),
    thoughts: {
      thoughtIndex: {
        [HOME_TOKEN]: thought(HOME_TOKEN, HOME_TOKEN, 0, ROOT_PARENT_ID),
      },
      lexemeIndex: {},
    },
  }

  const result = await refreshThoughtsFromMaterializationChanges(
    [{ kind: 'delete', node: A_ID, parentBefore: HOME_TOKEN }],
    fakeProvider({
      [HOME_TOKEN]: restoredParent,
      [A_ID]: restoredThought,
    }),
    materializationSnapshot(state),
  )

  expect(result.deletedIds).not.toContain(A_ID)
  expect(result.thoughts).toEqual(expect.arrayContaining([restoredParent, restoredThought]))
})

it('removes a deleted context from persisted lexemes when Redux already removed the thought', async () => {
  const key = hashThought('shared')
  const persistedLexeme: Lexeme = {
    contexts: [A_ID, B_ID],
    created: 0 as Timestamp,
    lastUpdated: 0 as Timestamp,
    updatedBy: '',
  }
  const parent = thought(HOME_TOKEN, HOME_TOKEN, 0, ROOT_PARENT_ID, [B_ID])
  const thoughtB = thought(B_ID, 'shared', 0, HOME_TOKEN)
  const state = {
    ...initialState(),
    thoughts: {
      thoughtIndex: { [HOME_TOKEN]: parent },
      lexemeIndex: { [key]: persistedLexeme },
    },
  }

  const result = await refreshThoughtsFromMaterializationChanges(
    [{ kind: 'delete', node: A_ID, parentBefore: HOME_TOKEN }],
    fakeProvider({ [HOME_TOKEN]: parent, [B_ID]: thoughtB }, { [key]: persistedLexeme }),
    materializationSnapshot(state),
  )

  expect(result.deletedIds).toContain(A_ID)
  expect(result.lexemeIndexUpdates[key]?.contexts).toEqual([B_ID])
})

it('merges a new shared-value context into the newest persisted lexeme row', async () => {
  const shared = 'shared'
  const key = hashThought(shared)
  const parent = thought(HOME_TOKEN, HOME_TOKEN, 0, ROOT_PARENT_ID, [A_ID, B_ID, C_ID])
  const thoughtA = thought(A_ID, shared, 0, HOME_TOKEN)
  const thoughtB = thought(B_ID, shared, 1, HOME_TOKEN)
  const thoughtC = thought(C_ID, shared, 2, HOME_TOKEN)
  const staleLexeme: Lexeme = { contexts: [A_ID], created: 0 as Timestamp, lastUpdated: 0 as Timestamp, updatedBy: '' }
  const persistedLexeme: Lexeme = {
    ...staleLexeme,
    contexts: [A_ID, B_ID],
  }
  const state = {
    ...initialState(),
    thoughts: {
      thoughtIndex: {
        [HOME_TOKEN]: parent,
        [A_ID]: thoughtA,
      },
      lexemeIndex: { [key]: staleLexeme },
    },
  }

  const result = await refreshThoughtsFromMaterializationChanges(
    [{ kind: 'insert', node: C_ID, parentAfter: HOME_TOKEN, payload: null }],
    fakeProvider(
      {
        [HOME_TOKEN]: parent,
        [A_ID]: thoughtA,
        [B_ID]: thoughtB,
        [C_ID]: thoughtC,
      },
      { [key]: persistedLexeme },
    ),
    materializationSnapshot(state),
  )

  expect(result.lexemeIndexUpdates[key]?.contexts).toEqual([A_ID, B_ID, C_ID])
})

it('preserves an unaffected local context missing from a peer-overwritten persisted lexeme row', async () => {
  const shared = 'shared'
  const key = hashThought(shared)
  const parent = thought(HOME_TOKEN, HOME_TOKEN, 0, ROOT_PARENT_ID, [A_ID, B_ID])
  const thoughtA = thought(A_ID, shared, 0, HOME_TOKEN)
  const thoughtB = thought(B_ID, shared, 1, HOME_TOKEN)
  const localLexeme: Lexeme = {
    contexts: [A_ID],
    created: 0 as Timestamp,
    lastUpdated: 0 as Timestamp,
    updatedBy: '',
  }
  const persistedPeerLexeme: Lexeme = {
    ...localLexeme,
    contexts: [B_ID],
  }
  const state = {
    ...initialState(),
    thoughts: {
      thoughtIndex: {
        [HOME_TOKEN]: parent,
        [A_ID]: thoughtA,
      },
      lexemeIndex: { [key]: localLexeme },
    },
  }

  const result = await refreshThoughtsFromMaterializationChanges(
    [{ kind: 'insert', node: B_ID, parentAfter: HOME_TOKEN, payload: null }],
    fakeProvider(
      {
        [HOME_TOKEN]: parent,
        [A_ID]: thoughtA,
        [B_ID]: thoughtB,
      },
      { [key]: persistedPeerLexeme },
    ),
    materializationSnapshot(state),
  )

  expect(result.lexemeIndexUpdates[key]?.contexts.sort()).toEqual([A_ID, B_ID].sort())
})

it('removes a stale Redux-only lexeme context after its thought was already renamed', async () => {
  const oldKey = hashThought('old')
  const renamed = thought(A_ID, 'new', 0, HOME_TOKEN)
  const parent = thought(HOME_TOKEN, HOME_TOKEN, 0, ROOT_PARENT_ID, [A_ID])
  const staleLexeme: Lexeme = {
    contexts: [A_ID],
    created: 0 as Timestamp,
    lastUpdated: 0 as Timestamp,
    updatedBy: '',
  }
  const state = {
    ...initialState(),
    thoughts: {
      thoughtIndex: {
        [HOME_TOKEN]: parent,
        [A_ID]: renamed,
      },
      lexemeIndex: { [oldKey]: staleLexeme },
    },
  }

  const result = await refreshThoughtsFromMaterializationChanges(
    [{ kind: 'payload', node: A_ID, payload: null }],
    fakeProvider({ [HOME_TOKEN]: parent, [A_ID]: renamed }),
    materializationSnapshot(state),
  )

  expect(result.lexemeIndexUpdates[oldKey]).toBeNull()
})

it('does not revive a lexeme staged for deletion by a second coalesced delete', async () => {
  const key = hashThought('shared')
  const persistedLexeme: Lexeme = {
    contexts: [A_ID, B_ID],
    created: 0 as Timestamp,
    lastUpdated: 0 as Timestamp,
    updatedBy: '',
  }
  const parent = thought(HOME_TOKEN, HOME_TOKEN, 0, ROOT_PARENT_ID)
  const state = {
    ...initialState(),
    thoughts: {
      thoughtIndex: { [HOME_TOKEN]: parent },
      lexemeIndex: {},
    },
  }

  const result = await refreshThoughtsFromMaterializationChanges(
    [
      { kind: 'delete', node: A_ID, parentBefore: HOME_TOKEN },
      { kind: 'delete', node: B_ID, parentBefore: HOME_TOKEN },
    ],
    fakeProvider({ [HOME_TOKEN]: parent }, { [key]: persistedLexeme }),
    materializationSnapshot(state),
  )

  expect(result.lexemeIndexUpdates[key]).toBeNull()
})
