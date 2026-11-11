/* ============================================================
   THINKER app — editor, animated margin, sketches, threads,
   commands, palette, personas, voice. Local-first, LFM3-powered.
   ============================================================ */
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const uid = () => Math.random().toString(36).slice(2, 10);
  const AI = window.ThinkerAI;
  const LS = "thinker.v1";
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  /* ---------------- state ---------------- */
  const PERSONAS = [
    { id: "thinker", name: "Thinker", prompt: "A warm, sharp Socratic companion." },
    { id: "staff", name: "Staff engineer", prompt: "Reviews like a staff engineer: probes failure modes, scale, and edge cases." },
    { id: "editor", name: "Editor", prompt: "Reviews like a ruthless editor: asks who it's for and whether each word earns its place." },
    { id: "investor", name: "Investor", prompt: "Reviews like an investor: asks whether it moves retention, revenue, or risk." },
    { id: "professor", name: "Professor", prompt: "Reviews like a professor: asks why this tool, what property of the problem makes it right." },
  ];

  function seed() {
    return {
      theme: "dark",
      personas: PERSONAS.slice(),
      notes: [
        {
          id: uid(), title: "Welcome to Thinker", folder: "", brief: "Try me out.", mode: "with",
          persona: "thinker", ink: "ink", intent: "challenge", updatedAt: Date.now(),
          body: "<p>Write anything. Thinker thinks with you: it reads along and speaks up in the margin when something's worth a second look.</p><p>Rather it waited? Set a note to <em>When you ask</em>, in the row above its title. Tap any reply to follow the thought.</p><p>how to solve two sum problem in cpp?</p><div class=\"inline-sketch sketch\" data-sketch=\"twosum\" contenteditable=\"false\"></div>",
          responses: [
            { id: uid(), text: "Before the hash map — what does brute force cost, and what exactly does the map let you skip? Watch the sketch: 7 arcs back to 2.", sketch: "twosum", draw: true, persona: "Thinker", ink: "ink", thread: [], revealed: true },
          ],
        },
        {
          id: uid(), title: "Signup flow", folder: "Building", brief: "Ship login by Friday.", mode: "with",
          persona: "staff", ink: "ink", intent: "challenge", updatedAt: Date.now() - 3600e3,
          body: "<h2>Signup flow</h2><p>save the user's password in the users table then login just checks if it matches I think?</p>",
          responses: [
            { id: uid(), text: "Hashed, right? What exactly gets stored, and what gets compared at login?", sketch: "flow", draw: true, persona: "Staff engineer", ink: "ink", thread: [], revealed: true },
          ],
        },
        {
          id: uid(), title: "Inclined planes", folder: "Studying", brief: "Physics midterm Friday.", mode: "with",
          persona: "professor", ink: "blue", intent: "challenge", updatedAt: Date.now() - 7200e3,
          body: "<h2>Inclined planes</h2><p>I have a hard time visualizing how forces act on an object on an incline.</p>",
          responses: [
            { id: uid(), text: "Gravity pulls straight down — so how much of it acts along the slope, and what balances the rest?", sketch: "incline", draw: true, persona: "Professor", ink: "blue", thread: [], revealed: true },
          ],
        },
        {
          id: uid(), title: "Going full time", folder: "", brief: "A big decision.", mode: "ask",
          persona: "thinker", ink: "ink", intent: "challenge", updatedAt: Date.now() - 9000e3,
          body: "<p>I'm going to quit my job next month and go full time on the app.</p>",
          responses: [
            { id: uid(), text: "With how many months of rent saved? Write the number down here.", sketch: "none", draw: false, persona: "Thinker", ink: "ink", thread: [], revealed: true },
          ],
        },
      ],
    };
  }

  let db;
  try { db = JSON.parse(localStorage.getItem(LS)) || seed(); } catch (e) { db = seed(); }
  if (!db.notes || !db.notes.length) db = seed();
  let activeId = db.notes[0].id;
  let justWords = false;
  let voiceOut = false;
  const active = () => db.notes.find((n) => n.id === activeId) || db.notes[0];
  const personaName = (id) => (db.personas.find((p) => p.id === id) || {}).name || "Thinker";

  function save() {
    try { localStorage.setItem(LS, JSON.stringify(db)); } catch (e) {}
    const ss = $("saveState"); if (ss) { ss.textContent = "Saving…"; setTimeout(() => (ss.textContent = "All notes saved"), 500); }
  }

  /* ---------------- toast ---------------- */
  let toastT;
  function toast(msg, undo) {
    const t = $("toast"); t.innerHTML = esc(msg);
    if (undo) { const b = document.createElement("button"); b.textContent = "Undo"; b.style.cssText = "margin-left:12px;background:transparent;border:0;color:inherit;text-decoration:underline;font-weight:600"; b.onclick = () => { undo(); t.classList.remove("show"); }; t.appendChild(b); }
    t.classList.add("show"); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove("show"), undo ? 6000 : 2400);
  }

  /* ---------------- theme ---------------- */
  function applyTheme() {
    document.documentElement.setAttribute("data-theme", db.theme);
    const icon = db.theme === "dark" ? "#i-sun" : "#i-moon";
    document.querySelectorAll("#themeToggle use, #appThemeToggle use").forEach((u) => u.setAttribute("href", icon));
  }
  function toggleTheme() { db.theme = db.theme === "dark" ? "light" : "dark"; applyTheme(); save(); }

  /* ---------------- view routing ---------------- */
  function go(view, fromHistory) {
    const landing = $("landing"), app = $("app"), path = view === "app" ? "/chat" : "/";
    if (!fromHistory && location.pathname !== path) history.pushState({ view }, "", path + location.search);
    document.title = view === "app" ? "Thinker · Chat" : "Thinker — a notebook that thinks with you";
    if (view === "app") {
      landing.classList.add("hidden"); app.classList.add("active");
      if (window.matchMedia("(max-width: 760px)").matches) $("sidebar").classList.add("collapsed");
      renderSidebar(); openNote(activeId); refreshConn();
      document.body.style.overflow = "hidden";
    } else {
      app.classList.remove("active"); landing.classList.remove("hidden");
      document.body.style.overflow = "";
      window.scrollTo(0, 0);
    }
  }

  async function refreshConn() { try { await AI.health(true); } catch (e) {} }

  /* ---------------- sidebar ---------------- */
  function renderSidebar() {
    const list = $("noteList"); list.innerHTML = "";
    // loose notes first, then each folder under its own label
    const sorted = db.notes.slice().sort((a, b) => (a.folder || "").localeCompare(b.folder || "") || b.updatedAt - a.updatedAt);
    let group = "";
    sorted.forEach((n) => {
      if ((n.folder || "") !== group) { group = n.folder || ""; const g = document.createElement("div"); g.className = "note-group"; g.textContent = group; list.appendChild(g); }
      const b = document.createElement("button");
      b.className = "note-item" + (n.id === activeId ? " active" : "");
      b.innerHTML = '<svg><use href="#i-file"/></svg><span class="title">' + esc(n.title || "Untitled") + '</span><span class="dot"></span><span class="note-del" role="button" tabindex="0" aria-label="Delete note" title="Delete"><svg><use href="#i-trash"/></svg></span>';
      b.onclick = (e) => { if (e.target.closest(".note-del")) { deleteNote(n.id); return; } openNote(n.id); if (window.innerWidth < 760) $("sidebar").classList.add("collapsed"); };
      list.appendChild(b);
    });
  }

  function deleteNote(id) {
    const i = db.notes.findIndex((x) => x.id === id); if (i < 0) return;
    const [gone] = db.notes.splice(i, 1);
    if (!db.notes.length) db.notes.push({ id: uid(), title: "Untitled", folder: "", brief: "", mode: "with", persona: "thinker", ink: "ink", intent: "challenge", body: "", responses: [], updatedAt: Date.now() });
    if (activeId === id) activeId = db.notes[0].id;
    save(); openNote(activeId);
    toast("Deleted “" + (gone.title || "Untitled") + "”.", () => { db.notes.splice(i, 0, gone); save(); openNote(gone.id); });
  }
  const isBlank = (n) => (!n.title || n.title === "Untitled") && !plainText(n.body).trim() && !n.responses.length;

  /* ---------------- sketches: mount, play on scroll, replay ---------------- */
  const sketchIO = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { sketchIO.unobserve(e.target); e.target._play(); } }), { threshold: 0.25 });
  function mountSketch(el, key, opts) {
    opts = opts || {};
    el.classList.add("sketch");
    el.innerHTML = AI.sketchSVG(key) +
      '<div class="sk-controls" contenteditable="false"><button class="sk-btn" data-k="prev" aria-label="Previous step">‹</button><span class="sk-count"></span>' +
      '<button class="sk-btn" data-k="next" aria-label="Next step">›</button><button class="sk-btn" data-k="replay" aria-label="Replay sketch"><svg><use href="#i-reply"/></svg></button></div>';
    const steps = [...el.querySelectorAll(".sk-step")], n = steps.length, count = el.querySelector(".sk-count");
    let at = 0, timer;
    const show = (k) => {
      at = Math.max(0, Math.min(n, k));
      steps.forEach((s, i) => { s.classList.toggle("on", i < at); s.classList.toggle("cur", i === at - 1); });
      count.textContent = at + "/" + n;
      el.querySelector('[data-k="prev"]').disabled = at <= 1;
      el.querySelector('[data-k="next"]').disabled = at >= n;
    };
    el._play = () => {
      clearInterval(timer); show(0);
      requestAnimationFrame(() => show(1));
      timer = setInterval(() => { if (!el.isConnected || at >= n) return clearInterval(timer); show(at + 1); }, 1300);
    };
    el.querySelector(".sk-controls").onclick = (ev) => {
      const b = ev.target.closest("[data-k]"); if (!b) return;
      ev.stopPropagation(); ev.preventDefault(); clearInterval(timer);
      if (b.dataset.k === "replay") el._play(); else show(at + (b.dataset.k === "next" ? 1 : -1));
    };
    show(0);
    if (opts.playNow) el._play(); else sketchIO.observe(el);
    return el;
  }
  function hydrateSketches(root) {
    root.querySelectorAll("[data-sketch]").forEach((el) => { if (el._mounted) return; el._mounted = true; mountSketch(el, el.dataset.sketch); });
  }
  function serializeBody() {
    const c = $("noteBody").cloneNode(true);
    c.querySelectorAll("[data-sketch]").forEach((el) => { el.innerHTML = ""; el.classList.remove("play"); });
    return c.innerHTML;
  }

  /* ---------------- editor render ---------------- */
  function openNote(id) {
    if (activeId !== id && db.notes.length > 1) { const prev = active(); if (prev && isBlank(prev)) db.notes = db.notes.filter((x) => x !== prev); }
    activeId = id;
    const n = active();
    $("noteTitle").textContent = n.title || "";
    $("noteBody").innerHTML = n.body || "";
    hydrateSketches($("noteBody"));
    $("briefInput").value = n.brief || "";
    $("personaName").textContent = personaName(n.persona);
    $("modeName").textContent = n.mode === "with" ? "Thinks with you" : "When you ask";
    $("modeBtn").querySelector(".bulb").style.color = n.mode === "with" ? "var(--accent)" : "var(--faint)";
    setNoteInk(n.ink);
    renderMargin(true);
    renderSidebar();
    lastBody = plainText(n.body || "");
  }

  function setNoteInk(ink) {
    const map = { ink: "var(--ink)", blue: "var(--blue)", green: "var(--green)", purple: "var(--purple)", orange: "var(--orange)" };
    document.querySelector(".editor-canvas").style.setProperty("--ink-pen", map[ink] || "var(--ink)");
  }

  function renderMargin(instant) {
    const col = $("marginCol"); col.innerHTML = "";
    const n = active();
    if (justWords) { col.innerHTML = '<div class="margin-empty">Just your words. Margin hidden.</div>'; return; }
    if (!n.responses.length) {
      col.innerHTML = '<div class="margin-empty">' + (n.mode === "with" ? "Thinker is reading along. Keep writing — it'll speak up when something's worth a second look." : "Quiet until you ask. Type below, or tap the mic to speak.") + "</div>";
      return;
    }
    n.responses.forEach((r) => col.appendChild(marginCard(r, instant || r.revealed)));
  }

  function marginCard(r, instant) {
    const card = document.createElement("div");
    card.className = "margin-card";
    card.style.setProperty("--ink-pen", inkVar(r.ink));
    const dot = document.createElement("span"); dot.className = "ink-dot" + (instant ? "" : " is-fresh");
    const body = document.createElement("div"); body.className = "body";
    const text = document.createElement("span"); body.appendChild(text);
    const meta = document.createElement("span"); meta.className = "meta"; meta.textContent = r.persona || "Thinker"; body.appendChild(meta);
    const chip = document.createElement("button"); chip.className = "follow-chip";
    chip.innerHTML = 'Follow the thought <svg><use href="#i-arrow"/></svg>';
    chip.onclick = (ev) => { ev.stopPropagation(); replyTo(r.id); };
    body.appendChild(chip);
    card._rid = r.id; card.appendChild(dot); card.appendChild(body);
    if (instant) text.innerHTML = AI.inkHTML(r.text.replace(/\$+/g, "")); else AI.revealWords(text, r.text);
    card.onclick = () => replyTo(r.id);
    return card;
  }

  function inkVar(ink) { return { ink: "var(--ink)", blue: "var(--blue)", green: "var(--green)", purple: "var(--purple)", orange: "var(--orange)" }[ink] || "var(--ink)"; }

  let replyId = null;
  function replyTo(rid) {
    const r = active().responses.find((x) => x.id === rid); if (!r) return;
    replyId = rid;
    document.querySelectorAll(".margin-card.replying").forEach((c) => c.classList.remove("replying"));
    const card = [...document.querySelectorAll(".margin-card")].find((c) => c._rid === rid); if (card) card.classList.add("replying");
    const inp = $("composerInput"); inp.placeholder = "Reply to “" + shorten(r.text) + "”"; inp.focus();
  }
  function clearReply() { replyId = null; document.querySelectorAll(".margin-card.replying").forEach((c) => c.classList.remove("replying")); $("composerInput").placeholder = PH(); }
  function noteHistory(n) {
    if (replyId) { const r = n.responses.find((x) => x.id === replyId); if (r) return [{ who: "riddler", text: r.text }].concat(r.thread || []); }
    const h = [];
    n.responses.slice(-3).forEach((r) => { h.push({ who: "riddler", text: r.text }); (r.thread || []).forEach((m) => h.push(m)); });
    return h;
  }

  /* ---------------- the animated response flow ---------------- */
  let responding = false, lastBody = "", cooldown = 0;

  // margin cue: writing in the note is read, and a pause gets a reply
  function readingCue(on) {
    let c = $("readingCue");
    if (!on) { if (c) c.remove(); return; }
    const em = $("marginCol").querySelector(".margin-empty"); if (em) em.remove();
    if (!c) { c = document.createElement("div"); c.id = "readingCue"; c.className = "reading-cue"; c.innerHTML = '<svg class="quill"><use href="#i-quill"/></svg><span>Reading along. Pause and I\'ll reply here.</span>'; $("marginCol").appendChild(c); }
    clearTimeout(c._t); c._t = setTimeout(() => readingCue(false), 4000);
  }

  async function think(opts) {
    // queue behind the current answer instead of dropping the message
    if (responding && (opts.task || "margin") === "margin") return;
    while (responding) await wait(200);
    readingCue(false);
    const n = active();
    responding = true;
    const col = $("marginCol");
    const empty = col.querySelector(".margin-empty"); if (empty) empty.remove();

    if (opts.message) {
      // a long paste is a problem statement: it belongs in the note, the margin shows a preview
      const long = opts.message.length > 240;
      if (long) {
        const p = document.createElement("blockquote"); p.className = "pasted-problem"; p.textContent = opts.message;
        $("noteBody").appendChild(p); n.body = serializeBody(); save();
      }
      const you = document.createElement("div"); you.className = "margin-you enter";
      you.innerHTML = '<span class="you-label">You</span>' + (opts.image ? '<img class="you-img" alt="Your image" src="' + opts.image + '">' : "") + "<span>" + (opts.cmd ? '<b class="you-cmd">' + esc(opts.cmd) + "</b> · " : "") + esc(long ? opts.message.slice(0, 110).trim() + "…" : opts.message) + "</span>" + (long ? '<span class="you-note">Added to your note</span>' : "");
      col.appendChild(you);
    }

    const card = document.createElement("div"); card.className = "margin-card enter";
    card.style.setProperty("--ink-pen", inkVar(n.ink));
    card.innerHTML = '<span class="ink-dot is-fresh"></span><div class="body"><span class="status-line"><svg class="quill"><use href="#i-quill"/></svg><span class="dots">' + (opts.deep ? "Thinking deeper" : opts.task === "draw" ? "Sketching it" : opts.task === "margin" ? "Reading along" : "Thinking") + "</span></span></div>";
    const t0 = Date.now(), tick = setInterval(() => { const st = card.querySelector(".status-line"); if (!st) return clearInterval(tick); let el = st.querySelector(".secs"); if (!el) { el = document.createElement("span"); el.className = "secs"; st.appendChild(el); } const secs = Math.round((Date.now() - t0) / 1000), stages = opts.deep ? ["Reading your question", "Working through it", "Checking the reasoning", "Almost there"] : ["Reading your question", "Finding the key idea", "Writing it out"];
      if (!card.querySelector(".draft-text")) st.querySelector(".dots").textContent = stages[Math.min(stages.length - 1, Math.floor(secs / (opts.deep ? 5 : 2)))];
      el.textContent = secs >= 3 ? secs + "s" : ""; }, 1000);
    col.appendChild(card);

    const hist = noteHistory(n);
    let res, message = opts.message || "";
    if (opts.image) {
      try { const seen = await AI.see(opts.image); if (seen) message += "\n\n[Image they shared, read by vision: " + seen + "]"; }
      catch (e) { toast("Couldn't read the image. Answering from your words."); }
    }
    try {
      res = await AI.respond({ noteText: plainText(n.body), message, persona: personaName(n.persona), intent: opts.intent || (opts.task === "chat" ? "" : n.intent), task: opts.task || "margin", history: hist, deep: opts.deep }, (draft, useNow) => {
        // show the quick take now; the thought-through answer replaces it
        const st = card.querySelector(".status-line"); if (!st) return;
        let d = card.querySelector(".draft-text"); if (!d) { d = document.createElement("span"); d.className = "draft-text"; st.before(d); }
        d.textContent = draft.replace(/\*/g, ""); st.querySelector(".dots").textContent = "Double-checking";
        const b = document.createElement("button"); b.className = "follow-chip use-draft"; b.textContent = "Use this answer";
        b.onclick = (ev) => { ev.stopPropagation(); useNow(); }; st.after(b);
      });
    } catch (e) { res = AI.localMind({ noteText: plainText(n.body), message, intent: n.intent, task: opts.task, history: hist }); }

    if ((!n.title || n.title === "Untitled") && (res.title || (message && res.source === "live"))) {
      n.title = res.title || message.split(/\s+/).slice(0, 6).join(" ").replace(/[?.!,:;-]+$/, "");
      $("noteTitle").textContent = n.title; renderSidebar();
    }
    const r = { id: uid(), text: res.say, sketch: res.sketch, draw: res.draw, persona: personaName(n.persona), ink: n.ink, thread: [], revealed: true };
    if (opts.message) r.thread.push({ who: "you", text: opts.message });
    n.responses.push(r);
    n.updatedAt = Date.now();

    card.innerHTML = "";
    card.style.setProperty("--ink-pen", inkVar(n.ink));
    const dot = document.createElement("span"); dot.className = "ink-dot is-fresh";
    const body = document.createElement("div"); body.className = "body";
    const text = document.createElement("span"); body.appendChild(text);
    const meta = document.createElement("span"); meta.className = "meta"; meta.textContent = r.persona; body.appendChild(meta);
    const chip = document.createElement("button"); chip.className = "follow-chip";
    chip.innerHTML = 'Follow the thought <svg><use href="#i-arrow"/></svg>';
    chip.onclick = (ev) => { ev.stopPropagation(); replyTo(r.id); };
    body.appendChild(chip);
    const q = opts.message || message;
    if (q && !opts.deep) {
      const deeper = document.createElement("button"); deeper.className = "follow-chip deeper-chip"; deeper.title = "Slower, more careful answer"; deeper.innerHTML = "<span aria-hidden=\"true\">✦</span> Think deeper <span class=\"deeper-hint\">better answer</span>";
      deeper.onclick = (ev) => { ev.stopPropagation(); deeper.remove(); think({ task: opts.task === "margin" ? "chat" : opts.task, intent: opts.intent, message: q, cmd: "think deeper", deep: true }); };
      body.appendChild(deeper);
    }
    card.appendChild(dot); card.appendChild(body); card._rid = r.id;
    card.onclick = () => replyTo(r.id);
    await AI.revealWords(text, r.text).done;

    // code answers read like a lesson: explanation, then the picture, then the code
    if (res.code && res.explain) {
      const ex = document.createElement("div"); ex.className = "code-explain";
      ex.innerHTML = res.explain.split(/\n\s*\n/).map((p) => "<p>" + AI.inkHTML(p.trim()).replace(/\n/g, "<br>") + "</p>").join("");
      $("noteBody").appendChild(ex);
    }
    const lastSk = [...$("noteBody").querySelectorAll("[data-sketch]")].pop();
    if (res.draw && res.sketch && res.sketch !== "none" && !(lastSk && lastSk.dataset.sketch === res.sketch)) { await wait(250); insertSketch(res.sketch); }
    if (res.code) {
      const pre = document.createElement("pre"); pre.className = "code-block"; pre.setAttribute("contenteditable", "false");
      if (res.code.lang) pre.dataset.lang = res.code.lang;
      const code = document.createElement("code"); code.textContent = res.code.src; pre.appendChild(code);
      $("noteBody").appendChild(pre); n.body = serializeBody();
    }
    if (voiceOut) speak(shorten(r.text));
    responding = false;
    save(); renderSidebar();
  }

  function insertSketch(key) {
    const n = active();
    const div = document.createElement("div");
    div.className = "inline-sketch sketch";
    div.setAttribute("contenteditable", "false");
    div.dataset.sketch = key;
    $("noteBody").appendChild(div);
    mountSketch(div, key, { playNow: true });
    div._mounted = true;
    n.body = serializeBody();
  }

  function plainText(html) { const d = document.createElement("div"); d.innerHTML = html || ""; return d.textContent || ""; }
  function shorten(s) { const words = String(s).replace(/\*/g, "").split(/\s+/); return words.slice(0, 12).join(" "); }

  /* ---------------- threads ---------------- */
  let threadId = null;
  function openThread(rid) {
    threadId = rid;
    const n = active(); const r = n.responses.find((x) => x.id === rid); if (!r) return;
    $("drawerTitle").textContent = "Follow the thought";
    const body = $("drawerBody"); body.innerHTML = "";
    const seedMsg = document.createElement("div"); seedMsg.className = "drawer-msg riddler";
    seedMsg.innerHTML = '<span class="ink-dot" style="background:' + inkVar(r.ink) + '"></span><span>' + AI.inkHTML(r.text.replace(/\$+/g, "")) + "</span>";
    // a reply to a composer question: show the question first
    const th = r.thread || [], lead = th[0] && th[0].who === "you" ? 1 : 0;
    th.slice(0, lead).forEach((m) => body.appendChild(threadMsg(m)));
    body.appendChild(seedMsg);
    th.slice(lead).forEach((m) => body.appendChild(threadMsg(m)));
    showDrawer(true);
    setTimeout(() => $("drawerInput").focus(), 200);
  }
  function threadMsg(m) {
    const d = document.createElement("div");
    d.className = "drawer-msg " + (m.who === "you" ? "you" : "riddler");
    if (m.who === "you") d.textContent = m.text;
    else d.innerHTML = '<span class="ink-dot"></span><span>' + AI.inkHTML(m.text) + "</span>";
    return d;
  }
  async function sendThread() {
    const inp = $("drawerInput"); const msg = inp.value.trim(); if (!msg || !threadId) return;
    inp.value = "";
    const n = active(); const r = n.responses.find((x) => x.id === threadId); if (!r) return;
    r.thread.push({ who: "you", text: msg });
    $("drawerBody").appendChild(threadMsg({ who: "you", text: msg }));
    const pending = document.createElement("div"); pending.className = "drawer-msg riddler";
    pending.innerHTML = '<span class="ink-dot"></span><span class="status-line"><span class="dots">Thinking</span></span>';
    $("drawerBody").appendChild(pending); scrollDrawer();
    const hist = [{ who: "riddler", text: r.text }].concat(r.thread || []);
    let res;
    try { res = await AI.respond({ noteText: plainText(n.body), message: msg, persona: personaName(n.persona), intent: n.intent, task: "chat", history: hist }); }
    catch (e) { res = AI.localMind({ noteText: plainText(n.body), message: msg, intent: n.intent, task: "chat", history: hist }); }
    r.thread.push({ who: "riddler", text: res.say });
    pending.innerHTML = '<span class="ink-dot"></span><span class="ink-target"></span>';
    await AI.revealWords(pending.querySelector(".ink-target"), res.say).done;
    if (res.draw && res.sketch !== "none") { const sk = document.createElement("div"); sk.className = "drawer-sketch"; pending.appendChild(sk); mountSketch(sk, res.sketch, { playNow: true }); }
    scrollDrawer(); save();
  }
  function scrollDrawer() { const b = $("drawerBody"); b.scrollTop = b.scrollHeight; }
  function showDrawer(open) { $("drawerOverlay").classList.toggle("open", open); }

  /* ---------------- chat panel ---------------- */
  let chatHistory = [];
  function openChat() {
    threadId = null; chatHistory = [];
    $("drawerTitle").textContent = "Chat with Thinker";
    const body = $("drawerBody"); body.innerHTML = "";
    const hi = document.createElement("div"); hi.className = "drawer-msg riddler";
    hi.innerHTML = '<span class="ink-dot"></span><span>Ask me anything about this note. I won\'t hand you the answer — I\'ll help you find it, and draw it if that helps.</span>';
    body.appendChild(hi);
    showDrawer(true); setTimeout(() => $("drawerInput").focus(), 200);
  }
  async function sendChat() {
    const inp = $("drawerInput"); const msg = inp.value.trim(); if (!msg) return;
    inp.value = "";
    $("drawerBody").appendChild(threadMsg({ who: "you", text: msg }));
    chatHistory.push({ who: "you", text: msg });
    const pending = document.createElement("div"); pending.className = "drawer-msg riddler";
    pending.innerHTML = '<span class="ink-dot"></span><span class="status-line"><span class="dots">Thinking</span></span>';
    $("drawerBody").appendChild(pending); scrollDrawer();
    const n = active();
    let res;
    try { res = await AI.respond({ noteText: plainText(n.body), message: msg, persona: personaName(n.persona), intent: n.intent, task: "chat", history: chatHistory }); }
    catch (e) { res = AI.localMind({ noteText: plainText(n.body), message: msg, intent: n.intent, task: "chat", history: chatHistory }); }
    chatHistory.push({ who: "riddler", text: res.say });
    pending.innerHTML = '<span class="ink-dot"></span><span class="ink-target"></span>';
    await AI.revealWords(pending.querySelector(".ink-target"), res.say).done;
    if (res.draw && res.sketch !== "none") { const sk = document.createElement("div"); sk.className = "drawer-sketch"; pending.appendChild(sk); mountSketch(sk, res.sketch, { playNow: true }); }
    scrollDrawer();
  }

  /* ---------------- composer + commands ---------------- */
  const COMMANDS = [
    { cmd: "/draw", desc: "sketch it in ink", task: "draw" },
    { cmd: "/explain", desc: "explain by questioning", task: "explain" },
    { cmd: "/quiz", desc: "quiz me", task: "quiz" },
    { cmd: "/vent", desc: "just listen", task: "vent" },
    { cmd: "/challenge", desc: "poke holes", task: "chat", intent: "challenge" },
    { cmd: "/plan", desc: "help me plan", task: "chat", intent: "plan" },
  ];
  let cmdSel = 0;
  function renderCmdMenu(filter) {
    const menu = $("cmdMenu");
    const items = COMMANDS.filter((c) => c.cmd.startsWith(filter || "/"));
    if (!items.length) { menu.classList.remove("open"); return; }
    cmdSel = Math.min(cmdSel, items.length - 1);
    menu.innerHTML = "";
    items.forEach((c, i) => {
      const b = document.createElement("button");
      b.className = "cmd-item" + (i === cmdSel ? " sel" : "");
      b.innerHTML = '<span class="slash">' + esc(c.cmd) + "</span><span>" + esc(c.desc) + "</span>";
      b.onclick = () => runCommand(c);
      menu.appendChild(b);
    });
    menu.classList.add("open");
    menu._items = items;
  }
  function runCommand(c, arg) {
    $("cmdMenu").classList.remove("open");
    const n = active();
    // the command acts on what was typed after it, else the latest line, else a real title
    const lines = plainText(n.body).split(/\n+/).map((x) => x.trim()).filter(Boolean);
    const topic = (arg || "").trim() || lines[lines.length - 1] || (n.title && !/^untitled/i.test(n.title) ? n.title : "");
    if (!topic) { $("composerInput").value = c.cmd + " "; $("composerInput").focus(); toast("Add a topic after " + c.cmd + ", e.g. " + c.cmd + " photosynthesis"); return; }
    $("composerInput").value = "";
    if (c.intent) { n.intent = c.intent; }
    think({ task: c.task, message: topic, cmd: c.cmd, intent: c.intent });
  }
  /* ---------------- images: paste, drop or pick → vision ---------------- */
  let pendingImg = null;
  function attachImage(file) {
    if (!file || !/^image\//.test(file.type)) return;
    const img = new Image(), url = URL.createObjectURL(file);
    img.onload = () => {
      // downscale so the VL request stays small and fast
      const k = Math.min(1, 1024 / Math.max(img.width, img.height)), c = document.createElement("canvas");
      c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height); URL.revokeObjectURL(url);
      pendingImg = c.toDataURL("image/jpeg", 0.85);
      const chip = $("attachChip"); chip.querySelector("img").src = pendingImg; chip.hidden = false;
      $("composerInput").placeholder = "Ask about this image…"; $("composerInput").focus();
    };
    img.onerror = () => { URL.revokeObjectURL(url); toast("Couldn't read that image."); };
    img.src = url;
  }
  const PH = () => (window.innerWidth < 760 ? "Ask Thinker anything…" : "Ask Thinker anything…   ( / for commands )");
  function clearImage() { pendingImg = null; $("attachChip").hidden = true; $("composerInput").placeholder = PH(); }

  function composerSubmit() {
    const inp = $("composerInput"); let v = inp.value.trim();
    setTimeout(clearReply, 0);
    if (pendingImg) { const image = pendingImg; clearImage(); inp.value = ""; think({ task: "chat", message: v || "What do you make of this?", image }); return; }
    if (!v) return;
    if (v.startsWith("/")) {
      const c = COMMANDS.find((x) => x.cmd === v.split(" ")[0]);
      if (c) { runCommand(c, v.slice(c.cmd.length)); return; }
    }
    inp.value = ""; $("cmdMenu").classList.remove("open");
    think({ task: "chat", message: v });
  }

  /* ---------------- voice ---------------- */
  let recognition = null, listening = false;
  function initVoice() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (SR) {
      recognition = new SR();
      recognition.lang = "en-US"; recognition.interimResults = false; recognition.maxAlternatives = 1;
      recognition.onresult = (e) => { const t = e.results[0][0].transcript; $("composerInput").value = t; stopListening(); composerSubmit(); };
      recognition.onend = () => stopListening();
      recognition.onerror = () => { stopListening(); toast("Couldn't hear that — try typing."); };
    }
  }
  function toggleListening() {
    if (!recognition) { toast("Voice input isn't supported here — type instead."); return; }
    if (listening) { recognition.stop(); stopListening(); }
    else { try { recognition.start(); listening = true; $("micBtn").classList.add("listening"); toast("Listening…"); } catch (e) {} }
  }
  function stopListening() { listening = false; $("micBtn").classList.remove("listening"); }
  async function speak(text) {
    try { const url = await AI.tts(text); const a = new Audio(url); a.play(); } catch (e) { if ("speechSynthesis" in window) { const u = new SpeechSynthesisUtterance(text); u.rate = 1.02; speechSynthesis.speak(u); } }
  }

  /* ---------------- command palette ---------------- */
  let palSel = 0;
  function openPalette() { $("paletteOverlay").classList.add("open"); $("paletteInput").value = ""; renderPalette(""); setTimeout(() => $("paletteInput").focus(), 60); }
  function closePalette() { $("paletteOverlay").classList.remove("open"); }
  function renderPalette(q) {
    const res = $("paletteResults"); res.innerHTML = ""; palSel = 0;
    const ql = q.toLowerCase();
    let notes = db.notes.filter((n) => (n.title || "").toLowerCase().includes(ql)).sort((a, b) => b.updatedAt - a.updatedAt);
    notes.forEach((n, i) => {
      const d = document.createElement("div"); d.className = "palette-item" + (i === 0 ? " sel" : "");
      d.innerHTML = '<svg style="width:16px;height:16px;color:var(--faint)"><use href="#i-file"/></svg><span>' + esc(n.title || "Untitled") + '</span>' + (n.id === activeId ? '<span class="dot"></span>' : "") + '<span class="open-now">Open now</span>';
      d.onclick = () => { closePalette(); go("app"); openNote(n.id); };
      res.appendChild(d);
    });
    if (q.trim()) {
      const d = document.createElement("div"); d.className = "palette-item" + (!notes.length ? " sel" : "");
      d.innerHTML = '<svg style="width:16px;height:16px;color:var(--accent)"><use href="#i-plus"/></svg><span>Create “' + esc(q.trim()) + '”</span>';
      d.onclick = () => { createNote(q.trim()); closePalette(); };
      res.appendChild(d);
    }
    res._notes = notes;
  }
  function createNote(name) {
    let folder = "", title = name || "Untitled";
    if (name && name.includes("/")) { const parts = name.split("/"); folder = parts[0].trim(); title = parts.slice(1).join("/").trim() || "Untitled"; }
    const n = { id: uid(), title, folder, brief: "", mode: "with", persona: "thinker", ink: "ink", intent: "challenge", body: "", responses: [], updatedAt: Date.now() };
    db.notes.unshift(n); save(); go("app"); openNote(n.id); renderSidebar();
    setTimeout(() => $("noteBody").focus(), 100);
  }

  /* ---------------- modals ---------------- */
  function openModal(html) { $("modalBox").innerHTML = html; $("modalOverlay").classList.add("open"); }
  function closeModal() { $("modalOverlay").classList.remove("open"); }

  function openCustomize() {
    const n = active();
    const intents = [["challenge", "Talk me out of bad ideas"], ["plan", "I've decided. Help me plan"], ["vent", "Just let me vent"], ["brutal", "Be brutal"], ["quiz", "Quiz me"]];
    const inks = [["ink", "#2a2824"], ["blue", "#33689c"], ["green", "#47763d"], ["purple", "#774f9c"], ["orange", "#b5621f"]];
    openModal(
      '<button class="icon-btn close-x" data-close><svg><use href="#i-x"/></svg></button>' +
      "<h3>Make it yours.</h3><p class='sub'>Tell Thinker what this note is for, and pick the ink it writes in.</p>" +
      '<label class="field-label">What\'s this note for?</label><input class="text-input" id="czBrief" value="' + esc(n.brief) + '" placeholder="Quiz me before Friday…" />' +
      '<label class="field-label">How should Thinker be?</label><div class="intent-row" id="czIntent">' +
      intents.map(([k, l]) => '<button class="pill-tab' + (n.intent === k ? " active" : "") + '" data-intent="' + k + '">' + esc(l) + "</button>").join("") + "</div>" +
      '<label class="field-label">Ink</label><div class="ink-row" id="czInk">' +
      inks.map(([k, c]) => '<button class="ink-swatch" data-ink="' + k + '" aria-checked="' + (n.ink === k) + '" aria-label="' + k + '" style="background:' + c + '"></button>').join("") + "</div>" +
      '<label class="field-label">Voice</label><div class="intent-row"><button class="pill-tab' + (voiceOut ? " active" : "") + '" id="czVoice">' + (voiceOut ? "Speaks replies aloud" : "Read replies aloud") + "</button></div>" +
      '<div style="margin-top:26px;display:flex;gap:10px"><button class="btn" data-close>Done</button></div>'
    );
    $("czBrief").oninput = (e) => { n.brief = e.target.value; $("briefInput").value = n.brief; save(); };
    $("czIntent").querySelectorAll("[data-intent]").forEach((b) => (b.onclick = () => { n.intent = b.dataset.intent; $("czIntent").querySelectorAll(".pill-tab").forEach((x) => x.classList.remove("active")); b.classList.add("active"); save(); toast("Intent set."); }));
    $("czInk").querySelectorAll("[data-ink]").forEach((b) => (b.onclick = () => { n.ink = b.dataset.ink; setNoteInk(n.ink); $("czInk").querySelectorAll(".ink-swatch").forEach((x) => x.setAttribute("aria-checked", "false")); b.setAttribute("aria-checked", "true"); save(); }));
    $("czVoice").onclick = () => { voiceOut = !voiceOut; $("czVoice").classList.toggle("active", voiceOut); $("czVoice").textContent = voiceOut ? "Speaks replies aloud" : "Read replies aloud"; toast(voiceOut ? "Voice on." : "Voice off."); };
  }

  function openPersonas() {
    const n = active();
    openModal(
      '<button class="icon-btn close-x" data-close><svg><use href="#i-x"/></svg></button>' +
      '<div class="modal-kicker"><svg class="ink-blot" style="width:13px;height:13px"><use href="#i-blot"/></svg>Personas</div>' +
      "<h3>Bring in the expert.</h3><p class='sub'>Same sentence, different minds. Pick one for this note, or make your own.</p>" +
      '<div class="persona-list" id="personaList">' +
      db.personas.map((p, i) =>
        '<button class="persona-card' + (n.persona === p.id ? " selected" : "") + '" data-p="' + p.id + '" style="animation-delay:' + i * 55 + 'ms">' +
        '<span class="persona-avatar"><svg><use href="#i-blot"/></svg></span>' +
        '<span class="persona-text"><span class="persona-name">' + esc(p.name) + '</span><span class="persona-prompt">' + esc(p.prompt) + "</span></span>" +
        '<span class="persona-check"><svg><use href="#i-check"/></svg></span></button>'
      ).join("") + "</div>" +
      '<div class="modal-divider"></div>' +
      '<label class="field-label">Make a new persona</label><input class="text-input" id="npName" placeholder="Name — e.g. Skeptical co-founder" />' +
      '<textarea class="textarea" id="npPrompt" placeholder="How should it think? e.g. Always asks what could go wrong." style="margin-top:8px"></textarea>' +
      '<div style="margin-top:16px"><button class="btn" id="npAdd"><svg style="width:15px;height:15px"><use href="#i-plus"/></svg>Add persona</button></div>'
    );
    $("personaList").querySelectorAll("[data-p]").forEach((b) => (b.onclick = () => {
      n.persona = b.dataset.p; $("personaName").textContent = personaName(n.persona); save();
      $("personaList").querySelectorAll(".persona-card").forEach((x) => x.classList.remove("selected"));
      b.classList.add("selected");
      setTimeout(() => { closeModal(); toast(personaName(n.persona) + " is in."); }, 220);
    }));
    $("npAdd").onclick = () => {
      const name = $("npName").value.trim(); const prompt = $("npPrompt").value.trim();
      if (!name) { $("npName").focus(); toast("Give it a name."); return; }
      const p = { id: uid(), name, prompt: prompt || "A thoughtful reviewer." };
      db.personas.push(p); n.persona = p.id; $("personaName").textContent = name; save(); closeModal(); toast(name + " is in.");
    };
  }

  function openUpgrade() {
    openModal(
      '<button class="icon-btn close-x" data-close><svg><use href="#i-x"/></svg></button>' +
      "<h3>This one's yours.</h3><p class='sub'>Thinker runs on your own LFM3 backend — no meter, no account, no cloud bill. Unlimited notes and replies, local-first.</p>" +
      '<div style="display:flex;flex-direction:column;gap:10px;margin-top:8px">' +
      '<div class="cmd-item"><svg style="width:16px;height:16px;color:var(--ok)"><use href="#i-check"/></svg><span>Unlimited notes &amp; margin conversations</span></div>' +
      '<div class="cmd-item"><svg style="width:16px;height:16px;color:var(--ok)"><use href="#i-check"/></svg><span>Text, vision &amp; voice on your own backend</span></div>' +
      '<div class="cmd-item"><svg style="width:16px;height:16px;color:var(--ok)"><use href="#i-check"/></svg><span>Notes saved in your browser, export anytime</span></div>' +
      "</div><div style='margin-top:24px'><button class='btn' data-close>Keep writing</button></div>"
    );
  }

  function openShare() {
    const n = active();
    openModal(
      '<button class="icon-btn close-x" data-close><svg><use href="#i-x"/></svg></button>' +
      "<h3>Share this note.</h3><p class='sub'>Your words stay yours. Copy it as Markdown and paste it anywhere.</p>" +
      '<textarea class="textarea" id="shareText" style="min-height:160px;font-family:var(--mono);font-size:13px">' + esc(noteMarkdown(n)) + "</textarea>" +
      '<div style="margin-top:16px;display:flex;gap:10px"><button class="btn" id="shareCopy">Copy Markdown</button><button class="btn ghost" data-close>Close</button></div>'
    );
    $("shareCopy").onclick = () => { copyText($("shareText").value); toast("Copied to clipboard."); };
  }

  function confirmDelete() {
    const n = active();
    openModal(
      "<h3>Delete “" + esc(n.title || "Untitled") + "\"?</h3><p class='sub'>This removes the note and its margin conversations. You can undo right after.</p>" +
      '<div style="display:flex;gap:10px;margin-top:20px"><button class="btn" id="delYes" style="background:var(--danger)">Delete note</button><button class="btn ghost" data-close>Keep it</button></div>'
    );
    $("delYes").onclick = () => {
      const idx = db.notes.findIndex((x) => x.id === n.id);
      const removed = db.notes.splice(idx, 1)[0];
      if (!db.notes.length) db.notes.push({ id: uid(), title: "Untitled", folder: "", brief: "", mode: "with", persona: "thinker", ink: "ink", intent: "challenge", body: "", responses: [], updatedAt: Date.now() });
      activeId = db.notes[Math.max(0, idx - 1)].id;
      save(); closeModal(); openNote(activeId); renderSidebar();
      toast("Deleted. Undo?", () => { db.notes.splice(idx, 0, removed); save(); openNote(removed.id); renderSidebar(); });
    };
  }

  /* ---------------- export / copy ---------------- */
  function noteMarkdown(n) {
    let md = "# " + (n.title || "Untitled") + "\n\n";
    if (n.brief) md += "> " + n.brief + "\n\n";
    md += plainText(n.body).replace(/\n{3,}/g, "\n\n").trim() + "\n\n";
    if (n.responses.length) { md += "---\n\n## In the margin\n\n"; n.responses.forEach((r) => { md += "**" + (r.persona || "Thinker") + ":** " + r.text + "\n\n"; }); }
    return md;
  }
  function copyText(s) { if (navigator.clipboard) navigator.clipboard.writeText(s).catch(() => fallbackCopy(s)); else fallbackCopy(s); }
  function fallbackCopy(s) { const ta = document.createElement("textarea"); ta.value = s; document.body.appendChild(ta); ta.select(); try { document.execCommand("copy"); } catch (e) {} ta.remove(); }
  function exportNote() {
    // Save as PDF on light paper: sketches finished, margin kept beside the note.
    const theme = document.documentElement.dataset.theme;
    document.documentElement.dataset.theme = "light";
    document.querySelectorAll("#noteBody .sk-step").forEach((g) => g.classList.add("on"));
    document.querySelectorAll("#noteBody svg").forEach((v) => { const st = v.querySelectorAll(".sk-step"); st.forEach((g, i) => g.classList.toggle("cur", i === st.length - 1)); });
    const t = document.title; document.title = active().title || "Note";
    addEventListener("afterprint", () => { document.documentElement.dataset.theme = theme; document.title = t; }, { once: true });
    setTimeout(() => window.print(), 60);
  }


  /* ---------------- landing: alive, auto-playing scenes ---------------- */
  const SCENES = {
    building: { goal: "Ship login by Friday.", h2: "Signup flow", text: "save the user's password in the users table|then login just checks if it matches — I think?", say: "Hashed, right? Store only a fingerprint: at login, hash what they typed and compare the two. What actually gets stored?", persona: "Staff engineer", sketch: "flow", sketchTitle: "Sketching the flow…", sketchDone: "Signup → hash → verify." },
    leetcode: { goal: "Interview on Friday.", h2: "N-Queens", text: "place n queens so none attack each other, backtrack row by row.|I get the code but can't picture how the backtracking goes", say: "Go row by row: put a queen on the first safe square. When a row has no safe square left, take back the last queen and move it one square right. Here's n = 4, board by board.", persona: "Thinker", sketch: "nqueens", sketchTitle: "Sketching the search…", sketchDone: "" },
    studying: { goal: "Physics midterm Friday.", h2: "Inclined planes", text: "I have a hard time|visualizing how forces act on an object on an incline.", say: "Tilt your axes to the slope. Gravity splits: mg·sinθ pulls it down, the normal force holds it up. Which piece moves it?", persona: "Professor", sketch: "incline", sketchTitle: "Resolving the forces…", sketchDone: "Two components, one motion." },
  };
  const SCENE_ORDER = ["building", "leetcode", "studying", "anything"];
  let sceneKey = "building", sceneTimer, sceneGen = 0, sceneCycleT;

  function setupRows(s) {
    return '<div class="setup-row"><span class="seg"><svg class="ink-blot"><use href="#i-blot"/></svg>Thinker</span><span class="seg"><svg class="bulb"><use href="#i-bulb"/></svg>Thinks with you <svg class="chev"><use href="#i-chev"/></svg></span></div>' +
      '<div class="setup-row" style="margin-top:-4px"><span class="seg"><svg class="pen"><use href="#i-pen"/></svg>Tell Thinker <span class="brief-goal">' + esc(s.goal) + "</span></span></div>";
  }
  function marginReply(say, persona) {
    $("heroMargin").innerHTML = '<span class="ink-dot is-fresh"></span><div class="body"><span id="heroSay"></span><span class="hero-margin-meta">' + esc(persona) + " · in the margin</span></div>";
    AI.revealWords($("heroSay"), say, { speed: 36 });
  }

  function playScene(key) {
    sceneKey = key; sceneGen++; const gen = sceneGen; clearTimeout(sceneTimer);
    const stage = $("heroStage");
    stage.classList.toggle("scene-anything", key === "anything");
    if (key === "anything") { renderAnything(stage, gen); return; }
    const s = SCENES[key];
    stage.innerHTML = setupRows(s) +
      '<h3 class="note-h2">' + esc(s.h2) + "</h3>" +
      '<p class="note-text">' + esc(s.text.split("|")[0]) + ' <span class="pencil-underline">' + esc(s.text.split("|")[1]) + '</span><span class="ink-dot pu-dot"></span></p>' +
      '<div class="sketch-wrap"><div class="sketch-title">' + esc(s.sketchTitle) + '</div><div class="sketch" id="heroSketch"></div></div>';
    marginReply(s.say, s.persona);
    sceneTimer = setTimeout(() => {
      if (gen !== sceneGen) return;
      const sk = $("heroSketch"); if (sk) { mountSketch(sk, s.sketch, { playNow: true }); const t = stage.querySelector(".sketch-title"); if (t) t.textContent = s.sketchDone; }
    }, 800);
  }

  const ANY_CARDS = [
    { tag: "Sunday", cls: "diary", text: "I keep saying I'll journal every night, but I never do.", say: "What's the smallest version — one line before bed?" },
    { tag: "Thursday", cls: "sync", text: "Standup keeps slipping to 10:30 and eating the morning.", say: "Who's it blocking — and what would a fixed 9:15 change?" },
    { tag: "Groceries", cls: "grocery", text: "Same five meals on repeat. Getting bored of dinner.", say: "What's one new thing you'd actually cook twice?" },
    { tag: "Launch budget", cls: "budget", bars: [["Design", "$400", "100%", "var(--purple)"], ["Infra", "$120", "30%", "var(--blue)"], ["Ads", "$300", "75%", "var(--orange)"]], say: "Which line grows if launch slips a month?" },
  ];
  function renderAnything(stage, gen) {
    stage.innerHTML = '<div class="any-grid">' + ANY_CARDS.map((c, i) => {
      const body = c.bars
        ? '<div class="bars">' + c.bars.map(([l, v, w, col]) => '<div class="bar-row"><span class="bar-label">' + l + '</span><span class="bar-track"><span class="bar-fill" data-w="' + w + '" style="background:' + col + '"></span></span><span class="bar-val">' + v + "</span></div>").join("") + "</div>"
        : '<p class="any-text">' + esc(c.text) + "</p>";
      return '<div class="any-card ' + c.cls + '" style="--i:' + i + '"><div class="any-tag">' + esc(c.tag) + "</div>" + body + '<div class="any-say"><span class="ink-dot"></span><span>' + esc(c.say) + "</span></div></div>";
    }).join("") + "</div>";
    $("heroMargin").innerHTML = '<div class="hand-note">Not just code.<br>Anything you\'re<br>thinking through.<svg viewBox="0 0 60 40"><path d="M4 30 C 20 34, 40 30, 52 12 M44 12 l8 0 l0 8"/></svg></div>';
    setTimeout(() => { if (gen !== sceneGen) return; stage.querySelectorAll(".any-card").forEach((c) => c.classList.add("in")); stage.querySelectorAll(".bar-fill").forEach((b) => (b.style.width = b.dataset.w)); }, 120);
  }

  function selectScene(key) {
    $("heroTabs").querySelectorAll("[role=tab]").forEach((t) => t.setAttribute("aria-selected", t.dataset.scene === key ? "true" : "false"));
    playScene(key);
  }
  function startSceneCycle() {
    clearInterval(sceneCycleT);
    sceneCycleT = setInterval(() => {
      if ($("landing").classList.contains("hidden")) return;
      const i = (SCENE_ORDER.indexOf(sceneKey) + 1) % SCENE_ORDER.length;
      selectScene(SCENE_ORDER[i]);
    }, 9500);
  }

  const CUSTOM = {
    challenge: "With how many months of rent saved? Write the number down here.",
    plan: "What has to be true before you hand in your notice? Start there.",
    vent: "That's a big call. What's driving it — the app, or the job?",
    brutal: "Nothing here says who pays you in month two.",
  };
  function playCustom() {
    const intentEl = document.querySelector("#intentRow [aria-checked='true']");
    const inkEl = document.querySelector("#inkRow [aria-checked='true']");
    if (!intentEl || !inkEl) return;
    const intent = intentEl.dataset.intent;
    const ink = inkEl.dataset.ink;
    const colors = { ink: "var(--ink)", blue: "var(--blue)", green: "var(--green)", purple: "var(--purple)", orange: "var(--orange)" };
    const resp = $("customResponse"); $("landing").style.setProperty("--ink-pen", colors[ink]); resp.style.color = colors[ink];
    AI.revealWords($("customResponseText"), CUSTOM[intent], { speed: 38 });
  }

  /* ---------------- follow-the-thought tracer ---------------- */
  function drawThreadLine() {
    const demo = $("threadDemo"); if (!demo) return;
    const box = demo.getBoundingClientRect(), pt = (el, right) => { const r = el.getBoundingClientRect(); return [right ? r.right - box.left + 8 : r.left - box.left + 3.5, r.top - box.top + (right ? r.height * 0.6 : 13.5)]; };
    const pts = [pt(demo.querySelector(".td-start span"), true)];
    demo.querySelectorAll(".td-node .td-dot").forEach((d) => pts.push(pt(d)));
    const end = demo.querySelector(".td-end"); pts.push([end.getBoundingClientRect().left - box.left - 14, end.getBoundingClientRect().top - box.top + 12]);
    let d = "M" + pts[0][0] + " " + pts[0][1];
    for (let i = 1; i < pts.length; i++) {
      const [x1, y1] = pts[i - 1], [x2, y2] = pts[i], dy = y2 - y1, b1 = x1 > x2 ? 70 : -40, b2 = x2 > x1 ? 10 : -40;
      d += " C" + (x1 + b1) + " " + (y1 + dy * 0.45) + " " + (x2 + b2) + " " + (y2 - dy * 0.45) + " " + x2 + " " + y2;
    }
    demo.querySelector(".td-line path").setAttribute("d", d);
  }

  const WHISPERS = ["Write something. I'm reading.", "Every question opens a door.", "Some ideas need a picture.", "Loud or quiet. Your call, note by note.", "Four minds, one sentence.", "Your ink, your rules.", "I won't. But I'll make you think.", "Start anywhere."];
  let whisperT;
  function whisper(text) {
    const t = $("idleText"); if (!t || t.dataset.full === text) return;
    t.dataset.full = text; clearInterval(whisperT); let i = 0; t.textContent = "";
    whisperT = setInterval(() => { t.textContent = text.slice(0, ++i); if (i >= text.length) clearInterval(whisperT); }, 45);
  }

  /* ---------------- reveals + idle ---------------- */
  function initReveals() {
    const io = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); } }), { threshold: 0.15 });
    document.querySelectorAll(".reveal").forEach((el) => io.observe(el));
    window.addEventListener("scroll", () => { const nv = $("siteNav"); if (nv) nv.classList.toggle("scrolled", window.scrollY > 20); }, { passive: true });
    const secs = [...document.querySelectorAll(".landing-main > section")];
    const wio = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) whisper(WHISPERS[secs.indexOf(e.target)] || WHISPERS[WHISPERS.length - 1]); }), { rootMargin: "-45% 0px -45% 0px" });
    secs.forEach((s) => wio.observe(s));
    drawThreadLine(); window.addEventListener("resize", drawThreadLine);
    if (document.fonts) document.fonts.ready.then(drawThreadLine);
    setTimeout(() => { const h = $("heroHand"); if (h) h.classList.add("play"); }, 400);
  }

  /* ---------------- wiring ---------------- */
  function wire() {
    document.querySelectorAll("[data-go]").forEach((el) => el.addEventListener("click", (e) => { e.preventDefault(); go(el.dataset.go); }));
    $("themeToggle").onclick = toggleTheme;
    $("appThemeToggle").onclick = toggleTheme;
    const nf = $("navFeedback"); if (nf) nf.onclick = (e) => { e.preventDefault(); toast("Something off? Tell us — this is your build."); };
    const ff = $("footFeedback"); if (ff) ff.onclick = (e) => { e.preventDefault(); toast("Feedback: it's your notebook, shape it."); };
    const fp = $("footPrivacy"); if (fp) fp.onclick = (e) => { e.preventDefault(); toast("Local-first: notes live in your browser."); };

    // landing demo
    $("heroTabs").querySelectorAll("[role=tab]").forEach((t) => (t.onclick = () => { selectScene(t.dataset.scene); startSceneCycle(); }));
    $("intentRow").querySelectorAll("[role=radio]").forEach((b) => (b.onclick = () => { $("intentRow").querySelectorAll("[role=radio]").forEach((x) => x.setAttribute("aria-checked", "false")); b.setAttribute("aria-checked", "true"); playCustom(); }));
    $("inkRow").querySelectorAll("[role=radio]").forEach((b) => (b.onclick = () => { $("inkRow").querySelectorAll("[role=radio]").forEach((x) => x.setAttribute("aria-checked", "false")); b.setAttribute("aria-checked", "true"); playCustom(); }));

    // sidebar
    $("sidebarToggle").onclick = () => $("sidebar").classList.toggle("collapsed");
    // phones: sidebar starts closed, closes when the view turns narrow, and on any tap outside it
    const narrow = matchMedia("(max-width: 760px)");
    narrow.addEventListener("change", (e) => { if (e.matches) $("sidebar").classList.add("collapsed"); });
    $("editorScroll").addEventListener("pointerdown", () => { if (narrow.matches) $("sidebar").classList.add("collapsed"); });
    $("newNote").onclick = () => createNote("");
    $("newFolder").onclick = () => {
      const f = $("newFolder"); if (f.querySelector("input")) return;
      f.innerHTML = '<svg style="width:16px;height:16px"><use href="#i-folder"/></svg><input class="folder-input" placeholder="Folder name, then Enter" />';
      const inp = f.querySelector("input"), done = () => { f.innerHTML = '<svg style="width:16px;height:16px"><use href="#i-folder"/></svg>New folder'; };
      inp.focus();
      inp.onkeydown = (e) => { if (e.key === "Enter" && inp.value.trim()) { const v = inp.value.trim(); done(); createNote(v + " / Untitled"); } else if (e.key === "Escape") done(); };
      inp.onblur = () => setTimeout(done, 100);
    };
    $("openPalette").onclick = openPalette;
    $("actCopy").onclick = () => { copyText(plainText(active().body)); toast("Note copied."); };
    $("actExport").onclick = exportNote;
    $("actJustWords").onclick = () => { justWords = !justWords; document.querySelectorAll(".inline-sketch").forEach((s) => (s.style.display = justWords ? "none" : "")); renderMargin(true); toast(justWords ? "Just your words." : "Margin restored."); };
    $("actCustomize").onclick = openCustomize;
    $("actPersonas").onclick = openPersonas;
    $("actDelete").onclick = confirmDelete;

    // setup row
    $("personaBtn").onclick = openPersonas;
    $("briefBtn").onclick = () => $("briefInput").focus();
    $("briefInput").oninput = (e) => { active().brief = e.target.value; save(); };
    $("modeBtn").onclick = () => { const n = active(); n.mode = n.mode === "with" ? "ask" : "with"; $("modeName").textContent = n.mode === "with" ? "Thinks with you" : "When you ask"; $("modeBtn").querySelector(".bulb").style.color = n.mode === "with" ? "var(--accent)" : "var(--faint)"; save(); renderMargin(true); toast(n.mode === "with" ? "Thinker reads along." : "Quiet until you ask."); };
    $("shareBtn").onclick = openShare;
    $("chatBtn").onclick = () => { clearReply(); $("composerInput").focus(); };

    // editor input
    $("noteTitle").oninput = () => { active().title = $("noteTitle").textContent; active().updatedAt = Date.now(); save(); renderSidebar(); };
    let bodyT;
    $("noteBody").oninput = () => {
      const n = active(); n.body = serializeBody(); n.updatedAt = Date.now(); save();
      clearTimeout(bodyT);
      if (n.mode === "with" && !responding) readingCue(true);
      if (n.mode === "with") {
        bodyT = setTimeout(() => {
          const txt = plainText(n.body);
          if (txt.length > 20 && txt !== lastBody && Date.now() > cooldown && !responding) {
            const added = txt.length - lastBody.length;
            if (added > 12 || /[?.!]$/.test(txt.trim())) { lastBody = txt; cooldown = Date.now() + 6000; think({ task: "margin" }); }
          }
        }, 1500);
      }
    };

    // composer
    $("sendBtn").onclick = composerSubmit;
    const coach = $("composerCoach"), cd = $("coachDismiss");
    try { if (localStorage.getItem("thinker.coach") === "1" && coach) coach.classList.add("gone"); } catch (e) {}
    if (cd) cd.onclick = () => { if (coach) coach.classList.add("gone"); try { localStorage.setItem("thinker.coach", "1"); } catch (e) {} };
    $("composerInput").addEventListener("keydown", (e) => {
      const menu = $("cmdMenu");
      if (menu.classList.contains("open")) {
        if (e.key === "ArrowDown") { e.preventDefault(); cmdSel = Math.min(cmdSel + 1, (menu._items || []).length - 1); renderCmdMenu($("composerInput").value.split(" ")[0]); return; }
        if (e.key === "ArrowUp") { e.preventDefault(); cmdSel = Math.max(cmdSel - 1, 0); renderCmdMenu($("composerInput").value.split(" ")[0]); return; }
        if (e.key === "Enter") { e.preventDefault(); const v = $("composerInput").value.trim(), c = (menu._items || [])[cmdSel]; if (/\s/.test(v)) { menu.classList.remove("open"); composerSubmit(); } else if (c) runCommand(c); return; }
        if (e.key === "Escape") { menu.classList.remove("open"); return; }
      }
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); composerSubmit(); }
    });
    $("composerInput").addEventListener("input", (e) => { const v = e.target.value; if (v.startsWith("/")) renderCmdMenu(v.split(" ")[0]); else $("cmdMenu").classList.remove("open"); });
    $("micBtn").onclick = toggleListening;
    $("attachBtn").onclick = () => $("attachInput").click();
    $("attachInput").onchange = (e) => { attachImage(e.target.files[0]); e.target.value = ""; };
    $("attachChip").querySelector("button").onclick = clearImage;
    document.addEventListener("paste", (e) => {
      if (!$("app").classList.contains("active")) return;
      const f = [...(e.clipboardData || {}).files || []].find((x) => /^image\//.test(x.type));
      if (f) { e.preventDefault(); attachImage(f); }
    });
    $("editorScroll").addEventListener("dragover", (e) => { if ([...e.dataTransfer.types].includes("Files")) e.preventDefault(); });
    $("editorScroll").addEventListener("drop", (e) => { const f = [...e.dataTransfer.files].find((x) => /^image\//.test(x.type)); if (f) { e.preventDefault(); attachImage(f); } });

    // palette
    $("paletteInput").addEventListener("input", (e) => renderPalette(e.target.value));
    $("paletteInput").addEventListener("keydown", (e) => {
      const items = [...$("paletteResults").children];
      if (e.key === "ArrowDown") { e.preventDefault(); palSel = Math.min(palSel + 1, items.length - 1); items.forEach((x, i) => x.classList.toggle("sel", i === palSel)); }
      else if (e.key === "ArrowUp") { e.preventDefault(); palSel = Math.max(palSel - 1, 0); items.forEach((x, i) => x.classList.toggle("sel", i === palSel)); }
      else if (e.key === "Enter") { e.preventDefault(); const sel = items[palSel]; if (sel) sel.click(); }
      else if (e.key === "Escape") closePalette();
      else if ((e.metaKey || e.ctrlKey) && e.key === "Backspace") { const n = ($("paletteResults")._notes || [])[palSel]; if (n) { db.notes = db.notes.filter((x) => x.id !== n.id); if (activeId === n.id) activeId = (db.notes[0] || {}).id; save(); renderPalette($("paletteInput").value); renderSidebar(); toast("Note deleted."); } }
    });

    // drawer
    $("drawerClose").onclick = () => showDrawer(false);
    $("drawerSend").onclick = () => (threadId ? sendThread() : sendChat());
    $("drawerInput").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); threadId ? sendThread() : sendChat(); } });

    // overlays close
    $("paletteOverlay").addEventListener("click", (e) => { if (e.target === $("paletteOverlay")) closePalette(); });
    $("modalOverlay").addEventListener("click", (e) => { if (e.target === $("modalOverlay")) closeModal(); });
    $("drawerOverlay").addEventListener("click", (e) => { if (e.target === $("drawerOverlay")) showDrawer(false); });
    $("modalBox").addEventListener("click", (e) => { if (e.target.closest("[data-close]")) closeModal(); });

    // global keys
    document.addEventListener("keydown", (e) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "k") { e.preventDefault(); $("app").classList.contains("active") ? openPalette() : (go("app"), openPalette()); }
      else if (mod && e.key === ",") { e.preventDefault(); if ($("app").classList.contains("active")) openCustomize(); }
      else if (mod && e.shiftKey && e.key.toLowerCase() === "c") { e.preventDefault(); copyText(plainText(active().body)); toast("Note copied."); }
      else if (mod && e.shiftKey && e.key.toLowerCase() === "e") { e.preventDefault(); exportNote(); }
      else if (e.key === "Escape") { closeModal(); closePalette(); showDrawer(false); clearReply(); $("cmdMenu").classList.remove("open"); }
      else if (e.altKey && e.code === "Space" && $("app").classList.contains("active")) { e.preventDefault(); toggleListening(); }
    });
  }

  /* ---------------- boot ---------------- */
  function boot() {
    applyTheme(); wire(); initVoice(); initReveals(); $("composerInput").placeholder = PH();
    renderSidebar();
    selectScene("building"); playCustom();
    mountSketch($("landingSketch"), "recursion");
    startSceneCycle();
    go(/^\/chat\/?$/.test(location.pathname) ? "app" : "landing", true);
    addEventListener("popstate", () => go(/^\/chat\/?$/.test(location.pathname) ? "app" : "landing", true));
    refreshConn();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();
})();