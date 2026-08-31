import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { parse } from './routes/parse.js';

function replyRecorder(): {
  reply: FastifyReply;
  status: () => number | null;
  body: () => unknown;
} {
  let statusCode: number | null = null;
  let sent: unknown;
  const fake = {
    status(code: number) {
      statusCode = code;
      return fake;
    },
    send(body: unknown) {
      sent = body;
      return fake;
    },
  };
  return {
    reply: fake as unknown as FastifyReply,
    status: () => statusCode,
    body: () => sent,
  };
}

describe('route schema parsing', () => {
  it('returns the schema output, including coercion and defaults', () => {
    const recorder = replyRecorder();
    const schema = z.object({ wait: z.coerce.number().default(10) });

    assert.deepEqual(parse(schema, { wait: '4' }, recorder.reply), { wait: 4 });
    assert.deepEqual(parse(schema, {}, recorder.reply), { wait: 10 });
    assert.equal(recorder.status(), null);
  });

  it('uses the common 400 response for invalid input', () => {
    const recorder = replyRecorder();
    const result = parse(z.object({ id: z.coerce.number().int().positive() }), { id: 'nope' }, recorder.reply);

    assert.equal(result, null);
    assert.equal(recorder.status(), 400);
    const body = recorder.body() as { error: string; issues: unknown[] };
    assert.equal(body.error, 'Validation failed');
    assert.ok(body.issues.length > 0);
  });
});
