import 'dotenv/config';
import express from 'express';
import { WebSocketServer } from 'ws';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { sendMessage, editMessage, readMessage } from './telegram.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { BOT_TOKEN, CHAT_ID, PORT = 3000 } = process.env;
let { INDEX_MESSAGE_ID } = process.env;

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
// as one Telegram message that we keep editing in place.
async function loadOrCreateIndex() {
  if (!INDEX_MESSAGE_ID) {
    const msg = await sendMessage(BOT_TOKEN, CHAT_ID, '{}');
    console.log('\n>>> First run: no INDEX_MESSAGE_ID set.');
    console.log('>>> Add this to your environment variables and restart the server:');
    console.log(`INDEX_MESSAGE_ID=${msg.message_id}\n`);
    INDEX_MESSAGE_ID = String(msg.message_id);
    return {};
  }
  const text = await readMessage(BOT_TOKEN, CHAT_ID, INDEX_MESSAGE_ID);
  try {
    return JSON.parse(text || '{}');
  } catch {
    return {};
  }
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
  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'join') {
      ws.page = msg.page || 'default';
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
});

loadOrCreateIndex().then((obj) => {
  for (const [page, chunkMap] of Object.entries(obj)) {
    pageIndex.set(page, new Map(Object.entries(chunkMap)));
  }
  server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
});
