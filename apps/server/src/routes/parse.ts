import type { FastifyReply } from 'fastify';
import type { z } from 'zod';

/** Parse with Zod and preserve the API's standard validation-error response. */
export function parse<S extends z.ZodTypeAny>(
  schema: S,
  data: unknown,
  reply: FastifyReply,
): z.output<S> | null {
  const result = schema.safeParse(data);
  if (!result.success) {
    reply.status(400).send({ error: 'Validation failed', issues: result.error.issues });
    return null;
  }
  return result.data;
}
