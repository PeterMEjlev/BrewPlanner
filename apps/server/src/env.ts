/**
 * Local development secrets.
 *
 * In production systemd hands the server its environment from
 * /etc/brewplanner.env, so nothing here applies. On a dev machine there is no
 * such file, which left `npm run knowledge` and the Bruce chat with no way to
 * see an OPENAI_API_KEY at all — this loads a `.env` so they can.
 *
 * Two locations are read, workspace first:
 *
 *   apps/server/.env   server-only overrides
 *   .env               repo root — the usual place for one shared key
 *
 * Existing environment variables always win: dotenv never overwrites, so a
 * value exported in the shell (or by systemd) beats anything in a file, and a
 * stale `.env` can't silently shadow production config.
 *
 * Paths resolve from this module rather than the working directory, so it
 * behaves the same whether run from the repo root, from apps/server, via tsx,
 * or from the compiled dist/.
 *
 * IMPORTANT: import this module *first* wherever it is used. Several modules
 * read process.env at import time (model names, base URLs), and ES imports
 * evaluate in source order — placing it below them means they read an
 * environment that has not been populated yet.
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Quiet: a missing .env is the normal case in production, not a warning.
config({ path: resolve(__dirname, '../.env'), quiet: true });
config({ path: resolve(__dirname, '../../../.env'), quiet: true });
