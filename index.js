// OTEX Riddle AI Worker — Cloudflare Worker (ES Module)
// Race: Groq + Gemini + OpenRouter — schnellste Antwort gewinnt

const DB_URL = "https://raw.githubusercontent.com/freedrag8-cell/otex-riddle-worker/refs/heads/main/database.txt";

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
          model: "llama3-70b-8192",
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
        url: "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-lite:generateContent",
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
          model: "mistralai/mistral-7b-instruct:free",
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
