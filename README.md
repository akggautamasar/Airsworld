# Air's World

An infinite collaborative text canvas (inspired by Your World of Text),
using a Telegram chat as the storage backend and a Node.js server for
real-time sync over WebSockets.

Any URL path is its own page, created the moment someone writes on it,
e.g. `yoursite.com/my-page`.

No local machine or command line needed — everything below can be done
from a phone browser plus the Render dashboard.

## How it works

- The canvas is split into 20x20 cell **chunks**. Each chunk is stored as
  one Telegram message (JSON text) in a chat your bot has access to.
- A single **index message** (also in that chat) maps `page -> chunk -> message_id`.
  This message is automatically **pinned** by the bot on first run, so the
  server can always find it again after a restart — no manual ID copying.
- The server keeps everything in memory while running, and debounces writes
  to Telegram every 2 seconds so rapid typing doesn't hit rate limits.
- The Bot API has no way to fetch an arbitrary message's content just from
  its ID, so reading chunk data back uses a forward-then-delete trick (see
  `telegram.js`). The one exception is the pinned index message, which
  `getChat` returns directly.

## 1. Create a Telegram bot and storage chat

All from the Telegram app on your phone:

1. Message **@BotFather**, run `/newbot`, and save the token it gives you.
2. Create a new **private group** (or channel) — this is where all your data will live.
3. Add your bot to that group, then make it an **admin** with permission to
   **edit messages**, **delete messages**, and **pin messages**.
4. Get the chat's numeric ID:
   - Add **@userinfobot** or **@RawDataBot** to the group temporarily, and it
     will show you the chat ID, or
   - Send any message in the group, then open
     `https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates` in your phone's
     browser and look for `"chat":{"id": ...}` in the response.
   - Group/channel IDs are negative numbers (e.g. `-1001234567890`).

## 2. Deploy to Render

Use **Render**, not Vercel — this app needs a long-running process to hold
WebSocket connections and an in-memory cache, which serverless platforms
(like Vercel) don't support.

### Option A: one-click with render.yaml (recommended)

1. Push this project (unzip it first) to a GitHub repo — you can do this
   entirely from the GitHub mobile app or github.com in your phone browser
   by uploading the files.
2. In Render, tap **New > Blueprint** and select your repo.
3. Render reads `render.yaml` and asks you to fill in `BOT_TOKEN` and
   `CHAT_ID` (kept out of the file itself since they're secrets).
4. Tap **Apply** — Render builds and deploys the service. No further setup
   needed; the bot creates and pins its own index message automatically
   the first time it starts.

### Option B: manual Web Service

1. Push this project to a GitHub repo.
2. Create a new **Web Service** in Render, connect the repo.
3. Build command: `npm install`
4. Start command: `npm start`
5. Add `BOT_TOKEN` and `CHAT_ID` as environment variables in Render's dashboard.

Once deployed, visit `your-app.onrender.com/my-first-page` and start typing.

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
- **Pinning requires admin rights**: if the bot can't pin messages (missing
  the "Pin messages" admin permission), it will fail on startup — double
  check that permission is enabled for the bot in your group's admin settings.
