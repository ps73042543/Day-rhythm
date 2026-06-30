// Serverless function — runs on Vercel's server, NOT in the browser.
// Your API key lives here as an environment variable and is never exposed to the client.
export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Use POST" });
  }

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    return res.status(500).json({ error: "Server is missing ANTHROPIC_API_KEY. Set it in Vercel → Settings → Environment Variables." });
  }

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    const messages = body && body.messages;
    if (!Array.isArray(messages)) {
      return res.status(400).json({ error: "Body must include a 'messages' array." });
    }

    // Switch to "claude-haiku-4-5-20251001" to cut costs on high-volume classifying.
    const model = process.env.CLAUDE_MODEL || "claude-sonnet-4-6";

    const upstream = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({ model, max_tokens: 1000, messages }),
    });

    const data = await upstream.json();
    return res.status(upstream.ok ? 200 : upstream.status).json(data);
  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
}
