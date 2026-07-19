# Air's World

An infinite collaborative text canvas (inspired by Your World of Text),
using a Telegram chat as the storage backend and a Node.js server for
real-time sync over WebSockets.

Any URL path is its own page, created the moment someone writes on it,
e.g. `yoursite.com/my-page`.

## How it works

- The canvas is split into 20x20 cell **chunks**. Each chunk is stored as
  one Telegram message (JSON text) in a chat your bot has access to.
- A single **index message** (also in that chat) maps `page -> chunk -> message_id`.
- The server keeps everything in memory while running, and debounces writes
  to Telegram every 2 seconds so rapid typing doesn't hit rate limits.
- The Bot API has no way to fetch an arbitrary message by ID, so reading
  stored data back uses a forward-then-delete trick (see `telegram.js`).

## 1. Create a Telegram bot and storage chat

1. Message **@BotFather** on Telegram, run `/newbot`, and save the token it gives you.
2. Create a new **private group** (or channel) — this is where all your data will live.
3. Add your bot to that group as a member, and make it an **admin** (needed to edit/delete messages).
4. Get the chat's numeric ID:
   - Add **@userinfobot** or **@RawDataBot** to the group temporarily, or
   - Send any message in the group, then visit
     `https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates` in a browser and
     look for `"chat":{"id": ...}` in the response.
   - Group/channel IDs are negative numbers (e.g. `-1001234567890`).

## 2. Configure environment variables

Copy `.env.example` to `.env` and fill in:

```
BOT_TOKEN=your bot token
CHAT_ID=your group's numeric id
INDEX_MESSAGE_ID=       (leave blank for now)
PORT=3000
```

## 3. Run locally

```bash
npm install
npm start
```

On the **first run**, since `INDEX_MESSAGE_ID` is blank, the server creates
an index message and prints something like:

```
>>> Add this to your environment variables and restart the server:
INDEX_MESSAGE_ID=42
```

Copy that value into `.env`, then restart with `npm start` again.

Visit `http://localhost:3000/my-first-page` and start typing.

## 4. Deploy

Use **Render**, not Vercel — this app needs a long-running process to hold
WebSocket connections and an in-memory cache, which serverless platforms
(like Vercel) don't support.

### Option A: one-click with render.yaml (recommended)

This repo includes a `render.yaml` Blueprint file.

1. Push this project to a GitHub repo (including `render.yaml`).
2. In Render, click **New > Blueprint** and select your repo.
3. Render reads `render.yaml` and creates the web service automatically —
   it will prompt you to fill in `BOT_TOKEN`, `CHAT_ID`, and
   `INDEX_MESSAGE_ID` (marked `sync: false`, so they're not stored in the
   file itself).
4. Get `INDEX_MESSAGE_ID` by running the server once locally first (see
   step 3 above), then paste that value in when Render asks.
5. Click **Apply** — Render builds and deploys the service.

### Option B: manual Web Service

1. Push this project to a GitHub repo.
2. Create a new **Web Service**, connect the repo.
3. Build command: `npm install`
4. Start command: `npm start`
5. Add `BOT_TOKEN`, `CHAT_ID`, `INDEX_MESSAGE_ID`, and `PORT` as environment
   variables in Render's dashboard (get `INDEX_MESSAGE_ID` by running once
   locally first, as above).


**Note:** Render's free tier spins the service down after ~15 minutes of
inactivity and cold-starts on the next visit — the page will take a few
seconds to load after being idle, then works normally.

## Known limitations

- **Telegram rate limits**: edits to the same chat are throttled to roughly
  one per second, which is why edits are batched every 2 seconds rather than
  saved instantly.
- **Message size**: Telegram messages cap at 4096 characters. With 20x20
  sparse chunks this is rarely an issue, but extremely dense chunks could
  hit the limit — reduce `CHUNK` in `server.js` if that happens.
- **No true message history read**: the forward-and-delete trick in
  `telegram.js` is a workaround for the Bot API's missing `getMessage`
  method. It works reliably but adds a bit of extra API traffic per read.
- **In-memory state resets on restart**: chunks are lazily reloaded from
  Telegram as users scroll into them, so nothing is lost — there's just a
  brief delay the first time a chunk is viewed after a restart.
