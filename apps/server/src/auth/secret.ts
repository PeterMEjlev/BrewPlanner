import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import { databasePath } from '../db/index.js';

/**
 * The secret used to sign session cookies. Order of preference:
 *   1. SESSION_SECRET env var (recommended in production).
 *   2. A persisted random secret in `data/session-secret` — generated once so
 *      sessions survive restarts without any configuration.
 *
 * Persisting (rather than regenerating each boot) means existing logins aren't
 * invalidated every time the server restarts.
 */
export function resolveSessionSecret(log: FastifyBaseLogger): string {
  const fromEnv = process.env.SESSION_SECRET;
  if (fromEnv && fromEnv.length >= 32) return fromEnv;
  if (fromEnv && fromEnv.length > 0) {
    log.warn('SESSION_SECRET is set but shorter than 32 chars — using it anyway.');
    return fromEnv;
  }

  const secretFile = resolve(dirname(databasePath), 'session-secret');
  if (existsSync(secretFile)) {
    const existing = readFileSync(secretFile, 'utf8').trim();
    if (existing.length >= 32) return existing;
  }

  const generated = randomBytes(48).toString('base64url');
  writeFileSync(secretFile, generated, { mode: 0o600 });
  log.warn(
    `Generated a session secret at ${secretFile}. ` +
      'Set SESSION_SECRET to control it explicitly.',
  );
  return generated;
}
