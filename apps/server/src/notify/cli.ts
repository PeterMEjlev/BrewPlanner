import { TelegramNotConfiguredError, fetchChats, sendTelegram } from './telegram.js';

/**
 * Telegram notification helpers (no server required):
 *   npm run notify -- chat-id          list chats that have messaged the bot,
 *                                      so you can find your TELEGRAM_CHAT_ID
 *   npm run notify -- test [message]   send a test message to TELEGRAM_CHAT_ID
 *
 * Env: TELEGRAM_BOT_TOKEN (required), TELEGRAM_CHAT_ID (required for `test`).
 */
const args = process.argv.slice(2);
const [cmd, ...rest] = args;

function usage(): never {
  console.error(
    'Usage:\n' +
      '  npm run notify -- chat-id          list chats that have messaged the bot\n' +
      '  npm run notify -- test [message]   send a test message to TELEGRAM_CHAT_ID\n' +
      '\nEnv: TELEGRAM_BOT_TOKEN (required), TELEGRAM_CHAT_ID (required for test).',
  );
  process.exit(1);
}

async function main(): Promise<void> {
  if (cmd === 'chat-id') {
    const chats = await fetchChats();
    if (chats.length === 0) {
      console.log(
        'No chats found. Open Telegram, send any message to your bot, then run this again.\n' +
          '(getUpdates only returns recent updates — and none at all if a webhook is set.)',
      );
      return;
    }
    console.log('Chats that have messaged your bot:\n');
    for (const c of chats) {
      console.log(`  ${c.id}\t${c.type}\t${c.label}`);
    }
    console.log('\nSet the chat you want as TELEGRAM_CHAT_ID.');
  } else if (cmd === 'test') {
    const message =
      rest.join(' ').trim() || '✅ <b>BrewPlanner</b> test notification — Telegram is wired up!';
    await sendTelegram(message);
    console.log('Sent. Check your Telegram chat.');
  } else {
    usage();
  }
}

main().catch((err) => {
  if (err instanceof TelegramNotConfiguredError) {
    console.error(err.message);
  } else {
    console.error(err instanceof Error ? err.message : err);
  }
  process.exit(1);
});
