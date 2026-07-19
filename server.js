import 'dotenv/config';
import express from 'express';
import { WebSocketServer } from 'ws';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'node:crypto';
import { sendMessage, editMessage, readMessage, getChat, pinMessage } from './telegram.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { BOT_TOKEN, CHAT_ID, PORT = 3000 } = process.env;
let INDEX_MESSAGE_ID = null;

if (!BOT_TOKEN || !CHAT_ID) {
  console.error('Missing BOT_TOKEN or CHAT_ID. Copy .env.example to .env and fill it in.');
  process.exit(1);
}

const CHUNK = 20; // each chunk is a 20x20 block of cells, stored as one Telegram message

// ---- In-memory state ----
const pages = new Map();       // pageName -> Map(cellKey "x,y" -> char)
const pageIndex = new Map();   // pageName -> Map(chunkKey "cx,cy" -> telegram message_id)
const dirtyChunks = new Set(); // "page|chunkKey" waiting to be written to Telegram
let indexDirty = false;

// Cursor positions are ephemeral — kept in memory only, never written to
// Telegram, and lost on restart (which is fine, they're just live presence).
const liveCursors = new Map(); // page -> Map(connectionId -> {x, y})

function chunkKeyOf(x, y) {
  return `${Math.floor(x / CHUNK)},${Math.floor(y / CHUNK)}`;
}
function getCells(page) {
  if (!pages.has(page)) pages.set(page, new Map());
  return pages.get(page);
}
function getIndex(page) {
  if (!pageIndex.has(page)) pageIndex.set(page, new Map());
  return pageIndex.get(page);
}

// ---- Bootstrap / persist the global index ----
// The index (which chunk lives in which Telegram message) is itself stored
// as one Telegram message that we keep editing in place. To find it again
// after a restart (without any manual setup step), we PIN that message in
// the chat and use getChat to read its text straight from the chat info —
// no need to know or copy a message ID by hand.
async function loadOrCreateIndex() {
  const chat = await getChat(BOT_TOKEN, CHAT_ID);
  if (chat.pinned_message && chat.pinned_message.text !== undefined) {
    INDEX_MESSAGE_ID = chat.pinned_message.message_id;
    console.log(`Found existing index message (id ${INDEX_MESSAGE_ID}), loading it.`);
    try {
      return JSON.parse(chat.pinned_message.text || '{}');
    } catch {
      return {};
    }
  }

  console.log('No pinned index message found — creating and pinning a new one.');
  const msg = await sendMessage(BOT_TOKEN, CHAT_ID, '{}');
  INDEX_MESSAGE_ID = msg.message_id;
  await pinMessage(BOT_TOKEN, CHAT_ID, msg.message_id);
  return {};
}

async function flushIndex() {
  if (!indexDirty) return;
  const obj = {};
  for (const [page, chunkMap] of pageIndex.entries()) {
    obj[page] = Object.fromEntries(chunkMap);
  }
  await editMessage(BOT_TOKEN, CHAT_ID, INDEX_MESSAGE_ID, JSON.stringify(obj));
  indexDirty = false;
}

// ---- Chunk load / save ----
async function loadChunk(page, ck) {
  const idx = getIndex(page);
  const msgId = idx.get(ck);
  if (!msgId) return; // nothing written here yet
  const text = await readMessage(BOT_TOKEN, CHAT_ID, msgId);
  try {
    const data = JSON.parse(text);
    const cells = getCells(page);
    for (const [k, v] of Object.entries(data.cells || {})) cells.set(k, v);
  } catch (e) {
    console.error('Failed to parse chunk', page, ck, e.message);
  }
}

async function flushChunk(page, ck) {
  const cells = getCells(page);
  const [cx, cy] = ck.split(',').map(Number);
  const chunkCells = {};
  for (const [key, val] of cells.entries()) {
    const [x, y] = key.split(',').map(Number);
    if (Math.floor(x / CHUNK) === cx && Math.floor(y / CHUNK) === cy) {
      chunkCells[key] = val;
    }
  }
  const payload = JSON.stringify({ page, chunk: ck, cells: chunkCells });
  const idx = getIndex(page);
  if (idx.has(ck)) {
    await editMessage(BOT_TOKEN, CHAT_ID, idx.get(ck), payload);
  } else {
    const msg = await sendMessage(BOT_TOKEN, CHAT_ID, payload);
    idx.set(ck, msg.message_id);
    indexDirty = true;
  }
}

// Debounced writer: batches rapid edits instead of hammering Telegram
// (the Bot API rate-limits edits to the same chat).
setInterval(async () => {
  if (dirtyChunks.size === 0 && !indexDirty) return;
  const batch = Array.from(dirtyChunks);
  dirtyChunks.clear();
  for (const item of batch) {
    const [page, ck] = item.split('|');
    try {
      await flushChunk(page, ck);
    } catch (e) {
      console.error('flushChunk failed', item, e.message);
      dirtyChunks.add(item); // retry next cycle
    }
  }
  try {
    await flushIndex();
  } catch (e) {
    console.error('flushIndex failed', e.message);
  }
}, 2000);

// ---- Express + WebSocket ----
const app = express();
app.use(express.static(path.join(__dirname, 'public')));

// Any URL path is its own infinite page — created the moment someone writes on it.
app.get('/:page', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  ws.id = randomUUID();

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'join') {
      ws.page = msg.page || 'default';
      // Send this client the current cursor positions of everyone already
      // on the page, so presence is visible immediately, not just on the
      // next move.
      const cursors = liveCursors.get(ws.page);
      if (cursors) {
        for (const [id, pos] of cursors.entries()) {
          if (id !== ws.id) {
            ws.send(JSON.stringify({ type: 'cursor', id, x: pos.x, y: pos.y }));
          }
        }
      }
    }

    if (msg.type === 'cursor') {
      const { page, x, y } = msg;
      if (!liveCursors.has(page)) liveCursors.set(page, new Map());
      liveCursors.get(page).set(ws.id, { x, y });
      for (const client of wss.clients) {
        if (client !== ws && client.page === page && client.readyState === 1) {
          client.send(JSON.stringify({ type: 'cursor', id: ws.id, x, y }));
        }
      }
    }

    if (msg.type === 'requestChunks') {
      const { page, chunks } = msg;
      const cells = getCells(page);
      for (const ck of chunks) {
        const [cx, cy] = ck.split(',').map(Number);
        const already = Array.from(cells.keys()).some((k) => {
          const [x, y] = k.split(',').map(Number);
          return Math.floor(x / CHUNK) === cx && Math.floor(y / CHUNK) === cy;
        });
        if (!already) await loadChunk(page, ck);
      }
      const out = {};
      for (const [k] of cells.entries()) {
        const [x, y] = k.split(',').map(Number);
        const ck = `${Math.floor(x / CHUNK)},${Math.floor(y / CHUNK)}`;
        if (chunks.includes(ck)) out[k] = cells.get(k);
      }
      ws.send(JSON.stringify({ type: 'chunkData', cells: out }));
    }

    if (msg.type === 'edit') {
      const { page, x, y, char } = msg;
      const cells = getCells(page);
      const key = `${x},${y}`;
      if (char === '') cells.delete(key); else cells.set(key, char);
      dirtyChunks.add(`${page}|${chunkKeyOf(x, y)}`);

      for (const client of wss.clients) {
        if (client !== ws && client.page === page && client.readyState === 1) {
          client.send(JSON.stringify({ type: 'edit', x, y, char }));
        }
      }
    }
  });

  ws.on('close', () => {
    if (ws.page && liveCursors.has(ws.page)) {
      liveCursors.get(ws.page).delete(ws.id);
      for (const client of wss.clients) {
        if (client !== ws && client.page === ws.page && client.readyState === 1) {
          client.send(JSON.stringify({ type: 'cursorLeave', id: ws.id }));
        }
      }
    }
  });
});

loadOrCreateIndex().then((obj) => {
  for (const [page, chunkMap] of Object.entries(obj)) {
    pageIndex.set(page, new Map(Object.entries(chunkMap)));
  }
  server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
});
