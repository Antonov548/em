import { createTreecrdtClient, type TreecrdtClient } from '@treecrdt/wa-sqlite/client'
import { tsid } from '../yjs'

let client: TreecrdtClient | null = null

export const initTreecrdt = async (): Promise<TreecrdtClient> => {
  client = await createTreecrdtClient({
    storage: 'opfs',
    docId: tsid,
    filename: `/treecrdt-em-${tsid}.db`,
  })
  return client
}

export const getTreecrdtClient = (): TreecrdtClient => {
  if (!client) throw new Error('TreeCRDT client not initialized. Call initTreecrdt() first.')
  return client
}

export const closeTreecrdt = async (): Promise<void> => {
  if (client) {
    await client.close()
    client = null
  }
}
