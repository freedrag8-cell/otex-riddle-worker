// OTEX Riddle AI Worker — Cloudflare Worker (ES Module)
// 3-DB Edition: DB aufgeteilt in db1/db2/db3 — jede AI bekommt einen Teil
// Alle 3 antworten, Mehrheit gewinnt (bei Unentschieden: erste gültige)

const REPO_BASE = "https://raw.githubusercontent.com/freedrag8-cell/otex-riddle-worker/refs/heads/main";

const DATABASES = [
  { name: "db1", url: `${REPO_BASE}/db1.txt` },
  { name: "db2", url: `${REPO_BASE}/db2.txt` },
  { name: "db3", url: `${REPO_BASE}/db3.txt` },
];

// ── DB Cache ──────────────────────────────────────────────────
const dbCache = new Map();

async function loadDB(db) {
  if (dbCache.has(db.name)) return dbCache.get(db.name);

  const resp = await fetch(db.url);
  if (!resp.ok) throw new Error(`DB "${db.name}" fetch failed: ${resp.status}`);

  const text = await resp.text();
  const map  = new Map();

  for (const line of text.split("\n")) {
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim().toLowerCase();
    const val = line.slice(eq + 1).trim().toUpperCase();
    if (key && val) map.set(key, val);
  }

  const entry = { text, map };
  dbCache.set(db.name, entry);
  return entry;
}

// ── Exakter DB Lookup (alle 3 DBs) ───────────────────────────
async function dbLookupAll(question) {
  const q = question.toLowerCase().trim();

  for (const db of DATABASES) {
    try {
      const entry = await loadDB(db);

      // Direkt
      if (entry.map.has(q)) return entry.map.get(q);

      // Multi-Fragen splitten
      const parts = q
        .split(/,?\s+and\s+|,?\s+what\s+|,?\s+who\s+|,?\s+which\s+|,?\s+how\s+/)
        .map(p => p.replace(/^[\s,?]+|[\s,?]+$/g, "").trim())
        .filter(p => p.length > 1);

      if (parts.length > 1) {
        const answers = [];
        let allFound = true;
        for (const part of parts) {
          const val = entry.map.get(part);
          if (!val) { allFound = false; break; }
          answers.push(val);
        }
        if (allFound) return answers.join("");
      }
    } catch (e) {
      // DB nicht verfügbar, weiter
    }
  }
  return null;
}

// ── System Prompt ─────────────────────────────────────────────
function buildPrompt(dbText, dbName) {
  return `You are an expert assistant for the Roblox game "Steal a Brainrot" (SAB).
You answer questions using ONLY the knowledge base below (part ${dbName} of the database).

RULES:
- If the question contains multiple sub-questions, answer each one in order with NO spaces — concatenate directly.
- Each answer UPPERCASE, ONE word/code only, no punctuation, no explanation.
- Never add spaces between answers.
- Never guess — only use what is in the knowledge base.
- If you don't know the answer from this knowledge base, reply with exactly: UNKNOWN

EXAMPLE:
Question: "what is my name what is my favourite brainrot what is my age"
Answer: SAMMYMEOWL24

KNOWLEDGE BASE (${dbName}):
${dbText}`;
}

// ── AI Race: alle 3 AIs gleichzeitig, jede mit ihrer DB ───────
async function askAllAIs(question, env) {
  const hasGroq   = !!env.GROQ_KEY   && env.GROQ_KEY.length   > 5;
  const hasGemini = !!env.GEMINI_KEY && env.GEMINI_KEY.length > 5;
  const hasOR     = !!env.OPENROUTER_KEY && env.OPENROUTER_KEY.length > 5;

  const aiProviders = [
    hasGroq && {
      name: "groq",
      url: "https://api.groq.com/openai/v1/chat/completions",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${env.GROQ_KEY}` },
      buildBody: (systemPrompt) => JSON.stringify({
        model: "meta-llama/llama-4-maverick-17b-128e-instruct",
        temperature: 0,
        max_completion_tokens: 64,
        messages: [{ role: "system", content: systemPrompt }, { role: "user", content: question }],
      }),
      extract: (d) => d?.choices?.[0]?.message?.content,
    },
    hasGemini && {
      name: "gemini",
      url: "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite-preview-06-17:generateContent",
      headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_KEY },
      buildBody: (systemPrompt) => JSON.stringify({
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
        "HTTP-Referer": "https://otex-riddle-worker.freedrag8.workers.dev",
        "X-Title": "OTEX Riddle AI",
      },
      buildBody: (systemPrompt) => JSON.stringify({
        model: "moonshotai/kimi-k2-instruct:free",
        temperature: 0,
        max_tokens: 64,
        messages: [{ role: "system", content: systemPrompt }, { role: "user", content: question }],
      }),
      extract: (d) => d?.choices?.[0]?.message?.content,
    },
  ].filter(Boolean);

  if (aiProviders.length === 0) throw new Error("No AI providers configured");

  // Jede AI bekommt eine andere DB
  const tasks = aiProviders.map(async (provider, i) => {
    const db = DATABASES[i % DATABASES.length];
    let dbEntry;
    try {
      dbEntry = await loadDB(db);
    } catch (e) {
      throw new Error(`${provider.name}: DB load failed`);
    }

    const systemPrompt = buildPrompt(dbEntry.text, db.name);
    const resp = await fetch(provider.url, {
      method: "POST",
      headers: provider.headers,
      body: provider.buildBody(systemPrompt),
    });

    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`${provider.name}: HTTP ${resp.status} — ${err.slice(0, 200)}`);
    }

    const data = await resp.json();
    const raw  = provider.extract(data);
    if (!raw || raw.trim() === "") throw new Error(`${provider.name}: empty response`);

    const cleaned = raw
      .replace(/<think>[\s\S]*?<\/think>/gi, "")
      .replace(/\r?\n/g, " ")
      .trim()
      .replace(/[.!?,;:]+$/, "")
      .trim()
      .toUpperCase();

    if (!cleaned || cleaned === "UNKNOWN") throw new Error(`${provider.name}: no answer`);
    return { answer: cleaned, provider: provider.name, db: db.name };
  });

  // Alle gleichzeitig ausführen, Ergebnisse sammeln
  const results = await Promise.allSettled(tasks);
  const answers = results
    .filter(r => r.status === "fulfilled")
    .map(r => r.value);

  if (answers.length === 0) throw new Error("All AI providers failed");

  // Mehrheitsentscheidung
  const counts = {};
  for (const a of answers) {
    counts[a.answer] = (counts[a.answer] || 0) + 1;
  }

  // Antwort mit meisten Stimmen
  const winner = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  const winnerAnswer = answers.find(a => a.answer === winner[0]);

  return {
    answer: winnerAnswer.answer,
    provider: `${winnerAnswer.provider}:${winnerAnswer.db}`,
    votes: counts,
    all_answers: answers.map(a => `${a.provider}:${a.answer}`),
  };
}

// ── Main Handler ──────────────────────────────────────────────
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
    try { body = await request.json(); }
    catch { return json({ error: "Invalid JSON" }, 400); }

    const question = typeof body.question === "string" ? body.question.trim() : "";
    if (!question) return json({ error: "No question provided" }, 400);

    // Erst exakter Lookup in allen 3 DBs
    const dbAnswer = await dbLookupAll(question);
    if (dbAnswer) {
      return json({ answer: dbAnswer, provider: "database:exact" }, 200);
    }

    // Alle 3 AIs fragen
    try {
      const result = await askAllAIs(question, env);
      return json(result, 200);
    } catch (err) {
      return json({ error: "All providers failed", detail: String(err) }, 502);
    }
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
