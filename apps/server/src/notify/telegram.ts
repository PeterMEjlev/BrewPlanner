/**
 * Telegram notifications. The bot token and target chat id are held server-side
 * (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID env vars) and never exposed to the
 * browser — the same pattern as the Brewer's Friend key (see brewersfriend.ts).
 * Sending is a single outbound HTTPS call, so no SDK is needed (Node 20 ships a
 * global fetch).
 *
 * Find your chat id once by messaging the bot from Telegram, then running
 * `npm run notify -- chat-id`.
 */

const apiBase = (token: string) => `https://api.telegram.org/bot${token}`;

/** Thrown when the required env vars are missing, so callers can react distinctly. */
export class TelegramNotConfiguredError extends Error {
  constructor(message = 'Telegram is not configured (set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID).') {
    super(message);
    this.name = 'TelegramNotConfiguredError';
  }
}

/** Whether both the bot token and a target chat id are configured. */
export function isConfigured(): boolean {
  return Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID);
}

/**
 * Send a message to the configured chat. `text` may use Telegram's HTML subset
 * (`<b>`, `<i>`, `<code>`, `<a href>`, …) since we send with `parse_mode=HTML`.
 * Throws {@link TelegramNotConfiguredError} when unconfigured, or a generic
 * Error if the Telegram API rejects the send.
 */
export async function sendTelegram(text: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) throw new TelegramNotConfiguredError();

  const res = await fetch(`${apiBase(token)}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    }),
  });
  if (!res.ok) {
    // Telegram returns a JSON body with a human-readable `description` on error.
    const detail = await res.text().catch(() => '');
    throw new Error(`Telegram sendMessage failed: ${res.status} ${res.statusText} ${detail}`.trim());
  }
}

/** A chat that has interacted with the bot, distilled from a getUpdates result. */
export interface TelegramChat {
  id: number;
  type: string;
  /** Group/channel title, or the user's display name for a private chat. */
  label: string;
}

interface RawChat {
  id: number;
  type: string;
  title?: string;
  username?: string;
  first_name?: string;
}
interface RawMessage {
  chat?: RawChat;
}
interface RawUpdate {
  message?: RawMessage;
  edited_message?: RawMessage;
  channel_post?: RawMessage;
  my_chat_member?: RawMessage;
}

/**
 * List the distinct chats that have recently messaged the bot, so you can pick
 * the right TELEGRAM_CHAT_ID. Only the token is required (you don't have a chat
 * id yet). Note: getUpdates only returns recent updates and returns nothing when
 * a webhook is configured — message the bot first, then call this.
 */
export async function fetchChats(): Promise<TelegramChat[]> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new TelegramNotConfiguredError('Set TELEGRAM_BOT_TOKEN to look up chats.');

  const res = await fetch(`${apiBase(token)}/getUpdates`);
  if (!res.ok) throw new Error(`Telegram getUpdates failed: ${res.status} ${res.statusText}`);
  const body = (await res.json()) as { ok: boolean; result?: RawUpdate[] };

  const byId = new Map<number, TelegramChat>();
  for (const u of body.result ?? []) {
    const chat = (u.message ?? u.edited_message ?? u.channel_post ?? u.my_chat_member)?.chat;
    if (!chat) continue;
    byId.set(chat.id, {
      id: chat.id,
      type: chat.type,
      label: chat.title ?? chat.username ?? chat.first_name ?? '(unknown)',
    });
  }
  return [...byId.values()];
}
