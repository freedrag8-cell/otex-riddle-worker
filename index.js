// OTEX Riddle AI Worker — Cloudflare Worker (ES Module)
// Race: Groq + Gemini + OpenRouter — schnellste Antwort gewinnt

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
      return new Response(JSON.stringify({ error: "Invalid JSON" }), {
        status: 400,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }

    const question = typeof body.question === "string" ? body.question.trim() : "";
    if (!question) {
      return new Response(JSON.stringify({ error: "No question provided" }), {
        status: 400,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }

    // ── Knowledge Base ──────────────────────────────────────────
    const SYSTEM_PROMPT = `You are an expert on the Roblox game "Steal a Brainrot". Answer riddle questions with ONLY the answer word/code, no explanation, no punctuation, no extra text. Just the answer.

Knowledge base:
- Real name of the game host: SAMBRATKA
- 19th machine: BROSMACHINE (type: MACHINE)
- Bros Machine brainrots: SCARYBROS, SCORPIBROS, NOOBINIBROS, NACHOBROS, FESTIVEFESTIVEBROS, SAMMYINIBROS
- Best brainrot from Bros Machine: SCARYBROS
- Second best: SAMMYINIBROS
- Third best: FESTIVEFESTIVEBROS
- Fourth best: SCORPIBROS
- Fifth best: NOOBINIBROS
- Sixth best: NACHOBROS

Rules:
- Answer with ONE word or code only
- Always UPPERCASE
- No punctuation, no spaces unless the answer itself has spaces
- If unsure, give your best guess`;

    // ── Provider Configs ────────────────────────────────────────
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
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user",   content: question },
          ],
        }),
        extract: (data) => data?.choices?.[0]?.message?.content,
      },
      {
        name: "gemini",
        url: `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent`,
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": env.GEMINI_KEY,
        },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
          contents: [{ role: "user", parts: [{ text: question }] }],
          generationConfig: { temperature: 0, maxOutputTokens: 64 },
        }),
        extract: (data) => data?.candidates?.[0]?.content?.parts?.[0]?.text,
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
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user",   content: question },
          ],
        }),
        extract: (data) => data?.choices?.[0]?.message?.content,
      },
    ];

    // ── Race all providers ──────────────────────────────────────
    const racePromises = providers.map(async (p) => {
      const resp = await fetch(p.url, {
        method: "POST",
        headers: p.headers,
        body: p.body,
      });

      if (!resp.ok) {
        throw new Error(`${p.name}: HTTP ${resp.status}`);
      }

      const data = await resp.json();
      const raw  = p.extract(data);

      if (!raw || raw.trim() === "") {
        throw new Error(`${p.name}: empty response`);
      }

      // Clean: strip whitespace, punctuation at end, uppercase
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

    // Promise.any = erste die NICHT wirft gewinnt
    let winner;
    try {
      winner = await Promise.any(racePromises);
    } catch (err) {
      // Alle haben gefailt
      return new Response(JSON.stringify({ error: "All providers failed", detail: String(err) }), {
        status: 502,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }

    return new Response(JSON.stringify({ answer: winner.answer, provider: winner.provider }), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    });
  },
};
