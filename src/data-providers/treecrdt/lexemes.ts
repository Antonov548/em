/* eslint-disable import/prefer-default-export */
import type { TreecrdtClient } from '@treecrdt/wa-sqlite'
import type Lexeme from '../../@types/Lexeme'

/**
 * Application-owned Lexeme projection in the same SQLite DB as TreeCRDT.
 *
 * Each row belongs to one thought context. TreeCRDT payloads include em's precomputed Lexeme key,
 * allowing SQLite triggers to update context ownership atomically with the winning materialized payload.
 */
const CONTEXTS_TABLE = 'em_lexeme_contexts_v2'
const PAYLOAD_VIEW = 'em_treecrdt_thought_payloads_v2'
const schemaReady = new WeakSet<TreecrdtClient>()

/** Adds or refreshes one projected context from the authoritative payload view. */
const upsertProjectedContextSql = (node = 'NEW.node'): string => `
  INSERT INTO ${CONTEXTS_TABLE} (context_id, lexeme_id, position, created, last_updated, updated_by)
  SELECT
    projected.context_id,
    projected.lexeme_id,
    0,
    projected.created,
    projected.last_updated,
    projected.updated_by
  FROM ${PAYLOAD_VIEW} AS projected
  WHERE projected.node = ${node}
  ON CONFLICT(context_id) DO UPDATE SET
    lexeme_id = excluded.lexeme_id,
    position = CASE
      WHEN ${CONTEXTS_TABLE}.lexeme_id = excluded.lexeme_id THEN ${CONTEXTS_TABLE}.position
      ELSE excluded.position
    END,
    created = excluded.created,
    last_updated = excluded.last_updated,
    updated_by = excluded.updated_by`

const DDL = `
BEGIN IMMEDIATE;
CREATE TABLE IF NOT EXISTS ${CONTEXTS_TABLE} (
  context_id TEXT PRIMARY KEY NOT NULL,
  lexeme_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  created INTEGER NOT NULL,
  last_updated INTEGER NOT NULL,
  updated_by TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS em_lexeme_contexts_v2_lexeme_id
  ON ${CONTEXTS_TABLE}(lexeme_id);

-- Thought payload bytes are JSON. The application supplies lexemeKey because SQLite cannot reproduce
-- em's value normalization and Murmur hash. Only visible materialized nodes are projected.
CREATE VIEW IF NOT EXISTS ${PAYLOAD_VIEW} AS
SELECT
  decoded.node,
  decoded.context_id,
  decoded.lexeme_id,
  decoded.created,
  decoded.last_updated,
  decoded.updated_by
FROM (
  SELECT
    payload.node,
    lower(hex(payload.node)) AS context_id,
    CASE WHEN json_valid(CAST(payload.payload AS TEXT))
      THEN json_extract(CAST(payload.payload AS TEXT), '$.lexemeKey') END AS lexeme_id,
    CASE WHEN json_valid(CAST(payload.payload AS TEXT))
      THEN COALESCE(CAST(json_extract(CAST(payload.payload AS TEXT), '$.created') AS INTEGER), 0) ELSE 0 END AS created,
    CASE WHEN json_valid(CAST(payload.payload AS TEXT))
      THEN COALESCE(CAST(json_extract(CAST(payload.payload AS TEXT), '$.lastUpdated') AS INTEGER), 0) ELSE 0 END AS last_updated,
    CASE WHEN json_valid(CAST(payload.payload AS TEXT))
      THEN COALESCE(json_extract(CAST(payload.payload AS TEXT), '$.updatedBy'), '') ELSE '' END AS updated_by
  FROM tree_payload AS payload
  JOIN tree_nodes AS node ON node.node = payload.node AND node.tombstone = 0
  WHERE payload.payload IS NOT NULL
) AS decoded
WHERE decoded.context_id NOT IN (
    '00000000000000000000000000000000',
    '00000000000000000000000000000001',
    '00000000000000000000000000000002',
    '00000000000000000000000000000003'
  )
  AND typeof(decoded.lexeme_id) = 'text'
  AND length(decoded.lexeme_id) = 32
  AND decoded.lexeme_id NOT GLOB '*[^0-9a-f]*';

CREATE TRIGGER IF NOT EXISTS em_lexeme_payload_insert_v2
AFTER INSERT ON tree_payload
BEGIN
  DELETE FROM ${CONTEXTS_TABLE}
  WHERE context_id = lower(hex(NEW.node))
    AND NOT EXISTS (SELECT 1 FROM ${PAYLOAD_VIEW} WHERE node = NEW.node);
  ${upsertProjectedContextSql()};
END;

CREATE TRIGGER IF NOT EXISTS em_lexeme_payload_update_v2
AFTER UPDATE OF payload ON tree_payload
BEGIN
  DELETE FROM ${CONTEXTS_TABLE}
  WHERE context_id = lower(hex(NEW.node))
    AND NOT EXISTS (SELECT 1 FROM ${PAYLOAD_VIEW} WHERE node = NEW.node);
  ${upsertProjectedContextSql()};
END;

CREATE TRIGGER IF NOT EXISTS em_lexeme_payload_delete_v2
AFTER DELETE ON tree_payload
BEGIN
  DELETE FROM ${CONTEXTS_TABLE} WHERE context_id = lower(hex(OLD.node));
END;

CREATE TRIGGER IF NOT EXISTS em_lexeme_node_insert_v2
AFTER INSERT ON tree_nodes
BEGIN
  DELETE FROM ${CONTEXTS_TABLE}
  WHERE context_id = lower(hex(NEW.node))
    AND NOT EXISTS (SELECT 1 FROM ${PAYLOAD_VIEW} WHERE node = NEW.node);
  ${upsertProjectedContextSql()};
END;

CREATE TRIGGER IF NOT EXISTS em_lexeme_node_update_v2
AFTER UPDATE OF tombstone ON tree_nodes
BEGIN
  DELETE FROM ${CONTEXTS_TABLE}
  WHERE context_id = lower(hex(NEW.node))
    AND NOT EXISTS (SELECT 1 FROM ${PAYLOAD_VIEW} WHERE node = NEW.node);
  ${upsertProjectedContextSql()};
END;

CREATE TRIGGER IF NOT EXISTS em_lexeme_node_delete_v2
AFTER DELETE ON tree_nodes
BEGIN
  DELETE FROM ${CONTEXTS_TABLE} WHERE context_id = lower(hex(OLD.node));
END;

-- Backfill already-materialized thoughts and discard stale rows for known TreeCRDT nodes. Rows with
-- no TreeCRDT node are retained for the controlled DataProvider conformance-test replacement API.
DELETE FROM ${CONTEXTS_TABLE}
WHERE EXISTS (SELECT 1 FROM tree_nodes WHERE node = unhex(${CONTEXTS_TABLE}.context_id))
  AND NOT EXISTS (
    SELECT 1 FROM ${PAYLOAD_VIEW} WHERE context_id = ${CONTEXTS_TABLE}.context_id
  );
INSERT INTO ${CONTEXTS_TABLE} (context_id, lexeme_id, position, created, last_updated, updated_by)
SELECT context_id, lexeme_id, 0, created, last_updated, updated_by
FROM ${PAYLOAD_VIEW}
WHERE 1
ON CONFLICT(context_id) DO UPDATE SET
  lexeme_id = excluded.lexeme_id,
  position = CASE
    WHEN ${CONTEXTS_TABLE}.lexeme_id = excluded.lexeme_id THEN ${CONTEXTS_TABLE}.position
    ELSE excluded.position
  END,
  created = excluded.created,
  last_updated = excluded.last_updated,
  updated_by = excluded.updated_by;
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

/** Ensures the normalized Lexeme projection and TreeCRDT materialization triggers exist. */
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
      'id', lexeme.lexeme_id,
      'lexeme', json_object(
        'contexts', json(COALESCE((
          SELECT json_group_array(context_id)
          FROM (
            SELECT context_id
            FROM ${CONTEXTS_TABLE}
            WHERE lexeme_id = lexeme.lexeme_id
            ORDER BY position, context_id
          )
        ), '[]')),
        'created', (SELECT MIN(created) FROM ${CONTEXTS_TABLE} WHERE lexeme_id = lexeme.lexeme_id),
        'lastUpdated', (SELECT MAX(last_updated) FROM ${CONTEXTS_TABLE} WHERE lexeme_id = lexeme.lexeme_id),
        'updatedBy', (
          SELECT updated_by
          FROM ${CONTEXTS_TABLE}
          WHERE lexeme_id = lexeme.lexeme_id
          ORDER BY last_updated DESC, context_id
          LIMIT 1
        )
      )
    ))
    FROM (
      SELECT DISTINCT lexeme_id
      FROM ${CONTEXTS_TABLE}
      WHERE lexeme_id IN (${placeholders})
    ) AS lexeme
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
    bindParams(`DELETE FROM ${CONTEXTS_TABLE} WHERE lexeme_id = ?1`, [id]),
    ...lexeme.contexts.map((contextId, position) =>
      bindParams(
        `INSERT INTO ${CONTEXTS_TABLE}
          (context_id, lexeme_id, position, created, last_updated, updated_by)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(context_id) DO UPDATE SET
           lexeme_id = excluded.lexeme_id,
           position = excluded.position,
           created = excluded.created,
           last_updated = excluded.last_updated,
           updated_by = excluded.updated_by`,
        [contextId, id, position, lexeme.created, lexeme.lastUpdated, lexeme.updatedBy],
      ),
    ),
  ]
  await client.runner.exec(transaction(statements))
}

/**
 * Applies the caller-observed change as context-level mutations.
 *
 * When the context already exists in TreeCRDT, inserts and removals are accepted only when they agree
 * with the materialized payload. The triggers then make later payload winners authoritative atomically.
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

  for (const contextId of added) {
    statements.push(
      bindParams(
        `INSERT INTO ${CONTEXTS_TABLE}
          (context_id, lexeme_id, position, created, last_updated, updated_by)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6
         WHERE NOT EXISTS (SELECT 1 FROM tree_nodes WHERE node = unhex(?1))
         ON CONFLICT(context_id) DO UPDATE SET
           lexeme_id = excluded.lexeme_id,
           position = excluded.position,
           created = excluded.created,
           last_updated = excluded.last_updated,
           updated_by = excluded.updated_by`,
        [contextId, id, positionByContext.get(contextId) ?? 0, lexeme!.created, lexeme!.lastUpdated, lexeme!.updatedBy],
      ),
    )
    statements.push(
      bindParams(
        `INSERT INTO ${CONTEXTS_TABLE}
          (context_id, lexeme_id, position, created, last_updated, updated_by)
         SELECT context_id, lexeme_id, ?3, created, last_updated, updated_by
         FROM ${PAYLOAD_VIEW}
         WHERE node = unhex(?1) AND lexeme_id = ?2
         ON CONFLICT(context_id) DO UPDATE SET
           lexeme_id = excluded.lexeme_id,
           position = excluded.position,
           created = excluded.created,
           last_updated = excluded.last_updated,
           updated_by = excluded.updated_by`,
        [contextId, id, positionByContext.get(contextId) ?? 0],
      ),
    )
  }

  // Reordering is local Lexeme behavior. Never reinsert a retained row another tab removed or reassigned.
  for (const contextId of retained) {
    statements.push(
      bindParams(`UPDATE ${CONTEXTS_TABLE} SET position = ?3 WHERE context_id = ?1 AND lexeme_id = ?2`, [
        contextId,
        id,
        positionByContext.get(contextId) ?? 0,
      ]),
    )
  }

  for (const contextId of removed) {
    statements.push(
      bindParams(
        `DELETE FROM ${CONTEXTS_TABLE}
         WHERE context_id = ?1
           AND lexeme_id = ?2
           AND NOT EXISTS (
             SELECT 1 FROM ${PAYLOAD_VIEW} WHERE node = unhex(?1) AND lexeme_id = ?2
           )`,
        [contextId, id],
      ),
    )
  }

  if (statements.length > 0) await client.runner.exec(transaction(statements))
}

/** Deletes a lexeme and all of its context rows by id. */
export async function deleteLexeme(client: TreecrdtClient, id: string): Promise<void> {
  await ensureLexemesSchema(client)
  await client.runner.exec(transaction([bindParams(`DELETE FROM ${CONTEXTS_TABLE} WHERE lexeme_id = ?1`, [id])]))
}

/** Deletes all lexeme rows. */
export async function deleteAllLexemes(client: TreecrdtClient): Promise<void> {
  await ensureLexemesSchema(client)
  await client.runner.exec(transaction([`DELETE FROM ${CONTEXTS_TABLE}`]))
}
