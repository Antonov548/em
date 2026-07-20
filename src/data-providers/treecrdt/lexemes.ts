/* eslint-disable import/prefer-default-export */
import type { TreecrdtClient } from '@treecrdt/wa-sqlite'
import type Lexeme from '../../@types/Lexeme'

/**
 * Application-owned lexeme metadata and context membership in the same SQLite DB as TreeCRDT.
 *
 * Context membership is normalized so independent tabs can add and remove different contexts
 * without replacing one shared `contexts` JSON array.
 */
const LEXEMES_TABLE = 'em_lexeme_metadata'
const CONTEXTS_TABLE = 'em_lexeme_contexts'
const schemaReady = new WeakSet<TreecrdtClient>()

const DDL = `
BEGIN IMMEDIATE;
CREATE TABLE IF NOT EXISTS ${LEXEMES_TABLE} (
  id TEXT PRIMARY KEY NOT NULL,
  created INTEGER NOT NULL,
  last_updated INTEGER NOT NULL,
  updated_by TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ${CONTEXTS_TABLE} (
  context_id TEXT PRIMARY KEY NOT NULL,
  lexeme_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  FOREIGN KEY (lexeme_id) REFERENCES ${LEXEMES_TABLE}(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS em_lexeme_contexts_lexeme_id
  ON ${CONTEXTS_TABLE}(lexeme_id);
COMMIT;
`

/** Escapes a value for SQL run through `runner.exec`, which does not accept bind args. */
const sqlLiteral = (value: string | number | null): string =>
  value === null ? 'NULL' : typeof value === 'number' ? String(value) : `'${value.replace(/'/g, "''")}'`

/** Injects bound parameters into SQL for `runner.exec`. Only `?1` … `?n` placeholders are supported. */
function bindParams(sql: string, params: (string | number | null)[]): string {
  let out = sql
  for (let i = params.length - 1; i >= 0; i--) {
    out = out.replace(new RegExp(`\\?${i + 1}\\b`, 'g'), sqlLiteral(params[i]))
  }
  return out
}

/** Builds an atomic SQLite script from individual statements. */
const transaction = (statements: string[]): string => `BEGIN IMMEDIATE;\n${statements.join(';\n')};\nCOMMIT;`

/** Inserts metadata, replacing it with the supplied authoritative Lexeme metadata. */
const replaceMetadataSql = (id: string, lexeme: Lexeme): string =>
  bindParams(
    `INSERT INTO ${LEXEMES_TABLE} (id, created, last_updated, updated_by) VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT(id) DO UPDATE SET
       created = excluded.created,
       last_updated = excluded.last_updated,
       updated_by = excluded.updated_by`,
    [id, lexeme.created, lexeme.lastUpdated, lexeme.updatedBy],
  )

/**
 * Merges metadata without letting a stale tab move timestamps backwards.
 * Context membership has independent conflict semantics below.
 */
const mergeMetadataSql = (id: string, lexeme: Lexeme): string =>
  bindParams(
    `INSERT INTO ${LEXEMES_TABLE} (id, created, last_updated, updated_by) VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT(id) DO UPDATE SET
       created = MIN(${LEXEMES_TABLE}.created, excluded.created),
       last_updated = MAX(${LEXEMES_TABLE}.last_updated, excluded.last_updated),
       updated_by = CASE
         WHEN excluded.last_updated >= ${LEXEMES_TABLE}.last_updated THEN excluded.updated_by
         ELSE ${LEXEMES_TABLE}.updated_by
       END`,
    [id, lexeme.created, lexeme.lastUpdated, lexeme.updatedBy],
  )

/** Ensures the normalized lexeme tables exist. Safe to call on every init. */
export async function ensureLexemesSchema(client: TreecrdtClient): Promise<void> {
  if (schemaReady.has(client)) return
  await client.runner.exec(DDL)
  schemaReady.add(client)
}

/** Loads lexemes for the given ids; order matches `ids`. */
export async function getLexemesByIds(client: TreecrdtClient, ids: string[]): Promise<(Lexeme | undefined)[]> {
  if (ids.length === 0) return []
  await ensureLexemesSchema(client)

  const placeholders = ids.map(() => '?').join(',')
  const sql = `
    SELECT json_group_array(json_object(
      'id', l.id,
      'lexeme', json_object(
        'contexts', json(COALESCE((
          SELECT json_group_array(context_id)
          FROM (
            SELECT context_id
            FROM ${CONTEXTS_TABLE}
            WHERE lexeme_id = l.id
            ORDER BY position, context_id
          )
        ), '[]')),
        'created', l.created,
        'lastUpdated', l.last_updated,
        'updatedBy', l.updated_by
      )
    ))
    FROM ${LEXEMES_TABLE} l
    WHERE l.id IN (${placeholders})
  `
  const text = await client.runner.getText(sql, ids)
  if (!text) return ids.map(() => undefined)

  const rows = JSON.parse(text) as ({ id: string; lexeme: Lexeme } | null)[]
  const map = new Map<string, Lexeme>()
  for (const row of rows) {
    if (row?.id) map.set(row.id, row.lexeme)
  }
  return ids.map(id => map.get(id))
}

/** Loads one lexeme by id (lexeme key / hash). */
export async function getLexemeById(client: TreecrdtClient, id: string): Promise<Lexeme | undefined> {
  return (await getLexemesByIds(client, [id]))[0]
}

/**
 * Replaces one complete lexeme. Used for controlled initialization and conformance-test bulk replacement.
 * Normal provider writes should use `applyLexemeUpdate` so they preserve concurrent membership changes.
 */
export async function upsertLexeme(client: TreecrdtClient, id: string, lexeme: Lexeme): Promise<void> {
  await ensureLexemesSchema(client)
  const statements = [
    replaceMetadataSql(id, lexeme),
    bindParams(`DELETE FROM ${CONTEXTS_TABLE} WHERE lexeme_id = ?1`, [id]),
    ...lexeme.contexts.map((contextId, position) =>
      bindParams(
        `INSERT INTO ${CONTEXTS_TABLE} (context_id, lexeme_id, position) VALUES (?1, ?2, ?3)
         ON CONFLICT(context_id) DO UPDATE SET lexeme_id = excluded.lexeme_id, position = excluded.position`,
        [contextId, id, position],
      ),
    ),
  ]
  await client.runner.exec(transaction(statements))
}

/**
 * Applies the caller-observed change to one lexeme as context-level mutations.
 *
 * Removed contexts are deleted only if they still belong to this lexeme, retained contexts are
 * repositioned only if they still exist, and only newly added contexts are inserted. Thus a stale
 * whole-object snapshot cannot revive a concurrent removal or erase a concurrent addition.
 */
export async function applyLexemeUpdate(
  client: TreecrdtClient,
  id: string,
  lexeme: Lexeme | null,
  lexemeOld: Lexeme | undefined,
): Promise<void> {
  await ensureLexemesSchema(client)

  const oldContexts = new Set(lexemeOld?.contexts ?? [])
  const newContexts = new Set(lexeme?.contexts ?? [])
  const removed = [...oldContexts].filter(contextId => !newContexts.has(contextId))
  const added = [...newContexts].filter(contextId => !oldContexts.has(contextId))
  const retained = [...newContexts].filter(contextId => oldContexts.has(contextId))
  const positionByContext = new Map((lexeme?.contexts ?? []).map((contextId, position) => [contextId, position]))

  const statements: string[] = []
  if (lexeme) statements.push(mergeMetadataSql(id, lexeme))

  // An absent old value means the caller is introducing known memberships, not replacing unknown persisted state.
  for (const contextId of added) {
    statements.push(
      bindParams(
        `INSERT INTO ${CONTEXTS_TABLE} (context_id, lexeme_id, position) VALUES (?1, ?2, ?3)
         ON CONFLICT(context_id) DO UPDATE SET lexeme_id = excluded.lexeme_id, position = excluded.position`,
        [contextId, id, positionByContext.get(contextId) ?? 0],
      ),
    )
  }

  // Do not reinsert retained rows: another tab may already have removed or reassigned the context.
  for (const contextId of retained) {
    statements.push(
      bindParams(`UPDATE ${CONTEXTS_TABLE} SET position = ?3 WHERE context_id = ?1 AND lexeme_id = ?2`, [
        contextId,
        id,
        positionByContext.get(contextId) ?? 0,
      ]),
    )
  }

  // Pair-scoped deletion cannot remove a context that another write has reassigned to a new lexeme.
  for (const contextId of removed) {
    statements.push(
      bindParams(`DELETE FROM ${CONTEXTS_TABLE} WHERE context_id = ?1 AND lexeme_id = ?2`, [contextId, id]),
    )
  }

  // A null update with no observed value is the explicit full-delete escape hatch.
  if (lexeme === null && lexemeOld === undefined) {
    statements.push(bindParams(`DELETE FROM ${CONTEXTS_TABLE} WHERE lexeme_id = ?1`, [id]))
  }

  if (lexeme === null) {
    statements.push(
      bindParams(
        `DELETE FROM ${LEXEMES_TABLE}
         WHERE id = ?1 AND NOT EXISTS (SELECT 1 FROM ${CONTEXTS_TABLE} WHERE lexeme_id = ?1)`,
        [id],
      ),
    )
  }

  if (statements.length > 0) await client.runner.exec(transaction(statements))
}

/** Deletes a lexeme and all of its context rows by id. */
export async function deleteLexeme(client: TreecrdtClient, id: string): Promise<void> {
  await ensureLexemesSchema(client)
  await client.runner.exec(
    transaction([
      bindParams(`DELETE FROM ${CONTEXTS_TABLE} WHERE lexeme_id = ?1`, [id]),
      bindParams(`DELETE FROM ${LEXEMES_TABLE} WHERE id = ?1`, [id]),
    ]),
  )
}

/** Deletes all lexeme rows. */
export async function deleteAllLexemes(client: TreecrdtClient): Promise<void> {
  await ensureLexemesSchema(client)
  await client.runner.exec(transaction([`DELETE FROM ${CONTEXTS_TABLE}`, `DELETE FROM ${LEXEMES_TABLE}`]))
}
