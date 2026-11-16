// OTEX Riddle AI Worker — Cloudflare Worker (ES Module)
// Race: Groq + Gemini + OpenRouter — schnellste Antwort gewinnt

const DB_URL = "https://raw.githubusercontent.com/freedrag8-cell/otex-riddle-worker/refs/heads/main/database.txt";

// DB cache: raw text + parsed map
let dbCache = null;      // raw text
let dbMap   = null;      // Map: lowercase key → uppercase value

async function loadDB() {
  if (dbCache) return dbCache;
  const resp = await fetch(DB_URL);
  if (!resp.ok) throw new Error("DB fetch failed: " + resp.status);
  dbCache = await resp.text();

  // Parse into map
  dbMap = new Map();
  for (const line of dbCache.split("\n")) {
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim().toLowerCase();
    const val = line.slice(eq + 1).trim().toUpperCase();
    if (key && val) dbMap.set(key, val);
  }

  return dbCache;
}

// Try to find the answer directly in the DB map
// Handles multiple questions by splitting on common conjunctions
function dbLookup(question) {
  if (!dbMap) return null;

  const q = question.toLowerCase().trim();

  // Direct lookup first
  if (dbMap.has(q)) return dbMap.get(q);

  // Split multiple questions by "what", "and what", "who", etc.
  // Try to find sub-questions
  const parts = q
    .split(/\band\b|\bwhat\b|\bwho\b|\bwhich\b|\bhow\b/)
    .map(p => p.replace(/^[\s,?]+|[\s,?]+$/g, ""))
    .filter(p => p.length > 1);

  if (parts.length <= 1) return null;

  // Try to answer each part
  const answers = [];
  for (const part of parts) {
    const val = dbMap.get(part);
    if (!val) return null; // if any part not found, fall back to AI
    answers.push(val);
  }

  return answers.join(""); // concatenate without spaces
}

function buildSystemPrompt(db) {
  return `You are an expert assistant for the Roblox game "Steal a Brainrot" (SAB).
You answer questions using ONLY the knowledge base below.

RULES:
- If the question contains multiple sub-questions, answer each one in order with NO spaces or separators between answers — concatenate them directly.
- Each answer must be UPPERCASE.
- Each answer is ONE word or code only — no punctuation, no explanation, no extra text.
- Look up EVERY sub-question carefully in the knowledge base before answering.
- Never add spaces between answers.
- Never guess — only use what is in the knowledge base.
- If a question asks for a name, return the exact value from the knowledge base.

EXAMPLE:
Question: "what is my name what is my favourite brainrot what is my age"
Answer: SAMMYMEOWL24

KNOWLEDGE BASE:
${db}`;
}

export default {
  async fetch(request, env) {
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

    // Debug: secrets vorhanden?
    const hasGroq = !!env.GROQ_KEY && env.GROQ_KEY.length > 5;
    const hasGemini = !!env.GEMINI_KEY && env.GEMINI_KEY.length > 5;
    const hasOR = !!env.OPENROUTER_KEY && env.OPENROUTER_KEY.length > 5;

    if (!hasGroq && !hasGemini && !hasOR) {
      return json({ error: "No secrets found", groq: hasGroq, gemini: hasGemini, openrouter: hasOR }, 500);
    }

    let db;
    try {
      db = await loadDB();
    } catch (e) {
      return json({ error: "Failed to load knowledge base", detail: String(e) }, 502);
    }

    // ── 1. Try exact DB lookup first (100% accurate) ──────────
    const dbAnswer = dbLookup(question);
    if (dbAnswer) {
      return json({ answer: dbAnswer, provider: "database" }, 200);
    }

    // ── 2. Fall back to AI race if not in DB ─────────────────
    const systemPrompt = buildSystemPrompt(db);

    const providers = [
      hasGroq && {
        name: "groq",
        url: "https://api.groq.com/openai/v1/chat/completions",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${env.GROQ_KEY}`,
        },
        body: JSON.stringify({
          model: "openai/gpt-oss-20b",
          temperature: 0,
          max_completion_tokens: 64,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user",   content: question },
          ],
        }),
        extract: (d) => d?.choices?.[0]?.message?.content,
      },
      hasGemini && {
        name: "gemini",
        url: "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent",
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
      hasOR && {
        name: "openrouter",
        url: "https://openrouter.ai/api/v1/chat/completions",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${env.OPENROUTER_KEY}`,
          "HTTP-Referer": "https://otexriddle.freedrag8.workers.dev",
          "X-Title": "OTEX Riddle AI",
        },
        body: JSON.stringify({
          model: "google/gemma-4-31b-it:free",
          temperature: 0,
          max_tokens: 64,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user",   content: question },
          ],
        }),
        extract: (d) => d?.choices?.[0]?.message?.content,
      },
    ].filter(Boolean);

    const errors = [];
    const racePromises = providers.map(async (p) => {
      const resp = await fetch(p.url, {
        method: "POST",
        headers: p.headers,
        body: p.body,
      });

      if (!resp.ok) {
        const errBody = await resp.text();
        throw new Error(`${p.name}: HTTP ${resp.status} — ${errBody.slice(0, 200)}`);
      }

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
      // Collect all errors for debugging
      const allErrors = await Promise.allSettled(racePromises);
      const details = allErrors.map((r, i) =>
        r.status === "rejected" ? `${providers[i].name}: ${r.reason}` : "ok"
      );
      return json({ error: "All providers failed", details }, 502);
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
