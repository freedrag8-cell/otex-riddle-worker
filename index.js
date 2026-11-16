// OTEX Riddle AI Worker — Cloudflare Worker (ES Module)
// Multi-DB Edition: jede Kategorie hat eigene DB-Datei
// Race: Groq + Gemini + OpenRouter — schnellste Antwort gewinnt

const REPO_BASE = "https://raw.githubusercontent.com/freedrag8-cell/otex-riddle-worker/refs/heads/main";

// ── Datenbanken mit Keywords ──────────────────────────────────
// Neue DB einfach hier hinzufügen!
const DATABASES = [
  {
    name: "sammy",
    url: `${REPO_BASE}/sammy.txt`,
    keywords: ["sammy", "my name", "my age", "my favourite", "my favorite", "my pet", "my color", "my colour", "my birthday", "my best", "i like", "my number"],
  },
  {
    name: "machines",
    url: `${REPO_BASE}/machines.txt`,
    keywords: ["machine", "craft", "crafting", "station", "1st machine", "2nd machine", "3rd machine", "first machine", "second machine", "third machine"],
  },
  {
    name: "traits",
    url: `${REPO_BASE}/traits.txt`,
    keywords: ["trait", "hat", "item", "wear", "outfit", "accessory", "equip", "halloween", "christmas", "event"],
  },
  {
    name: "brainrots",
    url: `${REPO_BASE}/brainrots.txt`,
    keywords: ["brainrot", "character", "removed", "added", "rarest", "best", "worst", "brothers", "bros", "sister"],
  },
  {
    name: "database",
    url: `${REPO_BASE}/database.txt`,
    keywords: [], // fallback — wird immer zuletzt genutzt wenn nichts anderes passt
  },
];

// ── DB Cache ──────────────────────────────────────────────────
const dbCache = new Map(); // name → { text, map }

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

// ── Welche DB passt zur Frage? ────────────────────────────────
function selectDB(question) {
  const q = question.toLowerCase();
  for (const db of DATABASES) {
    if (db.keywords.length === 0) continue; // skip fallback hier
    for (const kw of db.keywords) {
      if (q.includes(kw)) return db;
    }
  }
  // Fallback: database.txt
  return DATABASES[DATABASES.length - 1];
}

// ── Exakter DB Lookup ─────────────────────────────────────────
function dbLookup(map, question) {
  const q = question.toLowerCase().trim();

  // Direkt
  if (map.has(q)) return map.get(q);

  // Multi-Fragen splitten
  const parts = q
    .split(/,?\s+and\s+|,?\s+what\s+|,?\s+who\s+|,?\s+which\s+|,?\s+how\s+/)
    .map(p => p.replace(/^[\s,?]+|[\s,?]+$/g, "").trim())
    .filter(p => p.length > 1);

  if (parts.length <= 1) return null;

  const answers = [];
  for (const part of parts) {
    const val = map.get(part);
    if (!val) return null;
    answers.push(val);
  }
  return answers.join("");
}

// ── System Prompt mit kleiner DB ─────────────────────────────
function buildPrompt(dbText, dbName) {
  return `You are an expert assistant for the Roblox game "Steal a Brainrot" (SAB).
You answer questions using ONLY the ${dbName} knowledge base below.

RULES:
- If the question contains multiple sub-questions, answer each one in order with NO spaces — concatenate directly.
- Each answer UPPERCASE, ONE word/code only, no punctuation, no explanation.
- Never add spaces between answers.
- Never guess — only use what is in the knowledge base.

EXAMPLE:
Question: "what is my name what is my favourite brainrot what is my age"
Answer: SAMMYMEOWL24

KNOWLEDGE BASE (${dbName}):
${dbText}`;
}

// ── AI Race ───────────────────────────────────────────────────
async function raceAI(question, dbText, dbName, env) {
  const systemPrompt = buildPrompt(dbText, dbName);

  const hasGroq   = !!env.GROQ_KEY   && env.GROQ_KEY.length   > 5;
  const hasGemini = !!env.GEMINI_KEY && env.GEMINI_KEY.length > 5;
  const hasOR     = !!env.OPENROUTER_KEY && env.OPENROUTER_KEY.length > 5;

  const providers = [
    hasGroq && {
      name: "groq",
      url: "https://api.groq.com/openai/v1/chat/completions",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${env.GROQ_KEY}`,
      },
      body: JSON.stringify({
        model: "meta-llama/llama-4-maverick-17b-128e-instruct",
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
      url: "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite-preview-06-17:generateContent",
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
        "HTTP-Referer": "https://otex-riddle-worker.freedrag8.workers.dev",
        "X-Title": "OTEX Riddle AI",
      },
      body: JSON.stringify({
        model: "moonshotai/kimi-k2-instruct:free",
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

  if (providers.length === 0) throw new Error("No AI providers configured");

  const racePromises = providers.map(async (p) => {
    const resp = await fetch(p.url, {
      method: "POST",
      headers: p.headers,
      body: p.body,
    });
    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`${p.name}: HTTP ${resp.status} — ${err.slice(0, 200)}`);
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

  return await Promise.any(racePromises);
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

    // Welche DB passt?
    const selectedDB = selectDB(question);

    // DB laden
    let dbEntry;
    try {
      dbEntry = await loadDB(selectedDB);
    } catch (e) {
      return json({ error: "Failed to load DB", detail: String(e) }, 502);
    }

    // Exakter Lookup zuerst
    const dbAnswer = dbLookup(dbEntry.map, question);
    if (dbAnswer) {
      return json({ answer: dbAnswer, provider: `database:${selectedDB.name}` }, 200);
    }

    // AI Race mit kleiner passender DB
    try {
      const winner = await raceAI(question, dbEntry.text, selectedDB.name, env);
      return json({ answer: winner.answer, provider: `${winner.provider}:${selectedDB.name}` }, 200);
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
