// OTEX Riddle AI Worker — Cloudflare Worker (ES Module)
// 1 vollständige DB (~394KB) — 1x Gemini, Groq als Backup

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

// ── AI fragen ─────────────────────────────────────────────────
async function askAI(question, env) {
  const dbEntry = await loadDB();
  const prompt = buildPrompt(dbEntry.text);

  const hasGemini = !!env.GEMINI_KEY && env.GEMINI_KEY.length > 5;
  const hasGroq   = !!env.GROQ_KEY   && env.GROQ_KEY.length > 5;

  if (!hasGemini && !hasGroq) throw new Error("No AI provider configured");

  // ── Gemini ───────────────────────────────────────────────────
  if (hasGemini) {
    console.log(`[GEMINI] Sending request…`);
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${env.GEMINI_KEY}`;
    const geminiBody = JSON.stringify({
      system_instruction: { parts: [{ text: prompt }] },
      contents: [{ role: "user", parts: [{ text: question }] }],
      generationConfig: { temperature: 0, maxOutputTokens: 256 },
    });

    try {
      const resp = await fetch(geminiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: geminiBody,
      });

      if (!resp.ok) {
        const err = await resp.text();
        console.error(`[GEMINI] HTTP ${resp.status}: ${err.slice(0, 200)}`);
        throw new Error(`Gemini HTTP ${resp.status}`);
      }

      const data = await resp.json();
      const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!raw?.trim()) {
        console.error(`[GEMINI] Empty response. Data: ${JSON.stringify(data).slice(0, 300)}`);
        throw new Error("Gemini empty response");
      }

      console.log(`[GEMINI] Raw: "${raw.trim()}"`);

      const withoutThink = raw.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
      const parsed = extractJSON(withoutThink);

      if (!parsed || !Array.isArray(parsed.answers) || parsed.answers.length === 0) {
        console.error(`[GEMINI] Invalid JSON response: "${withoutThink.slice(0, 200)}"`);
        throw new Error("Gemini invalid JSON");
      }

      // Slots bereinigen
      const slots = parsed.answers.map(s =>
        (typeof s === "string" ? s.trim().toUpperCase() : "UNKNOWN") || "UNKNOWN"
      );

      console.log(`[GEMINI] Slots: [${slots.join(", ")}]`);

      // Finale Antwort: UNKNOWN-Slots rausfiltern, Rest zusammensetzen
      const finalSlots = slots.filter(s => s !== "UNKNOWN");

      if (finalSlots.length === 0) {
        console.warn(`[GEMINI] All slots UNKNOWN`);
        throw new Error("Gemini: no answer found");
      }

      const answer = finalSlots.join("");
      console.log(`[GEMINI] ✓ Answer: "${answer}"`);
      return { answer, provider: "gemini", slots };

    } catch (geminiErr) {
      console.warn(`[GEMINI] Failed: ${geminiErr.message} — trying Groq backup`);
      if (!hasGroq) throw geminiErr;
      // Groq Backup folgt unten
      return await askGroq(question, prompt, env);
    }
  }

  // Kein Gemini konfiguriert → direkt Groq
  return await askGroq(question, prompt, env);
}

// ── Groq Backup ───────────────────────────────────────────────
async function askGroq(question, prompt, env) {
  console.log(`[GROQ] Sending backup request…`);
  const resp = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${env.GROQ_KEY}`,
    },
    body: JSON.stringify({
      model: "openai/gpt-oss-120b",
      temperature: 0,
      max_tokens: 256,
      messages: [
        { role: "system", content: prompt },
        { role: "user",   content: question },
      ],
    }),
  });

  if (!resp.ok) {
    const err = await resp.text();
    console.error(`[GROQ] HTTP ${resp.status}: ${err.slice(0, 200)}`);
    throw new Error(`Groq HTTP ${resp.status}`);
  }

  const data = await resp.json();
  const raw = data?.choices?.[0]?.message?.content;
  if (!raw?.trim()) throw new Error("Groq empty response");

  console.log(`[GROQ] Raw: "${raw.trim()}"`);

  const withoutThink = raw.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  const parsed = extractJSON(withoutThink);

  if (!parsed || !Array.isArray(parsed.answers) || parsed.answers.length === 0) {
    console.error(`[GROQ] Invalid JSON: "${withoutThink.slice(0, 200)}"`);
    throw new Error("Groq invalid JSON");
  }

  const slots = parsed.answers.map(s =>
    (typeof s === "string" ? s.trim().toUpperCase() : "UNKNOWN") || "UNKNOWN"
  );

  console.log(`[GROQ] Slots: [${slots.join(", ")}]`);

  const finalSlots = slots.filter(s => s !== "UNKNOWN");
  if (finalSlots.length === 0) {
    console.warn(`[GROQ] All slots UNKNOWN`);
    throw new Error("Groq: no answer found");
  }

  const answer = finalSlots.join("");
  console.log(`[GROQ] ✓ Answer: "${answer}"`);
  return { answer, provider: "groq", slots };
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
