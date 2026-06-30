# Day Rhythm — deploy it yourself

A personal day-logger. You log moments (photo or note), Claude classifies each into one of
five axes (focus / movement / rest / nourishment / connection), and the app shows the shape
of your day as a 24-hour ring with a balance score and end-of-day suggestions.

Your data lives in your browser (localStorage). Your Anthropic API key lives on the server
(a serverless function) and is **never** sent to the browser.

---

## What you need (one-time)

1. A free **GitHub** account — github.com
2. A free **Vercel** account — vercel.com (sign in with GitHub)
3. An **Anthropic API key** — console.anthropic.com → API Keys → Create Key.
   You'll need a little credit on the account; classifying is cheap, especially on Haiku.
4. **Node.js** installed (only if you want to run it locally first) — nodejs.org, LTS version.

---

## Deploy in 6 steps

### 1. Get the code onto your machine
Unzip this folder somewhere sensible, e.g. `~/day-rhythm`.

### 2. Put it on GitHub
Open a terminal in the folder and run:

```bash
git init
git add .
git commit -m "Day Rhythm v1"
```

Create a new **empty** repo on github.com (no README), then run the two lines GitHub shows
you under "push an existing repository", which look like:

```bash
git remote add origin https://github.com/YOUR_NAME/day-rhythm.git
git branch -M main
git push -u origin main
```

### 3. Import into Vercel
- vercel.com → **Add New… → Project** → pick your `day-rhythm` repo → **Import**.
- Vercel auto-detects Vite. Don't change the build settings.
- **Before** clicking Deploy, open **Environment Variables** and add:
  - Name: `ANTHROPIC_API_KEY`  Value: your real key (`sk-ant-...`)
  - (optional) Name: `CLAUDE_MODEL`  Value: `claude-haiku-4-5-20251001` to lower cost
- Click **Deploy**. Wait ~1 minute.

### 4. Open it
Vercel gives you a URL like `https://day-rhythm-xxxx.vercel.app`. Open it. Log a note like
"deep work on the deck" — if it classifies, your key and function are wired correctly.

### 5. Put it on your phone (iOS)
- Open the Vercel URL in **Safari** on your iPhone.
- Share button → **Add to Home Screen**.
- It now opens fullscreen like a native app. The photo button uses your camera.

### 6. Feed it steps & location (optional, automatic-ish)
The "Passive data" drawer at the bottom takes JSON. Build an **Apple Shortcut** that reads
today's step count from Health and outputs `{ "steps": 8200, "locations": ["Office"] }`,
then paste it in. (Ask me and I'll write that Shortcut for you.)

---

## Run it locally first (optional)

`npm run dev` serves the UI but **not** the `/api` function, so classifying won't work that
way. To test the full thing locally, use Vercel's CLI, which runs both:

```bash
npm install -g vercel
vercel link        # connect this folder to your Vercel project
vercel env pull    # pulls ANTHROPIC_API_KEY into .env.local
vercel dev         # runs the app AND the function at localhost:3000
```

---

## How it's wired

```
Browser (App.jsx)
   │  POST /api/claude  { messages }
   ▼
api/claude.js  (Vercel serverless — holds ANTHROPIC_API_KEY)
   │  POST https://api.anthropic.com/v1/messages
   ▼
Claude → classification / suggestions → back to the browser
```

- **Data:** `localStorage`, keyed by date (`rhythm:day:YYYY-MM-DD`). Single device.
  Clearing browser data wipes it. For multi-device sync you'd add a database (Supabase) later.
- **Cost control:** every classify call is one request capped at 1000 tokens. Haiku is cheapest.

## One thing to harden later
`/api/claude` is open to anyone who finds the URL — fine for personal use, but they'd be
spending your tokens. When you're ready, add a simple shared-secret header check in
`api/claude.js`, or move to Supabase auth.
