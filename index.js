// OTEX Riddle AI Worker — Cloudflare Worker (ES Module)
// 12 DBs à ~32KB — 12x Gemini gleichzeitig, jeder liest nur seinen Teil

const REPO_BASE = "https://raw.githubusercontent.com/freedrag8-cell/otex-riddle-worker/refs/heads/main";

const DATABASES = [
  { name: "db1",  url: `${REPO_BASE}/db1.txt`  },
  { name: "db2",  url: `${REPO_BASE}/db2.txt`  },
  { name: "db3",  url: `${REPO_BASE}/db3.txt`  },
  { name: "db4",  url: `${REPO_BASE}/db4.txt`  },
  { name: "db5",  url: `${REPO_BASE}/db5.txt`  },
  { name: "db6",  url: `${REPO_BASE}/db6.txt`  },
  { name: "db7",  url: `${REPO_BASE}/db7.txt`  },
  { name: "db8",  url: `${REPO_BASE}/db8.txt`  },
  { name: "db9",  url: `${REPO_BASE}/db9.txt`  },
  { name: "db10", url: `${REPO_BASE}/db10.txt` },
  { name: "db11", url: `${REPO_BASE}/db11.txt` },
  { name: "db12", url: `${REPO_BASE}/db12.txt` },
];

// ── DB Cache ──────────────────────────────────────────────────
const dbCache = new Map();

async function loadDB(db) {
  if (dbCache.has(db.name)) return dbCache.get(db.name);
  const resp = await fetch(db.url);
  if (!resp.ok) throw new Error(`DB "${db.name}" fetch failed: ${resp.status}`);
  const text = await resp.text();
  const map = new Map();
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

// ── Exakter Lookup in allen 12 DBs ────────────────────────────
async function exactLookup(question) {
  const q = question.toLowerCase().trim();
  for (const db of DATABASES) {
    try {
      const entry = await loadDB(db);
      if (entry.map.has(q)) return entry.map.get(q);
    } catch (e) {}
  }
  return null;
}

// ── System Prompt ─────────────────────────────────────────────
function buildPrompt(dbText, dbName) {
  return `You are a lookup tool for the Roblox game "Steal a Brainrot".
You have access to ONLY the following knowledge base (${dbName}). This is your ONLY source of truth.

STRICT RULES:
- You MUST ONLY use answers from the knowledge base below. Do NOT use any outside knowledge.
- For each sub-question: search the knowledge base for a matching entry. If found, output the value. If NOT found in this knowledge base, output UNKNOWN for that part.
- If the question contains multiple sub-questions, concatenate all answers with NO spaces, NO punctuation, NO explanation.
- Each answer must be UPPERCASE, exactly as it appears in the knowledge base.
- Do NOT guess. Do NOT use general knowledge. If the exact question is not in the knowledge base, reply UNKNOWN.

EXAMPLE (if knowledge base only has "what is my name = SAMMY"):
Question: "what is my name what is my favourite brainrot"
Answer: SAMMYUNKNOWN

KNOWLEDGE BASE (${dbName}) — your ONLY source:
${dbText}`;
}

// ── Alle AIs fragen ───────────────────────────────────────────
async function askAllAIs(question, env) {
  // 12 Gemini Keys: GEMINI_KEY, GEMINI_KEY2 … GEMINI_KEY12
  const geminiKeys = [
    env.GEMINI_KEY,  env.GEMINI_KEY2,  env.GEMINI_KEY3,
    env.GEMINI_KEY4, env.GEMINI_KEY5,  env.GEMINI_KEY6,
    env.GEMINI_KEY7, env.GEMINI_KEY8,  env.GEMINI_KEY9,
    env.GEMINI_KEY10,env.GEMINI_KEY11, env.GEMINI_KEY12,
  ];
  const hasGroq = !!env.GROQ_KEY && env.GROQ_KEY.length > 5;

  const geminiBody = (prompt) => JSON.stringify({
    system_instruction: { parts: [{ text: prompt }] },
    contents: [{ role: "user", parts: [{ text: question }] }],
    generationConfig: { temperature: 0, maxOutputTokens: 64 },
  });

  const geminiExtract = (d) => d?.candidates?.[0]?.content?.parts?.[0]?.text;

  // ONLY CHANGE: Gemini model
  const geminiUrl = (key) => `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent?key=${key}`;

  // 12x Gemini, jeder mit eigenem Key und eigener DB
  const mainConfigs = geminiKeys
    .map((key, i) => key && key.length > 5 ? {
      name: `gemini-${i + 1}`,
      db: DATABASES[i],
      url: geminiUrl(key),
      headers: { "Content-Type": "application/json" },
      buildBody: geminiBody,
      extract: geminiExtract,
    } : null)
    .filter(Boolean);

  // Groq Backup
  const groqBackup = hasGroq ? {
    name: "groq-backup",
    url: "https://api.groq.com/openai/v1/chat/completions",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${env.GROQ_KEY}` },
    buildBody: (prompt) => JSON.stringify({
      model: "openai/gpt-oss-120b",
      temperature: 0,
      max_tokens: 64,
      messages: [{ role: "system", content: prompt }, { role: "user", content: question }],
    }),
    extract: (d) => d?.choices?.[0]?.message?.content,
  } : null;

  const aiConfigs = mainConfigs;

  if (aiConfigs.length === 0) throw new Error("No AI providers configured");

  console.log(`[OTEX] Question: "${question}"`);
  console.log(`[OTEX] Active providers: ${aiConfigs.map(a => a.name).join(", ")}`);

  const tasks = await Promise.allSettled(aiConfigs.map(async (ai) => {
    console.log(`[${ai.name.toUpperCase()}] Sending request → db: ${ai.db.name}`);
    const dbEntry = await loadDB(ai.db);
    const prompt = buildPrompt(dbEntry.text, ai.db.name);
    const resp = await fetch(ai.url, {
      method: "POST",
      headers: ai.headers,
      body: ai.buildBody(prompt),
    });
    if (!resp.ok) {
      const err = await resp.text();
      console.error(`[${ai.name.toUpperCase()}] FAILED — HTTP ${resp.status}: ${err.slice(0, 200)}`);
      throw new Error(`${ai.name}: HTTP ${resp.status} — ${err.slice(0, 150)}`);
    }
    const data = await resp.json();
    const raw = ai.extract(data);
    if (!raw?.trim()) {
      console.error(`[${ai.name.toUpperCase()}] FAILED — empty response. Full data: ${JSON.stringify(data).slice(0, 300)}`);
      throw new Error(`${ai.name}: empty response`);
    }
    const cleaned = raw
      .replace(/<think>[\s\S]*?<\/think>/gi, "")
      .replace(/\r?\n/g, " ")
      .trim()
      .replace(/[.!?,;:]+$/, "")
      .trim()
      .toUpperCase();
    console.log(`[${ai.name.toUpperCase()}] Raw answer: "${raw.trim()}" → Cleaned: "${cleaned}"`);
    if (!cleaned || cleaned === "UNKNOWN") {
      console.warn(`[${ai.name.toUpperCase()}] Answered UNKNOWN — not in db ${ai.db.name}`);
      throw new Error(`${ai.name}: no answer`);
    }
    console.log(`[${ai.name.toUpperCase()}] ✓ Answer: "${cleaned}"`);
    return { answer: cleaned, provider: ai.name };
  }));

  const answers = tasks
    .filter(r => r.status === "fulfilled")
    .map(r => r.value);

  const errors = tasks
    .filter(r => r.status === "rejected")
    .map(r => r.reason?.message || String(r.reason));

  console.log(`[OTEX] Results — fulfilled: ${answers.length}, failed: ${errors.length}`);
  if (errors.length > 0) console.warn(`[OTEX] Errors: ${errors.join(" | ")}`);

  // Groq Backup: für jeden fehlgeschlagenen Provider mit seiner DB nochmal versuchen
  if (groqBackup && errors.length > 0) {
    const failedDBs = tasks
      .map((r, i) => r.status === "rejected" ? aiConfigs[i].db : null)
      .filter(Boolean);

    console.log(`[OTEX] Groq backup kicking in for ${failedDBs.length} failed DB(s)`);
    const backupTasks = await Promise.allSettled(failedDBs.map(async (db) => {
      const dbEntry = await loadDB(db);
      const prompt = buildPrompt(dbEntry.text, db.name);
      const resp = await fetch(groqBackup.url, {
        method: "POST",
        headers: groqBackup.headers,
        body: groqBackup.buildBody(prompt, db),
      });
      if (!resp.ok) {
        const err = await resp.text();
        console.error(`[GROQ-BACKUP] FAILED — HTTP ${resp.status}: ${err.slice(0, 200)}`);
        throw new Error(`groq-backup: HTTP ${resp.status}`);
      }
      const data = await resp.json();
      const raw = groqBackup.extract(data);
      if (!raw?.trim()) throw new Error("groq-backup: empty response");
      const cleaned = raw
        .replace(/<think>[\s\S]*?<\/think>/gi, "")
        .replace(/\r?\n/g, " ")
        .trim()
        .replace(/[.!?,;:]+$/, "")
        .trim()
        .toUpperCase();
      console.log(`[GROQ-BACKUP] db: ${db.name} → "${cleaned}"`);
      if (!cleaned || cleaned === "UNKNOWN") throw new Error("groq-backup: no answer");
      return { answer: cleaned, provider: `groq-backup:${db.name}` };
    }));

    for (const r of backupTasks) {
      if (r.status === "fulfilled") answers.push(r.value);
    }
  }

  if (answers.length === 0) throw new Error("All AIs failed: " + errors.join(" | "));

  const validAnswers = answers.filter(a => a.answer !== "UNKNOWN");
  if (validAnswers.length === 0) throw new Error("No AI found an answer");

  const combined = validAnswers.map(a => a.answer).join("");
  console.log(`[OTEX] Final answer: "${combined}" from ${validAnswers.map(a => a.provider).join("+")}`);

  return {
    answer: combined,
    provider: validAnswers.map(a => a.provider).join("+"),
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

    // 1. Exakter Lookup in allen 12 DBs
    const dbAnswer = await exactLookup(question);
    if (dbAnswer) return json({ answer: dbAnswer + suffix, provider: "database" }, 200);

    // 2. Alle 12 AIs fragen
    try {
      const result = await askAllAIs(question, env);
      result.answer = result.answer + suffix;
      return json(result, 200);
    } catch (err) {
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
