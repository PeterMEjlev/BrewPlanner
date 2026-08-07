'use strict';

/**
 * Tiny loopback HTTP API exposing Bruce's live state to the BrewPlanner
 * server, which proxies it as /api/bruce/* behind its own auth (same pattern
 * as the brew-rig proxy). Deliberately binds 127.0.0.1 only and carries no
 * auth of its own — the only way in from outside is through the proxy.
 *
 *   GET  /status         → state, session, model, volume, transcript ring
 *   POST /speak {message} → Bruce says the message out loud
 *   POST /volume {percent} → set speech volume (0–200, 100 = native)
 *   POST /wake-ack {mode} → what the wake phrase triggers (speak|plop|none)
 */

const http = require('http');
const { WAKE_ACK_MODES } = require('../config');

const MAX_BODY_BYTES = 4096;

function readJsonBody(req, res, onBody) {
  let body = '';
  let overflow = false;
  req.on('data', (chunk) => {
    body += chunk;
    if (body.length > MAX_BODY_BYTES) {
      overflow = true;
      req.destroy();
    }
  });
  req.on('end', () => {
    if (overflow) return; // connection killed
    try {
      onBody(body ? JSON.parse(body) : {});
    } catch {
      sendJson(res, 400, { error: 'Invalid JSON body' });
    }
  });
}

function sendJson(res, status, payload) {
  const data = JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(data);
}

/**
 * @param {object} opts
 * @param {import('./engine')} opts.bruce - The running assistant
 * @param {Array} opts.transcript - Ring buffer of transcript entries (managed by main.js)
 * @param {string} opts.model - The realtime model in use (for display)
 * @param {number} [opts.port=3555]
 * @returns {import('http').Server}
 */
function startStatusServer({ bruce, transcript, model, port = 3555 }) {
  const startedAt = new Date().toISOString();

  const server = http.createServer((req, res) => {
    const url = (req.url || '/').split('?')[0];

    if (req.method === 'GET' && url === '/status') {
      return sendJson(res, 200, {
        state: bruce.state,
        connected: bruce.connected,
        model,
        volumePercent: Math.round(bruce.volume * 100),
        wakeAck: bruce.wakeAck,
        startedAt,
        transcript,
      });
    }

    if (req.method === 'POST' && url === '/speak') {
      return readJsonBody(req, res, (body) => {
        const message = typeof body.message === 'string' ? body.message.trim() : '';
        if (!message) return sendJson(res, 400, { error: 'message is required' });
        transcript.push({ type: 'system', content: `Dashboard speak request: ${message}`, timestamp: Date.now() });
        bruce.speak(`[SYSTEM] A message was sent from the dashboard. Say the following to the user, word for word. Do not add anything else: "${message}"`);
        return sendJson(res, 202, { ok: true });
      });
    }

    if (req.method === 'POST' && url === '/volume') {
      return readJsonBody(req, res, (body) => {
        const percent = Number(body.percent);
        if (!Number.isFinite(percent)) return sendJson(res, 400, { error: 'percent must be a number' });
        const clamped = Math.max(0, Math.min(200, percent));
        bruce.setVolume(clamped / 100);
        return sendJson(res, 200, { volumePercent: Math.round(bruce.volume * 100) });
      });
    }

    if (req.method === 'POST' && url === '/wake-ack') {
      return readJsonBody(req, res, (body) => {
        const mode = typeof body.mode === 'string' ? body.mode.trim().toLowerCase() : '';
        if (!WAKE_ACK_MODES.includes(mode)) {
          return sendJson(res, 400, { error: `mode must be one of: ${WAKE_ACK_MODES.join(', ')}` });
        }
        bruce.setWakeAck(mode);
        return sendJson(res, 200, { wakeAck: bruce.wakeAck });
      });
    }

    return sendJson(res, 404, { error: 'Not found' });
  });

  // A port clash must not kill the assistant — Bruce works fine without the
  // status API; the dashboard page just shows him as unreachable.
  server.on('error', (err) => {
    console.error(`[Bruce] Status API disabled (${err.message})`);
  });
  server.listen(port, '127.0.0.1', () => {
    console.log(`[Bruce] Status API listening on 127.0.0.1:${port}`);
  });
  return server;
}

module.exports = { startStatusServer };
