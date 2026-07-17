import {
  coalesceMaterializationEvents,
  enqueueMaterializedThoughtsToStoreWork,
  waitForMaterializedThoughtsToStore,
} from '../materializationQueue'

it('coalesces callbacks in materialized head order', () => {
  const coalesced = coalesceMaterializationEvents([
    {
      headSeq: 2,
      changes: [{ kind: 'restore', node: 'a', parentAfter: 'root', payload: null }],
    },
    {
      headSeq: 1,
      changes: [{ kind: 'delete', node: 'a', parentBefore: 'root' }],
    },
  ])

  expect(coalesced.headSeq).toBe(2)
  expect(coalesced.changes.map(change => change.kind)).toEqual(['delete', 'restore'])
})

it('waits for materialization work queued while waiting for idle', async () => {
  const order: string[] = []
  let finishFirst!: () => void

  const first = enqueueMaterializedThoughtsToStoreWork(async () => {
    order.push('first:start')
    await new Promise<void>(resolve => {
      finishFirst = resolve
    })
    order.push('first:end')
  })

  const wait = waitForMaterializedThoughtsToStore().then(() => {
    order.push('idle')
  })

  const second = enqueueMaterializedThoughtsToStoreWork(async () => {
    order.push('second')
  })

  await Promise.resolve()
  finishFirst()
  await Promise.all([first, second, wait])

  expect(order).toEqual(['first:start', 'first:end', 'second', 'idle'])
})

it('surfaces materialization failures when waiting for idle', async () => {
  const err = new Error('materialization failed')

  await expect(
    enqueueMaterializedThoughtsToStoreWork(async () => {
      throw err
    }),
  ).rejects.toThrow('materialization failed')

  await expect(waitForMaterializedThoughtsToStore()).rejects.toThrow('materialization failed')
  await expect(waitForMaterializedThoughtsToStore()).resolves.toBeUndefined()
})
