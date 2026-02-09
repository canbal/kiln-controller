import { z } from 'zod'

// Contracts for legacy WS `/status`.
// Source of truth: `docs/contracts.md` + `docs/fixtures/status_*.json`.

export const profileSchema = z
  .object({
    type: z.literal('profile'),
    name: z.string(),
    data: z.array(z.tuple([z.number(), z.number()])),
  })
  .passthrough()

// Server sometimes sends `{}` early in a run; later it sends numeric PID fields.
// Keep this permissive-but-typed: object with numeric values.
export const pidStatsSchema = z.record(z.string(), z.number())

export const ovenStateSchema = z
  .object({
    cost: z.number(),
    runtime: z.number(),
    // Additive: wall-clock seconds since the run was started (not paused by catch-up logic).
    elapsed: z.number().optional(),
    // Additive: natural cooldown tail capture.
    cooldown_active: z.boolean().optional(),
    cooldown_elapsed: z.number().optional(),
    cooldown_session_id: z.string().nullable().optional(),
    temperature: z.number(),
    target: z.number(),
    state: z.enum(['IDLE', 'RUNNING']),
    heat: z.number(),
    totaltime: z.number(),
    kwh_rate: z.number(),
    currency_type: z.string(),
    profile: z.string().nullable(),
    pidstats: pidStatsSchema,
  })
  .passthrough()

export const statusBacklogEnvelopeSchema = z
  .object({
    type: z.literal('backlog'),
    profile: profileSchema.nullable(),
    log: z.array(ovenStateSchema),
  })
  .passthrough()

export type Profile = z.infer<typeof profileSchema>
export type PidStats = z.infer<typeof pidStatsSchema>
export type OvenState = z.infer<typeof ovenStateSchema>
export type StatusBacklogEnvelope = z.infer<typeof statusBacklogEnvelopeSchema>

export type StatusWsMessage =
  | { kind: 'backlog'; value: StatusBacklogEnvelope }
  | { kind: 'state'; value: OvenState }

export function parseStatusWsMessage(input: unknown): StatusWsMessage {
  // backlog is the only message with a stable discriminator.
  if (typeof input === 'object' && input !== null && 'type' in input) {
    const parsedBacklog = statusBacklogEnvelopeSchema.safeParse(input)
    if (parsedBacklog.success) return { kind: 'backlog', value: parsedBacklog.data }
  }

  const parsedState = ovenStateSchema.safeParse(input)
  if (parsedState.success) return { kind: 'state', value: parsedState.data }

  throw new Error('Invalid /status payload shape')
}
