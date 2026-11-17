// OTEX Riddle AI Worker — Cloudflare Worker (ES Module)
// 1 vollständige DB — Gemini 1 (Haupt) + Gemini 2 (Backup)

const REPO_BASE = "https://raw.githubusercontent.com/freedrag8-cell/otex-riddle-worker/refs/heads/main";

const DATABASE_URL = `${REPO_BASE}/db.txt`;

// ── DB Cache ──────────────────────────────────────────────────
let dbCache = null;

async function loadDB() {
  if (dbCache) return dbCache;
  const resp = await fetch(DATABASE_URL);
  if (!resp.ok) throw new Error(`DB fetch failed: ${resp.status}`);
  const text = await resp.text();
  const map = new Map();
  for (const line of text.split("\n")) {
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim().toLowerCase();
    const val = line.slice(eq + 1).trim().toUpperCase();
    if (key && val) map.set(key, val);
  }
  dbCache = { text, map };
  return dbCache;
}

// ── Exakter Lookup ────────────────────────────────────────────
async function exactLookup(question) {
  const q = question.toLowerCase().trim();
  try {
    const entry = await loadDB();
    if (entry.map.has(q)) return entry.map.get(q);
  } catch (e) {
    console.error(`[OTEX] exactLookup error: ${e}`);
  }
  return null;
}

// ── System Prompt ─────────────────────────────────────────────
function buildPrompt(dbText) {
  return `You are a lookup tool for the Roblox game "Steal a Brainrot".
You have access to ONLY the following knowledge base. This is your ONLY source of truth.

STRICT RULES:
- You MUST ONLY use answers from the knowledge base below. Do NOT use any outside knowledge.
- The user question may contain one or more sub-questions chained together (e.g. "what is X what is Y what is Z").
- For EACH sub-question: search the knowledge base for a matching entry.
  - If found → output the value EXACTLY as it appears in the knowledge base (UPPERCASE).
  - If NOT found in this knowledge base → output the string UNKNOWN for that slot.
- Do NOT guess. Do NOT use general knowledge. Do NOT invent answers.
- Each answer must be UPPERCASE, exactly as it appears in the knowledge base.
- Output ONLY valid JSON. No markdown, no explanation, nothing else.

OUTPUT FORMAT:
{"answers":["ANSWER1","UNKNOWN","ANSWER3"]}

The array must have exactly one entry per sub-question, in the same order as the sub-questions.
If the entire question is a single sub-question, the array has exactly one entry.

EXAMPLES:
Question: "what is tralalelo tralala"
Response: {"answers":["TRALALELO TRALALA"]}

Question: "what is my name what is my favourite brainrot"
(knowledge base has "what is my name = SAMMY" but NOT "what is my favourite brainrot")
Response: {"answers":["SAMMY","UNKNOWN"]}

KNOWLEDGE BASE — your ONLY source:
${dbText}`;
}

// ── JSON aus AI-Antwort extrahieren ───────────────────────────
function extractJSON(raw) {
  if (!raw) return null;
  let cleaned = raw.replace(/```json[\s\S]*?```/gi, (m) => m.replace(/```json|```/gi, ""));
  cleaned = cleaned.replace(/```[\s\S]*?```/gi, (m) => m.replace(/```/gi, ""));
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
}

// ── Einzelnen Gemini anfragen ─────────────────────────────────
async function askGemini(question, prompt, apiKey, label) {
  console.log(`[${label}] Sending request…`);
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent?key=${apiKey}`;
  const body = JSON.stringify({
    system_instruction: { parts: [{ text: prompt }] },
    contents: [{ role: "user", parts: [{ text: question }] }],
    generationConfig: { temperature: 0, maxOutputTokens: 256 },
  });

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });

  if (!resp.ok) {
    const err = await resp.text();
    console.error(`[${label}] HTTP ${resp.status}: ${err.slice(0, 200)}`);
    throw new Error(`${label}: HTTP ${resp.status}`);
  }

  const data = await resp.json();
  const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!raw?.trim()) {
    console.error(`[${label}] Empty response. Data: ${JSON.stringify(data).slice(0, 300)}`);
    throw new Error(`${label}: empty response`);
  }

  console.log(`[${label}] Raw: "${raw.trim()}"`);

  const withoutThink = raw.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  const parsed = extractJSON(withoutThink);

  if (!parsed || !Array.isArray(parsed.answers) || parsed.answers.length === 0) {
    console.error(`[${label}] Invalid JSON: "${withoutThink.slice(0, 200)}"`);
    throw new Error(`${label}: invalid JSON`);
  }

  const slots = parsed.answers.map(s =>
    (typeof s === "string" ? s.trim().toUpperCase() : "UNKNOWN") || "UNKNOWN"
  );

  console.log(`[${label}] Slots: [${slots.join(", ")}]`);

  const finalSlots = slots.filter(s => s !== "UNKNOWN");
  if (finalSlots.length === 0) {
    console.warn(`[${label}] All slots UNKNOWN`);
    throw new Error(`${label}: no answer found`);
  }

  const answer = finalSlots.join("");
  console.log(`[${label}] ✓ Answer: "${answer}"`);
  return { answer, provider: label.toLowerCase(), slots };
}

// ── AI fragen (Gemini 1 → Gemini 2 als Backup) ───────────────
async function askAI(question, env) {
  const dbEntry = await loadDB();
  const prompt = buildPrompt(dbEntry.text);

  const hasGemini1 = !!env.GEMINI_KEY  && env.GEMINI_KEY.length  > 5;
  const hasGemini2 = !!env.GEMINI_KEY2 && env.GEMINI_KEY2.length > 5;

  if (!hasGemini1 && !hasGemini2) throw new Error("No AI provider configured");

  // ── Gemini 1 (Haupt) ─────────────────────────────────────────
  if (hasGemini1) {
    try {
      return await askGemini(question, prompt, env.GEMINI_KEY, "GEMINI-1");
    } catch (err) {
      console.warn(`[GEMINI-1] Failed: ${err.message} — trying Gemini 2 backup`);
      if (!hasGemini2) throw err;
    }
  }

  // ── Gemini 2 (Backup) ────────────────────────────────────────
  return await askGemini(question, prompt, env.GEMINI_KEY2, "GEMINI-2");
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
    if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

    let body;
    try { body = await request.json(); }
    catch { return json({ error: "Invalid JSON" }, 400); }

    let question = typeof body.question === "string" ? body.question.trim() : "";
    if (!question) return json({ error: "No question provided" }, 400);

    // +Zahl am Ende erkennen und abspalten (z.B. "+24")
    let suffix = "";
    const suffixMatch = question.match(/\s*\+(\d+)\s*$/);
    if (suffixMatch) {
      suffix = suffixMatch[1];
      question = question.slice(0, suffixMatch.index).trim();
    }

    console.log(`[OTEX] Question: "${question}"${suffix ? ` (suffix: +${suffix})` : ""}`);

    // 1. Exakter Lookup
    const dbAnswer = await exactLookup(question);
    if (dbAnswer) {
      console.log(`[OTEX] ✓ Exact DB hit: "${dbAnswer}"`);
      return json({ answer: dbAnswer + suffix, provider: "database" }, 200);
    }

    // 2. AI fragen
    try {
      const result = await askAI(question, env);
      result.answer = result.answer + suffix;
      console.log(`[OTEX] ✓ Final: "${result.answer}" via ${result.provider}`);
      return json({ answer: result.answer, provider: result.provider }, 200);
    } catch (err) {
      console.error(`[OTEX] All providers failed: ${err}`);
      return json({ error: "All providers failed", detail: String(err) }, 502);
    }
  },
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  });
}
