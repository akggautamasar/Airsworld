const CELL_W = 16, CELL_H = 20, CHUNK = 20;
const DEFAULT_COLOR = '#111111';

const canvas = document.getElementById('grid');
const ctx = canvas.getContext('2d');
const mobileInput = document.getElementById('mobileInput');
const colorPicker = document.getElementById('colorPicker');
const coordsToggle = document.getElementById('coordsToggle');
const coordsDisplay = document.getElementById('coords');
const eraserToggle = document.getElementById('eraserToggle');

let offsetX = 0, offsetY = 0; // top-left visible cell coordinate
let cursorX = 0, cursorY = 0;
const cellData = new Map();     // "x,y" -> encoded cell value (see encodeCell/decodeCell)
const remoteCursors = new Map(); // connectionId -> {x, y}  (other users, ephemeral)
const requestedKeys = new Set();

const page = decodeURIComponent(location.pathname.replace(/^\/+/, '')) || 'default';
document.title = page + " — Air's World";

// ---- Preferences (persisted in this browser only, via localStorage) ----
let currentColor = localStorage.getItem('aw_color') || DEFAULT_COLOR;
colorPicker.value = currentColor;
colorPicker.addEventListener('input', () => {
  currentColor = colorPicker.value;
  localStorage.setItem('aw_color', currentColor);
});

let showCoords = localStorage.getItem('aw_showCoords') === '1';
coordsToggle.checked = showCoords;
coordsDisplay.style.display = showCoords ? 'block' : 'none';
coordsToggle.addEventListener('change', () => {
  showCoords = coordsToggle.checked;
  localStorage.setItem('aw_showCoords', showCoords ? '1' : '0');
  coordsDisplay.style.display = showCoords ? 'block' : 'none';
  updateCoordsDisplay();
});

function updateCoordsDisplay() {
  if (showCoords) coordsDisplay.textContent = `${cursorX}, ${cursorY}`;
}

let eraserMode = localStorage.getItem('aw_eraser') === '1';
eraserToggle.checked = eraserMode;
applyEraserCursor();
eraserToggle.addEventListener('change', () => {
  eraserMode = eraserToggle.checked;
  localStorage.setItem('aw_eraser', eraserMode ? '1' : '0');
  applyEraserCursor();
});
function applyEraserCursor() {
  canvas.style.cursor = eraserMode ? 'cell' : 'text';
}

// Converts a pointer/touch position (viewport coordinates) into the grid
// cell it's over, accounting for the canvas's position and current pan offset.
function cellFromClientXY(clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  const col = Math.floor((clientX - rect.left) / CELL_W);
  const row = Math.floor((clientY - rect.top) / CELL_H);
  return { x: offsetX + col, y: offsetY + row };
}

// ---- Cell encoding: a plain single character = default color. A colored
// character is prefixed with a control character (never typed by a user)
// followed by JSON, so storage stays a single opaque string either way and
// the server/Telegram side needs no changes at all. ----
function encodeCell(ch, color) {
  if (!color || color === DEFAULT_COLOR) return ch;
  return '\u0001' + JSON.stringify({ c: ch, k: color });
}
function decodeCell(value) {
  if (value && value[0] === '\u0001') {
    try {
      const obj = JSON.parse(value.slice(1));
      return { c: obj.c, k: obj.k || DEFAULT_COLOR };
    } catch {
      // fall through to plain-character handling
    }
  }
  return { c: value, k: DEFAULT_COLOR };
}

function resize() {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  draw();
}
window.addEventListener('resize', resize);

const ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host);
let ready = false;

ws.onopen = () => {
  ws.send(JSON.stringify({ type: 'join', page }));
  ready = true;
  requestVisibleChunks();
};

ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.type === 'chunkData') {
    for (const [k, v] of Object.entries(msg.cells)) cellData.set(k, v);
    draw();
  } else if (msg.type === 'edit') {
    const key = `${msg.x},${msg.y}`;
    if (msg.char === '') cellData.delete(key); else cellData.set(key, msg.char);
    draw();
  } else if (msg.type === 'cursor') {
    remoteCursors.set(msg.id, { x: msg.x, y: msg.y });
    draw();
  } else if (msg.type === 'cursorLeave') {
    remoteCursors.delete(msg.id);
    draw();
  }
};

function visibleChunkKeys() {
  const cols = Math.ceil(canvas.width / CELL_W) + 2;
  const rows = Math.ceil(canvas.height / CELL_H) + 2;
  const minCX = Math.floor(offsetX / CHUNK) - 1;
  const maxCX = Math.floor((offsetX + cols) / CHUNK) + 1;
  const minCY = Math.floor(offsetY / CHUNK) - 1;
  const maxCY = Math.floor((offsetY + rows) / CHUNK) + 1;
  const keys = [];
  for (let cx = minCX; cx <= maxCX; cx++) {
    for (let cy = minCY; cy <= maxCY; cy++) keys.push(`${cx},${cy}`);
  }
  return keys;
}

function requestVisibleChunks() {
  if (!ready) return;
  const keys = visibleChunkKeys().filter((k) => !requestedKeys.has(k));
  if (keys.length === 0) return;
  keys.forEach((k) => requestedKeys.add(k));
  ws.send(JSON.stringify({ type: 'requestChunks', page, chunks: keys }));
}

// ---- Live cursor presence: broadcast our position (throttled), never stored ----
let lastCursorSent = 0;
function broadcastCursor() {
  const now = Date.now();
  if (now - lastCursorSent < 120) return;
  lastCursorSent = now;
  ws.send(JSON.stringify({ type: 'cursor', page, x: cursorX, y: cursorY }));
}

function colorForId(id) {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  return `hsl(${hash % 360}, 70%, 45%)`;
}

function draw() {
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.font = '16px monospace';
  ctx.textBaseline = 'top';

  const cols = Math.ceil(canvas.width / CELL_W);
  const rows = Math.ceil(canvas.height / CELL_H);

  for (let row = 0; row <= rows; row++) {
    for (let col = 0; col <= cols; col++) {
      const x = offsetX + col;
      const y = offsetY + row;
      const raw = cellData.get(`${x},${y}`);
      if (!raw) continue;
      const { c, k } = decodeCell(raw);
      ctx.fillStyle = k;
      ctx.fillText(c, col * CELL_W, row * CELL_H);
    }
  }

  // Other users' cursors
  for (const [id, pos] of remoteCursors.entries()) {
    const rx = (pos.x - offsetX) * CELL_W;
    const ry = (pos.y - offsetY) * CELL_H;
    ctx.strokeStyle = colorForId(id);
    ctx.lineWidth = 2;
    ctx.strokeRect(rx + 1, ry + 1, CELL_W - 2, CELL_H - 2);
  }

  // Our own cursor
  const cx = (cursorX - offsetX) * CELL_W;
  const cy = (cursorY - offsetY) * CELL_H;
  ctx.lineWidth = 1;
  ctx.strokeStyle = '#2266ee';
  ctx.strokeRect(cx + 0.5, cy + 0.5, CELL_W - 1, CELL_H - 1);

  updateCoordsDisplay();
}

canvas.addEventListener('click', (e) => {
  const { x, y } = cellFromClientXY(e.clientX, e.clientY);
  if (eraserMode) {
    sendEdit(x, y, '');
    draw();
    return;
  }
  cursorX = x;
  cursorY = y;
  mobileInput.value = '';
  mobileInput.focus();
  broadcastCursor();
  draw();
});

// All typing (mobile virtual keyboard AND desktop physical keyboard) goes
// through this hidden input. Character entry and backspace both surface as
// 'input' events with a value change, which we immediately clear.
mobileInput.addEventListener('input', (e) => {
  if (e.inputType === 'deleteContentBackward') {
    cursorX--;
    sendEdit(cursorX, cursorY, '');
  } else if (e.data) {
    for (const ch of e.data) {
      sendEdit(cursorX, cursorY, ch);
      cursorX++;
    }
  }
  mobileInput.value = '';
  centerViewOnCursor();
  requestVisibleChunks();
  broadcastCursor();
  draw();
});

// Enter and arrow keys don't produce 'input' events on a single-line input,
// so they're handled here instead.
mobileInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    cursorX = 0;
    cursorY++;
  } else if (e.key === 'ArrowRight') cursorX++;
  else if (e.key === 'ArrowLeft') cursorX--;
  else if (e.key === 'ArrowDown') cursorY++;
  else if (e.key === 'ArrowUp') cursorY--;
  else if (e.key === 'Delete') {
    sendEdit(cursorX, cursorY, '');
  } else return;
  e.preventDefault();
  centerViewOnCursor();
  requestVisibleChunks();
  broadcastCursor();
  draw();
});

// Paste: flows pasted text across the grid starting at the cursor, wrapping
// back to the starting column on each newline.
mobileInput.addEventListener('paste', (e) => {
  e.preventDefault();
  const text = (e.clipboardData || window.clipboardData).getData('text');
  if (!text) return;
  const anchorX = cursorX;
  for (const ch of text) {
    if (ch === '\r') continue;
    if (ch === '\n') {
      cursorX = anchorX;
      cursorY++;
      continue;
    }
    sendEdit(cursorX, cursorY, ch);
    cursorX++;
  }
  centerViewOnCursor();
  requestVisibleChunks();
  broadcastCursor();
  draw();
});

function sendEdit(x, y, char) {
  const key = `${x},${y}`;
  if (char === '') {
    cellData.delete(key);
    ws.send(JSON.stringify({ type: 'edit', page, x, y, char: '' }));
    return;
  }
  const encoded = encodeCell(char, currentColor);
  cellData.set(key, encoded);
  ws.send(JSON.stringify({ type: 'edit', page, x, y, char: encoded }));
}

let dragging = false, dragStartX = 0, dragStartY = 0, panStartX = 0, panStartY = 0;
let erasingMouse = false;
canvas.addEventListener('mousedown', (e) => {
  if (eraserMode) {
    erasingMouse = true;
    const { x, y } = cellFromClientXY(e.clientX, e.clientY);
    sendEdit(x, y, '');
    draw();
    return;
  }
  if (e.shiftKey) {
    dragging = true;
    dragStartX = e.clientX;
    dragStartY = e.clientY;
    panStartX = offsetX;
    panStartY = offsetY;
  }
});
window.addEventListener('mousemove', (e) => {
  if (erasingMouse) {
    const { x, y } = cellFromClientXY(e.clientX, e.clientY);
    sendEdit(x, y, '');
    draw();
    return;
  }
  if (!dragging) return;
  offsetX = panStartX - Math.round((e.clientX - dragStartX) / CELL_W);
  offsetY = panStartY - Math.round((e.clientY - dragStartY) / CELL_H);
  requestVisibleChunks();
  draw();
});
window.addEventListener('mouseup', () => {
  dragging = false;
  erasingMouse = false;
});

// Touch: a small tap places the cursor (handled by the 'click' event, which
// browsers still fire after a tap with little/no movement). A drag beyond a
// small threshold pans the canvas instead.
let touchActive = false, touchDragged = false;
let touchStartX = 0, touchStartY = 0, touchPanStartX = 0, touchPanStartY = 0;

canvas.addEventListener('touchstart', (e) => {
  const t = e.touches[0];
  if (eraserMode) {
    const { x, y } = cellFromClientXY(t.clientX, t.clientY);
    sendEdit(x, y, '');
    draw();
    touchActive = false;
    return;
  }
  touchActive = true;
  touchDragged = false;
  touchStartX = t.clientX;
  touchStartY = t.clientY;
  touchPanStartX = offsetX;
  touchPanStartY = offsetY;
}, { passive: true });

canvas.addEventListener('touchmove', (e) => {
  const t = e.touches[0];
  if (eraserMode) {
    const { x, y } = cellFromClientXY(t.clientX, t.clientY);
    sendEdit(x, y, '');
    draw();
    return;
  }
  if (!touchActive) return;
  const dx = t.clientX - touchStartX;
  const dy = t.clientY - touchStartY;
  if (Math.abs(dx) > 6 || Math.abs(dy) > 6) touchDragged = true;
  if (touchDragged) {
    offsetX = touchPanStartX - Math.round(dx / CELL_W);
    offsetY = touchPanStartY - Math.round(dy / CELL_H);
    requestVisibleChunks();
    draw();
  }
}, { passive: true });

canvas.addEventListener('touchend', () => {
  touchActive = false;
}, { passive: true });

function centerViewOnCursor() {
  const cols = Math.floor(canvas.width / CELL_W);
  const rows = Math.floor(canvas.height / CELL_H);
  if (cursorX < offsetX) offsetX = cursorX;
  if (cursorX >= offsetX + cols) offsetX = cursorX - cols + 1;
  if (cursorY < offsetY) offsetY = cursorY;
  if (cursorY >= offsetY + rows) offsetY = cursorY - rows + 1;
}

resize();
