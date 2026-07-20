import * as murmurHash3 from 'murmurhash3js'
import type ThoughtId from '../@types/ThoughtId'

/** Stable TreeCRDT node id for one target in the canonical Favorites order. */
const favoriteOrderEntryId = (targetId: ThoughtId): ThoughtId =>
  murmurHash3.x64.hash128(`em:favorite-order:v1:${targetId}`) as ThoughtId

export default favoriteOrderEntryId
