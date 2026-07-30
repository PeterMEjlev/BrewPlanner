'use strict';

/**
 * The brewery to-do list (GET/POST/PATCH/DELETE /api/todos) — the standalone
 * running list, deliberately not the brew-day checklist.
 *
 * This is the one BrewPlanner feature that is genuinely better by voice: the
 * thought "we're low on CO2" arrives with both hands full of hose, and the
 * alternative is remembering it until you reach a keyboard.
 *
 * Items are addressed by what they say rather than by number, because nobody
 * reads the list before adding to it. Every match is echoed back in the reply,
 * and an ambiguous one returns the candidates instead of guessing — deleting
 * the wrong line is not recoverable by voice.
 */

/** Lower-case, punctuation-free, single-spaced — for comparing by hand. */
function normalize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The to-dos a spoken phrase could mean, best first.
 *
 * Exact text wins outright; otherwise substring matches either way round, then
 * anything sharing a word. Returns every candidate at the best tier reached, so
 * the caller can ask which one rather than pick.
 */
function findTodos(todos, wanted) {
  const target = normalize(wanted);
  if (!target) return [];

  const exact = todos.filter((t) => normalize(t.text) === target);
  if (exact.length) return exact;

  const contains = todos.filter((t) => {
    const text = normalize(t.text);
    return text.includes(target) || target.includes(text);
  });
  if (contains.length) return contains;

  const words = new Set(target.split(' '));
  const scored = todos
    .map((todo) => ({
      todo,
      score: normalize(todo.text)
        .split(' ')
        .filter((word) => words.has(word)).length,
    }))
    .filter((entry) => entry.score > 0);
  if (scored.length === 0) return [];

  const best = Math.max(...scored.map((entry) => entry.score));
  return scored.filter((entry) => entry.score === best).map((entry) => entry.todo);
}

/** "1 item"/"2 items" — TTS reads "1 items" out loud verbatim. */
function itemNoun(n) {
  return n === 1 ? 'item' : 'items';
}

function register(bruce, apiCall) {
  /** Resolve a spoken phrase to one to-do, or a sentence explaining why not. */
  async function resolve(text, pool) {
    const todos = await apiCall('GET', '/api/todos');
    const candidates = findTodos(pool ? todos.filter(pool) : todos, text);

    if (candidates.length === 0) {
      return { error: `Nothing on the to-do list matches "${text}".` };
    }
    if (candidates.length > 1) {
      const list = candidates.map((t) => `"${t.text}"`).join(', ');
      return { error: `Several to-dos match "${text}" — ask the user which one they mean: ${list}.` };
    }
    return { todo: candidates[0] };
  }

  // ── Reading the list ────────────────────────────────────────────────────

  bruce.registerFunction(
    'get_todos',
    'Read the brewery to-do list — the running list of jobs, not the brew-day checklist. Use for "what\'s on the to-do list?", "what do I still need to do?" or "have I got anything outstanding?". Completed items are counted, not read out, unless asked for.',
    {
      type: 'object',
      properties: {
        include_done: { type: 'boolean', description: 'Read the completed items out too (default false)' },
      },
      required: [],
    },
    async ({ include_done = false } = {}) => {
      const todos = await apiCall('GET', '/api/todos');
      const open = todos.filter((t) => !t.done);
      const done = todos.filter((t) => t.done);

      if (todos.length === 0) return 'The to-do list is empty.';
      if (open.length === 0 && !include_done) {
        return `Nothing outstanding — all ${done.length} ${itemNoun(done.length)} on the list are done.`;
      }

      const lines = [
        open.length === 0
          ? 'Nothing outstanding.'
          : `${open.length} ${itemNoun(open.length)} outstanding${done.length ? `, and ${done.length} already done` : ''}.`,
      ];
      for (const todo of open) lines.push(todo.text + '.');
      if (include_done) {
        for (const todo of done) lines.push(`Done: ${todo.text}.`);
      }
      return lines.join('\n');
    },
  );

  // ── Changing the list ───────────────────────────────────────────────────

  bruce.registerFunction(
    'add_todo',
    'Add a job to the brewery to-do list — "add order more CO2 to the list", "remind me to descale the HLT". Write it as a short task the user would recognise later. For something that should be spoken back at a specific time instead, use set_reminder.',
    {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The task, as a short phrase (e.g. "Order more CO2")' },
      },
      required: ['text'],
    },
    async ({ text }) => {
      const trimmed = String(text || '').trim();
      if (!trimmed) return 'I need to know what the job is before I can add it.';
      const created = await apiCall('POST', '/api/todos', { text: trimmed });
      return `Added "${created && created.text ? created.text : trimmed}" to the to-do list.`;
    },
  );

  bruce.registerFunction(
    'complete_todo',
    'Tick a job off the brewery to-do list — "I\'ve ordered the CO2", "mark descale the HLT as done". Matched against the text of the item; if several match, the candidates come back so you can ask which one.',
    {
      type: 'object',
      properties: {
        text: { type: 'string', description: '(Part of) what the item says' },
      },
      required: ['text'],
    },
    async ({ text }) => {
      const found = await resolve(text, (t) => !t.done);
      if (found.error) return found.error;
      await apiCall('PATCH', `/api/todos/${found.todo.id}`, { done: true });
      return `Ticked off "${found.todo.text}".`;
    },
  );

  bruce.registerFunction(
    'reopen_todo',
    'Put a completed job back on the to-do list — "that CO2 order never went through, put it back". Matched against the text of the item.',
    {
      type: 'object',
      properties: {
        text: { type: 'string', description: '(Part of) what the item says' },
      },
      required: ['text'],
    },
    async ({ text }) => {
      const found = await resolve(text, (t) => t.done);
      if (found.error) return found.error;
      await apiCall('PATCH', `/api/todos/${found.todo.id}`, { done: false });
      return `Put "${found.todo.text}" back on the list.`;
    },
  );

  bruce.registerFunction(
    'delete_todo',
    'Remove a job from the brewery to-do list entirely — for something that is no longer needed rather than something that was done (use complete_todo for that). Only call this when the user clearly asked to delete or drop the item; the item text is echoed back so a wrong match is audible.',
    {
      type: 'object',
      properties: {
        text: { type: 'string', description: '(Part of) what the item says' },
      },
      required: ['text'],
    },
    async ({ text }) => {
      const found = await resolve(text);
      if (found.error) return found.error;
      await apiCall('DELETE', `/api/todos/${found.todo.id}`);
      return `Removed "${found.todo.text}" from the to-do list.`;
    },
  );

  bruce.registerFunction(
    'clear_completed_todos',
    'Delete every ticked-off item from the to-do list at once, leaving the outstanding ones. Use for "clear the finished jobs" or "tidy up the to-do list".',
    { type: 'object', properties: {}, required: [] },
    async () => {
      const before = await apiCall('GET', '/api/todos');
      const done = before.filter((t) => t.done).length;
      if (done === 0) return 'There are no completed items to clear.';
      const after = await apiCall('POST', '/api/todos/clear-completed');
      const left = Array.isArray(after) ? after.length : 0;
      return `Cleared ${done} completed ${itemNoun(done)}. ${left} ${itemNoun(left)} still on the list.`;
    },
  );
}

module.exports = { register, findTodos };
