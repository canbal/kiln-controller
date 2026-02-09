import { z } from 'zod'

// Contracts for additive REST `/v1/sessions*` endpoints.
// These are intentionally permissive: the backend is additive and the UI should
// stay resilient if new keys are introduced.

export const sessionSchema = z
  .object({
    id: z.string(),
    created_at: z.number(),
    started_at: z.number().nullable(),
    ended_at: z.number().nullable(),
    profile_name: z.string().nullable(),
    outcome: z.string().nullable(),
  })
  .passthrough()

export const listSessionsResponseSchema = z
  .object({
    success: z.boolean(),
    sessions: z.array(sessionSchema).optional(),
    count: z.number().optional(),
    error: z.string().optional(),
  })
  .passthrough()

export const sessionSampleSchema = z
  .object({
    t: z.number(),
    // Server stores a full `Oven.get_state()` payload per sample.
    // Keep as unknown-ish and validate only what we need in the chart.
    state: z.unknown().nullable(),
  })
  .passthrough()

export const listSessionSamplesResponseSchema = z
  .object({
    success: z.boolean(),
    session_id: z.string().optional(),
    session: sessionSchema.optional(),
    samples: z.array(sessionSampleSchema).optional(),
    count: z.number().optional(),
    error: z.string().optional(),
  })
  .passthrough()

export type Session = z.infer<typeof sessionSchema>
export type SessionSample = z.infer<typeof sessionSampleSchema>

export function parseListSessionsResponse(input: unknown): z.infer<typeof listSessionsResponseSchema> {
  const parsed = listSessionsResponseSchema.safeParse(input)
  if (!parsed.success) throw new Error('Invalid /v1/sessions response')
  return parsed.data
}

export function parseListSessionSamplesResponse(input: unknown): z.infer<typeof listSessionSamplesResponseSchema> {
  const parsed = listSessionSamplesResponseSchema.safeParse(input)
  if (!parsed.success) throw new Error('Invalid /v1/sessions/:id/samples response')
  return parsed.data
}
