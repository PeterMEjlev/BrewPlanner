'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// ── Reminder persistence ────────────────────────────────────────────────────
//
// Reminders survive restarts (crash, deploy, session reset): pending ones are
// written to a small JSON file OUTSIDE the git checkout, re-armed on startup.
// A reminder that should have fired while Bruce was down is spoken belatedly
// if it is less than MISSED_GRACE_MS late, otherwise dropped with a log — a
// "check the mash" from yesterday helps nobody.

const STATE_DIR = process.env.BRUCE_STATE_DIR || path.join(os.homedir(), '.bruce');
const REMINDERS_FILE = path.join(STATE_DIR, 'reminders.json');
const MISSED_GRACE_MS = 10 * 60 * 1000;

/** Speak-friendly remaining time, e.g. "1 hour and 12 minutes". */
function formatRemaining(ms) {
  const totalSec = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const parts = [];
  if (h > 0) parts.push(`${h} hour${h !== 1 ? 's' : ''}`);
  if (m > 0) parts.push(`${m} minute${m !== 1 ? 's' : ''}`);
  if (s > 0 && h === 0) parts.push(`${s} second${s !== 1 ? 's' : ''}`);
  return parts.length ? parts.join(' and ') : 'less than a second';
}

// ── Register tool/utility functions on Bruce ────────────────────────────────

function register(bruce) {
  // ── Reminders ──────────────────────────────────────────────────────────

  // id -> { message, firesAt, timer }
  const reminders = new Map();
  let reminderId = 0;

  function saveReminders() {
    try {
      fs.mkdirSync(STATE_DIR, { recursive: true });
      const list = [...reminders.entries()].map(([id, r]) => ({
        id,
        message: r.message,
        firesAt: r.firesAt,
      }));
      // Write-then-rename so a crash mid-write can't corrupt the file.
      const tmp = `${REMINDERS_FILE}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(list, null, 2));
      fs.renameSync(tmp, REMINDERS_FILE);
    } catch (err) {
      console.error('[Bruce] Could not persist reminders:', err.message);
    }
  }

  function fireReminder(id, belatedMs = 0) {
    const r = reminders.get(id);
    if (!r) return;
    reminders.delete(id);
    saveReminders();
    console.log(`[Bruce] Reminder fired: ${r.message}`);
    const belated =
      belatedMs > 30000
        ? ` Mention that this reminder is about ${Math.round(belatedMs / 60000)} minutes late because you were restarted.`
        : '';
    bruce.speak(`[SYSTEM] A scheduled reminder has fired. You MUST say the following reminder out loud to the user, word for word. Do not say anything else, no greetings, no follow-ups. Just deliver the reminder: "${r.message}"${belated}`);
  }

  function armReminder(id, message, firesAt) {
    const timer = setTimeout(() => fireReminder(id), Math.max(0, firesAt - Date.now()));
    reminders.set(id, { message, firesAt, timer });
  }

  // Restore persisted reminders once the assistant is up (speak() needs the
  // engine running to deliver anything that fired while we were down).
  bruce.once('ready', () => {
    let saved = [];
    try {
      saved = JSON.parse(fs.readFileSync(REMINDERS_FILE, 'utf-8'));
    } catch {
      return; // no file yet, or unreadable — start clean
    }
    if (!Array.isArray(saved) || saved.length === 0) return;

    const now = Date.now();
    for (const r of saved) {
      if (!r || typeof r.message !== 'string' || !Number.isFinite(r.firesAt)) continue;
      const id = ++reminderId;
      if (r.firesAt > now) {
        armReminder(id, r.message, r.firesAt);
        console.log(`[Bruce] Restored reminder: "${r.message}" in ${formatRemaining(r.firesAt - now)}`);
      } else if (now - r.firesAt <= MISSED_GRACE_MS) {
        reminders.set(id, { message: r.message, firesAt: r.firesAt, timer: null });
        fireReminder(id, now - r.firesAt);
      } else {
        console.log(`[Bruce] Dropping stale reminder from before restart: "${r.message}"`);
      }
    }
    saveReminders();
  });

  bruce.registerFunction(
    'set_reminder',
    'Set a timed reminder. Bruce will speak the reminder after the specified delay. For example "remind me to add hops in 10 minutes" or "remind me to check the mash in 1 hour and 30 minutes". Reminders survive restarts.',
    {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'What to remind the user about' },
        hours: { type: 'number', description: 'Hours from now (default 0)' },
        minutes: { type: 'number', description: 'Minutes from now (default 0)' },
        seconds: { type: 'number', description: 'Seconds from now (default 0)' },
      },
      required: ['message'],
    },
    async ({ message, hours = 0, minutes = 0, seconds = 0 }) => {
      const totalMs = Math.round((hours * 3600 + minutes * 60 + seconds) * 1000);
      if (totalMs <= 0) return 'Please specify a time in the future for the reminder.';

      const id = ++reminderId;
      armReminder(id, message, Date.now() + totalMs);
      saveReminders();

      return `Reminder ${id} set: "${message}" in ${formatRemaining(totalMs)}.`;
    }
  );

  bruce.registerFunction(
    'list_reminders',
    'List all pending reminders with their remaining time. Use when the user asks "what reminders do I have?" or before cancelling one.',
    { type: 'object', properties: {}, required: [] },
    async () => {
      if (reminders.size === 0) return 'You have no reminders set.';
      const now = Date.now();
      const lines = [`You have ${reminders.size} reminder${reminders.size !== 1 ? 's' : ''}:`];
      for (const [id, r] of reminders) {
        lines.push(`Reminder ${id}: "${r.message}", fires in ${formatRemaining(r.firesAt - now)}.`);
      }
      return lines.join('\n');
    }
  );

  bruce.registerFunction(
    'cancel_reminder',
    'Cancel a pending reminder, by its number or by (part of) its message text — e.g. "cancel the hop reminder". If several match, the function returns the candidates so you can ask the user which one.',
    {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'The reminder number, if known' },
        message: { type: 'string', description: 'Part of the reminder text to match, if the number is not known' },
      },
      required: [],
    },
    async ({ id, message } = {}) => {
      let matches = [];
      if (id != null && reminders.has(id)) {
        matches = [id];
      } else if (message) {
        const needle = message.toLowerCase();
        matches = [...reminders.entries()]
          .filter(([, r]) => r.message.toLowerCase().includes(needle))
          .map(([key]) => key);
      }

      if (matches.length === 0) {
        return reminders.size === 0
          ? 'There are no reminders to cancel.'
          : 'No reminder matches that. Ask the user which one they mean, or call list_reminders.';
      }
      if (matches.length > 1) {
        const now = Date.now();
        const lines = ['Several reminders match — ask the user which one to cancel:'];
        for (const key of matches) {
          const r = reminders.get(key);
          lines.push(`Reminder ${key}: "${r.message}", fires in ${formatRemaining(r.firesAt - now)}.`);
        }
        return lines.join('\n');
      }

      const key = matches[0];
      const r = reminders.get(key);
      if (r.timer) clearTimeout(r.timer);
      reminders.delete(key);
      saveReminders();
      return `Cancelled reminder ${key}: "${r.message}".`;
    }
  );

  // ── Speech volume ──────────────────────────────────────────────────────

  bruce.registerFunction(
    'set_volume',
    'Set how loud Bruce speaks. 100 is normal volume, 50 is half, 0 is mute, up to 200 for a boost on quiet speakers. Use when the user says things like "speak quieter", "set your volume to 50 percent", or "louder please".',
    {
      type: 'object',
      properties: {
        percent: { type: 'number', description: 'Volume percentage, 0–200 (100 = normal)' },
      },
      required: ['percent'],
    },
    async ({ percent }) => {
      const clamped = Math.max(0, Math.min(200, percent));
      bruce.setVolume(clamped / 100);
      if (clamped === 0) return 'Volume muted. Say "set volume to 100 percent" to hear me again.';
      return `Volume set to ${clamped} percent.`;
    }
  );

  // The three brewing calculators that used to live here — dilution,
  // hydrometer correction and carbonation pressure — are now the hub's
  // `brewing_calculator` tool (apps/server/src/bruce/tools.ts), registered by
  // functions/hub.js along with the rest of BrewPlanner. Same formulas, one
  // copy, and the written chat gets them too.
}

module.exports = { register };
