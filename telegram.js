// Thin wrapper around the Telegram Bot HTTP API.
// Node 18+ has a global `fetch`, so no extra HTTP library is needed.

const base = (token) => `https://api.telegram.org/bot${token}`;

export async function tgCall(token, method, params) {
  const res = await fetch(`${base(token)}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params)
  });
  const data = await res.json();
  if (!data.ok) {
    throw new Error(`Telegram API error in ${method}: ${data.description}`);
  }
  return data.result;
}

export function sendMessage(token, chatId, text) {
  return tgCall(token, 'sendMessage', {
    chat_id: chatId,
    text,
    disable_notification: true
  });
}

export function editMessage(token, chatId, messageId, text) {
  return tgCall(token, 'editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text
  });
}

// IMPORTANT: The Bot API has no "getMessage" method — a bot cannot fetch the
// text of an arbitrary past message just by knowing its ID. The workaround
// used everywhere in this project is to forward the message back into the
// same chat (the forward response includes the full text), then immediately
// delete that forwarded copy so the chat doesn't fill up with duplicates.
export async function readMessage(token, chatId, messageId) {
  const forwarded = await tgCall(token, 'forwardMessage', {
    chat_id: chatId,
    from_chat_id: chatId,
    message_id: messageId,
    disable_notification: true
  });
  tgCall(token, 'deleteMessage', {
    chat_id: chatId,
    message_id: forwarded.message_id
  }).catch(() => {});
  return forwarded.text ?? '';
}
