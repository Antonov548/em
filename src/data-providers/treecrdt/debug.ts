import { HOME_TOKEN } from '../../constants'
import { decodeThoughtPayload } from './thoughtspace'
import { getTreecrdtClient } from './treecrdt'

type TreeDumpRow = { node: string; parent: string | null; tombstone: boolean }

export type DumpTreecrdtRow = {
  id: string
  parent: string | null
  tombstone: boolean
  value: string | null
  index: number
  created: number | null
  lastUpdated: number | null
  updatedBy: string | null
  archived: number | null
}

export type DumpTreecrdtOptions = {
  includeTombstones?: boolean
}

/**
 * Fetches all treecrdt nodes via tree.dump(), enriches with parsed payloads,
 * and returns rows suitable for console.table().
 */
export async function dumpTreecrdt(opts: DumpTreecrdtOptions = {}): Promise<DumpTreecrdtRow[]> {
  const { includeTombstones = false } = opts
  const client = getTreecrdtClient()
  const rows = await client.tree.dump()

  const filtered = includeTombstones ? rows : (rows as TreeDumpRow[]).filter(r => !r.tombstone)

  const result: DumpTreecrdtRow[] = await Promise.all(
    filtered.map(async (row: TreeDumpRow) => {
      let value: string | null = null
      let created: number | null = null
      let lastUpdated: number | null = null
      let updatedBy: string | null = null
      let archived: number | null = null

      const payloadBytes = await client.tree.getPayload(row.node)
      if (payloadBytes !== null && payloadBytes.length > 0) {
        try {
          const payload = decodeThoughtPayload(payloadBytes)
          value = payload.value
          created = payload.created
          lastUpdated = payload.lastUpdated
          updatedBy = payload.updatedBy
          archived = payload.archived ?? null
        } catch {
          value = '[parse error]'
        }
      }

      const parentId = row.parent ?? HOME_TOKEN
      const children = await client.tree.children(parentId)
      const index = row.parent === null ? 0 : children.indexOf(row.node)

      return {
        id: row.node,
        parent: row.parent,
        tombstone: row.tombstone,
        value,
        index,
        created,
        lastUpdated,
        updatedBy,
        archived,
      }
    }),
  )

  return result
}
