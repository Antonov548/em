import hashThought from '../../util/hashThought'

export type ThoughtPayload = {
  value: string
  created: number
  lastUpdated: number
  updatedBy: string
  archived?: number
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/** Encodes a thought payload to bytes. */
export function encodeThoughtPayload(payload: ThoughtPayload): Uint8Array {
  return encoder.encode(
    JSON.stringify({
      ...payload,
      // Stored with the opaque payload so SQLite can maintain the normalized Lexeme index in the
      // same materialization transaction that chooses the winning TreeCRDT payload.
      lexemeKey: hashThought(payload.value),
    }),
  )
}

/** Decodes bytes to a thought payload. */
export function decodeThoughtPayload(bytes: Uint8Array): ThoughtPayload {
  return JSON.parse(decoder.decode(bytes)) as ThoughtPayload
}
