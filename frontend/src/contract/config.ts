import { z } from 'zod'

// Contracts for legacy WS `/config`.
// Source of truth: `kiln-controller.py#get_config`.

export const configEnvelopeSchema = z
  .object({
    temp_scale: z.string(),
  })
  .passthrough()

export type ConfigEnvelope = z.infer<typeof configEnvelopeSchema>

export type TempScale = 'f' | 'c'

export function parseTempScale(input: unknown): TempScale | null {
  if (typeof input !== 'string') return null
  const v = input.trim().toLowerCase()
  if (v === 'f') return 'f'
  if (v === 'c') return 'c'
  return null
}

export function parseConfigWsMessage(input: unknown): ConfigEnvelope {
  const parsed = configEnvelopeSchema.safeParse(input)
  if (!parsed.success) {
    throw new Error('Invalid /config payload shape')
  }
  return parsed.data
}
