import { z } from 'zod'

export const samplePointSchema = z
  .object({
    t: z.number(),
    temp: z.number().nullable().optional(),
    target: z.number().nullable().optional(),
    power_percent: z.number().nullable().optional(),
  })
  .passthrough()

export const listSamplesResponseSchema = z
  .object({
    success: z.boolean(),
    from: z.number().optional(),
    to: z.number().optional(),
    samples: z.array(samplePointSchema).optional(),
    count: z.number().optional(),
    error: z.string().optional(),
  })
  .passthrough()

export type SamplePoint = z.infer<typeof samplePointSchema>

export function parseListSamplesResponse(input: unknown): z.infer<typeof listSamplesResponseSchema> {
  const parsed = listSamplesResponseSchema.safeParse(input)
  if (!parsed.success) throw new Error('Invalid /v1/samples response')
  return parsed.data
}
