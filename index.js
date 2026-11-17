
// OTEX Riddle AI Worker — Cloudflare Worker (ES Module)
// 12 DBs — 12x Gemini gleichzeitig, jeder liest nur seinen eigenen Teil

const REPO_BASE = "https://raw.githubusercontent.com/freedrag8-cell/otex-riddle-worker/refs/heads/main";

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

  if (!resp.ok) {
    throw new Error(`DB "${db.name}" fetch failed: ${resp.status}`);
  }

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

// ── Teilfragen erkennen ───────────────────────────────────────

function splitSubquestions(question) {
  const starters =
    "(?:what|which|who|whom|whose|when|where|why|how|is|are|was|were|do|does|did|can|could|has|have|had|will|would)";

  const pattern = new RegExp(
    `[,;]\\s*(?:and\\s+)?(?=${starters}\\b)|\\s+and\\s+(?=${starters}\\b)`,
    "gi"
  );

  const parts = question
    .replace(/\s+/g, " ")
    .trim()
    .split(pattern)
    .map(part => part.trim().replace(/^and\s+/i, ""))
    .filter(Boolean);

  return parts.length > 0 ? parts : [question.trim()];
}

// ── System Prompt ─────────────────────────────────────────────

function buildPrompt(dbText, dbName, parts) {
  const numberedQuestions = parts
    .map((part, i) => `${i + 1}. ${part}`)
    .join("\n");

  return `You are a strict database lookup tool for the Roblox game "Steal a Brainrot".

You have access to ONLY this knowledge base: ${dbName}.
This database is your ONLY source of truth.

STRICT RULES:
- Answer every numbered question separately.
- Search ONLY your own knowledge base.
- Never use outside knowledge.
- Never guess or invent answers.
- If the answer is not explicitly available in your database, use "UNKNOWN".
- Every answer must be an exact database value.
- Do not explain anything.
- Do not add comments.
- Do not combine answers.
- Keep the original question order.
- Return exactly one answer for every numbered question.
- Return ONLY a valid JSON array of strings.
- Use uppercase answers.

IMPORTANT:
If you cannot answer question 1 but can answer question 2, return:
["UNKNOWN","THE_DATABASE_VALUE"]

If you can answer question 1 and question 3 but not question 2, return:
["ANSWER1","UNKNOWN","ANSWER3"]

QUESTIONS:
${numberedQuestions}

REQUIRED OUTPUT:
A JSON array containing exactly ${parts.length} strings.

KNOWLEDGE BASE (${dbName}) — YOUR ONLY SOURCE:
${dbText}`;
}

// ── Antworten aus JSON lesen und überprüfen ───────────────────

function parseAnswers(raw, expectedLength, dbEntry) {
  if (!raw || !raw.trim()) {
    throw new Error("Empty AI response");
  }

  let cleaned = raw
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .trim();

  // Markdown-Codeblöcke entfernen
  cleaned = cleaned
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  // JSON-Array aus der Antwort extrahieren
  const start = cleaned.indexOf("[");
  const end = cleaned.lastIndexOf("]");

  if (start === -1 || end === -1 || end < start) {
    throw new Error("AI did not return a JSON array");
  }

  let parsed;

  try {
    parsed = JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    throw new Error("Invalid JSON response");
  }

  if (!Array.isArray(parsed) || parsed.length !== expectedLength) {
    throw new Error(
      `Wrong answer count: expected ${expectedLength}, got ${Array.isArray(parsed) ? parsed.length : "invalid"}`
    );
  }

  // Nur Werte akzeptieren, die wirklich in dieser DB vorkommen.
  const validDBValues = new Set(dbEntry.map.values());

  return parsed.map(value => {
    if (typeof value !== "string") return "UNKNOWN";

    const answer = value.trim().toUpperCase();

    if (!answer || answer === "UNKNOWN") return "UNKNOWN";

    if (!validDBValues.has(answer)) {
      return "UNKNOWN";
    }

    return answer;
  });
}

// ── Eindeutige Antwort pro Teilfrage bestimmen ─────────────────

function selectAnswers(providerResults, questionCount) {
  const selected = [];
  const sources = [];

  for (let i = 0; i < questionCount; i++) {
    const counts = new Map();

    for (const result of providerResults) {
      const answer = result.answers[i];

      if (!answer || answer === "UNKNOWN") continue;

      counts.set(answer, (counts.get(answer) || 0) + 1);
    }

    if (counts.size === 0) {
      selected.push("UNKNOWN");
      continue;
    }

    const sorted = [...counts.entries()]
      .sort((a, b) => b[1] - a[1]);

    const highestCount = sorted[0][1];
    const secondHighest = sorted[1]?.[1] ?? 0;

    // Bei Gleichstand keine zufällige Antwort auswählen.
    if (highestCount === secondHighest) {
      selected.push("UNKNOWN");
      continue;
    }

    selected.push(sorted[0][0]);

    const matchingProviders = providerResults
      .filter(result => result.answers[i] === sorted[0][0])
      .map(result => result.provider);

    sources.push(...matchingProviders);
  }

  return {
    answers: selected,
    sources: [...new Set(sources)],
  };
}

// ── Alle AIs fragen ───────────────────────────────────────────

async function askAllAIs(question, env) {
  const parts = splitSubquestions(question);

  console.log(`[OTEX] Detected ${parts.length} sub-question(s)`);

  parts.forEach((part, i) => {
    console.log(`[OTEX] Part ${i + 1}: ${part}`);
  });

  const numberedQuestions = parts
    .map((part, i) => `${i + 1}. ${part}`)
    .join("\n");

  // 12 Gemini Keys
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

  const outputTokens = Math.min(
    1024,
    Math.max(128, parts.length * 64)
  );

  const geminiBody = (prompt) => JSON.stringify({
    system_instruction: {
      parts: [{ text: prompt }],
    },
    contents: [{
      role: "user",
      parts: [{ text: numberedQuestions }],
    }],
    generationConfig: {
      temperature: 0,
      maxOutputTokens: outputTokens,
    },
  });

  const geminiExtract = d =>
    d?.candidates?.[0]?.content?.parts?.[0]?.text;

  // Gemini-Modell bleibt wie in deinem aktuellen Code.
  const geminiUrl = key =>
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent?key=${key}`;

  // 12 Gemini Provider, jeder mit seiner eigenen DB.
  const mainConfigs = geminiKeys
    .map((key, i) => key && key.length > 5 ? {
      name: `gemini-${i + 1}`,
      db: DATABASES[i],
      url: geminiUrl(key),
      headers: {
        "Content-Type": "application/json",
      },
      buildBody: geminiBody,
      extract: geminiExtract,
    } : null)
    .filter(Boolean);

  // Groq Backup
  const groqBackup = hasGroq ? {
    name: "groq-backup",
    url: "https://api.groq.com/openai/v1/chat/completions",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${env.GROQ_KEY}`,
    },
    buildBody: (prompt) => JSON.stringify({
      model: "openai/gpt-oss-120b",
      temperature: 0,
      max_tokens: outputTokens,
      messages: [
        { role: "system", content: prompt },
        { role: "user", content: numberedQuestions },
      ],
    }),
    extract: d => d?.choices?.[0]?.message?.content,
  } : null;

  if (mainConfigs.length === 0) {
    throw new Error("No AI providers configured");
  }

  console.log(
    `[OTEX] Active providers: ${mainConfigs.map(a => a.name).join(", ")}`
  );

  // ── Gemini Requests ────────────────────────────────────────

  const tasks = await Promise.allSettled(
    mainConfigs.map(async ai => {
      console.log(
        `[${ai.name.toUpperCase()}] Sending request → ${ai.db.name}`
      );

      const dbEntry = await loadDB(ai.db);
      const prompt = buildPrompt(dbEntry.text, ai.db.name, parts);

      const resp = await fetch(ai.url, {
        method: "POST",
        headers: ai.headers,
        body: ai.buildBody(prompt),
      });

      if (!resp.ok) {
        const err = await resp.text();

        console.error(
          `[${ai.name.toUpperCase()}] HTTP ${resp.status}: ${err.slice(0, 200)}`
        );

        throw new Error(
          `${ai.name}: HTTP ${resp.status} — ${err.slice(0, 150)}`
        );
      }

      const data = await resp.json();
      const raw = ai.extract(data);

      if (!raw?.trim()) {
        throw new Error(`${ai.name}: empty response`);
      }

      console.log(`[${ai.name.toUpperCase()}] Raw: ${raw}`);

      const parsedAnswers = parseAnswers(
        raw,
        parts.length,
        dbEntry
      );

      console.log(
        `[${ai.name.toUpperCase()}] Parsed: ${JSON.stringify(parsedAnswers)}`
      );

      // Wenn ALLE Antworten UNKNOWN sind, gilt der Provider als fehlgeschlagen.
      if (parsedAnswers.every(a => a === "UNKNOWN")) {
        throw new Error(`${ai.name}: all answers UNKNOWN`);
      }

      return {
        answers: parsedAnswers,
        provider: ai.name,
        db: ai.db.name,
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
    `[OTEX] Gemini results — fulfilled: ${answers.length}, failed: ${errors.length}`
  );

  if (errors.length > 0) {
    console.warn(`[OTEX] Errors: ${errors.join(" | ")}`);
  }

  // ── Groq Backup für fehlgeschlagene Gemini Provider ────────

  if (groqBackup && errors.length > 0) {
    const failedDBs = tasks
      .map((r, i) =>
        r.status === "rejected" ? mainConfigs[i].db : null
      )
      .filter(Boolean);

    console.log(
      `[OTEX] Groq backup for ${failedDBs.length} failed DB(s)`
    );

    const backupTasks = await Promise.allSettled(
      failedDBs.map(async db => {
        const dbEntry = await loadDB(db);
        const prompt = buildPrompt(dbEntry.text, db.name, parts);

        const resp = await fetch(groqBackup.url, {
          method: "POST",
          headers: groqBackup.headers,
          body: groqBackup.buildBody(prompt),
        });

        if (!resp.ok) {
          const err = await resp.text();

          console.error(
            `[GROQ-BACKUP] HTTP ${resp.status}: ${err.slice(0, 200)}`
          );

          throw new Error(`groq-backup: HTTP ${resp.status}`);
        }

        const data = await resp.json();
        const raw = groqBackup.extract(data);

        if (!raw?.trim()) {
          throw new Error("groq-backup: empty response");
        }

        const parsedAnswers = parseAnswers(
          raw,
          parts.length,
          dbEntry
        );

        console.log(
          `[GROQ-BACKUP] ${db.name}: ${JSON.stringify(parsedAnswers)}`
        );

        if (parsedAnswers.every(a => a === "UNKNOWN")) {
          throw new Error("groq-backup: all answers UNKNOWN");
        }

        return {
          answers: parsedAnswers,
          provider: `groq-backup:${db.name}`,
          db: db.name,
        };
      })
    );

    for (const result of backupTasks) {
      if (result.status === "fulfilled") {
        answers.push(result.value);
      } else {
        console.warn(
          `[OTEX] Groq failed: ${result.reason?.message || result.reason}`
        );
      }
    }
  }

  if (answers.length === 0) {
    throw new Error(
      "All AIs failed: " + errors.join(" | ")
    );
  }

  // ── Antworten nach Teilfragen zusammenführen ───────────────

  const result = selectAnswers(answers, parts.length);

  const finalAnswer = result.answers
    .filter(answer => answer !== "UNKNOWN")
    .join("");

  if (!finalAnswer) {
    throw new Error("No AI found an answer");
  }

  console.log(
    `[OTEX] Final parts: ${JSON.stringify(result.answers)}`
  );

  console.log(
    `[OTEX] Final answer: "${finalAnswer}"`
  );

  return {
    answer: finalAnswer,
    provider: result.sources.join("+") || "database",
    sub_answers: result.answers,
    all_answers: answers.map(a =>
      `${a.provider}:${JSON.stringify(a.answers)}`
    ),
  };
}

// ── Main Handler ─────────────────────────────────────────────

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

    // +Zahl am Ende erkennen und abspalten.
    let suffix = "";

    const suffixMatch = question.match(/\s*\+(\d+)\s*$/);

    if (suffixMatch) {
      suffix = suffixMatch[1];
      question = question.slice(0, suffixMatch.index).trim();
    }

    // 1. Exakter Lookup in allen 12 DBs.
    const dbAnswer = await exactLookup(question);

    if (dbAnswer) {
      return json({
        answer: dbAnswer + suffix,
        provider: "database",
      }, 200);
    }

    // 2. Alle AIs fragen.
    try {
      const result = await askAllAIs(question, env);

      result.answer += suffix;

      return json(result, 200);
    } catch (err) {
      console.error("[OTEX] Final error:", err);

      return json({
        error: "All providers failed",
        detail: String(err),
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
