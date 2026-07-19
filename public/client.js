const CELL_W = 16, CELL_H = 20, CHUNK = 20;

const canvas = document.getElementById('grid');
const ctx = canvas.getContext('2d');

let offsetX = 0, offsetY = 0; // top-left visible cell coordinate
let cursorX = 0, cursorY = 0;
const cellData = new Map(); // "x,y" -> char
const requestedKeys = new Set();

const page = decodeURIComponent(location.pathname.replace(/^\/+/, '')) || 'default';
document.title = page + " — Air's World";

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

function draw() {
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.font = '16px monospace';
  ctx.textBaseline = 'top';
  ctx.fillStyle = '#111111';

  const cols = Math.ceil(canvas.width / CELL_W);
  const rows = Math.ceil(canvas.height / CELL_H);

  for (let row = 0; row <= rows; row++) {
    for (let col = 0; col <= cols; col++) {
      const x = offsetX + col;
      const y = offsetY + row;
      const ch = cellData.get(`${x},${y}`);
      if (ch) ctx.fillText(ch, col * CELL_W, row * CELL_H);
    }
  }

  const cx = (cursorX - offsetX) * CELL_W;
  const cy = (cursorY - offsetY) * CELL_H;
  ctx.strokeStyle = '#2266ee';
  ctx.strokeRect(cx + 0.5, cy + 0.5, CELL_W - 1, CELL_H - 1);
}

canvas.addEventListener('click', (e) => {
  const col = Math.floor(e.offsetX / CELL_W);
  const row = Math.floor(e.offsetY / CELL_H);
  cursorX = offsetX + col;
  cursorY = offsetY + row;
  mobileInput.value = '';
  mobileInput.focus();
  draw();
});

// All typing (mobile virtual keyboard AND desktop physical keyboard) goes
// through this hidden input. Character entry and backspace both surface as
// 'input' events with a value change, which we immediately clear.
const mobileInput = document.getElementById('mobileInput');

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
  else return;
  e.preventDefault();
  centerViewOnCursor();
  requestVisibleChunks();
  draw();
});

function sendEdit(x, y, char) {
  const key = `${x},${y}`;
  if (char === '') cellData.delete(key); else cellData.set(key, char);
  ws.send(JSON.stringify({ type: 'edit', page, x, y, char }));
}

let dragging = false, dragStartX = 0, dragStartY = 0, panStartX = 0, panStartY = 0;
canvas.addEventListener('mousedown', (e) => {
  if (e.shiftKey) {
    dragging = true;
    dragStartX = e.clientX;
    dragStartY = e.clientY;
    panStartX = offsetX;
    panStartY = offsetY;
  }
});
window.addEventListener('mousemove', (e) => {
  if (!dragging) return;
  offsetX = panStartX - Math.round((e.clientX - dragStartX) / CELL_W);
  offsetY = panStartY - Math.round((e.clientY - dragStartY) / CELL_H);
  requestVisibleChunks();
  draw();
});
window.addEventListener('mouseup', () => (dragging = false));

// Touch: a small tap places the cursor (handled by the 'click' event, which
// browsers still fire after a tap with little/no movement). A drag beyond a
// small threshold pans the canvas instead.
let touchActive = false, touchDragged = false;
let touchStartX = 0, touchStartY = 0, touchPanStartX = 0, touchPanStartY = 0;

canvas.addEventListener('touchstart', (e) => {
  const t = e.touches[0];
  touchActive = true;
  touchDragged = false;
  touchStartX = t.clientX;
  touchStartY = t.clientY;
  touchPanStartX = offsetX;
  touchPanStartY = offsetY;
}, { passive: true });

canvas.addEventListener('touchmove', (e) => {
  if (!touchActive) return;
  const t = e.touches[0];
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
