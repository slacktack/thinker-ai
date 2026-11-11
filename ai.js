/* ============================================================
   THINKER AI — Socratic by construction.
   Primary: your LFM3 bridge (no key, open CORS).
   Fallback: a contextual local mind that listens to the thread,
   quotes the writer's words, and scribbles ideas step by step.
   Every response is question-first and revealed word-by-word in ink.
   ============================================================ */
(function () {
  "use strict";

  const BASE = "https://ail.buyhatke.com/lfm";
  const UA = {}; // never set User-Agent: Safari sends it, and the server's CORS rejects it
  const SKETCH_KEYS = ["flow", "incline", "recursion", "twosum", "timeline", "graph", "nqueens", "linkedlist", "binarysearch", "bigo", "none"];

  const state = { mode: "local", health: null, lastCheck: 0 };

  /* ---------- low-level LFM3 client ---------- */
  async function health(force) {
    const now = Date.now();
    if (!force && state.mode === "live" && state.health && now - state.lastCheck < 30000) return state.health;
    try {
      const r = await fetch(BASE + "/health", { headers: UA, signal: timeout(6000) });
      const j = await r.json();
      state.health = j;
      state.mode = j && j.text && j.text.up ? "live" : "local";
    } catch (e) {
      state.health = null;
      state.mode = "local";
    }
    state.lastCheck = now;
    return state.health;
  }

  function timeout(ms) {
    const c = new AbortController();
    setTimeout(() => c.abort(), ms);
    return c.signal;
  }

  async function chat({ messages, thinking = false, max_tokens = 400, temperature = 0.7, response_format, signal }) {
    const body = { messages, thinking, max_tokens, temperature };
    if (response_format) body.response_format = response_format;
    const r = await fetch(BASE + "/text/v1/chat/completions", {
      method: "POST",
      headers: Object.assign({ "Content-Type": "application/json" }, UA),
      body: JSON.stringify(body),
      signal: signal || timeout(150000),
    });
    if (!r.ok) throw new Error("lfm " + r.status);
    const j = await r.json();
    const msg = j.choices && j.choices[0] && j.choices[0].message;
    if (!msg) throw new Error("lfm empty");
    return { content: msg.content || "", reasoning: msg.reasoning_content || "" };
  }

  // Vision: read an image as plain facts so the Socratic text model can reason over it.
  async function see(dataUrl) {
    const r = await fetch(BASE + "/vl/v1/chat/completions", {
      method: "POST",
      headers: Object.assign({ "Content-Type": "application/json" }, UA),
      body: JSON.stringify({
        max_tokens: 260, temperature: 0.1,
        messages: [
          { role: "system", content: "Read the image exactly. Transcribe any text, code or math verbatim. Then describe diagrams or figures as plain facts. Never guess. Max 150 words." },
          { role: "user", content: [{ type: "image_url", image_url: { url: dataUrl } }, { type: "text", text: "What is in this image?" }] },
        ],
      }),
      signal: timeout(60000),
    });
    if (!r.ok) throw new Error("vl " + r.status);
    const j = await r.json();
    return (j.choices && j.choices[0] && j.choices[0].message.content || "").trim();
  }

  async function tts(text, voice = "female") {
    const r = await fetch(BASE + "/omni/tts", {
      method: "POST",
      headers: Object.assign({ "Content-Type": "application/json" }, UA),
      body: JSON.stringify({ input: text, voice, language: "en" }),
      signal: timeout(20000),
    });
    if (!r.ok) throw new Error("tts " + r.status);
    return URL.createObjectURL(await r.blob());
  }

  async function stt(base64wav) {
    const r = await fetch(BASE + "/omni/v1/chat/completions", {
      method: "POST",
      headers: Object.assign({ "Content-Type": "application/json" }, UA),
      body: JSON.stringify({
        temperature: 0,
        messages: [
          { role: "system", content: "Perform ASR. Transcribe exactly." },
          { role: "user", content: [{ type: "input_audio", input_audio: { data: base64wav, format: "wav" } }] },
        ],
      }),
      signal: timeout(20000),
    });
    if (!r.ok) throw new Error("stt " + r.status);
    const j = await r.json();
    return j.choices[0].message.content;
  }

  /* ---------- the Socratic contract ---------- */
  const SYSTEM = [
    "You are Thinker, a Socratic tutor writing in the margin of someone's notebook.",
    "Think in at most 4 short lines (under 60 words), then answer.",
    "Rules:",
    "- Answer the QUESTION. Older notes and thread are background only; never answer an older question again.",
    "- One move, max 45 words: the standard textbook fact or one plain sentence that makes it click, then one question.",
    "- Use only well-established facts. Never invent numbers, names or formulas.",
    "- If they name a problem you don't know by name (e.g. a LeetCode title), don't guess: say you don't know that exact problem and ask them to paste the statement.",
    "- If you are not sure what they mean, ask one short clarifying question instead of guessing.",
    "- Reply in English. Only if the writer writes in Hindi or Hinglish, reply in Hinglish using Latin script.",
    "- say is your final answer only: no thinking out loud, no 'Wait', no self-corrections.",
    "- For coding problems give only the next hint (the idea or what to track) and a question; never the full recurrence, solution or code.",
    "- Never write their notes, full solutions or complete code. If they ask for full code, say you'll guide them instead and give the first step as a hint.",
    "- Plain text only: no LaTeX, no $ signs, no markdown. Write math in plain text, using ^ for powers.",
    "- If the answer has a key formula, put it in formula and explain each symbol in terms.",
    "- If the idea is a process or algorithm, put 3 to 6 steps in steps, each 6 words max, in order.",
    "- Numbers and calculations go in work (one calculation per line, with its result), never in say. When there are numbers, say stays short reasoning, max 30 words.",
    "- draw=true when a picture helps them see it; pick the closest sketch, else none.",
    'Output JSON only: {"say": string, "title": "2-5 word note title for this topic", "formula": string or null, "terms": [[symbol, meaning]], "steps": [string], "work": [string], "draw": boolean, "sketch": "' + SKETCH_KEYS.join("|") + '"}',
  ].join("\n");

  // The thinking call only gets the facts right: tiny schema, so its reasoning stays short.
  const SYSTEM_FACTS = SYSTEM.split("\n").filter((l) => !/formula|steps|work|draw=|Output JSON|title/.test(l)).concat('Output JSON only: {"say": string}').join("\n");

  // What each slash command means, in words the model can follow.
  const TASK_HINT = {
    explain: "Explain it clearly and completely; the study sheet on the page carries the details, so say gives the big picture.",
    draw: "Make it visual: fill steps, work or formula so it can be drawn.",
    quiz: "Quiz them: ask exactly 3 short numbered questions about this topic, easiest first. Do not give the answers.",
    vent: "Just listen: reflect what they seem to feel in one or two sentences, no advice, then one gentle question.",
    challenge: "Poke holes: name the weakest assumption in what they wrote and ask one sharp question about it.",
    plan: "Help them plan: 3 to 5 concrete next steps in steps, then ask which one they'll start with.",
  };
  const SYSTEM_LESSON = [
    "You write a compact study sheet that answers the QUESTION for a student.",
    "One section per item the question asks about (each law, type, pillar, equation or concept), max 5, in the usual textbook order. Never add topics that were not asked.",
    "Each section: title (short), idea (one plain sentence), formula (or null), example (one concrete everyday or numeric example), derive (2 to 4 short steps showing why it holds or how the formula follows).",
    "Use only standard textbook facts. Plain text only: no LaTeX, no $ signs, no markdown. Write math in plain text, using ^ for powers.",
    'Output JSON only: {"sections": [{"title": string, "idea": string, "formula": string or null, "example": string, "derive": [string]}]}',
  ].join("\n");
  const WANTS_LESSON = /\b(all|each|every|list|compare|comparison|differences?|types of|kinds of|laws|pillars|principles|derive|derivation|prove|with examples?|and examples?|in detail|step by step|full explanation)\b|\b\d+\s+(laws|pillars|types|principles|rules|stages|steps|phases|kinds)\b/i;

  // Stable prefix first (note, thread) so the server's prompt cache reuses it; the changing ask goes last.
  // a hand-drawn sketch only when the question names its exact subject
  const EXACT = { twosum: /two\s?sum/i, linkedlist: /linked\s?list/i, binarysearch: /binary\s?search/i, recursion: /recursi|fibonacci|fib\(/i, nqueens: /n.?queens/i, incline: /inclin|slope|ramp/i, bigo: /big.?o\b|time complexity|space complexity/i };
  const NOTE_CHARS = 64000, HIST_TURNS = 8;
  function latestLine(t) { const ls = String(t || "").split(/\n+/).map((x) => x.trim()).filter(Boolean); return (ls[ls.length - 1] || "").slice(-400); }
  function buildMessages({ noteText, message, persona, intent, task, history }, system) {
    if (!message && latestLine(noteText)) message = latestLine(noteText);
    const hist = (history || []).slice(-HIST_TURNS).map((m) => (m.who === "you" ? "Writer: " : "Thinker: ") + truncate(m.text, 1200)).join("\n");
    let ctx = [
      noteText ? "NOTE:\n" + tail(noteText, NOTE_CHARS) : "NOTE: (empty)",
      hist ? "THREAD:\n" + hist : "",
      [persona && persona !== "Thinker" ? "Persona: " + persona + "." : "", intent ? "Intent: " + intent + "." : "", "Task: " + (task || "margin") + "."].filter(Boolean).join(" "),
      TASK_HINT[intent && task === "chat" ? intent : task] ? "TASK: " + TASK_HINT[intent && task === "chat" ? intent : task] : "",
      message ? "QUESTION (answer this, not anything older): " + message : "The writer paused on the last lines of the note. Speak only if something deserves a second look.",
    ].filter(Boolean).join("\n\n");
    if (message) ctx = "QUESTION: " + message + "\n\n" + ctx;
    return [{ role: "system", content: system || SYSTEM }, { role: "user", content: ctx }];
  }

  function fmt(n) { return Number.isInteger(n) ? String(n).replace("-", "−") : n.toFixed(2).replace("-", "−"); }
  function poly(a, b, c) {
    const parts = [[a, "x²"], [b, "x"], [c, ""]].filter(([k]) => k);
    return parts.map(([k, v], i) => { const s = k < 0 ? "−" : "+", m = Math.abs(k), body = (m === 1 && v ? "" : fmt(m)) + v; return i ? " " + s + " " + body : (k < 0 ? "−" : "") + body; }).join("") || "0";
  }
  // Parses a linear/quadratic equation in x, e.g. "x^2 + 3x = 10" → a,b,c of ax²+bx+c=0.
  function parseEquation(src) {
    const s = String(src).replace(/²/g, "^2").replace(/[−–]/g, "-").replace(/[\s*]/g, "");
    const sides = s.split("="); if (sides.length !== 2 || !/x/.test(s)) return null;
    const side = (str) => {
      const k = [0, 0, 0], terms = str.match(/[+-]?[^+-]+/g); if (!terms) return null;
      for (const term of terms) {
        const m = term.match(/^([+-]?)(\d*\.?\d*)(x(\^([12]))?)?$/); if (!m || (!m[2] && !m[3])) return null;
        const coef = (m[1] === "-" ? -1 : 1) * (m[2] ? parseFloat(m[2]) : 1), deg = m[3] ? +(m[5] || 1) : 0;
        k[2 - deg] += coef;
      }
      return k;
    };
    const l = side(sides[0]), r = side(sides[1]); if (!l || !r) return null;
    const a = l[0] - r[0], b = l[1] - r[1], c = l[2] - r[2]; if (!a && !b) return null;
    return { a, b, c, lhs: src.trim().replace(/\^2/g, "²").replace(/-/g, "−") };
  }
  function findEquation(text) {
    const cands = String(text || "").match(/[0-9x^²+\-−*.() ]*x[0-9x^²+\-−*. ]*=[0-9x^²+\-−*. ]+/g) || [];
    for (const c of cands) if (parseEquation(c)) return c.trim();
    return null;
  }

  function tail(s, n) { s = String(s || ""); return s.length > n ? "…" + s.slice(-n) : s; }
  function truncate(s, n) { s = String(s || ""); return s.length > n ? s.slice(0, n) + "…" : s; }

  const SMALL_TALK = /^\s*(hi+|hey+|hello+|yo|sup|hola|namaste|thanks?|thank you|ty|ok(ay)?|cool|nice|great|hmm+|bye|good (morning|night|evening))\b[\s!.?,]*$/i;
  async function respond(opts, onDraft) {
    if (SMALL_TALK.test(opts.message || "")) {
      const say = /thank|ty\b/i.test(opts.message) ? "Anytime. What do you want to dig into next?" : /bye|night/i.test(opts.message) ? "See you. Your notes are saved here." : "Hi! Write what you're studying in the note, or ask me anything here.";
      if (onDraft) onDraft(say);
      return { say, draw: false, sketch: "none", title: "", source: "local" };
    }
    if (!opts.message && latestLine(opts.noteText)) opts = Object.assign({}, opts, { message: latestLine(opts.noteText) });
    await health();
    if (state.mode === "live" && opts.task === "quiz") {
      // the JSON prompt drops the questions on the small model; ask plainly
      const r = await chat({ messages: [{ role: "system", content: "Write exactly 3 short numbered quiz questions about the topic, easiest first. One per line. No answers, no intro." }, { role: "user", content: "Topic: " + clip(opts.message || tail(opts.noteText, 400), 300) }], thinking: false, max_tokens: 200, temperature: 0.4, signal: timeout(20000) }).catch(() => null);
      const qs = String((r && r.content) || "").split("\n").map((x) => x.replace(/^\s*\d+[.)]\s*/, "").trim()).filter((x) => x.length > 3).slice(0, 3);
      if (qs.length) return { say: "Quick quiz:\n" + qs.map((x, i) => i + 1 + ". " + x).join("\n"), draw: false, sketch: "none", title: clip(opts.message || "", 40).replace(/^./, (c) => c.toUpperCase()) + " Quiz", source: "live" };
    }
    if (state.mode === "live") {
      try {
        // thinking needs room (~1k reasoning tokens); if it fails, retry fast before any offline fallback
        // two concurrent calls: fast = structure (drawing, title, steps); thinking = checked wording of the answer
        const ok = (p) => p && typeof p.say === "string" && p.say.trim();
        const fastP = chat({ messages: buildMessages(opts), thinking: false, max_tokens: 500, temperature: 0.3, response_format: { type: "json_object" }, signal: timeout(30000) })
          .then((r) => safeJSON(r.content)).catch(() => null);
        // fast by default; the slow reasoning pass only runs when the user asks to think deeper
        const deep = !!opts.deep;
        const thinkP = !deep ? Promise.resolve(null) : chat({ messages: buildMessages(opts, SYSTEM_FACTS), thinking: true, max_tokens: 2500, temperature: 0.3, response_format: { type: "json_object" }, signal: timeout(45000) })
          .then((r) => safeJSON(r.content)).catch(() => null);
        // quickest possible first answer: same facts prompt, no thinking, tiny output
        const quickP = onDraft && deep ? chat({ messages: buildMessages(opts, SYSTEM_FACTS), thinking: false, max_tokens: 160, temperature: 0.3, response_format: { type: "json_object" }, signal: timeout(20000) }).then((r) => safeJSON(r.content)).catch(() => null) : null;
        let settled = false, drafted = false, useNow;
        const skipP = new Promise((r) => (useNow = r));
        // second arg lets the user take the draft instead of waiting on the slow check
        const draft = (p) => { if (ok(p) && !settled && !drafted) { drafted = true; onDraft(normalize(p).say, () => useNow([p, null, null])); } };
        if (onDraft && deep) { quickP.then(draft); fastP.then(draft); }
        const lessonP = opts.task === "explain" || (opts.task !== "quiz" && opts.task !== "vent" && WANTS_LESSON.test(opts.message || "")) ? chat({ messages: buildMessages(opts, SYSTEM_LESSON), thinking: false, max_tokens: 1400, temperature: 0.2, response_format: { type: "json_object" }, signal: timeout(45000) }).then((r) => safeJSON(r.content)).catch(() => null) : Promise.resolve(null);
        // once the fast answer is in, give the lesson sheet at most 5s more
        const capped = (p) => Promise.race([p, fastP.then((f) => (ok(f) ? new Promise((r) => setTimeout(() => r(null), 5000)) : p))]);
        const [fast, slow, lesson] = await Promise.race([Promise.all([fastP, thinkP, capped(lessonP)]), skipP]);
        settled = true;
        let parsed = ok(fast) ? fast : slow;
        // a deep answer much shorter than the fast one is usually a bare intro line; keep the fast one
        if (parsed && ok(slow) && !(ok(fast) && slow.say.length < fast.say.length / 2)) parsed = Object.assign({}, parsed, { say: slow.say });
        const recent = (opts.history || []).slice(-6).map((m) => m.text).reverse().join("\n");
        const eq = findEquation(opts.message) || (/solve|how|draw|show|graph|plot|root|factor/i.test(opts.message || "") || opts.task === "draw" || opts.task === "explain" ? findEquation(recent) || findEquation(tail(opts.noteText, 600)) : null);
        if (eq && parsed && typeof parsed.say === "string" && parsed.say.trim()) { const o = normalize(parsed); o.draw = true; o.sketch = "equation:" + eq; return o; }
        if (parsed && typeof parsed.say === "string" && parsed.say.trim()) {
          const out = normalize(parsed);
          // safety net: a tutor never hands over a code dump
          if (/#include|\bdef \w+\(|\bint main\b|\bfunction \w+\(|(;\s*\n.*){3}/.test(out.say)) {
            out.say = "I won't hand you the full code, but let's build it together. What's the simplest version that works, even if it's slow? Write that first and I'll help you sharpen it.";
          }
          if (opts.task === "vent" || opts.task === "quiz") { out.draw = false; out.sketch = "none"; return out; }
          if (/\b(could you|can you|please) (share|paste|explain|clarify|give)|\bnot sure\b|\bnot familiar\b|don'?t know (that|this)/i.test(out.say)) { out.draw = false; out.sketch = "none"; return out; }
          const secs = lesson && Array.isArray(lesson.sections) ? lesson.sections.filter((x) => x && x.title).slice(0, 5).map((x) => ({
            t: clip(String(x.title), 60), i: String(x.idea || "").replace(/\$+/g, ""), f: x.formula ? String(x.formula).replace(/\$+/g, "") : "",
            e: fixArithmetic(String(x.example || "").replace(/\$+/g, "")), d: (Array.isArray(x.derive) ? x.derive : []).slice(0, 4).map((y) => fixArithmetic(String(y).replace(/\$+/g, ""))) })) : [];
          if (secs.length >= 2) { out.draw = true; out.sketch = "lesson:" + encodeURIComponent(JSON.stringify(secs)); return out; }
          const tr = algoTrace(opts.message || "");
          if (tr && !/complexit|big.?o/i.test(opts.message || "")) { out.draw = true; out.sketch = tr; return out; }
          // drawing priority: known topic from the question > formula > generic steps
          // only sketches that literally picture their topic; "flow"/"graph"/"timeline" are scene-specific
          const q = opts.message || tail(opts.noteText, 300);
          const exact = Object.keys(EXACT).find((k) => EXACT[k].test(q)), topic = exact && { sketch: exact };
          if (topic && (out.draw || CONFUSED.test(opts.message || ""))) { out.draw = true; out.sketch = topic.sketch; return out; }
          let work = (Array.isArray(parsed.work) ? parsed.work : []).map((x) => fixArithmetic(String(x).replace(/\$+/g, "").trim())).filter((x) => x && /\d/.test(x)).slice(0, 8);
          // calculations belong on the page, not in a margin paragraph
          const sents = out.say.split(/(?<=[.!?])\s+(?=[A-Z(])/), isCalc = (x) => /\d[^.]*[=≈][^.]*\d/.test(x);
          const calcs = sents.filter(isCalc);
          if (calcs.length) {
            work = work.concat(calcs.map((x) => fixArithmetic(x.trim()))).slice(0, 8);
            const rest = sents.filter((x) => !isCalc(x)).join(" ").trim();
            out.say = rest ? rest + " The numbers are worked out on the page." : "Worked out step by step on the page.";
          }
          if (work.length >= 1) { out.draw = true; out.sketch = "work:" + encodeURIComponent(JSON.stringify(work)); return out; }
          const steps = (Array.isArray(parsed.steps) ? parsed.steps : []).map((x) => clip(String(x).replace(/\$+/g, "").trim(), 140)).filter(Boolean).slice(0, 6);
          const wantsFormula = /formula|equation|law|rule|express|derive/i.test(opts.message || "");
          if (steps.length >= 3 && !wantsFormula) { out.draw = true; out.sketch = "steps:" + encodeURIComponent(JSON.stringify(steps)); return out; }
          const f = typeof parsed.formula === "string" && /=|→|->/.test(parsed.formula) ? parsed.formula.replace(/\$+/g, "").trim() : "";
          if (f) {
            const terms = (Array.isArray(parsed.terms) ? parsed.terms : []).filter((t) => Array.isArray(t) && t.length >= 2).slice(0, 5).map((t) => [String(t[0]).slice(0, 12), String(t[1]).slice(0, 90)]);
            out.draw = true; out.sketch = "formula:" + encodeURIComponent(JSON.stringify({ f: f.slice(0, 90), t: terms }));
            return out;
          }
          const f0 = typeof parsed.sketch === "string" && SKETCH_KEYS.includes(parsed.sketch) && parsed.sketch !== "none" ? parsed.sketch : "";
          if (steps.length >= 3) { out.draw = true; out.sketch = "steps:" + encodeURIComponent(JSON.stringify(steps)); return out; }
          if (opts.task === "draw" && f0) { out.draw = true; out.sketch = f0; return out; }
          if (opts.message && out.draw && opts.task !== "draw") { out.draw = false; out.sketch = "none"; }
          return out;
        }
      } catch (e) { /* fall through to local mind */ }
    }
    // never invent an answer when the server can't be reached
    return { say: state.mode === "live" ? "I lost the connection mid-answer. Send it again?" : "I can't reach my brain right now (no connection to the server). Check your internet and send it again.", draw: false, sketch: "none", title: "", source: "offline" };
  }

  // Recompute "a op b = c" so a small model's arithmetic slip never reaches a student.
  function choose(n, k) { if (k < 0 || k > n || n > 170) return NaN; let r = 1; for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i; return Math.round(r); }
  function calc(raw) {
    const expr = String(raw).replace(/\bC\(\s*(\d+)\s*,\s*(\d+)\s*\)|\b(\d+)\s*C\s*(\d+)\b/g, (m, a, b, c, d) => String(choose(+(a || c), +(b || d))));
    const e = expr.replace(/½/g, "0.5").replace(/[×x·](?=\s*[\d(])/g, "*").replace(/÷/g, "/").replace(/\^/g, "**").replace(/,(?=\d{3})/g, "");
    if (/^\s*\d+\s*$/.test(e) && /C\(|\dC\d/.test(raw)) return +e;
    if (!/^[\d\s.+\-*/()]+$/.test(e) || !/[+\-*/]/.test(e)) return null;
    try { const v = Function('"use strict";return (' + e + ")")(); return Number.isFinite(v) ? v : null; } catch (err) { return null; }
  }
  function fixArithmetic(line) {
    // "total = 2^10" or "C(10,5)" with no result: append the value
    line = line.replace(/(=\s*)((?:C\(\s*\d+\s*,\s*\d+\s*\)|\d+(?:\.\d+)?(?:\s*[+\-*/^×÷]\s*\d+(?:\.\d+)?)+))(?!\s*=)(?=\s*(?:[a-zA-Z.,;]|$))/g, (m, eq, ex) => { const v = calc(ex); return v == null ? m : eq + ex + " = " + (Number.isInteger(v) ? v : +v.toFixed(4)); });
    line = line.replace(/(:\s*|is\s+)(C\(\s*\d+\s*,\s*\d+\s*\))(?!\s*=)/g, (m, pre, ex) => { const v = calc(ex); return v == null ? m : pre + ex + " = " + v; });
    return line.replace(/((?:\d[\d.,]*|\(|C\(|½)[\d.,\s+\-*/^×x·÷()C½]*[\d)])\s*=\s*(-?\d[\d.,]*)/g, (m, lhs, rhs) => {
      const v = calc(lhs); if (v == null) return m;
      const r = +rhs.replace(/,/g, ""); if (Math.abs(v - r) < 1e-9 * Math.max(1, Math.abs(v))) return m;
      return lhs + " = " + (Number.isInteger(v) ? v : +v.toFixed(4));
    });
  }
  // Which algorithm to animate, plus any input the writer gave ([1,2,5], "abcabcbb", n = 6, target 9, amount 11).
  function algoTrace(q) {
    const k = /dijkstra|shortest path/i.test(q) ? "dijkstra" : /\bbfs\b|breadth.?first|level.?order/i.test(q) ? "bfs" : /\bdfs\b|depth.?first/i.test(q) ? "dfs"
      : /sliding window|longest substring|without repeating/i.test(q) ? "window" : /two.?pointer|container with most water|pair.*(sum|target).*sorted|sorted.*pair/i.test(q) ? "twoptr"
      : /parenthes|brackets/i.test(q) ? "parens" : /climb(ing)?.?stairs/i.test(q) ? "stairs" : /coin.?change|fewest coins|minimum (number of )?coins/i.test(q) ? "coins" : /merge.?sort/i.test(q) ? "merge" : null;
    if (!k) return null;
    const arr = (q.match(/\[([-\d,\s]+)\]/) || [])[1], str = (q.match(/["“']([^"”']{2,12})["”']/) || [])[1];
    const num = (re) => { const m = q.match(re); return m ? +m[1] : undefined; };
    const sp = { k, a: arr ? arr.split(",").map(Number).filter((x) => !isNaN(x)) : undefined, s: str, n: num(/\b(?:n|amount)\s*=?\s*(\d+)/i) ?? num(/(\d+)\s*(?:stairs|steps)/i), t: num(/target\s*=?\s*(-?\d+)/i) };
    return "trace:" + encodeURIComponent(JSON.stringify(sp));
  }
  function clip(t, n) { return t.length <= n ? t : t.slice(0, n).replace(/\s+\S*$/, "") + "…"; }
  function tidy(say) {
    const cut = say.search(/\s*\(?\b(Wait|Actually|Hmm)\b[:,]?\s/);
    if (cut > 0) {
      say = say.slice(0, cut).trim();
      if ((say.match(/\(/g) || []).length > (say.match(/\)/g) || []).length) say = say.slice(0, say.lastIndexOf("(")).trim();
      if (!/[.!?]$/.test(say)) say += ".";
    }
    const sents = say.split(/(?<=[.!?])\s+(?=[A-Z(])/);
    let out = "";
    for (const x of sents) { if ((out + " " + x).split(/\s+/).length > 90 && out) break; out = (out + " " + x).trim(); }
    return out;
  }

  function safeJSON(s) {
    try { return JSON.parse(s); } catch (e) {}
    const m = String(s).match(/\{[\s\S]*\}/);
    if (m) { try { return JSON.parse(m[0]); } catch (e) {} }
    return null;
  }

  function normalize(p) {
    let sketch = SKETCH_KEYS.includes(p.sketch) ? p.sketch : "none";
    const draw = !!p.draw && sketch !== "none";
    p.say = String(p.say).replace(/\\n/g, "\n");
    return { title: typeof p.title === "string" ? p.title.replace(/["$]/g, "").trim().slice(0, 48) : "", say: tidy(String(p.say).replace(/\$+/g, "").replace(/\\\(|\\\)/g, "").trim()), draw, sketch: draw ? sketch : "none", source: "live" };
  }

  /* ---------- contextual local mind (offline fallback) ----------
     Reads what the writer ACTUALLY asked, builds on followups by
     quoting their words, and relieves confusion with a sketch. */

  const CONFUSED = /don'?t (get|understand|see|know)|can'?t (picture|visualize|understand|figure|wrap)|confus|stuck|lost|no idea|how (does|do|is|would|can)|why (does|do|is|would|can)|what (is|does|do|are)|explain|help me (see|understand)|not sure|i think\??$/i;

  // Each topic: matchers, the sketch that builds intuition, and Socratic
  // probes. `relief` variants orient a confused writer before asking.
  const TOPICS = [
    { re: /n.?queens|backtrack|eight queens|4 queens|place.*queens/i, sketch: "nqueens",
      qs: ["Before you place the next queen, which squares are already attacked — row, column, and both diagonals?", "When a row has no safe square, what exactly do you undo, and where do you try next?", "Why does trying columns left-to-right with an undo guarantee you find a solution if one exists?"],
      relief: ["Watch the board: place a queen, shade everything it attacks, then move down a row. When you're stuck, slide the last queen right.", "Backtracking is 'try, check, undo.' The sketch shows a queen placed, a row getting stuck, then the undo."] },
    { re: /linked\s?list|reverse (a |the )?(list|nodes)|ListNode|next pointer/i, sketch: "linkedlist",
      qs: ["When you reverse it, what should the new head be — and what does each node's next need to point at?", "Walk three nodes: before you flip a pointer, what must you save so you don't lose the rest?", "If you reverse in place, how many pointers do you need to keep, and why?"],
      relief: ["Picture three beads A→B→C. To flip the string you hold the previous bead, save the next, then point curr back.", "The sketch flips one arrow at a time: save next, reverse the link, advance. Watch where the head ends up."] },
    { re: /two\s?sum|2\s?sum|three\s?sum|3\s?sum|n\s?sum|pair.*target|adds? to (the )?target/i, sketch: "twosum",
      qs: ["Before the hash map — what does brute force cost, and what does the map let you skip?", "For each x, what number completes the target? Where could you have seen it already?", "Why check the map before you insert — what bug does that order prevent?"],
      relief: ["You want two numbers that sum to T. Holding x, the missing piece is T−x. The sketch arcs 7 back to 2 because 7+2=9.", "Imagine remembering every number you've passed in a map. Now each new x just asks: have I seen T−x?"] },
    { re: /hash\s?(map|table|set)|unordered_map|dictionary|O\(1\) look/i, sketch: "twosum",
      qs: ["What's the key, and what's the value — and why does that pairing give you O(1)?", "What happens on a collision, and what does that do to your worst case?", "What property of the problem makes a map the right tool instead of a scan?"],
      relief: ["A map trades memory for speed. What are you storing so you never re-scan?", "Think of it as a coat check: what's the ticket, and what's the coat?"] },
    { re: /recurs|fibonacci|fib\(|calls itself|base case|divide and conquer/i, sketch: "recursion",
      qs: ["Trace fib(3) by hand: which call returns first, and what does it hand back up?", "What's the base case, and what goes wrong if it's missing?", "What does each call assume the smaller call already solved?"],
      relief: ["Watch the tree: the leaves return first, then the answers flow up — 1+0=1, then 1+1=2. Follow one branch down, then back.", "Recursion is trusting a smaller version of you. The smallest version that needs no trust is the base case — which one is it here?"] },
    { re: /binary search|sorted array|log n|lower bound|midpoint/i, sketch: "binarysearch",
      qs: ["What must be true about the data before halving it is even valid?", "Each step you discard half — what guarantees the answer isn't in the half you threw away?", "Where do left and right meet, and what does that tell you?"],
      relief: ["The sketch shades the half it throws away: 7 < 11, so the left four are gone. Sorted order is what makes 'too low' useful.", "Picture the range shrinking by half each guess. What stays true about the answer the whole time?"] },
    { re: /sort|quicksort|mergesort|bubble|heap sort|O\(n log n\)/i, sketch: "bigo",
      qs: ["What's the smallest input where your sort misbehaves — already sorted, all equal, reversed?", "Merge sort splits then merges: where does the actual ordering happen?", "What does the choice of pivot do to quicksort's worst case?"],
      relief: ["Sorting is repeatedly putting one thing in its final place. Which thing, and how do you know it's final?", "Picture splitting the pile until single cards, then zipping them back in order. Where's the work?"] },
    { re: /dynamic program|\bdp\b|memoiz|tabulat|overlapping subproblem|knapsack|climbing stairs/i, sketch: "recursion",
      qs: ["What subproblem repeats, and what's the smallest table that captures it?", "What's the state — what few numbers fully describe where you are?", "Write the recurrence in one line: how does dp[i] depend on smaller i?"],
      relief: ["DP is recursion that remembers. The same call tree appears twice — which repeated call would you cache first?", "Fill a tiny table by hand for n=3. What pattern lets you fill n=4?"] },
    { re: /\bgraph\b|\bbfs\b|\bdfs\b|shortest path|dijkstra|adjacen|traversal|node.*edge/i, sketch: "graph",
      qs: ["BFS or DFS — which matches what you're searching for, and why?", "What does the queue hold in BFS, and what does that guarantee about order?", "How do you avoid visiting a node twice in a graph with cycles?"],
      relief: ["Picture ripples from a stone: BFS visits by distance. Is distance what you care about?", "DFS dives deep first. When is 'go deep, backtrack' the right shape?"] },
    { re: /\btree\b|binary tree|bst|inorder|preorder|height of|leaf nodes/i, sketch: "recursion",
      qs: ["What does the recursion return up from each subtree — and how do you combine left and right?", "For a BST, what property lets you discard half the tree at each step?", "What's the base case for an empty node, and why does it make the recursion clean?"],
      relief: ["A tree is a decision at every node. Solve a single leaf, assume the subtrees are solved — how do you join them?", "Watch the answers flow up from the leaves. What does each parent do with its two children's results?"] },
    { re: /stack|queue|parenthes|balanced|push.*pop|lifo|fifo/i, sketch: "flow",
      qs: ["What does the top of the stack represent right now, and when do you pop?", "For balanced brackets, what must be true when you see a closing one?", "Why does LIFO fit this problem better than a queue?"],
      relief: ["A stack is a pile of plates: last on, first off. What are you stacking here?", "Picture opening brackets as plates you set down. What happens when a closing one arrives?"] },
    { re: /big.?o|time complexity|space complexity|O\(n\)|runtime|efficient|faster way/i, sketch: "bigo",
      qs: ["What grows with the input — and what stays constant? Count the dominant loop.", "If n doubles, what happens to the work? That ratio is your complexity.", "What's the bottleneck operation, and how many times does it run?"],
      relief: ["The sketch draws three growth curves. Ignore constants; watch which one wins when n is huge.", "Count nested loops: each level multiplies. How many levels deep are you — and which curve is that?"] },
    { re: /pointer|memory|malloc|free|segfault|reference|dereference|nullptr/i, sketch: "linkedlist",
      qs: ["Who owns this memory, and who frees it — and what happens if both think they do?", "After you free it, what does the pointer still hold, and is that safe to use?", "What's the difference between the pointer and the thing it points at?"],
      relief: ["A pointer is an address, not the value. Draw the box and the arrow — what's at that address right now?", "If you delete the box, where does the arrow point? That dangling arrow is the bug."] },
    { re: /password|signup|sign.?up|login|auth|hash(ed|ing)?|argon|bcrypt|salt/i, sketch: "flow",
      qs: ["Hashed, right? What exactly gets stored, and what gets compared at login?", "Why a fresh salt per user — what attack does that defeat?", "If the database leaks, what can the attacker do with a hash vs. a plaintext password?"],
      relief: ["You never store the password — you store a fingerprint. The sketch shows signup and login meeting at the same hash.", "Picture two paths that must produce the same hash to match. What's shared, and what's secret?"] },
    { re: /cache|redis|memcach|feed|followers|invalidat|hot key/i, sketch: "graph",
      qs: ["What happens to the cache when someone with 50,000 followers posts?", "When the source changes, how does the cache find out — and what if it doesn't?", "What's the cost of a miss, and how often will it happen under load?"],
      relief: ["A cache is a copy that can go stale. The sketch shows one hot key and many readers — where's the pressure?", "Picture the moment the copy disagrees with the source. What's your plan for that moment?"] },
    { re: /\bsql\b|database|index|query|join|postgres|mysql|schema|transaction/i, sketch: "flow",
      qs: ["What does the query scan without an index — and what would the index let it skip?", "What happens if two transactions touch this row at once?", "Is this a read-heavy or write-heavy path, and does the schema match that?"],
      relief: ["An index is a book's contents page. What column are you looking up by?", "Picture the query plan: where does it read the whole table instead of jumping?"] },
    { re: /\bapi\b|rest|endpoint|http|request|response|status code|json/i, sketch: "flow",
      qs: ["What does the client send, and what's the smallest response that answers it?", "What happens when this call fails halfway — is it safe to retry?", "Who is this endpoint for, and what does a 4xx vs 5xx tell them?"],
      relief: ["An API is a contract: request in, response out. What's the shape of each?", "Picture the happy path, then the timeout. What should the client do differently?"] },
    { re: /react|component|state|render|hook|frontend|useEffect|props/i, sketch: "flow",
      qs: ["What state drives this render, and what triggers it to change?", "If this re-renders too often, what's changing that shouldn't be?", "Where does the data live — and does every consumer need to know when it changes?"],
      relief: ["UI is a function of state. What state, when changed, should redraw this?", "Picture the render as a snapshot. What makes the next snapshot differ?"] },
    { re: /incline|slope|ramp|friction|normal force|sin ?θ|tilted/i, sketch: "incline",
      qs: ["Gravity pulls straight down — how much acts along the slope, and what balances the rest?", "Which way does the net force point, and what does that tell you about the motion?", "What changes if friction disappears — which term goes to zero?"],
      relief: ["Tilt your axes to the slope. The sketch splits mg into mg·sinθ (along) and the normal force (into) — which piece moves it?", "Draw the weight arrow straight down, then resolve it along and into the surface. Watch the two components appear."] },
    { re: /velocity|momentum|energy|kinetic|potential|projectile|motion|speed/i, sketch: "incline",
      qs: ["What's conserved here — energy, momentum, or both? Why?", "What's the initial state and the final state, and what connects them?", "Which quantity is zero at the top of the path, and which isn't?"],
      relief: ["Pick two moments in time. What stays the same between them?", "Energy changes form but not total. Where does it start, and where does it end?"] },
    { re: /calculus|derivative|integral|limit|differentiat|rate of change|area under/i, sketch: "bigo",
      qs: ["What does the derivative measure at this point — and what are its units?", "If the integral is accumulated area, what is the function accumulating?", "What happens to the slope as you approach the point from each side?"],
      relief: ["A derivative is a zoomed-in slope. What's changing, with respect to what?", "Picture the area under the curve growing. What does its growth rate equal?"] },
    { re: /probability|statistic|expected|distribution|bayes|random|variance/i, sketch: "graph",
      qs: ["What's the sample space, and are the outcomes equally likely?", "What does the expected value weight by — and why?", "If you repeated this 1000 times, what would the average settle to?"],
      relief: ["List every way it can happen. Which ways count as success?", "Probability is favorable over possible. What's the full set of possible?"] },
    { re: /quit|full.?time|my job|go full|startup|founder|runway/i, sketch: "timeline",
      qs: ["With how many months of rent saved? Write the number down here.", "What has to be true before you hand in your notice?", "What's the smallest version that proves people want it before you leap?"],
      relief: ["Big call. The sketch lays it out: save rent → prove pull → then leap. Which step are you actually on?", "Picture month two with no salary. What covers it — and is that written down?"] },
    { re: /retention|onboarding|churn|users|growth|activation|teammate|emails/i, sketch: "graph",
      qs: ["If 30% open them but nobody clicks, what is each email actually asking the reader to do?", "What's the one action that correlates with staying — and how do you get users there faster?", "Who are the users that leave, and what did they never experience?"],
      relief: ["Retention is 'did they come back.' What would make them come back tomorrow?", "Picture the first session. What's the moment they feel the value?"] },
    { re: /essay|writing|draft|paragraph|thesis|argument|blog|article/i, sketch: "none",
      qs: ["Who's this for, and what should they believe by the last line?", "What's the one sentence the whole piece hangs on?", "Where would a skeptical reader stop and say 'prove it'?"],
      relief: ["Say the point to a friend in one line. What's that line?", "Picture the reader finishing. What do you want them to do next?"] },
    { re: /exam|midterm|study|quiz|test on|revision|memoriz/i, sketch: "recursion",
      qs: ["Can you explain it to a blank page without notes? Where do you stall?", "What's the one concept everything else here depends on?", "If the exam asked 'why', not 'what', could you answer?"],
      relief: ["Close the notes and teach it back. The gap you hit is what to study.", "Picture the hardest question. What single idea unlocks it?"] },
    { re: /wake up|wake early|sleep|morning routine|early rise|bedtime|insomnia|tired/i, sketch: "timeline",
      qs: ["What time do you actually fall asleep now — and what's keeping you up that late?", "If waking early is the goal, what's the one evening change that makes it possible?", "What would make you want to get up, rather than just forcing it?"],
      relief: ["Waking early is really a sleeping-early problem. What does your last hour before bed look like?", "Picture tomorrow's first 30 minutes. What would make them worth getting up for?"] },
    { re: /jacked|muscle|gym|workout|lift|bulk|fitness|exercise|strength|protein|gain weight|leaner|lean\b/i, sketch: "timeline",
      qs: ["What's the one lift or habit you'll track weekly — and what number tells you it's working?", "Are you eating enough to grow, and how do you know? What's the protein target?", "What's the smallest routine you'd actually stick to on a bad week?"],
      relief: ["Muscle is stress plus food plus sleep. Which of the three is your weak link right now?", "Picture one workout. What progressive overload means you're stronger next month?"] },
    { re: /sharper|focus|concentrat|productiv|procrastinat|discipline|habit|motivat|distract|deep work/i, sketch: "timeline",
      qs: ["When are you naturally sharpest — and what do you protect that time for?", "What's the one distraction you'd remove to get an hour of real focus back?", "What does 'sharper' look like in a week — what could you do that you can't now?"],
      relief: ["Focus is a subtraction game. What's the biggest thing you'd stop doing?", "Picture a single deep-work block. What makes it happen instead of scroll?"] },
    { re: /learn|skill|practice|improve|get better|master|study plan/i, sketch: "recursion",
      qs: ["What's the smallest thing you could build or do today that proves you're learning?", "How will you know you've improved — what's the test?", "Who's slightly ahead of you, and what do they do that you don't yet?"],
      relief: ["Learning is doing, then reflecting. What's the doing part for this skill?", "Picture yourself competent. What can that version do that you can't today?"] },
  ];

  let lastSay = "";
  function pickVariant(arr, seed) {
    if (!arr || !arr.length) return "";
    let i = Math.floor(hashStr(seed) % arr.length);
    if (arr.length > 1 && arr[i] === lastSay) i = (i + 1) % arr.length;
    return arr[i];
  }

  /* ---------- followup mind: listens to the thread ----------
     The fix for generic back-and-forth. When the writer replies in an
     ongoing thread, quote THEIR words, detect tension, and push deeper
     instead of dumping a stale keyword probe. */
  const QUALITY = /\b(leaner|lean|sharper|sharp|faster|fast|bigger|big|smaller|stronger|strong|better|more|less|fitter|jacked|muscular|toned|richer|cheaper|safer|simpler|cleaner|healthier|calmer|quicker)\b/i;
  const OPPOSE = [
    [/lean(er)?|cut(ting)?|deficit|lose (weight|fat)/i, /jacked|bulk|muscle|gain|surplus|big(ger)?/i, "Leaner wants a calorie deficit; jacked wants a surplus. They pull opposite ways — which one wins for you this month?"],
    [/fast(er)?|quick|speed|ship/i, /cheap|cost|save|budget|safe|careful/i, "Faster and cheaper usually trade off. Which are you optimizing, and what are you willing to spend to get it?"],
    [/more|grow|scale|bigger/i, /less|simple|focus|smaller/i, "More and less at once — what's the one thing you'd actually add, and what would you drop to make room?"],
  ];

  function followupMind(focus, history, noteText) {
    const reply = focus.trim();
    const rl = reply.toLowerCase();
    const lastR = [...(history || [])].reverse().find((m) => m.who === "riddler");
    const prior = lastR ? lastR.text : "";
    const hay = (prior + " " + (noteText || "") + " " + reply).toLowerCase();

    for (const [a, b, line] of OPPOSE) {
      if (a.test(rl) && b.test(hay)) { lastSay = line; return { say: line, draw: false, sketch: "none", source: "local" }; }
    }

    const qm = reply.match(QUALITY);
    if (qm) {
      const w = qm[0].toLowerCase();
      const probes = [
        "“" + w + "” — measured how? What number today, and what number would prove it?",
        "Okay, " + w + ". Compared to what baseline — and over what time box?",
        "What's the one habit that actually moves “" + w + "”, and how often will you do it?",
      ];
      const say = pickVariant(probes, reply + prior);
      lastSay = say; return { say, draw: false, sketch: "none", source: "local" };
    }

    if (/\d/.test(reply) && reply.length < 40) {
      const probes = [
        "Where does that number come from — measured, or guessed?",
        "Is that enough? What's the threshold that would actually change your decision?",
        "Good — now what's the one thing that number depends on most?",
      ];
      const say = pickVariant(probes, reply + prior);
      lastSay = say; return { say, draw: false, sketch: "none", source: "local" };
    }

    if (/^(why|how|but|and|so|then|what about|can you|could you|explain|more|example|still|wait|hmm)\b/i.test(reply)) {
      const t = TOPICS.find((x) => x.re.test(prior)) || TOPICS.find((x) => x.re.test(hay));
      if (t) {
        const say = pickVariant(t.relief.concat(t.qs), reply + prior + history.length);
        lastSay = say;
        return { say, draw: t.sketch !== "none", sketch: t.sketch, source: "local" };
      }
    }

    if (reply.length < 48) {
      const frag = reply.replace(/[.?!]+$/, "");
      const probes = [
        "Okay — “" + frag + "”. What does that change about the plan?",
        "“" + frag + "” — and what's the consequence you haven't written down yet?",
        "Sit with “" + frag + "” for a second: what's the assumption underneath it?",
      ];
      const say = pickVariant(probes, reply + prior);
      lastSay = say; return { say, draw: false, sketch: "none", source: "local" };
    }
    return null;
  }

  function localMind({ noteText = "", message = "", intent = "", persona = "", task = "", history = [] }) {
    const focus = (message || "").trim();
    const focusL = focus.toLowerCase();
    const noteL = (noteText || "").toLowerCase();
    const confused = CONFUSED.test(focus) || CONFUSED.test(noteText.slice(-200));
    const seed = focusL || noteL || "think";
    const hasThread = history && history.some((m) => m.who === "riddler");

    // In an ongoing thread, listen to the reply before anything else.
    if (focus && hasThread && task !== "draw") {
      const fu = followupMind(focus, history, noteText);
      if (fu) return fu;
    }

    // Personal decision notes are intent-driven.
    if (/quit|full.?time|my job|go full/.test(focusL) || (!focus && /quit|full.?time|my job/.test(noteL))) {
      const byIntent = {
        brutal: "Nothing here says who pays you in month two.",
        plan: "What has to be true before you hand in your notice? List the three things.",
        vent: "That's a big call. What's driving it — the app, or the job?",
        challenge: "With how many months of rent saved? Write the number down here.",
        quiz: "Quick: what's your runway in months, and what's the milestone that extends it?",
      };
      const say = byIntent[intent] || byIntent.challenge;
      lastSay = say;
      return { say, draw: intent === "plan", sketch: intent === "plan" ? "timeline" : "none", source: "local" };
    }

    // Find the topic from the CURRENT question first, then the note.
    let topic = TOPICS.find((t) => t.re.test(focus));
    let fromNote = false;
    if (!topic) { topic = TOPICS.find((t) => t.re.test(noteText)); fromNote = true; }

    if (topic) {
      const pool = confused ? topic.relief.concat(topic.qs) : topic.qs;
      let say = pickVariant(pool, seed + (fromNote ? "n" : "m") + history.length);
      if (persona === "Investor" && /cache|redis|feed|retention|users/.test(seed)) say = "Does this move retention or revenue, or is it a nice-to-have?";
      if (persona === "Editor" && /essay|writing|draft|argument/.test(seed)) say = "Who's this for, and does every line earn its place?";
      const draw = task === "draw" || task === "explain" || (confused && topic.sketch !== "none") || (!fromNote && task === "chat" && topic.sketch !== "none" && hashStr(seed) % 2 === 0);
      lastSay = say;
      return { say, draw: draw && topic.sketch !== "none", sketch: topic.sketch, source: "local" };
    }

    // Task-specific with no matched topic.
    if (task === "vent") { lastSay = "I'm listening. What's the part that's weighing on you most?"; return { say: lastSay, draw: false, sketch: "none", source: "local" }; }
    if (task === "quiz") { const s = "Quick check: explain the core idea of “" + (keyFragment(focus || noteText) || "this") + "” in one sentence — where do you hesitate?"; lastSay = s; return { say: s, draw: false, sketch: "none", source: "local" }; }
    if (task === "draw") { const sk = pickSketch(focusL || noteL); const s = "Here's the shape of it — follow the strokes as they draw, then tell me what's missing."; lastSay = s; return { say: s, draw: true, sketch: sk, source: "local" }; }

    // Contextual generic probes that quote the writer's own words.
    const frag = keyFragment(focus || noteText);
    const probes = [
      frag ? "What's the assumption hiding in “" + frag + "”?" : "What made you write that down — what's the part you're unsure about?",
      "If that's true, what follows next? Push it one step further.",
      "What would have to be false for this to fall apart?",
      frag ? "Say “" + frag + "” to a skeptical friend — where do they push back?" : "Say it to a skeptical friend in one line — where do they push back?",
      "What's the smallest experiment that would tell you if this works?",
      confused ? "Let's slow down: what's the one piece that, if it clicked, would make the rest follow?" : "Who is this for, and what changes for them if you're right?",
    ];
    const say = pickVariant(probes, seed + history.length);
    lastSay = say;
    const sketch = pickSketch(focusL || noteL);
    const draw = (task === "explain" || task === "draw" || confused) && sketch !== "none";
    return { say, draw, sketch: draw ? sketch : "none", source: "local" };
  }

  function pickSketch(hay) {
    const t = TOPICS.find((x) => x.re.test(hay));
    if (t && t.sketch !== "none") return t.sketch;
    if (/plan|step|timeline|month|week|ship|launch|sprint/.test(hay)) return "timeline";
    return "flow";
  }

  function keyFragment(s) {
    const words = String(s || "").replace(/\s+/g, " ").trim().split(" ");
    if (words.length < 3) return "";
    const start = Math.max(0, words.length - 7);
    let frag = words.slice(start, start + 6).join(" ");
    return frag.length > 46 ? frag.slice(0, 46) + "…" : frag;
  }

  function hashStr(s) { let h = 0; for (let i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) | 0; } return Math.abs(h); }

  /* ---------- animated ink sketches (SVG) ----------
     Contract: strokes carry pathLength="1" + .draw; badges/nodes .pop;
     labels .fade. All paused until the container gets .play (on scroll
     into view), then d1..d10 stagger the sequence so it scribbles live. */
  let SK_UID = 0;
  function sketchSVG(key) {
    const P = 'pathLength="1"';
    function delayNum(el) {
      const own = (el.getAttribute("class") || "").match(/\bd(\d+)\b/);
      if (own) return +own[1];
      for (const k of el.querySelectorAll("*")) {
        const m = (k.getAttribute("class") || "").match(/\bd(\d+)\b/);
        if (m) return +m[1];
      }
      return 1;
    }
    const wrap = (inner, vb) => {
      const host = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      host.innerHTML = inner;
      const buckets = new Map();
      Array.from(host.children).forEach((el) => {
        const s = Math.max(1, Math.ceil(delayNum(el) / 2));
        if (!buckets.has(s)) buckets.set(s, []);
        buckets.get(s).push(el.outerHTML);
      });
      let groups = "", n = 0;
      Array.from(buckets.keys()).sort((a, b) => a - b).forEach((s) => {
        n++;
        groups += '<g class="sk-step" data-step="' + n + '">' + buckets.get(s).join("") + "</g>";
      });
      const id = "chalk" + (++SK_UID);
      return '<svg viewBox="' + (vb || "0 0 400 240") + '" data-steps="' + n + '" role="img" aria-label="Thinker sketch">'
        + '<defs><filter id="' + id + '" x="-8%" y="-8%" width="116%" height="116%">'
        + '<feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed="7" result="n"/>'
        + '<feDisplacementMap in="SourceGraphic" in2="n" scale="0.55" xChannelSelector="R" yChannelSelector="G"/>'
        + '</filter></defs>'
        + '<g filter="url(#' + id + ')">' + groups + "</g></svg>";
    };
    function underline(x, y, w, cls) {
      return '<path class="stroke underline draw ' + (cls || "d3") + '" ' + P + ' d="M' + x + ' ' + y + ' q ' + (w * 0.25) + ' 4 ' + (w * 0.5) + ' 0 t ' + (w * 0.5) + ' 0"/>';
    }

    function node(x, y, label, cls) {
      const w = Math.max(58, label.length * 8 + 20);
      return '<g class="pop ' + cls + '"><rect class="stroke node-bg" x="' + (x - w / 2) + '" y="' + (y - 15) + '" width="' + w + '" height="30" rx="8"/><text class="label node-tx" x="' + x + '" y="' + (y + 5) + '" text-anchor="middle">' + label + "</text></g>";
    }
    function badge(x, y, text, cls) {
      const w = Math.max(36, text.length * 8 + 16);
      return '<g class="pop ' + cls + '"><rect class="badge-bg" x="' + x + '" y="' + (y - 13) + '" width="' + w + '" height="23" rx="11.5"/><text class="badge-tx" x="' + (x + w / 2) + '" y="' + (y + 3) + '" text-anchor="middle">' + text + "</text></g>";
    }
    function box(x, y, label, cls, w) {
      w = w || 56;
      return '<g><rect class="stroke draw ' + cls + '" ' + P + ' x="' + x + '" y="' + y + '" width="' + w + '" height="42" rx="8"/><text class="label fade ' + cls + '" x="' + (x + w / 2) + '" y="' + (y + 27) + '" text-anchor="middle">' + label + "</text></g>";
    }
    function tick(x, label, cls) {
      return '<g><path class="stroke draw ' + cls + '" ' + P + ' d="M' + x + ' 108 v24"/><circle class="stroke pop ' + cls + '" cx="' + x + '" cy="120" r="5"/><text class="label fade ' + cls + '" x="' + x + '" y="152" text-anchor="middle">' + label + "</text></g>";
    }
    function board(x, y, c) {
      let s = '<rect class="stroke draw d1" ' + P + ' x="' + x + '" y="' + y + '" width="' + c * 4 + '" height="' + c * 4 + '" rx="4"/>';
      for (let i = 1; i < 4; i++) {
        s += '<path class="stroke draw d2" ' + P + ' d="M' + (x + i * c) + ' ' + y + ' V' + (y + c * 4) + '"/>';
        s += '<path class="stroke draw d2" ' + P + ' d="M' + x + ' ' + (y + i * c) + ' H' + (x + c * 4) + '"/>';
      }
      return s;
    }
    function queen(x, y, cls) {
      return '<g class="pop ' + cls + '"><circle class="queen-bg" cx="' + x + '" cy="' + y + '" r="13"/><text class="queen-tx" x="' + x + '" y="' + (y + 5) + '" text-anchor="middle">♛</text></g>';
    }

    if (/^trace:/.test(key)) { let sp; try { sp = JSON.parse(decodeURIComponent(key.slice(6))); } catch (e) { sp = {}; } return traceSVG(sp); }
    // Algorithm traces: the app runs the real algorithm on a small input, so every frame is correct.
    // Base drawing is step 1; each frame is one more step. Elements marked fx show only on their own step.
    function traceSVG(sp) {
      const E = (x) => String(x).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
      const tx = (x, y, s, cls, anchor) => '<text class="label fade ' + (cls || "") + '" x="' + x + '" y="' + y + '"' + (anchor ? ' text-anchor="middle"' : "") + ">" + E(s) + "</text>";
      const note = (x, y, s) => { const ws = String(s).split(" "), ls = []; let c = ""; ws.forEach((w) => { if ((c + " " + w).trim().length > 58 && c) { ls.push(c); c = w; } else c = (c + " " + w).trim(); }); if (c) ls.push(c); return ls.map((l, i) => tx(x, y + i * 17, l, "fx trace-note")).join(""); };
      const fr = (k, inner) => '<g class="d' + (2 * k + 1) + '">' + inner + "</g>";
      const title = (s) => tx(20, 20, s, "big");
      if (sp.k === "dijkstra" || sp.k === "bfs" || sp.k === "dfs") return graphTrace(sp.k);
      if (sp.k === "window" || sp.k === "twoptr" || sp.k === "parens") return arrayTrace(sp);
      if (sp.k === "stairs" || sp.k === "coins") return dpTrace(sp);
      if (sp.k === "merge") return mergeTrace(sp.a);
      return wrap(title("Nothing to trace."), "0 0 400 40");

      function graphTrace(kind) {
        const pos = { A: [40, 125], B: [140, 58], C: [140, 192], D: [262, 58], E: [262, 192], F: [362, 125] }, N = Object.keys(pos);
        const ed = [["A", "B", 4], ["A", "C", 2], ["C", "B", 1], ["B", "D", 5], ["C", "D", 8], ["C", "E", 10], ["D", "E", 2], ["D", "F", 6], ["E", "F", 3]];
        const adj = {}; N.forEach((n) => (adj[n] = []));
        ed.forEach(([u, v, w]) => { adj[u].push([v, w]); adj[v].push([u, w]); });
        Object.values(adj).forEach((l) => l.sort((a, b) => a[0].localeCompare(b[0])));
        const weighted = kind === "dijkstra";
        const line = (u, v, cls) => { const [x1, y1] = pos[u], [x2, y2] = pos[v]; return '<path class="stroke draw ' + cls + '" ' + P + ' d="M' + x1 + " " + y1 + " L" + x2 + " " + y2 + '"/>'; };
        let o = tx(20, 20, kind === "dijkstra" ? "Dijkstra from A: settle the closest unsettled node, then relax its edges." : kind === "bfs" ? "BFS from A: a queue visits the graph level by level." : "DFS from A: go as deep as you can, then backtrack.", "big");
        ed.forEach(([u, v, w]) => { o += line(u, v, "d1"); if (weighted) { const [x1, y1] = pos[u], [x2, y2] = pos[v]; o += tx((x1 + x2) / 2 + 7, (y1 + y2) / 2 - 6, w, "small d1 wt"); } });
        N.forEach((n) => { const [x, y] = pos[n]; o += '<circle class="node-c pop d1" cx="' + x + '" cy="' + y + '" r="15"/>' + tx(x, y + 5, n, "d1 node-l", 1); });
        const rowsLab = kind === "dijkstra" ? ["dist", "prev"] : kind === "bfs" ? ["level", "from"] : ["order", "from"];
        N.forEach((n, i) => { o += tx(84 + i * 52, 238, n, "d1 node-l", 1); });
        o += tx(20, 260, rowsLab[0], "small d1") + tx(20, 280, rowsLab[1], "small d1") + '<path class="stroke draw d1" ' + P + ' d="M20 244 H380" style="opacity:.25"/>';
        const F = [], snap = (o2) => F.push(Object.assign({}, o2, { r0: Object.assign({}, o2.r0), r1: Object.assign({}, o2.r1) }));
        const r0 = {}, r1 = {}, done = new Set();
        if (kind === "dijkstra") {
          r0.A = 0; r1.A = "–";
          const pq = () => "PQ: " + N.filter((n) => r0[n] != null && !done.has(n)).sort((a, b) => r0[a] - r0[b]).map((n) => "(" + r0[n] + "," + n + ")").join(" ");
          snap({ r0, r1, pq: pq(), note: "Start: dist[A] = 0, every other node ∞. Put A in the priority queue." });
          while (done.size < N.length) {
            const u = N.filter((n) => r0[n] != null && !done.has(n)).sort((a, b) => r0[a] - r0[b])[0]; if (!u) break;
            done.add(u);
            snap({ r0, r1, u, settle: u, pq: pq(), note: "Pop " + u + " (smallest dist " + r0[u] + "). " + u + " is final: no shorter way can exist." });
            adj[u].forEach(([v, w]) => {
              if (done.has(v)) return;
              const cand = r0[u] + w, cur = r0[v], better = cur == null || cand < cur;
              if (better) { r0[v] = cand; r1[v] = u; }
              snap({ r0, r1, u, edge: [u, v], ok: better, pq: pq(), note: "Check " + u + "→" + v + ": " + r0[u] + " + " + w + " = " + cand + (better ? (cur == null ? " < ∞" : " < " + cur) + " → update dist[" + v + "] = " + cand + ", prev = " + u : " ≥ " + cur + " → keep " + cur) });
            });
          }
          const path = (n) => (r1[n] === "–" ? [n] : path(r1[n]).concat(n));
          snap({ r0, r1, tree: true, pq: "PQ: empty", note: "Done. Read a path backwards with prev: F ← " + r1.F + " … so A→F is " + path("F").join("→") + " (" + r0.F + ")." });
        } else if (kind === "bfs") {
          const q = ["A"]; r0.A = 0; r1.A = "–"; done.add("A");
          snap({ r0, r1, pq: "Queue: [A]", note: "Start: mark A seen at level 0 and enqueue it." });
          while (q.length) {
            const u = q.shift();
            snap({ r0, r1, u, settle: u, pq: "Queue: [" + q.join(", ") + "]", note: "Dequeue " + u + " (level " + r0[u] + "). Look at each neighbor." });
            adj[u].forEach(([v]) => {
              const nw = !done.has(v);
              if (nw) { done.add(v); r0[v] = r0[u] + 1; r1[v] = u; q.push(v); }
              snap({ r0, r1, u, edge: [u, v], ok: nw, pq: "Queue: [" + q.join(", ") + "]", note: u + "→" + v + ": " + (nw ? "not seen → mark, level " + r0[v] + ", enqueue" : "already seen → skip") });
            });
          }
          snap({ r0, r1, tree: true, pq: "Queue: empty", note: "Done. Levels are the fewest edges from A; prev links form the BFS tree." });
        } else {
          let c = 0; r1.A = "–";
          const stack = [];
          const go = (u) => {
            done.add(u); r0[u] = ++c; stack.push(u);
            snap({ r0, r1, u, settle: u, pq: "Stack: [" + stack.join(" → ") + "]", note: "Visit " + u + " (#" + c + "). Try its neighbors in order." });
            adj[u].forEach(([v]) => {
              if (done.has(v)) { snap({ r0, r1, u, edge: [u, v], ok: false, pq: "Stack: [" + stack.join(" → ") + "]", note: u + "→" + v + ": already visited → skip" }); return; }
              r1[v] = u;
              snap({ r0, r1, u, edge: [u, v], ok: true, pq: "Stack: [" + stack.join(" → ") + "]", note: u + "→" + v + ": unvisited → go deeper" });
              go(v);
            });
            stack.pop();
            snap({ r0, r1, u, pq: "Stack: [" + stack.join(" → ") + "]", note: u + " has no unvisited neighbors left → backtrack" + (stack.length ? " to " + stack[stack.length - 1] : ", done") });
          };
          go("A");
          snap({ r0, r1, tree: true, pq: "Stack: empty", note: "Done. Order: " + N.slice().sort((a, b) => r0[a] - r0[b]).join(" → ") + "; prev links form the DFS tree." });
        }
        F.forEach((f, i) => {
          let g = "";
          if (f.settle) { const [x, y] = pos[f.settle]; g += '<circle class="visited pop" cx="' + x + '" cy="' + y + '" r="15"/>' + tx(x, y + 5, f.settle, "node-l", 1); }
          if (f.u) { const [x, y] = pos[f.u]; g += '<circle class="ring pop fx" cx="' + x + '" cy="' + y + '" r="21"/>'; }
          if (f.edge) g += line(f.edge[0], f.edge[1], (f.ok ? "return" : "trace") + " fx");
          if (f.tree) N.forEach((n) => { if (f.r1[n] && f.r1[n] !== "–") g += line(f.r1[n], n, "return fx"); });
          N.forEach((n, j) => { g += tx(84 + j * 52, 260, f.r0[n] == null ? "∞" : f.r0[n], "fx dist", 1) + tx(84 + j * 52, 280, f.r1[n] || "·", "fx small", 1); });
          g += tx(20, 302, f.pq, "fx small") + note(20, 324, f.note);
          o += fr(i + 1, g);
        });
        return wrap(o, "0 0 400 356");
      }

      function arrayTrace(sp) {
        let cells, frames = [], head;
        if (sp.k === "window") {
          const s = String(sp.s || "abcabcbb").slice(0, 10); cells = s.split("");
          head = 'Longest substring without repeats in "' + s + '"';
          const last = {}; let l = 0, best = 0, bl = 0;
          cells.forEach((c, r) => {
            let moved = false;
            if (last[c] != null && last[c] >= l) { l = last[c] + 1; moved = true; }
            last[c] = r; if (r - l + 1 > best) { best = r - l + 1; bl = l; }
            frames.push({ l, r, note: "R = " + r + " '" + c + "'" + (moved ? ": repeat, move L to " + l : ": new, grow") + ' · window "' + s.slice(l, r + 1) + '" · best ' + best });
          });
          frames.push({ l: bl, r: bl + best - 1, note: 'Answer: "' + s.slice(bl, bl + best) + '", length ' + best });
        } else if (sp.k === "twoptr") {
          const a = (sp.a && sp.a.length > 1 ? sp.a : [1, 3, 4, 6, 8, 11]).slice(0, 10).sort((x, y) => x - y), t = sp.t != null ? sp.t : 10;
          cells = a.map(String); head = "Two pointers: find a pair that sums to " + t;
          let l = 0, r = a.length - 1;
          while (l < r && frames.length < 10) {
            const sum = a[l] + a[r];
            frames.push({ l, r, note: a[l] + " + " + a[r] + " = " + sum + (sum === t ? " ✓ found it" : sum < t ? " < " + t + ", move L right" : " > " + t + ", move R left") });
            if (sum === t) break; if (sum < t) l++; else r--;
          }
          if (l >= r) frames.push({ note: "Pointers met: no pair sums to " + t });
        } else {
          const s = String(sp.s || "{[()]}").slice(0, 10); cells = s.split(""); head = 'Valid parentheses? "' + s + '"';
          const st = [], pair = { ")": "(", "]": "[", "}": "{" }; let ok = true;
          cells.forEach((c, i) => {
            if (!ok) return;
            if ("([{".includes(c)) { st.push(c); frames.push({ i, st: st.slice(), note: "'" + c + "' opens: push" }); }
            else if (st[st.length - 1] === pair[c]) { st.pop(); frames.push({ i, st: st.slice(), note: "'" + c + "' matches the top: pop" }); }
            else { ok = false; frames.push({ i, st: st.slice(), note: "'" + c + "' doesn't match: invalid" }); }
          });
          if (ok) frames.push({ st: st.slice(), note: st.length ? "Leftover opens on the stack: invalid" : "Stack empty: valid ✓" });
        }
        const n = cells.length, w = Math.min(40, Math.floor((sp.k === "parens" ? 280 : 360) / n)), x0 = 20, y0 = 50;
        let o = tx(20, 20, head, "big");
        cells.forEach((c, i) => { o += '<rect class="stroke fade d1" x="' + (x0 + i * w) + '" y="' + y0 + '" width="' + (w - 4) + '" height="34" rx="6"/>' + tx(x0 + i * w + (w - 4) / 2, y0 + 22, c, "d1 cell-tx", 1) + tx(x0 + i * w + (w - 4) / 2, y0 + 48, i, "small d1", 1); });
        const ptr = (i, lab, dy) => tx(x0 + i * w + (w - 4) / 2, y0 + 64 + (dy || 0), "▲ " + lab, "fx ptr", 1);
        frames.forEach((f, k) => {
          let g = "";
          if (f.l != null && f.r != null && sp.k === "window") g += '<rect class="win fade fx" x="' + (x0 + f.l * w - 3) + '" y="' + (y0 - 4) + '" width="' + ((f.r - f.l + 1) * w + 2) + '" height="42" rx="8"/>';
          if (f.l != null && sp.k !== "parens") g += ptr(f.l, "L") + (f.r != null && f.r !== f.l ? ptr(f.r, "R") : "");
          if (f.i != null) g += ptr(f.i, "i");
          if (f.st) { f.st.forEach((c, j) => { g += '<rect class="stroke fade fx" x="330" y="' + (178 - j * 26) + '" width="44" height="24" rx="5"/>' + tx(352, 195 - j * 26, c, "fx cell-tx", 1); }); g += tx(352, 222, "stack", "small fx", 1); }
          g += note(20, 150, f.note);
          o += fr(k + 1, g);
        });
        return wrap(o, "0 0 400 " + (sp.k === "parens" ? 236 : 186));
      }

      function dpTrace(sp) {
        const frames = []; let dp = [], head, n;
        if (sp.k === "stairs") {
          n = Math.max(2, Math.min(sp.n || 6, 10)); head = "Climbing " + n + " stairs: ways(i) = ways(i−1) + ways(i−2)";
          dp = [1, 1]; frames.push({ fill: [0, 1], note: "Base: 1 way to stand at 0, 1 way to reach step 1" });
          for (let i = 2; i <= n; i++) { dp[i] = dp[i - 1] + dp[i - 2]; frames.push({ fill: [i], from: [i - 1, i - 2], to: i, note: "dp[" + i + "] = dp[" + (i - 1) + "] + dp[" + (i - 2) + "] = " + dp[i - 1] + " + " + dp[i - 2] + " = " + dp[i] }); }
          frames.push({ note: n + " stairs can be climbed in " + dp[n] + " ways" });
        } else {
          const coins = (sp.a && sp.a.length ? sp.a : [1, 2, 5]).filter((c) => c > 0).slice(0, 4); n = Math.max(1, Math.min(sp.n || 11, 11));
          head = "Coin change, coins [" + coins.join(", ") + "], amount " + n + ": fewest coins";
          dp = [0]; frames.push({ fill: [0], note: "Base: 0 coins make amount 0" });
          for (let i = 1; i <= n; i++) {
            let best = Infinity, bc = null;
            coins.forEach((c) => { if (c <= i && dp[i - c] + 1 < best) { best = dp[i - c] + 1; bc = c; } });
            dp[i] = best;
            frames.push({ fill: [i], from: bc ? [i - bc] : [], to: i, note: "dp[" + i + "] = " + (bc ? "dp[" + (i - bc) + "] + 1 (use coin " + bc + ") = " + best : "∞, no coin fits") });
          }
          frames.push({ note: dp[n] === Infinity ? "Amount " + n + " can't be made" : "Amount " + n + " needs " + dp[n] + " coins" });
        }
        const w = Math.min(34, Math.floor(360 / (n + 1))), x0 = 20, y0 = 74, cx = (i) => x0 + i * w + (w - 4) / 2;
        let o = tx(20, 20, head, "big");
        for (let i = 0; i <= n; i++) o += '<rect class="stroke fade d1" x="' + (x0 + i * w) + '" y="' + y0 + '" width="' + (w - 4) + '" height="32" rx="5"/>' + tx(cx(i), y0 + 48, i, "small d1", 1);
        frames.forEach((f, k) => {
          let g = "";
          (f.fill || []).forEach((i) => { g += tx(cx(i), y0 + 21, dp[i] === Infinity ? "∞" : dp[i], "cell-tx", 1); });
          (f.from || []).forEach((s) => { g += '<path class="stroke return draw fx" ' + P + ' d="M' + cx(s) + " " + (y0 - 2) + " C " + cx(s) + " " + (y0 - 34) + ", " + cx(f.to) + " " + (y0 - 34) + ", " + cx(f.to) + " " + (y0 - 4) + '"/>'; });
          g += note(20, 150, f.note);
          o += fr(k + 1, g);
        });
        return wrap(o, "0 0 400 180");
      }

      function mergeTrace(a0) {
        const a = (a0 && a0.length > 1 ? a0 : [38, 27, 43, 3, 9, 82, 10]).slice(0, 8);
        const rows = [], split = (arr) => arr.length < 2 ? [arr] : [arr.slice(0, Math.ceil(arr.length / 2)), arr.slice(Math.ceil(arr.length / 2))];
        let lvl = [a]; rows.push({ segs: lvl, lab: "start" });
        while (lvl.some((s) => s.length > 1)) { lvl = lvl.flatMap(split); rows.push({ segs: lvl, lab: "split" }); }
        const levels = rows.map((r) => r.segs);
        for (let d = levels.length - 2; d >= 0; d--) rows.push({ segs: levels[d].map((s) => s.slice().sort((x, y) => x - y)), lab: "merge" });
        const w = Math.min(30, Math.floor(300 / a.length)), gap = 10;
        let o = tx(20, 20, "Merge sort: split to singles, merge back in order", "big"), y = 40;
        rows.forEach((r, k) => {
          let x = 64, g = tx(20, y + 18, r.lab, "small fade");
          r.segs.forEach((s) => { s.forEach((v, i) => { g += '<rect class="stroke fade" x="' + (x + i * w) + '" y="' + y + '" width="' + (w - 2) + '" height="26" rx="4"/>' + tx(x + i * w + (w - 2) / 2, y + 17, v, "cell-tx small-cell", 1); }); x += s.length * w + gap; });
          o += k === 0 ? g.replace(/class="([^"]*fade)/g, 'class="$1 d1') : fr(k, g);
          y += 32;
        });
        return wrap(o, "0 0 400 " + (y + 6));
      }
    }
    if (/^equation:/.test(key)) return eqSVG(key.slice(9));
    if (/^lesson:/.test(key)) {
      let ss; try { ss = JSON.parse(decodeURIComponent(key.slice(7))); } catch (e) { ss = []; }
      const e = (x) => String(x).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
      const wrapL = (t, n) => { const out = []; let cur = ""; String(t).split(/\s+/).forEach((w) => { if ((cur + " " + w).trim().length > n && cur) { out.push(cur); cur = w; } else cur = (cur + " " + w).trim(); }); if (cur) out.push(cur); return out; };
      let o = "", y = 8;
      ss.forEach((sec, i) => {
        const k = 2 * i + 1, top = y; let g = "";
        y += 26; g += '<text class="label big fade d' + k + '" x="34" y="' + y + '">' + e(sec.t) + "</text>";
        g += '<text class="label small fade d' + k + '" x="16" y="' + y + '">' + (i + 1) + "</text>";
        wrapL(sec.i, 54).forEach((l) => { y += 20; g += '<text class="label fade d' + k + '" x="34" y="' + y + '">' + e(l) + "</text>"; });
        if (sec.f) { y += 30; g += '<text class="label formula fade d' + k + '" x="34" y="' + y + '">' + e(sec.f) + "</text>"; y += 8; g += underline(34, y, Math.min(330, sec.f.length * 11 + 10), "d" + k); }
        if (sec.e) { y += 26; g += '<text class="label small fade d' + k + '" x="34" y="' + y + '">EXAMPLE</text>'; wrapL(sec.e, 54).forEach((l) => { y += 19; g += '<text class="label fade d' + k + '" x="34" y="' + y + '">' + e(l) + "</text>"; }); }
        if (sec.d && sec.d.length) {
          y += 26; g += '<text class="label small fade d' + k + '" x="34" y="' + y + '">WHY</text>';
          sec.d.forEach((st, j) => { wrapL(st, 50).forEach((l, m) => { y += 19; g += '<text class="label fade d' + k + '" x="' + (m ? 52 : 34) + '" y="' + y + '">' + (m ? "" : (j + 1) + ". ") + e(l) + "</text>"; }); });
        }
        y += 18;
        o += '<g class="d' + k + '"><rect class="stroke lesson-card draw d' + k + '" ' + P + ' x="6" y="' + top + '" width="388" height="' + (y - top) + '" rx="12"/>' + g + "</g>";
        y += 14;
      });
      return wrap(o, "0 0 400 " + y);
    }
    if (/^work:/.test(key)) {
      let ws; try { ws = JSON.parse(decodeURIComponent(key.slice(5))); } catch (e) { ws = []; }
      const e = (x) => String(x).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
      let o = '<text class="label fade d1" x="20" y="22">Worked example</text>', y = 34;
      ws.forEach((line, i) => {
        const k = 2 * i + 2, eq = line.lastIndexOf("="), lhs = eq > 0 ? line.slice(0, eq + 1) : line, rhs = eq > 0 ? line.slice(eq + 1).trim() : "";
        const words = lhs.split(/\s+/), ls = []; let cur = "";
        words.forEach((w) => { if ((cur + " " + w).trim().length > 40 && cur) { ls.push(cur); cur = w; } else cur = (cur + " " + w).trim(); });
        if (cur) ls.push(cur);
        o += '<g class="d' + k + '"><text class="label small fade d' + k + '" x="20" y="' + (y + 18) + '">' + (i + 1) + "</text>";
        ls.forEach((l, j) => { o += '<text class="label fade d' + k + '" x="40" y="' + (y + 18 + j * 20) + '">' + e(l) + (j === ls.length - 1 && rhs ? ' <tspan class="work-rhs">' + e(rhs) + "</tspan>" : "") + "</text>"; });
        y += ls.length * 20 + 12;
        o += '<path class="stroke draw d' + k + '" ' + P + ' d="M40 ' + (y - 4) + ' H380" style="opacity:.18"/></g>';
      });
      return wrap(o, "0 0 400 " + (y + 6));
    }
    if (/^steps:/.test(key)) {
      let st; try { st = JSON.parse(decodeURIComponent(key.slice(6))); } catch (e) { st = []; }
      const e = (x) => String(x).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
      const wrapText = (t, n) => { const out = []; let cur = ""; String(t).split(/\s+/).forEach((w) => { if ((cur + " " + w).trim().length > n && cur) { out.push(cur); cur = w; } else cur = (cur + " " + w).trim(); }); if (cur) out.push(cur); return out; };
      let o = "", y = 10;
      st.forEach((t, i) => {
        const ls = wrapText(t, 42), h = 16 + ls.length * 19, w = Math.min(370, Math.max(140, Math.max(...ls.map((l) => l.length)) * 7.6 + 56)), k = 2 * i + 1;
        o += '<g class="d' + k + '"><rect class="stroke node-bg draw d' + k + '" ' + P + ' x="16" y="' + y + '" width="' + w + '" height="' + h + '" rx="9"/>' +
          '<text class="label small fade d' + k + '" x="28" y="' + (y + 22) + '" style="font-size:11px">' + (i + 1) + "</text>";
        ls.forEach((l, j) => { o += '<text class="label fade d' + k + '" x="44" y="' + (y + 23 + j * 19) + '">' + e(l) + "</text>"; });
        o += "</g>";
        y += h;
        if (i < st.length - 1) { o += '<path class="stroke draw d' + (k + 1) + '" ' + P + ' d="M40 ' + (y + 2) + " v16 M35 " + (y + 12) + " L40 " + (y + 19) + " L45 " + (y + 12) + '"/>'; y += 22; }
      });
      return wrap(o, "0 0 400 " + (y + 8));
    }
    if (/^formula:/.test(key)) {
      let d; try { d = JSON.parse(decodeURIComponent(key.slice(8))); } catch (e) { d = { f: "", t: [] }; }
      const e = (x) => String(x).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
      const lines = [], words = String(d.f).split(" "); let cur = "";
      words.forEach((w) => { if ((cur + " " + w).trim().length > 30 && cur) { lines.push(cur); cur = w; } else cur = (cur + " " + w).trim(); });
      if (cur) lines.push(cur);
      let o = '<text class="label fade d1" x="20" y="22">The formula</text>';
      lines.forEach((l, i) => { o += '<text class="label formula fade d1" x="20" y="' + (56 + i * 30) + '">' + e(l) + "</text>"; });
      const top = 56 + (lines.length - 1) * 30;
      o += underline(20, top + 10, Math.min(360, Math.max(...lines.map((l) => l.length)) * 11 + 10), "d2");
      const symW = Math.min(150, Math.max(24, ...(d.t || []).map(([sym]) => String(sym).length * 9.5)));
      (d.t || []).forEach(([sym, mean], i) => {
        const y = top + 50 + i * 32, k = 2 * i + 3;
        o += '<text class="label big fade d' + k + '" x="30" y="' + y + '">' + e(sym) + '</text><path class="stroke draw d' + k + '" ' + P + ' d="M' + (38 + symW) + " " + (y - 5) + ' h14" style="opacity:.5"/><text class="label fade d' + k + '" x="' + (60 + symW) + '" y="' + y + '">' + e(mean) + "</text>";
      });
      const W = Math.max(400, ...(d.t || []).map(([, m]) => 70 + symW + String(m).length * 7.6), ...lines.map((l) => 40 + l.length * 12));
      return wrap(o, "0 0 " + Math.ceil(W) + " " + (top + 40 + (d.t || []).length * 32));
    }
    function eqSVG(src) {
      const q = parseEquation(src); if (!q) return wrap('<text class="label fade d1" x="20" y="30">Couldn\'t read that equation.</text>', "0 0 400 60");
      const { a, b, c, lhs } = q, f = (x) => a * x * x + b * x + c, t = (x, y, s, cls, big) => '<text class="label ' + (big ? "big " : "") + 'fade ' + cls + '" x="' + x + '" y="' + y + '">' + s + "</text>";
      let out = t(20, 26, "Solve: " + lhs, "d1", true) + t(20, 54, "Move everything to one side: " + poly(a, b, c) + " = 0", "d3");
      let roots = [];
      if (!a) {
        roots = [-c / b];
        out += t(20, 82, "Isolate x: " + fmt(b) + "x = " + fmt(-c), "d5") + t(20, 110, "x = " + fmt(roots[0]), "d7", true) + underline(20, 116, 80, "d7");
      } else {
        const D = b * b - 4 * a * c;
        if (D < 0) out += t(20, 82, "D = b² − 4ac = " + fmt(D) + " < 0", "d5") + t(20, 110, "No real roots: the curve never touches zero.", "d7", true);
        else {
          roots = D === 0 ? [-b / (2 * a)] : [(-b - Math.sqrt(D)) / (2 * a), (-b + Math.sqrt(D)) / (2 * a)];
          const nice = roots.every((r) => Number.isInteger(r)) && a === 1;
          out += t(20, 82, nice ? "Factor: " + roots.map((r) => "(x " + (r > 0 ? "− " + r : "+ " + -r) + ")").join("") + " = 0" : "Formula: x = (−b ± √D) / 2a, D = " + fmt(D), "d5");
          out += t(20, 110, "x = " + roots.map(fmt).join("  or  x = "), "d7", true) + underline(20, 116, 140, "d7");
        }
      }
      // plot: window around the roots / vertex
      const vx = a ? -b / (2 * a) : roots[0] || 0, xs = roots.concat([vx]);
      let x0 = Math.min.apply(null, xs) - 3, x1 = Math.max.apply(null, xs) + 3;
      const N = 60, pts = []; for (let i = 0; i <= N; i++) { const x = x0 + (x1 - x0) * i / N; pts.push([x, f(x)]); }
      let y0 = Math.min(0, ...pts.map((p) => p[1])), y1 = Math.max(0, ...pts.map((p) => p[1]));
      const L = 40, R = 380, T = 140, B = 290, X = (x) => L + (x - x0) / (x1 - x0) * (R - L), Y = (y) => B - (y - y0) / (y1 - y0 || 1) * (B - T);
      out += '<path class="stroke draw d9" ' + P + ' d="M' + L + " " + Y(0) + " H" + R + '" style="opacity:.45"/>';
      if (x0 < 0 && x1 > 0) out += '<path class="stroke draw d9" ' + P + ' d="M' + X(0) + " " + T + " V" + B + '" style="opacity:.45"/>';
      out += '<path class="stroke return draw d10" ' + P + ' d="M' + pts.map((p) => X(p[0]).toFixed(1) + " " + Y(p[1]).toFixed(1)).join(" L") + '"/>';
      roots.forEach((r) => { out += '<g class="pop d10"><circle class="stroke" cx="' + X(r) + '" cy="' + Y(0) + '" r="4.5" style="fill:var(--paper)"/>' + '<text class="label" x="' + X(r) + '" y="' + (Y(0) + (Y(0) > B - 20 ? -12 : 20)) + '" text-anchor="middle">' + fmt(r) + "</text></g>"; });
      return wrap(out, "0 0 400 300");
    }
    switch (key) {
      case "recursion": return wrap(
        '<text class="label fade d1" x="20" y="22">Watch the leaves return, then the answers flow up.</text>' +
        node(200, 52, "fib(3)", "d2") +
        '<path class="stroke draw d3" ' + P + ' d="M186 66 L122 104"/>' +
        '<path class="stroke draw d3" ' + P + ' d="M214 66 L278 104"/>' +
        node(110, 118, "fib(2)", "d4") + node(290, 118, "fib(1)", "d4") +
        '<text class="label fade d5" x="266" y="146">returns 1</text>' +
        '<path class="stroke draw d5" ' + P + ' d="M98 132 L64 176"/>' +
        '<path class="stroke draw d5" ' + P + ' d="M122 132 L156 176"/>' +
        node(62, 190, "fib(1)", "d6") + node(158, 190, "fib(0)", "d6") +
        '<text class="label fade d7" x="34" y="216">returns 1</text>' +
        '<text class="label fade d7" x="132" y="216">returns 0</text>' +
        '<path class="stroke return draw d7" ' + P + ' d="M62 176 L96 142 M88 148 L98 140 L96 152"/>' +
        '<path class="stroke return draw d7" ' + P + ' d="M158 176 L124 142 M132 152 L122 140 L124 152"/>' +
        badge(140, 108, "= 1", "d8") +
        badge(232, 42, "= 2", "d9") +
        '<text class="label big fade d9" x="120" y="246">answers flow up</text>' +
        underline(120, 252, 118, "d9") +
        '<text class="label fade d10" x="118" y="266">1 + 0 = 1, then 1 + 1 = 2</text>', "0 0 400 276");

      case "nqueens": {
        // storyboard: one mini board per step, like flipping through the search
        const P6 = [
          ["1. First choices", [[0, 0], [1, 2]], -1, "One queen per row."],
          ["2. Stuck", [[0, 0], [1, 2]], 2, "Undo the last queen."],
          ["3. Next safe square", [[0, 0], [1, 3], [2, 1]], -1, "Continue downward."],
          ["4. Stuck again", [[0, 0], [1, 3], [2, 1]], 3, "Undo back to row 1."],
          ["5. Change the start", [[0, 1]], -1, "Try downward again."],
          ["6. All rows filled", [[0, 1], [1, 3], [2, 0], [3, 2]], -1, "Save this solution."],
        ];
        let o = '<text class="label big fade d1" x="20" y="22">Try a square. Undo when stuck.</text>';
        P6.forEach(([title, qs, stuck, cap], i) => {
          const x = 30 + (i % 2) * 190, y = 44 + Math.floor(i / 2) * 118, c = 16, d = 2 * i + 1, s = 2 * i + 2;
          o += '<g class="d' + d + '"><text class="label fade d' + d + '" x="' + x + '" y="' + y + '">' + title + "</text>";
          if (stuck >= 0) o += '<rect class="shade fade d' + s + '" x="' + x + '" y="' + (y + 10 + stuck * c) + '" width="' + 4 * c + '" height="' + c + '"/>';
          o += '<rect class="stroke draw d' + d + '" ' + P + ' x="' + x + '" y="' + (y + 10) + '" width="' + 4 * c + '" height="' + 4 * c + '" style="stroke-width:1"/>';
          for (let k = 1; k < 4; k++) o += '<path class="stroke draw d' + d + '" ' + P + ' style="stroke-width:.6;opacity:.55" d="M' + (x + k * c) + " " + (y + 10) + " v" + 4 * c + " M" + x + " " + (y + 10 + k * c) + " h" + 4 * c + '"/>';
          qs.forEach(([r, col]) => { o += '<circle class="nq-dot pop d' + s + '" cx="' + (x + col * c + c / 2) + '" cy="' + (y + 10 + r * c + c / 2) + '" r="4"/>'; });
          o += '<text class="label small fade d' + s + '" x="' + x + '" y="' + (y + 92) + '">' + cap + "</text></g>";
        });
        return wrap(o, "0 0 400 400");
      }

      case "linkedlist": return wrap(
        '<text class="label fade d1" x="20" y="24">Flip the arrows, one node at a time.</text>' +
        box(40, 56, "A", "d2") + box(160, 56, "B", "d2") + box(280, 56, "C", "d2") +
        '<path class="stroke draw d3" ' + P + ' d="M96 77 L156 77 M148 71 L158 77 L148 83"/>' +
        '<path class="stroke draw d3" ' + P + ' d="M216 77 L276 77 M268 71 L278 77 L268 83"/>' +
        '<text class="label fade d4" x="150" y="128">save next → flip → advance</text>' +
        box(40, 150, "A", "d6") + box(160, 150, "B", "d6") + box(280, 150, "C", "d6") +
        '<path class="stroke return draw d7" ' + P + ' d="M160 171 L100 171 M108 165 L98 171 L108 177"/>' +
        '<path class="stroke return draw d7" ' + P + ' d="M280 171 L220 171 M228 165 L218 171 L228 177"/>' +
        badge(288, 138, "new head", "d8") +
        '<text class="label fade d9" x="40" y="222">C is the head now; A points to null.</text>', "0 0 400 236");

      case "binarysearch": return wrap(
        '<text class="label fade d1" x="20" y="24">Sorted? Then halve it. Target = 11.</text>' +
        box(36, 60, "1", "d2", 36) + box(76, 60, "3", "d2", 36) + box(116, 60, "5", "d2", 36) + box(156, 60, "7", "d2", 36) +
        box(196, 60, "9", "d2", 36) + box(236, 60, "11", "d2", 36) + box(276, 60, "13", "d2", 36) + box(316, 60, "15", "d2", 36) +
        '<rect class="shade fade d4" x="34" y="58" width="160" height="46" rx="8"/>' +
        '<text class="label fade d4" x="60" y="130">7 &lt; 11 → discard the left half</text>' +
        '<path class="stroke draw d5" ' + P + ' d="M254 104 L254 140 M248 132 L254 142 L260 132"/>' +
        '<rect class="found pop d7" x="234" y="58" width="40" height="46" rx="8"/>' +
        badge(238, 168, "11 = 11 ✓", "d8") +
        '<text class="label fade d9" x="40" y="206">Two guesses, not eight. That is log n.</text>', "0 0 400 220");

      case "bigo": return wrap(
        '<text class="label fade d1" x="20" y="24">What grows when n grows?</text>' +
        '<path class="stroke draw d2" ' + P + ' d="M50 200 L372 200"/>' +
        '<path class="stroke draw d2" ' + P + ' d="M50 200 L50 34"/>' +
        '<path class="stroke c1 draw d4" ' + P + ' d="M50 192 L360 96"/>' +
        '<path class="stroke c2 draw d6" ' + P + ' d="M50 196 C 180 168, 280 120, 360 60"/>' +
        '<path class="stroke c3 draw d8" ' + P + ' d="M50 198 C 210 192, 300 150, 356 38"/>' +
        '<text class="label c1 fade d5" x="300" y="88">O(n)</text>' +
        '<text class="label c2 fade d7" x="288" y="50">O(n log n)</text>' +
        '<text class="label c3 fade d9" x="300" y="30">O(n²)</text>' +
        '<text class="label fade d10" x="50" y="226">Nested loops multiply — watch the red curve win.</text>', "0 0 400 238");

      case "flow": return wrap(
        '<text class="label fade d1" x="20" y="24">Store a fingerprint, not the password.</text>' +
        box(30, 48, "pass", "d2") +
        '<path class="stroke draw d3" ' + P + ' d="M58 90 v22"/>' +
        '<rect class="stroke draw d3" ' + P + ' x="20" y="112" width="120" height="40" rx="8"/>' +
        '<text class="label fade d4" x="44" y="137">Argon2id</text>' +
        badge(150, 122, "+ salt", "d4") +
        '<path class="stroke draw d5" ' + P + ' d="M80 152 v22"/>' +
        '<rect class="stroke draw d5" ' + P + ' x="20" y="174" width="140" height="40" rx="8"/>' +
        '<text class="label fade d6" x="40" y="199">stored hash</text>' +
        '<path class="stroke draw d7" ' + P + ' d="M160 194 C 240 194, 250 120, 300 120"/>' +
        '<rect class="stroke draw d7" ' + P + ' x="300" y="100" width="80" height="40" rx="8"/>' +
        '<text class="label fade d8" x="318" y="125">verify</text>' +
        badge(300, 168, "match?", "d9"), "0 0 400 232");

      case "incline": {
        // slope rises left→right at θ≈20.6°; block sits on it, forces drawn from its centre
        const arrow = (x1, y1, x2, y2, cls) => {
          const ang = Math.atan2(y2 - y1, x2 - x1), h = 9, l = [x2 - h * Math.cos(ang - 0.45), y2 - h * Math.sin(ang - 0.45)], r = [x2 - h * Math.cos(ang + 0.45), y2 - h * Math.sin(ang + 0.45)];
          return '<path class="stroke draw ' + cls + '" ' + P + ' d="M' + x1 + " " + y1 + " L" + x2 + " " + y2 + " M" + l[0].toFixed(1) + " " + l[1].toFixed(1) + " L" + x2 + " " + y2 + " L" + r[0].toFixed(1) + " " + r[1].toFixed(1) + '"/>';
        };
        return wrap(
          '<text class="label fade d1" x="20" y="24">Tilt your axes to the slope.</text>' +
          '<path class="stroke draw d2" ' + P + ' d="M40 200 L360 200 L360 80 Z"/>' +
          '<path class="stroke draw d2" ' + P + ' d="M80 200 A 40 40 0 0 0 77.4 186" style="opacity:.6"/><text class="label fade d2" x="88" y="194">θ</text>' +
          '<rect class="stroke draw d3" ' + P + ' x="175" y="117" width="34" height="24" transform="rotate(-20.6 192 129)"/>' +
          arrow(192, 129, 192, 197, "d4") + '<text class="label fade d4" x="198" y="196">mg</text>' +
          arrow(192, 129, 136, 150, "c2 d6") + '<text class="label c2 fade d6" x="74" y="160">mg sinθ</text>' +
          '<path class="stroke trace draw d6" ' + P + ' d="M192 129 L213 185"/><text class="label fade d6" x="218" y="186" style="font-size:12px">mg cosθ</text>' +
          arrow(192, 129, 171, 73, "c1 d8") + '<text class="label c1 fade d8" x="156" y="68">N</text>' +
          '<text class="label fade d9" x="40" y="226">mg sinθ pulls it down the slope; N balances mg cosθ.</text>', "0 0 400 236");
      }

      case "twosum": return wrap(
        '<text class="label fade d1" x="20" y="24">target 9 · the missing piece is 9 − x</text>' +
        box(40, 50, "2", "d2") + box(110, 50, "7", "d2") + box(180, 50, "11", "d2") + box(250, 50, "15", "d2") +
        '<path class="stroke return draw d4" ' + P + ' d="M138 92 C 138 132, 68 132, 68 92 M74 100 L66 90 L62 102"/>' +
        badge(70, 150, "7 + 2 = 9 ✓", "d6") +
        '<rect class="stroke draw d7" ' + P + ' x="40" y="176" width="300" height="40" rx="8"/>' +
        '<text class="label fade d8" x="56" y="201">seen = { 2:0 } → check before you insert</text>' +
        underline(56, 208, 240, "d8"), "0 0 400 230");

      case "timeline": return wrap(
        '<text class="label fade d1" x="20" y="24">What has to be true first?</text>' +
        '<path class="stroke draw d2" ' + P + ' d="M40 120 L360 120"/>' +
        tick(80, "Runway", "d3") + tick(180, "Users", "d5") + tick(280, "Notice", "d7") +
        '<text class="label fade d9" x="40" y="184">Save rent → prove pull → then leap.</text>', "0 0 400 206");

      case "graph": return wrap(
        '<text class="label fade d1" x="20" y="24">One hot key, many readers.</text>' +
        '<circle class="stroke draw d2" ' + P + ' cx="200" cy="120" r="26"/>' +
        '<text class="label fade d3" x="178" y="125">cache</text>' +
        '<path class="stroke draw d4" ' + P + ' d="M178 108 L90 60 M222 108 L310 60 M178 132 L90 180 M222 132 L310 180 M200 94 L200 40"/>' +
        '<circle class="stroke pop d6" cx="80" cy="54" r="12"/><circle class="stroke pop d6" cx="320" cy="54" r="12"/>' +
        '<circle class="stroke pop d7" cx="80" cy="186" r="12"/><circle class="stroke pop d7" cx="320" cy="186" r="12"/>' +
        '<circle class="stroke pop d8" cx="200" cy="30" r="12"/>' +
        '<text class="label fade d9" x="20" y="226">What if 50,000 followers hit it at once?</text>', "0 0 400 240");

      default: return wrap(
        '<text class="label fade d1" x="20" y="24">The shape of the idea.</text>' +
        '<rect class="stroke draw d2" ' + P + ' x="40" y="60" width="120" height="44" rx="8"/>' +
        '<path class="stroke draw d4" ' + P + ' d="M160 82 L240 82 M232 76 L242 82 L232 88"/>' +
        '<rect class="stroke draw d4" ' + P + ' x="240" y="60" width="120" height="44" rx="8"/>' +
        '<path class="stroke return draw d6" ' + P + ' d="M300 104 L300 160 L100 160 L100 104 M106 112 L100 102 L94 112"/>' +
        '<text class="label fade d8" x="40" y="200">Follow the loop — where does it break?</text>', "0 0 400 220");
    }
  }

  /* ---------- word-by-word ink reveal ---------- */
  function revealWords(el, text, opts) {
    opts = opts || {};
    const speed = opts.speed || 42;
    el.innerHTML = "";
    const words = String(text).split(/(\s+)/);
    const spans = [];
    words.forEach((w) => {
      if (/^\s+$/.test(w)) { el.appendChild(document.createTextNode(w)); return; }
      const s = document.createElement("span");
      s.className = "ink-word";
      s.textContent = w;
      el.appendChild(s);
      spans.push(s);
    });
    let i = 0, cancelled = false;
    const reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce) { spans.forEach((s) => s.classList.add("on")); return { cancel() {}, done: Promise.resolve() }; }
    let resolveDone;
    const done = new Promise((res) => (resolveDone = res));
    (function step() {
      if (cancelled) return resolveDone();
      if (i >= spans.length) return resolveDone();
      spans[i].classList.add("on");
      i++;
      setTimeout(step, speed + Math.random() * 30);
    })();
    return { cancel() { cancelled = true; spans.forEach((s) => s.classList.add("on")); }, done };
  }

  window.ThinkerAI = {
    health, chat, see, tts, stt, respond, localMind, sketchSVG, revealWords,
    get mode() { return state.mode; },
    SKETCH_KEYS,
  };
})();