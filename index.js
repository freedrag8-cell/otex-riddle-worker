// OTEX Riddle AI Worker — Cloudflare Worker (ES Module)
// Race: Groq + Gemini + OpenRouter — schnellste Antwort gewinnt

const DB_URL = "https://raw.githubusercontent.com/freedrag8-cell/otex-riddle-worker/refs/heads/main/database.txt";

// In-memory cache (lebt solange der Worker-Isolate läuft)
let dbCache = null;

async function loadDB() {
  if (dbCache) return dbCache;
  const resp = await fetch(DB_URL);
  if (!resp.ok) throw new Error("DB fetch failed: " + resp.status);
  dbCache = await resp.text();
  return dbCache;
}

function buildSystemPrompt(db) {
  return `You are an expert assistant for the Roblox game "Steal a Brainrot" (SAB).
Answer questions using ONLY the knowledge base below.
Reply with ONLY the answer — one word or code, UPPERCASE, no punctuation, no explanation.
If the answer is not in the knowledge base, make your best guess based on the data.

KNOWLEDGE BASE:
${db}`;
}

export default {
  async fetch(request, env) {
    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        },
      });
    }

    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "Invalid JSON" }, 400);
    }

    const question = typeof body.question === "string" ? body.question.trim() : "";
    if (!question) return json({ error: "No question provided" }, 400);

    // Load DB (cached after first call)
    let db;
    try {
      db = await loadDB();
    } catch (e) {
      return json({ error: "Failed to load knowledge base", detail: String(e) }, 502);
    }

    const systemPrompt = buildSystemPrompt(db);

    // ── Provider configs ────────────────────────────────────────
    const providers = [
      {
        name: "groq",
        url: "https://api.groq.com/openai/v1/chat/completions",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${env.GROQ_KEY}`,
        },
        body: JSON.stringify({
          model: "llama-3.3-70b-versatile",
          temperature: 0,
          max_completion_tokens: 64,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user",   content: question },
          ],
        }),
        extract: (d) => d?.choices?.[0]?.message?.content,
      },
      {
        name: "gemini",
        url: "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": env.GEMINI_KEY,
        },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: systemPrompt }] },
          contents: [{ role: "user", parts: [{ text: question }] }],
          generationConfig: { temperature: 0, maxOutputTokens: 64 },
        }),
        extract: (d) => d?.candidates?.[0]?.content?.parts?.[0]?.text,
      },
      {
        name: "openrouter",
        url: "https://openrouter.ai/api/v1/chat/completions",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${env.OPENROUTER_KEY}`,
          "HTTP-Referer": "https://otexriddle.freedrag8.workers.dev",
          "X-Title": "OTEX Riddle AI",
        },
        body: JSON.stringify({
          model: "meta-llama/llama-3.3-70b-instruct:free",
          temperature: 0,
          max_tokens: 64,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user",   content: question },
          ],
        }),
        extract: (d) => d?.choices?.[0]?.message?.content,
      },
    ];

    // ── Race all providers ──────────────────────────────────────
    const racePromises = providers.map(async (p) => {
      const resp = await fetch(p.url, {
        method: "POST",
        headers: p.headers,
        body: p.body,
      });

      if (!resp.ok) throw new Error(`${p.name}: HTTP ${resp.status}`);

      const data = await resp.json();
      const raw  = p.extract(data);
      if (!raw || raw.trim() === "") throw new Error(`${p.name}: empty response`);

      const cleaned = raw
        .replace(/<think>[\s\S]*?<\/think>/gi, "")
        .replace(/\r?\n/g, " ")
        .trim()
        .replace(/[.!?,;:]+$/, "")
        .trim()
        .toUpperCase();

      if (!cleaned) throw new Error(`${p.name}: empty after clean`);
      return { answer: cleaned, provider: p.name };
    });

    let winner;
    try {
      winner = await Promise.any(racePromises);
    } catch (err) {
      return json({ error: "All providers failed", detail: String(err) }, 502);
    }

    return json({ answer: winner.answer, provider: winner.provider }, 200);
  },
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
