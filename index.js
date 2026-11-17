
 // OTEX Riddle AI Worker — Cloudflare Worker (ES Module)
 // 12 DBs — 12x Gemini 2.5 Flash gleichzeitig

const REPO_BASE = "https://raw.githubusercontent.com/freedrag8-cell/otex-riddle-worker/refs/heads/main";

const GEMINI_MODEL = "gemini-2.5-flash";

const DATABASES = [
  { name: "db1", url: `${REPO_BASE}/db1.txt` },
  { name: "db2", url: `${REPO_BASE}/db2.txt` },
  { name: "db3", url: `${REPO_BASE}/db3.txt` },
  { name: "db4", url: `${REPO_BASE}/db4.txt` },
  { name: "db5", url: `${REPO_BASE}/db5.txt` },
  { name: "db6", url: `${REPO_BASE}/db6.txt` },
  { name: "db7", url: `${REPO_BASE}/db7.txt` },
  { name: "db8", url: `${REPO_BASE}/db8.txt` },
  { name: "db9", url: `${REPO_BASE}/db9.txt` },
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

// ── Exact Lookup ──────────────────────────────────────────────

async function exactLookup(question) {
  const q = question.toLowerCase().trim();

  for (const db of DATABASES) {
    try {
      const entry = await loadDB(db);
      if (entry.map.has(q)) return entry.map.get(q);
    } catch (e) {
      console.error(`[DB] ${db.name}: ${e.message}`);
    }
  }

  return null;
}

// ── System Prompt ─────────────────────────────────────────────

function buildPrompt(dbText, dbName) {
  return `You are a lookup tool for the Roblox game "Steal a Brainrot".

You have access to ONLY the following knowledge base (${dbName}).
This is your ONLY source of truth.

STRICT RULES:
- ONLY use answers from the knowledge base below.
- For each sub-question, search for a matching entry.
- If found, output its value.
- If NOT found, output UNKNOWN for that part.
- Multiple answers must be concatenated with NO spaces.
- Do NOT add punctuation or explanations.
- Every answer must be UPPERCASE.
- Do NOT guess.
- Do NOT use outside knowledge.
- Never invent information.

EXAMPLE:
Knowledge base: what is my name = SAMMY

Question: what is my name what is my favourite brainrot

Answer: SAMMYUNKNOWN

KNOWLEDGE BASE (${dbName}):
${dbText}`;
}

// ── Answer Cleaning ───────────────────────────────────────────

function cleanAnswer(raw) {
  return raw
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/\r?\n/g, " ")
    .trim()
    .replace(/[.!?,;:]+$/, "")
    .trim()
    .toUpperCase();
}

// ── Ask all AIs ───────────────────────────────────────────────

async function askAllAIs(question, env) {
  const geminiKeys = [
    env.GEMINI_KEY,
    env.GEMINI_KEY2,
    env.GEMINI_KEY3,
    env.GEMINI_KEY4,
    env.GEMINI_KEY5,
    env.GEMINI_KEY6,
    env.GEMINI_KEY7,
    env.GEMINI_KEY8,
    env.GEMINI_KEY9,
    env.GEMINI_KEY10,
    env.GEMINI_KEY11,
    env.GEMINI_KEY12,
  ];

  const hasGroq = !!env.GROQ_KEY && env.GROQ_KEY.length > 5;

  const geminiBody = (prompt) => JSON.stringify({
    system_instruction: {
      parts: [{ text: prompt }]
    },
    contents: [
      {
        role: "user",
        parts: [{ text: question }]
      }
    ],
    generationConfig: {
      temperature: 0,
      maxOutputTokens: 128
    }
  });

  const geminiExtract = (data) =>
    data?.candidates?.[0]?.content?.parts
      ?.map(part => part.text || "")
      .join("");

  const geminiUrl = (key) =>
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${key}`;

  // 12 Gemini providers
  const mainConfigs = geminiKeys
    .map((key, i) => {
      if (!key || key.length <= 5) return null;

      return {
        name: `gemini-${i + 1}`,
        db: DATABASES[i],
        url: geminiUrl(key),
        headers: {
          "Content-Type": "application/json"
        },
        buildBody: geminiBody,
        extract: geminiExtract,
      };
    })
    .filter(Boolean);

  // Groq Backup
  const groqBackup = hasGroq ? {
    name: "groq-backup",
    url: "https://api.groq.com/openai/v1/chat/completions",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${env.GROQ_KEY}`
    },
    buildBody: (prompt) => JSON.stringify({
      model: "openai/gpt-oss-120b",
      temperature: 0,
      max_tokens: 128,
      messages: [
        { role: "system", content: prompt },
        { role: "user", content: question }
      ]
    }),
    extract: (data) => data?.choices?.[0]?.message?.content,
  } : null;

  const aiConfigs = mainConfigs;

  if (aiConfigs.length === 0) {
    throw new Error("No AI providers configured");
  }

  console.log(`[OTEX] Question: "${question}"`);
  console.log(`[OTEX] Model: ${GEMINI_MODEL}`);
  console.log(`[OTEX] Active providers: ${aiConfigs.map(a => a.name).join(", ")}`);

  // Run all Gemini requests simultaneously
  const tasks = await Promise.allSettled(
    aiConfigs.map(async (ai) => {
      console.log(`[${ai.name}] Sending request → ${ai.db.name}`);

      const dbEntry = await loadDB(ai.db);
      const prompt = buildPrompt(dbEntry.text, ai.db.name);

      const resp = await fetch(ai.url, {
        method: "POST",
        headers: ai.headers,
        body: ai.buildBody(prompt),
      });

      if (!resp.ok) {
        const err = await resp.text();
        throw new Error(
          `${ai.name}: HTTP ${resp.status} — ${err.slice(0, 150)}`
        );
      }

      const data = await resp.json();
      const raw = ai.extract(data);

      if (!raw?.trim()) {
        throw new Error(`${ai.name}: empty response`);
      }

      const cleaned = cleanAnswer(raw);

      console.log(`[${ai.name}] Answer: "${cleaned}"`);

      if (!cleaned || cleaned === "UNKNOWN") {
        throw new Error(`${ai.name}: no answer`);
      }

      return {
        answer: cleaned,
        provider: ai.name
      };
    })
  );

  const answers = tasks
    .filter(r => r.status === "fulfilled")
    .map(r => r.value);

  const errors = tasks
    .filter(r => r.status === "rejected")
    .map(r => r.reason?.message || String(r.reason));

  console.log(
    `[OTEX] Results: ${answers.length} successful, ${errors.length} failed`
  );

  // ── Groq Backup ─────────────────────────────────────────────

  if (groqBackup && errors.length > 0) {
    const failedDBs = tasks
      .map((r, i) => r.status === "rejected" ? aiConfigs[i].db : null)
      .filter(Boolean);

    console.log(`[OTEX] Groq backup for ${failedDBs.length} DBs`);

    const backupTasks = await Promise.allSettled(
      failedDBs.map(async (db) => {
        const dbEntry = await loadDB(db);
        const prompt = buildPrompt(dbEntry.text, db.name);

        const resp = await fetch(groqBackup.url, {
          method: "POST",
          headers: groqBackup.headers,
          body: groqBackup.buildBody(prompt),
        });

        if (!resp.ok) {
          const err = await resp.text();
          throw new Error(
            `groq-backup ${db.name}: HTTP ${resp.status} — ${err.slice(0, 150)}`
          );
        }

        const data = await resp.json();
        const raw = groqBackup.extract(data);

        if (!raw?.trim()) {
          throw new Error(`groq-backup ${db.name}: empty response`);
        }

        const cleaned = cleanAnswer(raw);

        console.log(`[GROQ] ${db.name}: "${cleaned}"`);

        if (!cleaned || cleaned === "UNKNOWN") {
          throw new Error(`groq-backup ${db.name}: no answer`);
        }

        return {
          answer: cleaned,
          provider: `groq-backup:${db.name}`
        };
      })
    );

    for (const r of backupTasks) {
      if (r.status === "fulfilled") {
        answers.push(r.value);
      } else {
        console.error(`[GROQ] ${r.reason?.message || r.reason}`);
      }
    }
  }

  if (answers.length === 0) {
    throw new Error("All AIs failed: " + errors.join(" | "));
  }

  const validAnswers = answers.filter(a => a.answer !== "UNKNOWN");

  if (validAnswers.length === 0) {
    throw new Error("No AI found an answer");
  }

  const combined = validAnswers.map(a => a.answer).join("");

  console.log(`[OTEX] Final answer: "${combined}"`);

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

    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    let body;

    try {
      body = await request.json();
    } catch {
      return json({ error: "Invalid JSON" }, 400);
    }

    let question =
      typeof body.question === "string"
        ? body.question.trim()
        : "";

    if (!question) {
      return json({ error: "No question provided" }, 400);
    }

    // Detect +number suffix
    let suffix = "";
    const suffixMatch = question.match(/\s*\+(\d+)\s*$/);

    if (suffixMatch) {
      suffix = suffixMatch[1];
      question = question.slice(0, suffixMatch.index).trim();
    }

    // 1. Exact database lookup
    const dbAnswer = await exactLookup(question);

    if (dbAnswer) {
      return json({
        answer: dbAnswer + suffix,
        provider: "database"
      }, 200);
    }

    // 2. Ask all AI providers
    try {
      const result = await askAllAIs(question, env);
      result.answer += suffix;

      return json(result, 200);

    } catch (err) {
      console.error("[OTEX] FINAL ERROR:", err);

      return json({
        error: "All providers failed",
        detail: String(err)
      }, 502);
    }
  },
};

// ── JSON Response ─────────────────────────────────────────────

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
