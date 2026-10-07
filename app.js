/* ============================================================
   Harriet's Ironman Journey — UI logic
   Cloud sync (Supabase) · PIN-gated editing · iPhone-first UI:
   tab bar, bottom sheets, iOS-Calendar month view, swipe nav.
   Built by her best friend, Ali.
   ============================================================ */
(function () {
  "use strict";

  // ---------- config ----------
  const SB_URL = "https://notibogaoeqakmeyxhar.supabase.co";
  const SB_KEY = "sb_publishable_PzxYn1w0zQwHku16EPtTXQ_GGan7WEL";
  const ATHLETE_ID = "harriet";
  const EDIT_PIN = "6569";            // PIN to unlock editing.
  const LOCAL_KEY = "htp_v2";

  const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];
  const MON_ABBR = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const DOW = ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"];
  const DOW_FULL = ["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday"];
  const ICONS = { run: "🏃‍♀️", bike: "🚴‍♀️", swim: "🏊‍♀️", strength: "💪", mobility: "🧘‍♀️", rest: "🌙", race: "🏁" };
  const CHECK_SVG = '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
  const CHEV_SVG = '<svg class="chev" viewBox="0 0 8 14"><path d="M1 1l6 6-6 6"/></svg>';
  const $ = id => document.getElementById(id);

  // ---------- state ----------
  function normalize(d) { d = d || {}; return { done: d.done || {}, notes: d.notes || {}, overrides: d.overrides || {}, imported: d.imported || {}, reviews: d.reviews || {} }; }
  function loadLocal() { try { return normalize(JSON.parse(localStorage.getItem(LOCAL_KEY))); } catch (e) { return normalize(); } }
  function saveLocal() { try { localStorage.setItem(LOCAL_KEY, JSON.stringify(state)); } catch (e) { /* private mode */ } }
  let state = loadLocal();
  const today = TP.iso(new Date());
  const anchorDay = today < TP.PLAN_START ? TP.PLAN_START : today;
  let view = new Date(TP.parse(anchorDay).getFullYear(), TP.parse(anchorDay).getMonth(), 1);
  let selIso = anchorDay;                 // day highlighted in the Plan month view
  let calMode = "month";                  // "month" | "list"
  let currentIso = null, focusRace = false;

  // ---------- Supabase sync ----------
  let sb = null;
  function setSync(s, label) {
    const pill = $("syncPill");
    pill.className = "sync-pill " + s;
    $("syncText").textContent = label || ({ live: "Synced", saving: "Saving…", offline: "Offline" }[s] || s);
  }
  let saveTimer = null;
  // Guards against our own realtime echo clobbering newer local edits: a write
  // started before you finished typing would otherwise come back and overwrite
  // whatever you typed in the meantime.
  let lastSentJson = null, lastEditAt = 0;
  const ECHO_QUIET_MS = 3000;

  function persist() {
    saveLocal();
    lastEditAt = Date.now();
    if (!sb) return;
    setSync("saving");
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      const snapshot = JSON.stringify(state);
      try {
        const { error } = await sb.from("athlete_state").upsert({ id: ATHLETE_ID, data: state, updated_at: new Date().toISOString() });
        if (!error) lastSentJson = snapshot;
        setSync(error ? "offline" : "live");
      } catch (e) { setSync("offline"); }
    }, 500);
  }
  async function cloudInit() {
    if (!window.supabase) { setSync("offline", "On device"); return; }
    try {
      sb = window.supabase.createClient(SB_URL, SB_KEY);
      const { data, error } = await sb.from("athlete_state").select("data").eq("id", ATHLETE_ID).single();
      if (!error && data && data.data) { state = normalize(data.data); saveLocal(); rerenderAll(); }
      setSync(error ? "offline" : "live");
      sb.channel("athlete").on("postgres_changes",
        { event: "*", schema: "public", table: "athlete_state", filter: "id=eq." + ATHLETE_ID },
        payload => {
          if (!payload.new || !payload.new.data) return;
          const incoming = JSON.stringify(payload.new.data);
          if (incoming === lastSentJson) return;                     // our own write coming back
          if (Date.now() - lastEditAt < ECHO_QUIET_MS) return;       // mid-edit — don't stomp it
          state = normalize(payload.new.data); saveLocal(); rerenderAll();
        }
      ).subscribe();
    } catch (e) { setSync("offline"); }
  }
  function rerenderAll() {
    renderToday(); renderReview(); renderUpNext(); recomputeStats(); renderPlan();
    if (drawer.classList.contains("open") && currentIso) openDrawer(currentIso, { keepScroll: true });
  }

  // ---------- activity sync: Garmin → intervals.icu → here ----------
  // Garmin's own API is business-only, so we read from intervals.icu, which
  // syncs from Garmin automatically. The API key stays in the edge function —
  // it grants full access to the intervals.icu account, so it never ships here.
  const ICU_SYNC_ENABLED = true;
  const ICU_FN = SB_URL + "/functions/v1/icu-sync";

  // intervals.icu activity type → our session type. Unlisted types are ignored.
  const ICU_TYPES = {
    Run: "run", TrailRun: "run", VirtualRun: "run", Treadmill: "run",
    Ride: "bike", VirtualRide: "bike", GravelRide: "bike", MountainBikeRide: "bike", EBikeRide: "bike",
    Swim: "swim", OpenWaterSwim: "swim",
    WeightTraining: "strength", Crossfit: "strength", Workout: "strength",
    Yoga: "mobility", Walk: "mobility", Hike: "mobility", Elliptical: "mobility"
  };

  async function icuCall(action, extra) {
    const res = await fetch(ICU_FN, {
      method: "POST",
      // The publishable key goes on `apikey` ONLY. It is not a JWT, so sending it
      // as `Authorization: Bearer` makes the platform try to parse it as one and
      // reject the call with 401 before the function runs.
      headers: { "Content-Type": "application/json", "apikey": SB_KEY },
      body: JSON.stringify(Object.assign({ action: action }, extra || {}))
    });
    return res.json();
  }

  function setSyncBtn(state_, ok) {
    const b = $("icuBtn"); if (!b) return;
    b.classList.toggle("spin", state_ === "busy");
    b.classList.toggle("connected", !!ok);
  }

  // Match one activity to a planned session on the same day, and tick it.
  function applyActivity(a) {
    const type = ICU_TYPES[a.type];
    if (!type) return false;
    const iso = String(a.start_local || "").slice(0, 10);
    if (!iso) return false;
    const tag = "icu:" + a.id;
    if (state.imported[tag]) return false;            // already counted

    const sessions = sessionsOfDay(iso);
    for (let i = 0; i < sessions.length; i++) {
      if (sessions[i].type !== type) continue;
      const key = keyFor(iso, i);
      if (state.done[key]) continue;                   // already ticked by hand
      state.done[key] = true;
      state.imported[tag] = key;
      return true;
    }
    return false;
  }

  async function syncActivities(opts) {
    const quiet = opts && opts.quiet;
    try {
      if (!quiet) setSyncBtn("busy", true);
      const r = await icuCall("sync", {});
      if (r.error) { setSyncBtn("idle", false); if (!quiet) toast("Sync failed — " + r.error); return; }
      let n = 0;
      (r.activities || []).forEach(a => { if (applyActivity(a)) n++; });
      if (n) { persist(); rerenderAll(); }
      setSyncBtn("idle", true);
      if (!quiet || n) toast(n ? "✓ " + n + " workout" + (n > 1 ? "s" : "") + " synced from Garmin" : "✓ All up to date");
    } catch (e) {
      setSyncBtn("idle", false);
      if (!quiet) toast("Couldn't reach the sync service");
    }
  }

  // ---------- toast ----------
  let toastTimer = null;
  function toast(msg) {
    const t = $("toast"); t.textContent = msg; t.classList.add("show");
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove("show"), 2400);
  }

  // ---------- helpers ----------
  function meta(type) { return TP.TYPE_META[type] || { label: type, color: "#888" }; }
  function col(type) { return TP.TYPE_META[type] ? "var(--c-" + type + ")" : "#888"; }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
  function dayOf(iso) {
    const base = TP.getDay(iso);
    if (state.overrides && state.overrides[iso]) return Object.assign({}, base, { sessions: state.overrides[iso], swapped: true });
    return base;
  }
  function sessionsOfDay(iso) { return dayOf(iso).sessions; }
  function keyFor(iso, idx) { return iso + ":" + idx; }
  function allDone(iso) {
    const s = sessionsOfDay(iso), real = s.filter(x => x.type !== "rest");
    if (!real.length) return false;
    return s.every((x, i) => x.type === "rest" || state.done[keyFor(iso, i)]);
  }
  function isMissed(iso) {
    if (iso >= today || iso < TP.PLAN_START) return false;
    const real = sessionsOfDay(iso).filter(x => x.type !== "rest");
    if (!real.length) return false;
    return !allDone(iso);
  }
  function mondayOf(iso) { return TP.addDays(iso, -TP.weekdayMon0(iso)); }
  // drop the "Run — " prefix, unless what's left only makes sense with it ("Bike — easy")
  function shortTitle(t) {
    const full = t.replace(/^🏁 /, ""), cut = full.replace(/^Run — |^Swim — |^Bike — /, "");
    return /^[a-z]/.test(cut) ? full : cut;
  }
  function prettyDate(iso, withYear) {
    const d = TP.parse(iso);
    return d.getDate() + " " + MONTHS[d.getMonth()] + (withYear ? " " + d.getFullYear() : "");
  }
  // ---------- shared UI components ----------
  // Meta pills: "≈ 1,750 m · 25 m pool" → one tinted pill per fact. Used for every
  // secondary detail line on the site so nothing is left as faint grey text.
  function pills(text, acc, extra) {
    const parts = (Array.isArray(text) ? text : String(text || "").split(/\s+·\s+|,\s+/)).filter(Boolean);
    const all = parts.map(p => '<span class="pill">' + esc(p) + '</span>').concat(extra || []);
    if (!all.length) return "";
    return '<span class="pills"' + (acc ? ' style="--acc:' + acc + '"' : '') + '>' + all.join("") + '</span>';
  }
  // Workout steps: label pill (Warm-up, Main…) over readable body text.
  function steps(blocks, acc) {
    return '<div class="steps" style="--acc:' + acc + '">' + blocks.map(b =>
      '<div class="step"><span class="step-l">' + esc(b.label) + '</span><div class="step-t">' + esc(b.text) + '</div></div>').join("") + '</div>';
  }

  function relDay(iso) {
    const n = TP.daysBetween(today, iso);
    if (n === 0) return "Today";
    if (n === 1) return "Tomorrow";
    if (n === -1) return "Yesterday";
    return DOW[TP.weekdayMon0(iso)];
  }

  function toggleDone(iso, idx, val) {
    state.done[keyFor(iso, idx)] = val;
    if (!val) delete state.done[keyFor(iso, idx)];
    persist();
  }
  // one place for every "tick a session" tap, so all views stay in step
  function tick(iso, idx) {
    if (!ensureEdit(() => tick(iso, idx))) return false;
    const val = !state.done[keyFor(iso, idx)];
    toggleDone(iso, idx, val);
    if (val && allDone(iso)) toast(iso === today ? "Day complete — proud of you 💪" : "Day complete ✓");
    rerenderAll();
    return true;
  }

  // ---------- TODAY view ----------
  // everything counts down to one day: the Ironman 70.3
  function nextRaceInfo() {
    return TP.RACE_703 >= today ? { iso: TP.RACE_703, name: "Ironman 70.3", from: TP.PLAN_START } : null;
  }

  function renderHero() {
    const day = dayOf(today), dt = TP.parse(today), h = new Date().getHours();
    $("greeting").textContent = (h < 12 ? "Morning" : h < 18 ? "Afternoon" : "Evening") + ", Harriet";
    $("heroDate").textContent = day.dayName + " " + dt.getDate() + " " + MONTHS[dt.getMonth()];
    $("heroPhase").textContent = day.phase.label;
    $("heroDay").textContent = day.weekNum ? "Week " + day.weekNum : "";

    // tint the hero to the day's dominant discipline
    const real = sessionsOfDay(today).filter(s => s.type !== "rest");
    $("hero").setAttribute("data-lead", real.length ? real[0].type : "rest");

    const r = nextRaceInfo(), ring = $("hcFill"), C = 2 * Math.PI * 52;
    ring.style.strokeDasharray = C;
    if (r) {
      const left = TP.daysBetween(today, r.iso);
      const span = Math.max(1, TP.daysBetween(r.from, r.iso));
      const gone = Math.min(1, Math.max(0, TP.daysBetween(r.from, today) / span));
      $("heroCountdown").textContent = left;
      $("heroCountLabel").textContent = left === 0 ? "Race day — " + r.name + "!" : "to " + r.name;
      $("heroCountSub").textContent = Math.round(gone * 100) + "% of the journey done · " + prettyDate(r.iso, true);
      ring.style.strokeDashoffset = C * (1 - gone);
    } else {
      $("heroCountdown").textContent = "🎉";
      $("heroCountLabel").textContent = "Season complete";
      $("heroCountSub").textContent = "What a year.";
      ring.style.strokeDashoffset = 0;
    }
  }

  function renderTodaySessions() {
    const wrap = $("todaySessions");
    const sessions = sessionsOfDay(today);
    const real = sessions.filter(s => s.type !== "rest");
    const doneCount = sessions.filter((s, i) => s.type !== "rest" && state.done[keyFor(today, i)]).length;
    $("todayMeta").textContent = real.length ? doneCount + " of " + real.length + " done" : "";

    if (!sessions.length) {
      wrap.innerHTML = '<article class="tcard card t-rest" style="--acc:var(--c-rest)"><div class="tc-top"><div class="tc-badge">🌙</div>' +
        '<div class="tc-meta"><div class="tc-type">Off plan</div><h3>Nothing scheduled</h3>' +
        pills(["Plan runs 27 Jul 2026 → 9 May 2027"], col("rest")) + '</div></div></article>';
      return;
    }

    wrap.innerHTML = sessions.map((s, idx) => {
      const isRest = s.type === "rest", done = !!state.done[keyFor(today, idx)];
      const blocks = (s.blocks || []).length ? steps(s.blocks.slice(0, 3), col(s.type)) : "";
      return '<article class="tcard card' + (done ? " done" : "") + (isRest ? " t-rest" : "") + '" style="--acc:' + col(s.type) + '">' +
        '<div class="tc-top">' +
          '<div class="tc-badge">' + (ICONS[s.type] || "•") + '</div>' +
          '<div class="tc-meta">' +
            '<div class="tc-type">' + meta(s.type).label + '</div>' +
            '<h3>' + esc(s.title) + '</h3>' +
            pills(s.sub, col(s.type)) +
          '</div>' +
        '</div>' +
        blocks +
        '<div class="tc-actions">' +
          (isRest ? '' : '<button class="tcard-btn tc-tick' + (done ? " on" : "") + '" data-idx="' + idx + '">' +
            (done ? '<svg class="ck" viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>Done' : 'Mark as done') + '</button>') +
          '<button class="tcard-btn tc-more">' + (isRest ? "See the plan for today" : "Workout") + '</button>' +
        '</div>' +
      '</article>';
    }).join("");

    wrap.querySelectorAll(".tc-tick").forEach(b => b.addEventListener("click", () => {
      if (tick(today, Number(b.getAttribute("data-idx")))) {
        const nb = wrap.querySelector('.tc-tick[data-idx="' + b.getAttribute("data-idx") + '"]');
        if (nb) nb.classList.add("pop");
      }
    }));
    wrap.querySelectorAll(".tc-more").forEach(b => b.addEventListener("click", () => openDrawer(today)));
  }

  function renderRhythm() {
    const el = $("rhythm");
    const monday = mondayOf(anchorDay);
    let done = 0, total = 0, html = "";
    for (let i = 0; i < 7; i++) {
      const d = TP.addDays(monday, i), dt = TP.parse(d);
      const ss = sessionsOfDay(d), real = ss.filter(x => x.type !== "rest");
      const dn = ss.filter((x, j) => x.type !== "rest" && state.done[keyFor(d, j)]).length;
      done += dn; total += real.length;
      const st = !real.length ? "rest" : (dn === real.length ? "done" : (d < today ? "missed" : "todo"));
      const dots = real.length
        ? real.slice(0, 3).map(x => '<i style="background:' + col(x.type) + '"></i>').join("")
        : '<i class="rest-dot"></i>';
      html += '<button class="rh-day ' + st + (d === today ? " is-today" : "") + '" data-iso="' + d + '" aria-label="' + DOW_FULL[i] + " " + dt.getDate() + '">' +
        '<span class="rh-dow">' + DOW[i][0] + '</span>' +
        '<span class="rh-num">' + dt.getDate() + '</span>' +
        '<span class="rh-dots">' + dots + '</span>' +
      '</button>';
    }
    el.innerHTML = html;
    el.querySelectorAll(".rh-day").forEach(b => b.addEventListener("click", () => openDrawer(b.getAttribute("data-iso"))));
    $("rhythmLabel").textContent = total ? done + " / " + total + " sessions" : "";
  }

  function renderToday() { renderHero(); renderTodaySessions(); renderRhythm(); }

  // ---------- week review ----------
  // Completion is only half the story: this also names what was missed and gives
  // her somewhere to say why, which is the bit that's actually useful later.
  const RV_REASONS = ["Too tired", "Illness", "No time", "Work", "Travel", "Weather", "Injury niggle", "Chose to rest"];
  let rvMonday = null;   // Monday of the week being reviewed

  function weekSessions(monday) {
    const out = [];
    for (let i = 0; i < 7; i++) {
      const d = TP.addDays(monday, i);
      sessionsOfDay(d).forEach((s, idx) => {
        if (s.type === "rest") return;
        const done = !!state.done[keyFor(d, idx)];
        out.push({ iso: d, idx: idx, s: s, status: done ? "done" : (d < today ? "missed" : "upcoming") });
      });
    }
    return out;
  }

  function rvRangeLabel(monday) {
    const a = TP.parse(monday), b = TP.parse(TP.addDays(monday, 6));
    const sameMonth = a.getMonth() === b.getMonth();
    const lbl = a.getDate() + (sameMonth ? "" : " " + MON_ABBR[a.getMonth()]) + " – " + b.getDate() + " " + MON_ABBR[b.getMonth()];
    return monday === mondayOf(today) ? "This week · " + lbl : lbl;
  }

  function saveReview(patch) {
    const cur = state.reviews[rvMonday] || { reasons: [], note: "" };
    state.reviews[rvMonday] = Object.assign({}, cur, patch);
    persist();
    const tag = $("rvSaved");
    if (tag) { tag.textContent = "Saved ✓"; clearTimeout(tag._t); tag._t = setTimeout(() => { tag.textContent = ""; }, 2000); }
  }

  let rvNoteTimer = null;
  function renderReview() {
    if (!rvMonday) rvMonday = mondayOf(anchorDay);
    const items = weekSessions(rvMonday);
    const done = items.filter(x => x.status === "done").length;
    const missed = items.filter(x => x.status === "missed");
    const total = items.length;
    const pct = total ? Math.round(done / total * 100) : 0;

    $("rvRange").textContent = rvRangeLabel(rvMonday);
    $("rvCount").textContent = done + "/" + total;
    $("rvPct").textContent = pct + "%";
    $("rvNext").disabled = rvMonday >= mondayOf(today);
    $("rvPrev").disabled = rvMonday <= mondayOf(TP.PLAN_START);

    $("rvBar").innerHTML = total
      ? items.map(x => '<i class="rv-seg ' + x.status + '"></i>').join("")
      : '<i class="rv-seg upcoming"></i>';

    const vd = $("rvVerdict");
    const settled = missed.length === 0 && items.every(x => x.status !== "upcoming");
    if (!total) { vd.textContent = "No sessions"; vd.className = "rv-verdict"; }
    else if (settled) { vd.textContent = "✓ Perfect week"; vd.className = "rv-verdict good"; }
    else if (missed.length === 0) { vd.textContent = "On track"; vd.className = "rv-verdict good"; }
    else if (missed.length <= 2) { vd.textContent = missed.length + " missed"; vd.className = "rv-verdict mid"; }
    else { vd.textContent = missed.length + " missed"; vd.className = "rv-verdict low"; }

    const mw = $("rvMissed");
    if (missed.length) {
      mw.innerHTML = '<div class="rv-missed-title">Missed</div>' +
        missed.map(x => {
          const dt = TP.parse(x.iso);
          return '<button class="rv-miss" data-iso="' + x.iso + '">' +
            '<i class="rv-miss-dot" style="background:' + col(x.s.type) + '"></i>' +
            '<span class="rv-miss-day">' + DOW[TP.weekdayMon0(x.iso)] + " " + dt.getDate() + '</span>' +
            '<span class="rv-miss-name">' + esc(shortTitle(x.s.title)) + '</span>' + CHEV_SVG + '</button>';
        }).join("") +
        '<div class="rv-missed-note">Missing a session is normal — the plan is built to absorb it.</div>';
      mw.hidden = false;
      mw.querySelectorAll(".rv-miss").forEach(b => b.addEventListener("click", () => openDrawer(b.getAttribute("data-iso"))));
    } else { mw.hidden = true; mw.innerHTML = ""; }

    const saved = state.reviews[rvMonday] || { reasons: [], note: "" };
    $("rvFbLabel").textContent = missed.length ? "What got in the way?" : "How did the week go?";
    $("rvChips").innerHTML = RV_REASONS.map(r =>
      '<button class="rv-chip' + ((saved.reasons || []).indexOf(r) > -1 ? " on" : "") + '" data-r="' + r + '">' + r + '</button>').join("");
    $("rvChips").querySelectorAll(".rv-chip").forEach(b =>
      b.addEventListener("click", () => {
        if (!ensureEdit()) return;
        const r = b.getAttribute("data-r");
        const cur = ((state.reviews[rvMonday] || {}).reasons || []).slice();
        const i = cur.indexOf(r);
        if (i > -1) cur.splice(i, 1); else cur.push(r);
        saveReview({ reasons: cur });
        b.classList.toggle("on");
      }));

    const ta = $("rvNote");
    if (document.activeElement !== ta) ta.value = saved.note || "";
    ta.readOnly = !editing;
    ta.onfocus = () => { if (!editing) { ta.blur(); ensureEdit(); } };
    ta.oninput = () => {
      if (!editing) return;
      clearTimeout(rvNoteTimer);
      rvNoteTimer = setTimeout(() => saveReview({ note: ta.value }), 600);
    };
  }

  // ---------- readiness strip (sleep / HRV / resting HR) ----------
  // Wellness syncs from Garmin every day, including days with no workout, so
  // this works even while there are no recorded activities to tick off.
  function mean(xs) { return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null; }

  function renderReadiness(days) {
    const el = $("readiness");
    if (!el || !days || !days.length) return;
    const sorted = days.slice().sort((a, b) => a.date < b.date ? -1 : 1);
    const latest = sorted[sorted.length - 1];
    if (!latest) return;

    // baselines from the trailing window, excluding the day being judged
    const prior = sorted.slice(0, -1).slice(-28);
    const hrvBase = mean(prior.map(d => d.hrv).filter(v => typeof v === "number"));
    const rhrBase = mean(prior.map(d => d.resting_hr).filter(v => typeof v === "number"));

    const sleepH = latest.sleep_s ? latest.sleep_s / 3600 : null;
    const hrv = typeof latest.hrv === "number" ? latest.hrv : null;
    const rhr = typeof latest.resting_hr === "number" ? latest.resting_hr : null;

    const set = (id, txt) => { const n = $(id); if (n) n.textContent = txt; };
    const delta = (v, base, invert) => {
      if (v === null || base === null) return "";
      const d = v - base, r = Math.round(d * 10) / 10;
      const good = invert ? d <= 0 : d >= 0;
      return (r > 0 ? "+" : "") + r + " vs avg" + (good ? " ✓" : "");
    };

    set("rdDate", latest.date === today ? "last night" : prettyDate(latest.date));
    set("rdSleep", sleepH ? sleepH.toFixed(1) + "h" : "—");
    set("rdSleepSub", latest.sleep_score ? "score " + latest.sleep_score : (sleepH ? "" : "not recorded"));
    set("rdHrv", hrv !== null ? String(hrv) : "—");
    set("rdHrvSub", delta(hrv, hrvBase, false));
    set("rdRhr", rhr !== null ? String(rhr) : "—");
    set("rdRhrSub", delta(rhr, rhrBase, true));
    set("rdSteps", latest.steps ? (latest.steps >= 10000 ? (latest.steps / 1000).toFixed(1) + "k" : latest.steps.toLocaleString()) : "—");

    // Simple, conservative read — flags only where we actually have a signal.
    const flags = [];
    if (sleepH !== null && sleepH < 6) flags.push("short sleep");
    if (hrv !== null && hrvBase !== null && hrv < hrvBase * 0.92) flags.push("HRV below your baseline");
    if (rhr !== null && rhrBase !== null && rhr > rhrBase + 3) flags.push("resting HR up");

    let verdict, cls, note;
    if (flags.length >= 2) {
      verdict = "Go easy"; cls = "rd-verdict low";
      note = "Your body's asking for a lighter day — " + flags.join(" and ") + ". Keep today easy, or swap the hard session to tomorrow.";
    } else if (flags.length === 1) {
      verdict = "Steady"; cls = "rd-verdict mid";
      note = "Mostly fine, but " + flags[0] + ". Start easy and see how the legs feel before pushing.";
    } else if (hrv === null && sleepH === null) {
      verdict = "No data"; cls = "rd-verdict mid";
      note = "Nothing recorded overnight — worth checking the watch was worn.";
    } else {
      verdict = "Primed"; cls = "rd-verdict good";
      note = "Sleep and HRV are where they should be. A good day to take on the hard session.";
    }
    const badge = $("rdVerdict"); badge.textContent = verdict; badge.className = cls;
    set("rdNote", note);
    el.hidden = false;
  }

  async function loadReadiness() {
    if (!ICU_SYNC_ENABLED) return;
    try {
      const r = await icuCall("wellness", {});
      if (r && r.days && r.days.length) renderReadiness(r.days);
    } catch (e) { /* readiness is a bonus — never block the app on it */ }
  }

  async function initActivitySync() {
    const b = $("icuBtn"); if (!b) return;
    if (!ICU_SYNC_ENABLED) { b.hidden = true; return; }
    b.addEventListener("click", () => { if (ensureEdit()) syncActivities({}); });
    const st = await icuCall("status", {}).catch(() => null);
    if (st && st.connected) { setSyncBtn("idle", true); syncActivities({ quiet: true }); }
    else setSyncBtn("idle", false);
  }

  // ---------- PIN / edit lock ----------
  let editing = sessionStorage.getItem("htp_edit") === "1" || localStorage.getItem("htp_trust") === "1";
  let pinBuf = "", pinThen = null;
  function setLockUI() {
    const b = $("editLock"), app = $("app");
    b.classList.toggle("unlocked", editing);
    b.setAttribute("aria-label", editing ? "Editing unlocked — tap to lock" : "View only — tap to unlock");
    app.classList.toggle("locked", !editing);
    const ta = $("rvNote"); if (ta) ta.readOnly = !editing;
  }
  function paintPin() { $("pinDots").querySelectorAll("i").forEach((d, i) => d.classList.toggle("on", i < pinBuf.length)); }
  function openPin(then) {
    pinBuf = ""; pinThen = then || null; paintPin();
    $("pinErr").textContent = "";
    $("pinScrim").hidden = false;
  }
  function closePin() { $("pinScrim").hidden = true; pinBuf = ""; pinThen = null; }
  function pinKey(k) {
    if (k === "del") { pinBuf = pinBuf.slice(0, -1); paintPin(); return; }
    if (pinBuf.length >= EDIT_PIN.length) return;
    pinBuf += k; paintPin(); $("pinErr").textContent = "";
    if (pinBuf.length < EDIT_PIN.length) return;
    setTimeout(() => {
      if (pinBuf === EDIT_PIN) {
        editing = true; sessionStorage.setItem("htp_edit", "1");
        if ($("pinTrust").checked) localStorage.setItem("htp_trust", "1");
        const then = pinThen;
        setLockUI(); closePin(); toast("Editing unlocked");
        if (currentIso && drawer.classList.contains("open")) openDrawer(currentIso, { keepScroll: true });
        if (then) then();
      } else {
        const dots = $("pinDots");
        dots.classList.remove("shake"); void dots.offsetWidth; dots.classList.add("shake");
        $("pinErr").textContent = "Wrong PIN — try again";
        pinBuf = ""; paintPin();
      }
    }, 120);
  }
  function ensureEdit(then) { if (editing) return true; openPin(then); return false; }

  // ---------- swap ----------
  function swapDays(a, b) {
    const aS = JSON.parse(JSON.stringify(dayOf(a).sessions));
    const bS = JSON.parse(JSON.stringify(dayOf(b).sessions));
    state.overrides[a] = bS; state.overrides[b] = aS;
    const n = Math.max(aS.length, bS.length);
    for (let i = 0; i < n; i++) {
      const ka = keyFor(a, i), kb = keyFor(b, i), va = state.done[ka], vb = state.done[kb];
      if (vb) state.done[ka] = true; else delete state.done[ka];
      if (va) state.done[kb] = true; else delete state.done[kb];
    }
    const na = state.notes[a], nb = state.notes[b];
    if (nb) state.notes[a] = nb; else delete state.notes[a];
    if (na) state.notes[b] = na; else delete state.notes[b];
    persist(); rerenderAll(); openDrawer(a);
    toast("Swapped with " + DOW[TP.weekdayMon0(b)] + " " + TP.parse(b).getDate() + " " + MON_ABBR[TP.parse(b).getMonth()]);
  }
  function resetDay(iso) {
    delete state.overrides[iso];
    sessionsOfDay(iso).forEach((_, i) => delete state.done[keyFor(iso, i)]);
    persist(); rerenderAll(); openDrawer(iso);
    toast("Day reset to the original plan");
  }

  // ---------- week aggregates / stats ----------
  function weekAgg(anchorIso) {
    const monday = mondayOf(anchorIso);
    let done = 0, total = 0, easyPlan = 0, hardPlan = 0;
    for (let i = 0; i < 7; i++) {
      const d = TP.addDays(monday, i);
      sessionsOfDay(d).forEach((x, idx) => {
        if (x.type === "rest") return;
        total++;
        const it = TP.intensityOf(x);
        if (state.done[keyFor(d, idx)]) done++;
        if (it === "easy") easyPlan++; else if (it === "hard") hardPlan++;
      });
    }
    return { done, total, easyPlan, hardPlan };
  }
  function recomputeStats() {
    let totalDone = 0; Object.keys(state.done).forEach(k => { if (state.done[k]) totalDone++; });
    const wk = weekAgg(anchorDay);
    // streak counts back from yesterday if today isn't finished yet — an
    // unfinished morning shouldn't read as a broken streak
    let streak = 0, cursor = allDone(today) ? today : TP.addDays(today, -1);
    for (let i = 0; i < 400; i++) {
      if (cursor < TP.PLAN_START) break;
      const ss = sessionsOfDay(cursor);
      if (!ss.length) { cursor = TP.addDays(cursor, -1); continue; }
      const ok = ss.every((x, idx) => x.type === "rest" || state.done[keyFor(cursor, idx)]);
      if (ok) { streak++; cursor = TP.addDays(cursor, -1); } else break;
    }
    $("stat-total").textContent = totalDone;
    $("stat-week").textContent = wk.done + "/" + wk.total;
    $("stat-streak").textContent = streak;
    $("week-bar").style.width = (wk.total ? Math.round(wk.done / wk.total * 100) : 0) + "%";
    const r = nextRaceInfo();
    const left = r ? TP.daysBetween(today, r.iso) : "🎉";
    $("stat-race").textContent = left; $("goalDays").textContent = left;
    if (!r) $("stat-race-l").textContent = "season complete";
    renderPolar(); renderCoachNote(wk, streak, wk.total ? Math.round(wk.done / wk.total * 100) : 0);
  }
  function renderPolar() {
    const wk = weekAgg(anchorDay), planTotal = wk.easyPlan + wk.hardPlan;
    let easyPct = 80; if (planTotal) easyPct = Math.round(wk.easyPlan / planTotal * 100);
    const hardPct = 100 - easyPct;
    $("pbEasy").style.width = easyPct + "%";
    $("pbHard").style.width = hardPct + "%";
    $("pbEasyPct").textContent = easyPct + "%";
    $("pbHardPct").textContent = hardPct + "%";
    const badge = $("polarBadge"), sub = $("polarSub");
    if (!planTotal) { badge.textContent = "Rest week"; badge.className = "polar-badge off"; sub.textContent = "Recovery — the easy weeks are where fitness sticks."; return; }
    if (easyPct >= 75) { badge.textContent = "Polarized ✓"; badge.className = "polar-badge"; sub.textContent = "Textbook Seiler — mostly easy so the hard days land hard."; }
    else { badge.textContent = easyPct + "/" + hardPct; badge.className = "polar-badge off"; sub.textContent = "A punchier week — a little more quality than usual."; }
  }
  // A little message from her best friend, picked from how the week is going.
  function renderCoachNote(wk, streak, pct) {
    const wrap = $("coachNote");
    const lwMon = TP.addDays(mondayOf(anchorDay), -7), lw = weekAgg(lwMon);
    const lwPast = lwMon >= TP.PLAN_START && lwMon < today;
    const block = TP.currentBlock(today);
    let cls = "", msg = "";
    if (streak >= 5) { cls = "fire"; msg = streak + " days in a row — you're flying, H. Keep stacking them 🔥"; }
    else if (lwPast && lw.total && lw.done / lw.total < 0.5) { msg = "Last week was lighter — zero guilt. We ease back in; consistency beats any one session."; }
    else if (pct >= 80 && wk.total) { msg = "This week's basically in the bag. Seriously proud of you."; }
    else if (block === "recovery") { msg = "Reset weeks are part of the plan, not a break from it. Enjoy the easy stuff — you earned it."; }
    else if (wk.total) { msg = "One session at a time. Tick today off and the week takes care of itself."; }
    else { wrap.hidden = true; return; }
    wrap.className = "bf-note " + cls; wrap.hidden = false;
    $("coachText").textContent = msg;
  }

  // ---------- up next ----------
  function renderUpNext() {
    const list = $("upnextList");
    let html = "", found = 0, cursor = TP.addDays(anchorDay, today < TP.PLAN_START ? 0 : 1);
    for (let i = 0; i < 30 && found < 5; i++) {
      const d = cursor, day = dayOf(d), real = day.sessions.filter(s => s.type !== "rest");
      if (real.length) {
        const s = real[0], dt = TP.parse(d);
        html += '<button class="row" data-iso="' + d + '">' +
          '<span class="row-icon" style="background:color-mix(in srgb,' + col(s.type) + ' 16%, transparent)">' + (ICONS[s.type] || "•") + '</span>' +
          '<span class="row-main"><span class="row-title">' + esc(shortTitle(s.title)) + '</span>' +
          pills(s.sub, col(s.type), real.slice(1).map(x =>
            '<span class="pill" style="--acc:' + col(x.type) + '">+ ' + (ICONS[x.type] || "") + " " + esc(shortTitle(x.title)) + '</span>')) + '</span>' +
          '<span class="row-end"><b>' + relDay(d) + '</b><span class="date-pill">' + dt.getDate() + ' ' + MON_ABBR[dt.getMonth()] + '</span></span>' + CHEV_SVG +
        '</button>';
        found++;
      }
      cursor = TP.addDays(cursor, 1);
    }
    $("upnext").hidden = !found;
    list.innerHTML = html;
    list.querySelectorAll(".row").forEach(c => c.addEventListener("click", () => openDrawer(c.getAttribute("data-iso"))));
  }

  // ---------- race spotlight ----------
  // key days = the hard, long and brick sessions that build the 70.3
  function isKeyDay(iso, day) {
    if (!day.sessions.length) return false;
    return day.sessions.some(s => s.type === "race" || TP.intensityOf(s) === "hard" || /long|brick/i.test(s.title));
  }
  function setFocus(on) {
    focusRace = on;
    $("goalCard").classList.toggle("active", focusRace);
    $("focusBanner").hidden = !focusRace;
    renderPlan();
  }

  // ---------- PLAN: month grid ----------
  function renderPlan() { renderCalendar(); renderDayPeek(); if (calMode === "list") renderAgenda(); }

  function renderCalendar(dir) {
    const y = view.getFullYear(), m = view.getMonth();
    $("cal-title").textContent = MONTHS[m] + " " + y;
    const grid = $("grid");
    const first = new Date(y, m, 1), startPad = (first.getDay() + 6) % 7, daysInMonth = new Date(y, m + 1, 0).getDate();
    let html = "";
    for (let i = 0; i < startPad; i++) html += '<div class="cell empty"></div>';
    for (let d = 1; d <= daysInMonth; d++) {
      const iso = TP.iso(new Date(y, m, d)), day = dayOf(iso);
      const real = day.sessions.filter(s => s.type !== "rest");
      const cls = ["cell"];
      if (!day.sessions.length) cls.push("off");
      if (iso === today) cls.push("today");
      if (iso === selIso) cls.push("sel");
      if (day.sessions.some(s => s.type === "race")) cls.push("race-day");
      else if (day.sessions.length && !real.length) cls.push("rest-day");
      if (allDone(iso)) cls.push("all-done"); else if (isMissed(iso)) cls.push("missed");
      if (day.swapped) cls.push("swapped");
      if (focusRace && day.sessions.length) cls.push(isKeyDay(iso, day) ? "focus" : "dim");
      const dots = real.slice(0, 3).map(s => '<i style="background:' + col(s.type) + '"></i>').join("");
      html += '<button class="' + cls.join(" ") + '" data-iso="' + iso + '" aria-label="' + prettyDate(iso) + (real.length ? ", " + real.length + " session" + (real.length > 1 ? "s" : "") : "") + '">' +
        '<span class="dnum">' + d + '</span><span class="cdots">' + dots + '</span></button>';
    }
    grid.innerHTML = html;
    grid.classList.remove("slide-l", "slide-r");
    if (dir) { void grid.offsetWidth; grid.classList.add(dir > 0 ? "slide-l" : "slide-r"); }
    grid.querySelectorAll(".cell[data-iso]").forEach(c => c.addEventListener("click", () => {
      const iso = c.getAttribute("data-iso");
      if (iso === selIso && sessionsOfDay(iso).length) { openDrawer(iso); return; }   // second tap opens the day
      selIso = iso;
      grid.querySelectorAll(".cell.sel").forEach(x => x.classList.remove("sel"));
      c.classList.add("sel");
      renderDayPeek();
    }));
  }

  function shiftMonth(n) {
    view = new Date(view.getFullYear(), view.getMonth() + n, 1);
    const ti = TP.parse(anchorDay);
    selIso = (ti.getFullYear() === view.getFullYear() && ti.getMonth() === view.getMonth()) ? anchorDay : TP.iso(view);
    renderCalendar(n); renderDayPeek();
    if (calMode === "list") renderAgenda();
  }

  // rows for a day's sessions, with a tick circle — used by the peek and list mode
  function sessionRows(iso, cls) {
    return sessionsOfDay(iso).map((s, idx) => {
      const isRest = s.type === "rest", dn = !!state.done[keyFor(iso, idx)];
      return '<div class="' + cls + '" data-iso="' + iso + '">' +
        '<span class="row-icon" style="background:color-mix(in srgb,' + col(s.type) + ' 16%, transparent)">' + (ICONS[s.type] || "•") + '</span>' +
        '<span class="row-main"><span class="row-title">' + esc(shortTitle(s.title)) + '</span>' +
        pills(s.sub, col(s.type)) + '</span>' +
        (isRest ? CHEV_SVG : '<button class="check-hit" data-iso="' + iso + '" data-idx="' + idx + '" aria-label="Mark ' + esc(shortTitle(s.title)) + ' done"><span class="check' + (dn ? " on" : "") + '">' + CHECK_SVG + '</span></button>') +
      '</div>';
    }).join("");
  }
  function wireRows(root) {
    root.querySelectorAll(".check-hit").forEach(b => b.addEventListener("click", e => {
      e.stopPropagation();
      tick(b.getAttribute("data-iso"), Number(b.getAttribute("data-idx")));
    }));
    root.querySelectorAll("[data-open]").forEach(r => r.addEventListener("click", () => openDrawer(r.getAttribute("data-iso"))));
  }

  function renderDayPeek() {
    const el = $("dayPeek");
    if (calMode !== "month") { el.hidden = true; return; }
    el.hidden = false;
    const day = dayOf(selIso);
    const head = '<div class="peek-head"><h3>' + relDay(selIso).replace(/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)$/, DOW_FULL[TP.weekdayMon0(selIso)]) + ', ' + prettyDate(selIso) + '</h3>' +
      '<span>' + (day.sessions.length ? esc(day.phase.label) + (day.weekNum ? " · Wk " + day.weekNum : "") : "") + '</span></div>';
    if (!day.sessions.length) {
      el.innerHTML = head + '<div class="card list"><div class="row"><span class="row-main"><span class="row-title">Nothing planned</span>' + pills(["Plan runs 27 Jul 2026 → 9 May 2027"]) + '</span></div></div>';
      return;
    }
    el.innerHTML = head + '<div class="card list">' + sessionRows(selIso, "row").replace(/class="row"/g, 'class="row" data-open role="button" tabindex="0"') + '</div>';
    wireRows(el);
  }

  // ---------- PLAN: list (agenda) mode ----------
  function renderAgenda() {
    const y = view.getFullYear(), m = view.getMonth();
    const body = $("agendaBody");
    const daysInMonth = new Date(y, m + 1, 0).getDate();
    let html = "";
    for (let d = 1; d <= daysInMonth; d++) {
      const iso = TP.iso(new Date(y, m, d)), day = dayOf(iso);
      if (!day.sessions.length) continue;
      html += '<div class="ag-day' + (iso === today ? " is-today" : "") + '" id="ag-' + iso + '">' +
        '<div class="ag-date"><b>' + relDay(iso) + " " + d + '</b>' +
        '<span>' + (day.weekNum ? "Week " + day.weekNum : esc(day.phase.label)) + '</span>' +
        (day.events.length ? '<span class="ag-ev">' + esc(day.events.join(" · ")) + '</span>' : '') + '</div>' +
        sessionRows(iso, "ag-sess").replace(/class="ag-sess"/g, 'class="ag-sess" data-open role="button" tabindex="0"') +
      '</div>';
    }
    body.innerHTML = html || '<p class="empty-note">No sessions this month — the plan runs 27 Jul 2026 → 9 May 2027.</p>';
    wireRows(body);
  }

  function setCalMode(mode) {
    calMode = mode;
    document.querySelectorAll(".seg-opt").forEach(b => b.classList.toggle("active", b.getAttribute("data-mode") === mode));
    document.querySelector(".segmented").classList.toggle("list", mode === "list");
    $("monthMode").hidden = mode !== "month";
    $("listMode").hidden = mode !== "list";
    renderPlan();
    if (mode === "list") {
      const t = document.getElementById("ag-" + today);
      if (t) setTimeout(() => t.scrollIntoView({ behavior: "smooth", block: "center" }), 50);
    }
  }

  // ---------- JOURNEY ----------
  function renderBlocks() {
    const wrap = $("blocksList"), cur = TP.currentBlock(today);
    wrap.innerHTML = TP.BLOCKS.map(b => {
      const weeks = Math.max(1, Math.round(TP.daysBetween(b.start, b.end) / 7));
      const s = TP.parse(b.start), e = TP.parse(b.end);
      const span = s.getDate() + " " + MON_ABBR[s.getMonth()] + " → " + e.getDate() + " " + MON_ABBR[e.getMonth()] + " " + e.getFullYear();
      const st = b.id === cur ? "now" : (b.end < today ? "past" : "");
      return '<div class="block card ' + st + '"><div class="block-top"><span class="block-n">Block ' + b.n + '</span>' +
        (st === "now" ? '<span class="block-now">You are here</span>' : st === "past" ? '<span class="block-done">Done ✓</span>' : '') +
        '<h3>' + esc(b.name) + '</h3></div>' +
        pills([span, weeks + " weeks", b.points], st === "now" ? "var(--accent)" : st === "past" ? "var(--good)" : null) +
        '<div class="block-focus">' + esc(b.focus) + '</div>' +
        '<div class="block-key">' + b.key.map(k => '<span>' + esc(k) + '</span>').join('') + '</div></div>';
    }).join("");
    const total = TP.daysBetween(TP.PLAN_START, TP.RACE_703);
    const pct = Math.round(Math.min(1, Math.max(0, TP.daysBetween(TP.PLAN_START, today) / total)) * 100);
    $("seasonPct").textContent = pct + "% through the season";
    requestAnimationFrame(() => { $("seasonFill").style.width = pct + "%"; });
    $("aliQuote").textContent = "There is no way around the hard work. Embrace it — and know I'm cheering for every single session.";
  }

  // ---------- sheet (day detail) ----------
  const scrim = $("scrim"), drawer = $("drawer");
  let swapView = null, lockedY = 0;

  function lockScroll() {
    if (document.body.classList.contains("no-scroll")) return;
    lockedY = window.scrollY;
    document.body.style.position = "fixed"; document.body.style.top = -lockedY + "px";
    document.body.style.left = "0"; document.body.style.right = "0";
    document.body.classList.add("no-scroll");
  }
  function unlockScroll() {
    if (!document.body.classList.contains("no-scroll")) return;
    document.body.classList.remove("no-scroll");
    document.body.style.position = ""; document.body.style.top = ""; document.body.style.left = ""; document.body.style.right = "";
    window.scrollTo(0, lockedY);
  }

  function renderSwapGrid(isoStr) {
    const picker = $("swapPicker"); if (!picker) return;
    const y = swapView.y, m = swapView.m;
    const first = new Date(y, m, 1), pad = (first.getDay() + 6) % 7, dim = new Date(y, m + 1, 0).getDate();
    let cells = "";
    for (let i = 0; i < pad; i++) cells += '<span class="mg-cell empty"></span>';
    for (let d = 1; d <= dim; d++) {
      const dISO = TP.iso(new Date(y, m, d, 12));
      const has = sessionsOfDay(dISO).filter(s => s.type !== "rest").length > 0;
      if (dISO === isoStr) cells += '<span class="mg-cell self">' + d + '</span>';
      else if (has) cells += '<button class="mg-cell has" data-iso="' + dISO + '">' + d + '</button>';
      else cells += '<span class="mg-cell none">' + d + '</span>';
    }
    picker.innerHTML =
      '<div class="sp-label">Pick a day to swap the whole day with:</div>' +
      '<div class="mg-head"><button class="round-btn mg-nav" data-nav="-1" aria-label="Previous month"><svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg></button>' +
        '<span class="mg-title">' + MONTHS[m] + ' ' + y + '</span>' +
        '<button class="round-btn mg-nav" data-nav="1" aria-label="Next month"><svg viewBox="0 0 24 24"><path d="M9 5l7 7-7 7"/></svg></button></div>' +
      '<div class="mg-dow">' + DOW.map(x => '<span>' + x[0] + '</span>').join('') + '</div>' +
      '<div class="mg-grid">' + cells + '</div>';
    picker.querySelectorAll(".mg-nav").forEach(b => b.addEventListener("click", () => {
      swapView.m += Number(b.getAttribute("data-nav"));
      if (swapView.m < 0) { swapView.m = 11; swapView.y--; } else if (swapView.m > 11) { swapView.m = 0; swapView.y++; }
      renderSwapGrid(isoStr);
    }));
    picker.querySelectorAll(".mg-cell.has").forEach(b => b.addEventListener("click", () => {
      const target = b.getAttribute("data-iso");
      if (ensureEdit(() => swapDays(isoStr, target))) swapDays(isoStr, target);
    }));
  }

  function openDrawer(isoStr, opts) {
    const keep = opts && opts.keepScroll;
    const body = $("d-body"), prevScroll = body.scrollTop;
    const wasOpenSame = currentIso === isoStr && drawer.classList.contains("open");
    const expandedBefore = wasOpenSame ? Array.from(body.querySelectorAll(".sess")).map(n => !n.classList.contains("collapsed")) : null;
    currentIso = isoStr;
    const day = dayOf(isoStr), dt = TP.parse(isoStr);
    $("d-phase").textContent = day.sessions.length
      ? day.phase.label + (day.weekNum ? " · Week " + day.weekNum : "") + (day.swapped ? " · swapped" : "")
      : "Off plan";
    $("d-title").textContent = relDay(isoStr) === "Today" ? "Today" : day.dayName;
    $("d-date").textContent = (relDay(isoStr) === "Today" ? day.dayName + " " : "") + prettyDate(isoStr, true);
    const ev = $("d-event");
    if (day.events.length) { ev.hidden = false; ev.textContent = day.events.join(" · "); } else ev.hidden = true;

    let html = "";
    if (day.banner) html += '<div class="banner">' + esc(day.banner) + '</div>';
    if (!day.sessions.length) html += '<div class="card sess"><h4>Nothing planned for this day</h4></div>';
    day.sessions.forEach((s, idx) => {
      const done = !!state.done[keyFor(isoStr, idx)], isRest = s.type === "rest";
      const hasDetail = s.blocks && s.blocks.length;
      const open = expandedBefore ? expandedBefore[idx] : idx === 0;
      html += '<div class="sess card' + (done ? " done" : "") + (hasDetail && !open ? " collapsed" : "") + '">' +
        '<div class="sess-top">' +
          '<div class="sess-badge" style="background:color-mix(in srgb,' + col(s.type) + ' 16%, transparent)">' + (ICONS[s.type] || "•") + '</div>' +
          '<div class="sess-main"><div class="stype" style="color:' + col(s.type) + '">' + meta(s.type).label + '</div><h4>' + esc(s.title) + '</h4>' +
          pills(s.sub, col(s.type)) + '</div>' +
          (!isRest ? '<button class="check-hit d-chk" data-idx="' + idx + '" aria-label="Mark done"><span class="check' + (done ? " on" : "") + '">' + CHECK_SVG + '</span></button>' : '') +
        '</div>';
      if (hasDetail) {
        html += '<div class="sess-detail">' + steps(s.blocks, col(s.type)) + '</div>' +
          '<button class="sess-toggle"><span class="st-l">' + (open ? "Hide workout" : "Show full workout") + '</span><svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg></button>';
      }
      html += '</div>';
    });
    html += '<div class="notes-wrap"><label for="d-notes">Notes</label>' +
      '<textarea id="d-notes" rows="3" placeholder="Times, how the legs felt, anything to remember…"' + (editing ? "" : " readonly") + '></textarea><div class="saved-tag" id="d-saved"></div></div>';
    if (day.sessions.length) {
      html += '<div class="dactions card">' +
        '<button class="dact" id="swapBtn">⇄&nbsp; Swap with another day</button>' +
        (day.swapped ? '<button class="dact muted" id="resetDayBtn">↺&nbsp; Reset to the original plan</button>' : '') +
      '</div><div class="swap-picker card" id="swapPicker" hidden></div>';
    }
    body.innerHTML = html;

    body.querySelectorAll(".d-chk").forEach(b => b.addEventListener("click", () => tick(isoStr, Number(b.getAttribute("data-idx")))));
    body.querySelectorAll(".sess-toggle").forEach(t => t.addEventListener("click", () => {
      const card = t.closest(".sess"); card.classList.toggle("collapsed");
      t.querySelector(".st-l").textContent = card.classList.contains("collapsed") ? "Show full workout" : "Hide workout";
    }));
    const ta = $("d-notes"); ta.value = state.notes[isoStr] || "";
    let t = null;
    ta.addEventListener("focus", () => { if (!editing) { ta.blur(); ensureEdit(); } });
    ta.addEventListener("input", () => {
      if (!editing) return;
      state.notes[isoStr] = ta.value; if (!ta.value) delete state.notes[isoStr];
      clearTimeout(t); t = setTimeout(() => { persist(); const sv = $("d-saved"); if (sv) { sv.textContent = "Saved ✓"; setTimeout(() => sv.textContent = "", 1400); } }, 400);
    });
    const sw = $("swapBtn");
    if (sw) {
      const dt0 = TP.parse(isoStr); swapView = { y: dt0.getFullYear(), m: dt0.getMonth() };
      sw.addEventListener("click", () => {
        const p = $("swapPicker"); p.hidden = !p.hidden;
        if (!p.hidden) { renderSwapGrid(isoStr); setTimeout(() => p.scrollIntoView({ behavior: "smooth", block: "nearest" }), 30); }
      });
    }
    const rd = $("resetDayBtn");
    if (rd) rd.addEventListener("click", () => { if (ensureEdit(() => resetDay(isoStr))) resetDay(isoStr); });

    lockScroll();
    scrim.classList.add("open"); drawer.classList.add("open");
    drawer.style.transform = "";
    body.scrollTop = keep || wasOpenSame ? prevScroll : 0;
  }
  function closeDrawer() {
    if (!drawer.classList.contains("open")) return;
    scrim.classList.remove("open"); drawer.classList.remove("open"); drawer.style.transform = "";
    currentIso = null;
    unlockScroll();
  }

  // drag the sheet down by its header to dismiss, like a native iOS sheet
  (function sheetDrag() {
    const grab = $("sheetGrab");
    let y0 = 0, dy = 0, t0 = 0, active = false;
    grab.addEventListener("touchstart", e => {
      if (e.target.closest("button")) return;
      active = true; y0 = e.touches[0].clientY; dy = 0; t0 = Date.now();
      drawer.classList.add("dragging");
    }, { passive: true });
    grab.addEventListener("touchmove", e => {
      if (!active) return;
      dy = Math.max(0, e.touches[0].clientY - y0);
      drawer.style.transform = "translateY(" + dy + "px)";
      scrim.style.opacity = String(Math.max(0, 1 - dy / 400));
    }, { passive: true });
    grab.addEventListener("touchend", () => {
      if (!active) return;
      active = false; drawer.classList.remove("dragging"); scrim.style.opacity = "";
      const v = dy / Math.max(1, Date.now() - t0);
      if (dy > 120 || v > 0.6) closeDrawer(); else drawer.style.transform = "";
    });
  })();

  // ---------- wiring ----------
  const TITLES = { today: "Today", calendar: "Plan", blocks: "Journey" };
  function showView(v) {
    document.querySelectorAll(".tab").forEach(t => t.classList.toggle("active", t.getAttribute("data-view") === v));
    $("view-today").hidden = v !== "today";
    $("view-calendar").hidden = v !== "calendar";
    $("view-blocks").hidden = v !== "blocks";
    $("nbTitle").textContent = TITLES[v];
    if (v === "blocks") renderBlocks();
    if (v === "today") renderToday();
    if (v === "calendar") renderPlan();
    window.scrollTo(0, 0);
    try { sessionStorage.setItem("htp_tab", v); } catch (e) { /* ignore */ }
  }
  document.querySelectorAll(".tab").forEach(tab => tab.addEventListener("click", () => {
    const v = tab.getAttribute("data-view");
    if (tab.classList.contains("active")) { window.scrollTo({ top: 0, behavior: "smooth" }); return; }   // iOS: tap active tab → top
    showView(v);
  }));

  $("goalCard").addEventListener("click", () => setFocus(!focusRace));
  $("focusClear").addEventListener("click", () => setFocus(false));
  document.querySelectorAll(".seg-opt").forEach(b => b.addEventListener("click", () => setCalMode(b.getAttribute("data-mode"))));
  $("prev").addEventListener("click", () => shiftMonth(-1));
  $("next").addEventListener("click", () => shiftMonth(1));
  $("todayBtn").addEventListener("click", () => {
    view = new Date(TP.parse(anchorDay).getFullYear(), TP.parse(anchorDay).getMonth(), 1);
    selIso = anchorDay; renderPlan();
    if (calMode === "list") setCalMode("list");
  });

  // swipe the month card left/right to change month
  (function calSwipe() {
    const el = $("calCard");
    let x0 = 0, y0 = 0, tracking = false;
    el.addEventListener("touchstart", e => { x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; tracking = true; }, { passive: true });
    el.addEventListener("touchend", e => {
      if (!tracking) return; tracking = false;
      const dx = e.changedTouches[0].clientX - x0, dy = e.changedTouches[0].clientY - y0;
      if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) shiftMonth(dx < 0 ? 1 : -1);
    });
  })();

  scrim.addEventListener("click", closeDrawer);
  $("dclose").addEventListener("click", closeDrawer);
  document.addEventListener("keydown", e => {
    if (!$("pinScrim").hidden) {
      if (/^[0-9]$/.test(e.key)) pinKey(e.key);
      else if (e.key === "Backspace") pinKey("del");
      else if (e.key === "Escape") closePin();
      return;
    }
    if (e.key === "Escape") closeDrawer();
  });
  $("resetBtn").addEventListener("click", () => {
    const go = () => {
      if (confirm("Clear all completed sessions, notes and swaps? This can't be undone.")) { state = normalize(); persist(); rerenderAll(); }
    };
    if (ensureEdit(go)) go();
  });
  $("editLock").addEventListener("click", () => {
    if (editing) {
      editing = false; sessionStorage.removeItem("htp_edit"); localStorage.removeItem("htp_trust");
      setLockUI(); toast("Locked — view only");
      if (currentIso && drawer.classList.contains("open")) openDrawer(currentIso, { keepScroll: true });
    } else openPin();
  });

  $("rvPrev").addEventListener("click", () => { rvMonday = TP.addDays(rvMonday, -7); renderReview(); });
  $("rvNext").addEventListener("click", () => {
    if (rvMonday >= mondayOf(today)) return;
    rvMonday = TP.addDays(rvMonday, 7); renderReview();
  });

  $("keypad").querySelectorAll("[data-k]").forEach(b => b.addEventListener("click", () => pinKey(b.getAttribute("data-k"))));
  $("pinCancel").addEventListener("click", closePin);
  $("pinScrim").addEventListener("click", e => { if (e.target.id === "pinScrim") closePin(); });

  // navbar gains its blurred backing + small title once the large title scrolls away
  (function navElevation() {
    const nav = $("navbar");
    const onScroll = () => nav.classList.toggle("scrolled", window.scrollY > 34);
    addEventListener("scroll", onScroll, { passive: true });
    onScroll();
  })();

  (function legend() {
    $("legend").innerHTML = Object.keys(TP.TYPE_META).filter(t => t !== "rest")
      .map(t => '<span><i class="dot" style="background:' + col(t) + '"></i>' + TP.TYPE_META[t].label + '</span>').join("");
  })();

  // ---------- splash: cinematic landing ----------
  (function splash() {
    const el = $("splash");
    // shown once per visit — reopening the app mid-session goes straight in
    let seen = false; try { seen = sessionStorage.getItem("htp_splash") === "1"; } catch (e) { /* ignore */ }
    if (seen) { el.hidden = true; return; }
    const emblem = document.getElementById("spEmblem");
    const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
    let running = !still;

    // split the wordmark into letters so they can slam in one by one
    let i = 0;
    el.querySelectorAll(".splash-word > span").forEach(part => {
      part.innerHTML = [...part.textContent].map(ch => '<span class="l" style="--i:' + (i++) + '">' + ch + "</span>").join("");
    });

    // embers drifting up out of the dark
    const cv = document.getElementById("spEmbers"), cx = cv.getContext("2d");
    let W = 0, H = 0, dpr = 1, motes = [];
    const size = () => {
      dpr = Math.min(devicePixelRatio || 1, 2);
      W = cv.width = innerWidth * dpr; H = cv.height = innerHeight * dpr;
    };
    const spawn = (y) => ({
      x: Math.random() * W, y: y != null ? y : H + Math.random() * H * 0.2,
      r: (0.6 + Math.random() * 1.9) * dpr, v: (0.35 + Math.random() * 1.1) * dpr,
      w: Math.random() * Math.PI * 2, ws: 0.008 + Math.random() * 0.02,
      a: 0.25 + Math.random() * 0.6, hue: 350 + Math.random() * 30
    });
    function tick() {
      if (!running) return;
      if (!H) { size(); requestAnimationFrame(tick); return; }
      cx.clearRect(0, 0, W, H);
      cx.globalCompositeOperation = "lighter";
      motes.forEach((m, k) => {
        m.y -= m.v; m.w += m.ws; m.x += Math.sin(m.w) * 0.45 * dpr;
        if (m.y < -10) { motes[k] = spawn(); return; }
        const fade = H ? Math.max(0, Math.min(1, m.y / (H * 0.35))) : 0;   // dim out near the top
        const g = cx.createRadialGradient(m.x, m.y, 0, m.x, m.y, m.r * 4);
        g.addColorStop(0, "hsla(" + m.hue + ",100%,72%," + (m.a * fade) + ")");
        g.addColorStop(1, "hsla(" + m.hue + ",100%,50%,0)");
        cx.fillStyle = g; cx.beginPath(); cx.arc(m.x, m.y, m.r * 4, 0, Math.PI * 2); cx.fill();
      });
      requestAnimationFrame(tick);
    }
    if (running) {
      size(); addEventListener("resize", size);
      const n = innerWidth < 600 ? 45 : 85;
      for (let k = 0; k < n; k++) motes.push(spawn(Math.random() * H));
      requestAnimationFrame(tick);

      // emblem tilts toward the pointer
      el.addEventListener("pointermove", e => {
        const x = e.clientX / innerWidth - 0.5, y = e.clientY / innerHeight - 0.5;
        emblem.style.setProperty("--ry", (x * 22).toFixed(2) + "deg");
        emblem.style.setProperty("--rx", (-y * 22).toFixed(2) + "deg");
      });
      el.addEventListener("pointerleave", () => { emblem.style.setProperty("--rx", "0deg"); emblem.style.setProperty("--ry", "0deg"); });
    }

    const reveal = () => {
      if (el.classList.contains("hidden") || el.classList.contains("warp")) return;
      const done = () => {
        el.classList.add("hidden");
        try { sessionStorage.setItem("htp_splash", "1"); } catch (e) { /* ignore */ }
        setTimeout(() => { running = false; }, 900);   // stop the embers once faded
      };
      if (still) return done();
      el.classList.add("warp");   // punch through the emblem, then hand over
      setTimeout(done, 560);
    };
    document.getElementById("splashSkip").addEventListener("click", reveal);   // user actively enters
  })();

  if ("scrollRestoration" in history) history.scrollRestoration = "manual";
  setLockUI();
  let startTab = "today"; try { startTab = sessionStorage.getItem("htp_tab") || "today"; } catch (e) { /* ignore */ }
  showView(TITLES[startTab] ? startTab : "today");
  renderReview(); renderUpNext(); recomputeStats();
  cloudInit();
  initActivitySync();
  loadReadiness();
})();
