'use strict';

/**
 * Everything Bruce knows about BrewPlanner, fetched from BrewPlanner.
 *
 * This one file replaces what used to be six — kegs, stats, devices, recipes,
 * todos and settings — each of which was a second implementation of a tool the
 * server already had for its written chat. Two copies of "what is in the
 * fermenter" drift, and they did: the server grew the brew-session log, sensor
 * history and the calculators while the speaker in the brewery kept answering
 * from the older set.
 *
 * So the definitions are fetched from `GET /api/bruce/voice/tools` and each one
 * is registered as a handler that posts the call straight back to
 * `POST /api/bruce/voice/tool`, where it runs against the hub's own database and
 * is audited like any other change. A tool added to apps/server/src/bruce/tools.ts
 * now appears here, in the written chat, and in the phone's voice mode at once,
 * with no second version to keep in step.
 *
 * What stays local to this process is what genuinely lives here: the rig
 * controls (see brewSystem.js — the speaker is the one place with full control
 * of the heaters), reminders, and Bruce's own speaking volume.
 */

/** Tools the speaker answers better itself; see brewSystem.js. */
const SKIP = new Set([
  // The rig is read-only from the server's tools by design. This process has
  // the full set — temperatures, elements, pumps, the timer — so registering
  // the server's read-only version alongside them would give the model two
  // tools for one question and a worse answer from the wrong one.
  'get_rig_status',
]);

/**
 * The hub is on the same Pi, and at boot both services come up together — so
 * "the server isn't answering yet" is the normal case, not an error. Bruce
 * keeps trying in the background rather than starting deaf to the brewery.
 */
const RETRY_DELAY_MS = 15_000;
const MAX_ATTEMPTS = 40; // ~10 minutes of trying before giving up quietly

/**
 * Fetch the hub's tool definitions and register each as a proxy.
 *
 * @param {import('../engine')} bruce
 * @param {(method: string, endpoint: string, body?: object) => Promise<any>} apiCall
 * @returns {Promise<number>} how many tools were registered
 */
async function registerOnce(bruce, apiCall) {
  const { tools } = await apiCall('GET', '/api/bruce/voice/tools');
  if (!Array.isArray(tools)) throw new Error('The hub returned no tool definitions.');

  let count = 0;
  for (const tool of tools) {
    if (!tool || typeof tool.name !== 'string' || SKIP.has(tool.name)) continue;
    bruce.registerFunction(
      tool.name,
      tool.description || '',
      tool.parameters || { type: 'object', properties: {}, required: [] },
      async (args) => {
        // The server answers every failure as text — an unknown tool, a bad
        // argument, a sheet that wouldn't answer — so the only errors reaching
        // here are the transport itself being down.
        const result = await apiCall('POST', '/api/bruce/voice/tool', {
          name: tool.name,
          args: args || {},
        });
        return result && typeof result.output === 'string'
          ? result.output
          : 'The hub answered, but with nothing to say.';
      },
    );
    count++;
  }
  return count;
}

/**
 * Register the hub's tools, retrying in the background until the server is up.
 *
 * Returns immediately: Bruce is useful without them (he can still drive the rig
 * and set reminders), and a wake word during the first few seconds of a reboot
 * should get an answer rather than silence. `registerFunction` re-sends the
 * session configuration, so tools that land after a conversation has started
 * are picked up mid-session.
 *
 * @param {import('../engine')} bruce
 * @param {(method: string, endpoint: string, body?: object) => Promise<any>} apiCall
 */
function register(bruce, apiCall) {
  let attempt = 0;

  const attemptRegistration = async () => {
    attempt++;
    try {
      const count = await registerOnce(bruce, apiCall);
      console.log(`[Bruce] Registered ${count} tools from BrewPlanner`);
    } catch (err) {
      if (attempt >= MAX_ATTEMPTS) {
        console.error(
          `[Bruce] Could not fetch the hub's tools after ${attempt} attempts (${err.message}). ` +
            'Bruce can still control the rig and set reminders; restart the service once the server is up.',
        );
        return;
      }
      if (attempt === 1) {
        console.log(`[Bruce] BrewPlanner not answering yet (${err.message}) — retrying in the background`);
      }
      setTimeout(attemptRegistration, RETRY_DELAY_MS).unref?.();
    }
  };

  void attemptRegistration();
}

module.exports = { register, registerOnce, SKIP };
