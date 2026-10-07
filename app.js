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
  function normalize(d) { d = d || {}; return { done: d.done || {}, notes: d.notes || {}, overrides: d.overrides || {}, imported: d.imported || {}, reviews: d.reviews || {}, css: d.css || null }; }
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
    relink();      // a swap or a realtime update can change which session each workout belongs to
    renderToday(); renderReview(); renderUpNext(); recomputeStats(); renderPlan(); renderProgress();
    if (drawer.classList.contains("open") && currentIso) openDrawer(currentIso, { keepScroll: true });
  }

  // ---------- activity sync: Garmin → intervals.icu → here ----------
  // Garmin's own API is business-only, so we read from intervals.icu, which
  // syncs from Garmin automatically. The API key stays in the edge function —
  // it grants full access to the intervals.icu account, so it never ships here.
  const ICU_SYNC_ENABLED = true;
  const ICU_FN = SB_URL + "/functions/v1/icu-sync";

  // intervals.icu activity type → our session type. Unlisted types never tick
  // anything, but still show up as extras.
  const ICU_TYPES = {
    Run: "run", TrailRun: "run", VirtualRun: "run", Treadmill: "run",
    Ride: "bike", VirtualRide: "bike", GravelRide: "bike", MountainBikeRide: "bike", EBikeRide: "bike",
    Swim: "swim", OpenWaterSwim: "swim",
    WeightTraining: "strength", Crossfit: "strength", Workout: "strength", HighIntensityIntervalTraining: "strength",
    Yoga: "mobility", Pilates: "mobility", Walk: "mobility", Hike: "mobility", Elliptical: "mobility"
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

  // ---------- the watch: activities, matching, auto-tick ----------
  // Activities are fetched once per load (and on the sync button), cached on
  // the device so the page paints instantly, and matched to the plan fresh on
  // every render — so a swapped day re-matches without a re-sync.
  const ACTS_KEY = "htp_icu_acts", ACTS_AT_KEY = "htp_icu_at";
  const MIN_LINK_S = 10 * 60;          // shorter than this is a warm-up, never "the session"
  const RACE_LEGS = ["swim", "bike", "run"];
  let acts = [];                       // newest first, as intervals.icu returns them
  let links = { bySession: {}, byAct: {}, extrasByDay: {} };
  try { acts = JSON.parse(localStorage.getItem(ACTS_KEY)) || []; } catch (e) { acts = []; }

  const actIso = a => String(a.start_local || "").slice(0, 10);
  const actType = a => ICU_TYPES[a.type] || "other";

  // Which planned session (if any) each activity belongs to. Pure: plan +
  // activities in, links out — ticks don't affect it, except that a moved
  // activity never claims a session she already ticked by hand.
  function relink() {
    const bySession = {}, byAct = {}, extrasByDay = {};
    const claim = (key, a, how) => { (bySession[key] = bySession[key] || []).push(a); byAct[a.id] = { key: key, how: how }; };
    const inPlan = acts.filter(a => actIso(a) >= TP.PLAN_START);
    // longest first, so the main effort claims the session and the warm-up jog doesn't
    const ordered = inPlan.filter(a => ICU_TYPES[a.type] && (a.moving_s || 0) >= MIN_LINK_S)
      .sort((x, y) => (y.moving_s || 0) - (x.moving_s || 0));

    // 1. same day, same discipline — plus race day takes every leg, and a brick takes the run off the bike
    ordered.forEach(a => {
      const iso = actIso(a), t = actType(a), ss = sessionsOfDay(iso);
      for (let i = 0; i < ss.length; i++) {
        if (ss[i].type === t && !bySession[keyFor(iso, i)]) { claim(keyFor(iso, i), a, "same"); return; }
      }
      for (let i = 0; i < ss.length; i++) {
        if (ss[i].type === "race" && RACE_LEGS.indexOf(t) > -1) { claim(keyFor(iso, i), a, "race"); return; }
      }
      if (t !== "run") return;
      for (let i = 0; i < ss.length; i++) {
        const got = bySession[keyFor(iso, i)] || [];
        if (ss[i].type === "bike" && /brick/i.test(ss[i].title) && got.length === 1 && actType(got[0]) === "bike") {
          claim(keyFor(iso, i), a, "brick"); return;
        }
      }
    });

    // 2. moved by a day: still unmatched, so look for a free session of the same discipline either side
    ordered.forEach(a => {
      if (byAct[a.id]) return;
      const iso = actIso(a), t = actType(a);
      for (const off of [-1, 1]) {
        const d = TP.addDays(iso, off), ss = sessionsOfDay(d);
        for (let i = 0; i < ss.length; i++) {
          const key = keyFor(d, i);
          if (ss[i].type !== t || bySession[key]) continue;
          if (state.done[key] && state.imported["icu:" + a.id] !== key) continue;   // ticked by hand — leave it
          claim(key, a, "moved"); return;
        }
      }
    });

    // 3. everything else she recorded is an extra — still worth showing
    inPlan.forEach(a => { if (!byAct[a.id]) (extrasByDay[actIso(a)] = extrasByDay[actIso(a)] || []).push(a); });
    links = { bySession: bySession, byAct: byAct, extrasByDay: extrasByDay };
  }

  // Tick every matched session once. `imported` remembers each activity, so a
  // session she deliberately un-ticks stays un-ticked on the next sync.
  function autoTick() {
    let ticked = 0, changed = false;
    Object.keys(links.byAct).forEach(id => {
      const tag = "icu:" + id;
      if (state.imported[tag]) return;
      const key = links.byAct[id].key;
      state.imported[tag] = key; changed = true;
      if (!state.done[key]) { state.done[key] = true; ticked++; }
    });
    return { ticked: ticked, changed: changed };
  }

  const linkedTo = (iso, idx) => links.bySession[keyFor(iso, idx)] || [];
  const extrasOn = iso => links.extrasByDay[iso] || [];
  function stripFor(iso, idx) {
    const l = linkedTo(iso, idx);
    return l.length ? actualStrip(l, links.byAct[l[0].id].how, sessionsOfDay(iso)[idx]) : "";
  }

  // Pull everything since well before the plan started — the extra history
  // warms up the fitness curve so it doesn't start from zero on 27 July.
  async function syncActivities(opts) {
    const quiet = opts && opts.quiet;
    if (!quiet) setSyncBtn("busy", true);
    try {
      const r = await icuCall("sync", { oldest: TP.addDays(TP.PLAN_START, -90), newest: today });
      if (!r || r.error || !Array.isArray(r.activities)) {
        setSyncBtn("idle", false);
        if (!quiet) toast("Sync failed — " + ((r && r.error) || "no data"));
        return;
      }
      const before = acts.length;
      acts = r.activities;
      try { localStorage.setItem(ACTS_KEY, JSON.stringify(acts)); localStorage.setItem(ACTS_AT_KEY, String(Date.now())); } catch (e) { /* private mode */ }
      relink();
      const res = autoTick(), n = res.ticked;
      if (res.changed) persist();
      rerenderAll();
      detectCss();
      setSyncBtn("idle", true);
      const fresh = Math.max(0, acts.length - before);
      if (n) toast("✓ " + n + " session" + (n > 1 ? "s" : "") + " ticked off from Garmin");
      else if (!quiet) toast(fresh ? "✓ " + fresh + " new workout" + (fresh > 1 ? "s" : "") + " — nothing new to tick" : "✓ All up to date");
    } catch (e) {
      setSyncBtn("idle", false);
      if (!quiet) toast("Couldn't reach the sync service");
    }
  }

  // ---------- the watch: formatting ----------
  function fmtDur(s) {
    if (!s) return "";
    const m = Math.round(s / 60);
    return m < 60 ? m + " min" : Math.floor(m / 60) + "h " + String(m % 60).padStart(2, "0") + "m";
  }
  // 56:12 or 1:54:20 — a stopwatch reading, for a single workout
  function fmtClock(s) {
    s = Math.round(s || 0);
    const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = String(s % 60).padStart(2, "0");
    return h ? h + ":" + String(m).padStart(2, "0") + ":" + x : m + ":" + x;
  }
  function fmtKm(m) { return m >= 100000 ? Math.round(m / 1000) + " km" : (m / 1000).toFixed(1) + " km"; }
  function fmtDist(a) {
    if (!a.distance_m) return "";
    return actType(a) === "swim" ? Math.round(a.distance_m).toLocaleString("en-GB") + " m" : fmtKm(a.distance_m);
  }
  function fmtPace(a) {
    const d = a.distance_m, s = a.moving_s, t = actType(a);
    if (!d || !s) return "";
    if (t === "run") return TP.fmtPace(s / (d / 1000)) + " /km";
    if (t === "swim") return TP.fmtPace(s / (d / 100)) + " /100m";
    if (t === "bike") return (d / 1000 / (s / 3600)).toFixed(1) + " km/h";
    return "";
  }
  function actStats(a) { return [fmtDist(a), fmtDur(a.moving_s), fmtPace(a), a.avg_hr ? Math.round(a.avg_hr) + " bpm" : ""].filter(Boolean); }
  function actLabel(a) {
    const t = actType(a);
    return t === "other" ? String(a.type || "Workout").replace(/([a-z])([A-Z])/g, "$1 $2") : meta(t).label;
  }
  function joinAnd(xs) { return xs.length < 2 ? xs.join("") : xs.slice(0, -1).join(", ") + " and " + xs[xs.length - 1]; }
  function ago(ms) {
    const m = Math.round((Date.now() - ms) / 60000);
    return m < 1 ? "just now" : m < 60 ? m + " min ago" : m < 24 * 60 ? Math.round(m / 60) + "h ago" : Math.round(m / 1440) + "d ago";
  }

  // The four numbers that describe a workout, as value / unit / label.
  function metricGrid(a) {
    const t = actType(a), cells = [];
    if (a.distance_m) cells.push(t === "swim" ? [Math.round(a.distance_m).toLocaleString("en-GB"), "m", "distance"] : [(a.distance_m / 1000).toFixed(1), "km", "distance"]);
    if (a.moving_s) cells.push([fmtClock(a.moving_s), "", "time"]);
    const p = fmtPace(a);
    if (p) { const i = p.indexOf(" "); cells.push([p.slice(0, i), p.slice(i + 1), t === "bike" ? "speed" : "pace"]); }
    if (a.avg_hr) cells.push([Math.round(a.avg_hr), "bpm", "avg HR"]);
    return '<div class="mgrid">' + cells.map(c => '<div class="mg"><b>' + esc(c[0]) + (c[1] ? '<small>' + esc(c[1]) + '</small>' : '') + '</b><span>' + c[2] + '</span></div>').join("") + '</div>';
  }

  // ---------- planned vs actual ----------
  // How much of the workout sat where the plan asked. Plan zones are the
  // five-zone kind; intervals.icu splits Z5 into three, so "Z5" in the plan
  // means its Z5 and up. Easy days count everything at or below the target
  // (Z1 is fine on a Z2 day); hard days count everything at or above it — the
  // warm-up and cool-down are in the total, hence the lower bar for "good".
  // Swims are skipped: wrist HR in water isn't worth judging.
  const sum = xs => xs.reduce((a, b) => a + b, 0);
  function zoneCheck(s, list) {
    if (!s || s.type === "swim" || s.type === "race" || s.type === "strength") return null;
    const m = ((s.sub || "") + " " + (s.title || "")).match(/Z(\d)(?:\s*[–-]\s*Z?(\d))?/);
    if (!m) return null;
    const lo = Number(m[1]), hi = m[2] ? Number(m[2]) : lo;
    const z = [0, 0, 0, 0, 0, 0, 0];
    list.forEach(a => (a.hr_zone_times || []).forEach((sec, i) => { if (i < 7) z[i] += sec || 0; }));
    const total = sum(z);
    if (total < 300) return null;
    const easy = hi <= 2;
    const pct = Math.round((easy ? sum(z.slice(0, hi)) : sum(z.slice(lo - 1))) / total * 100);
    const verb = s.type === "bike" ? "Rode" : "Ran";
    let level, text;
    if (easy) {
      level = pct >= 70 ? "good" : pct >= 40 ? "mid" : "low";
      text = (pct >= 70 ? "Kept it easy" : pct >= 40 ? "Mostly easy" : verb + " too hard for an easy day") + " · " + pct + "% in Zone " + (hi === 1 ? "1" : "1–" + hi);
    } else {
      level = pct >= 30 ? "good" : pct >= 15 ? "mid" : "low";
      text = (pct >= 30 ? "Hit the effort" : pct >= 15 ? "Some quality" : "Stayed easy") + " · " + pct + "% in Zone " + lo + "+";
    }
    return { level: level, text: text, z: z, total: total };
  }
  // one hue, light to dark as the zones climb; each segment says its zone on hover
  function zoneBar(zc, acc) {
    return '<div class="zbar" style="--acc:' + acc + '">' + zc.z.map((sec, i) => sec
      ? '<i class="z' + (i + 1) + '" style="flex:' + sec + '" title="Zone ' + (i + 1) + ' · ' + fmtDur(sec) + '"></i>' : "").join("") + '</div>';
  }

  // What she actually did, under a planned session.
  function actualStrip(list, how, s) {
    if (!list.length) return "";
    const zc = zoneCheck(s, list);
    const head = how === "moved" ? "Done " + DOW_FULL[TP.weekdayMon0(actIso(list[0]))] + " instead" : "From your watch";
    return '<div class="actual">' +
      '<div class="act-head">' + esc(head) + '</div>' +
      list.map(a => (list.length > 1 ? '<div class="act-sub">' + (ICONS[actType(a)] || "•") + " " + esc(actLabel(a)) + '</div>' : '') + metricGrid(a)).join("") +
      (zc ? '<div class="zc ' + zc.level + '">' + zoneBar(zc, s ? col(s.type) : "var(--ink)") +
        '<div class="zc-t"><i class="zc-dot"></i>' + esc(zc.text) + '</div></div>' : '') +
    '</div>';
  }

  // A recorded workout as a list row — the latest feed and the extras.
  function actRow(a, showDay) {
    const t = actType(a), m = links.byAct[a.id];
    const s = m ? sessionsOfDay(m.key.split(":")[0])[Number(m.key.split(":")[1])] : null;
    const tag = s ? '<span class="tag ok">✓ ' + esc(shortTitle(s.title)) + '</span>' : '<span class="tag">Extra</span>';
    const d = TP.parse(actIso(a));
    return '<div class="row act-row" data-iso="' + actIso(a) + '"' + (showDay ? ' data-open role="button" tabindex="0"' : '') + '>' +
      '<span class="row-icon" style="background:color-mix(in srgb,' + col(t) + ' 16%, transparent)">' + (ICONS[t] || "⚡") + '</span>' +
      '<span class="row-main"><span class="row-title">' + esc(a.name || actLabel(a)) + '</span>' +
      '<span class="row-sub">' + esc(actStats(a).slice(0, 3).join(" · ")) + '</span>' + (showDay ? tag : '') + '</span>' +
      (showDay ? '<span class="row-end"><b>' + relDay(actIso(a)) + '</b><span class="row-date">' + d.getDate() + ' ' + MON_ABBR[d.getMonth()] + '</span></span>' + CHEV_SVG : '') +
    '</div>';
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
      '<div class="step"><span class="step-l">' + esc(b.label) + '</span><div class="step-t">' + esc(cssify(b.text)) + '</div></div>').join("") + '</div>';
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

  // ---------- readiness ----------
  // Last night's sleep, HRV and resting HR against her own four-week normal,
  // plus training form. Conservative: a number that isn't there never counts
  // against her, and sleep that hasn't synced yet just shows a dash.
  let wellness = [];
  function mean(xs) { return xs.length ? sum(xs) / xs.length : null; }
  function readiness() {
    const days = wellness.slice().sort((a, b) => a.date < b.date ? -1 : 1);
    const latest = days[days.length - 1] || null;
    const fresh = !!latest && TP.daysBetween(latest.date, today) <= 1;
    const prior = latest ? days.filter(d => d.date < latest.date).slice(-28) : [];
    const base = k => mean(prior.map(d => d[k]).filter(v => typeof v === "number"));
    const r = { latest: latest, fresh: fresh, hrvBase: base("hrv"), rhrBase: base("resting_hr"), flags: [] };
    r.hrv = fresh && typeof latest.hrv === "number" ? latest.hrv : null;
    r.rhr = fresh && typeof latest.resting_hr === "number" ? latest.resting_hr : null;
    r.sleepH = fresh && latest.sleep_s ? latest.sleep_s / 3600 : null;
    r.sleepScore = fresh ? latest.sleep_score : null;
    if (r.sleepH !== null && r.sleepH < 6) r.flags.push("short sleep");
    if (r.hrv !== null && r.hrvBase && r.hrv < r.hrvBase * 0.92) r.flags.push("HRV is below your normal");
    if (r.rhr !== null && r.rhrBase && r.rhr > r.rhrBase + 3) r.flags.push("resting HR is up");
    const series = loadSeries();
    r.form = series.length >= 14 ? series[series.length - 1] : null;
    r.fr = r.form ? formRead(r.form.ctl, r.form.form) : null;
    if (r.fr && r.fr.label === "Overreaching") r.flags.push("training load is high");

    if (r.flags.length >= 2) { r.level = "low"; r.head = "Take it easy today"; r.note = "Your body's asking for a lighter day — " + joinAnd(r.flags) + "."; }
    else if (r.flags.length === 1) { r.level = "mid"; r.head = "Steady does it"; r.note = "Mostly fine, but " + r.flags[0] + ". Start easy and see how you feel."; }
    else if (fresh) { r.level = "good"; r.head = "Good to go"; r.note = "Sleep and HRV look normal for you — train as planned."; }
    else if (r.fr) { r.level = r.fr.cls; r.head = r.fr.label; r.note = r.fr.note; }
    else { r.level = "none"; r.head = "One session at a time"; r.note = ""; }
    if (latest && !fresh && TP.daysBetween(latest.date, today) > 3) r.note += (r.note ? " " : "") + "Sleep & HRV last synced " + prettyDate(latest.date) + ".";
    return r;
  }

  function renderHero() {
    const day = dayOf(today), dt = TP.parse(today), h = new Date().getHours();
    $("greeting").textContent = (h < 12 ? "Morning" : h < 18 ? "Afternoon" : "Evening") + ", Harriet";
    $("heroDate").textContent = day.dayName + " " + dt.getDate() + " " + MONTHS[dt.getMonth()];
    $("heroPhase").textContent = day.phase.label + (day.weekNum ? " · Week " + day.weekNum : "");
    const race = nextRaceInfo();
    $("heroCountdown").textContent = race ? TP.daysBetween(today, race.iso) : "🎉";

    const r = readiness();
    $("hero").setAttribute("data-level", r.level);
    $("heroHead").textContent = r.head;
    $("heroNote").textContent = r.note;

    // "usual 61" beside the number says the comparison in the fewest words
    const delta = (v, b, lowerIsBetter) => {
      if (v === null || !b) return ["", ""];
      const better = lowerIsBetter ? v <= b + 1 : v >= b * 0.97;
      return ["usual " + Math.round(b), better ? "ok" : "warn"];
    };
    const cell = (label, val, unit, sub) => '<div class="hm"><span class="hm-l">' + label + '</span>' +
      '<b>' + val + (unit && val !== "—" ? '<small>' + unit + '</small>' : '') + '</b><span class="hm-s ' + (sub[1] || "") + '">' + (sub[0] || "&nbsp;") + '</span></div>';
    $("heroMetrics").innerHTML =
      cell("Sleep", r.sleepH !== null ? r.sleepH.toFixed(1) : "—", "h", [r.sleepScore ? "score " + r.sleepScore : (r.fresh ? "not in yet" : ""), ""]) +
      cell("HRV", r.hrv !== null ? Math.round(r.hrv) : "—", "ms", delta(r.hrv, r.hrvBase, false)) +
      cell("Resting HR", r.rhr !== null ? r.rhr : "—", "bpm", delta(r.rhr, r.rhrBase, true)) +
      cell("Form", r.form ? (r.form.form > 0 ? "+" : "") + Math.round(r.form.form) : "—", "", [r.fr ? r.fr.label : "", ""]);
    renderSuggestion(r);
  }

  // When the body says "easy" and today is a hard day, offer to swap it with
  // the gentlest day left this week (a rest day is the best swap of all).
  function isHard(s) { return s.type !== "race" && (TP.intensityOf(s) === "hard" || /long|brick/i.test(s.title)); }
  function swapCandidate() {
    const ss = sessionsOfDay(today);
    const hard = ss.filter((s, i) => !state.done[keyFor(today, i)] && isHard(s))[0];
    if (!hard) return null;
    const sunday = TP.addDays(mondayOf(today), 6);
    for (let d = TP.addDays(today, 1); d <= sunday; d = TP.addDays(d, 1)) {
      const ds = sessionsOfDay(d);
      if (!ds.length || ds.some(x => x.type === "race" || isHard(x)) || ds.some((x, i) => state.done[keyFor(d, i)])) continue;
      return { hard: hard, day: d, sessions: ds };
    }
    return null;
  }
  function renderSuggestion(r) {
    const el = $("heroSugg");
    let dismissed = false; try { dismissed = localStorage.getItem("htp_sugg") === today; } catch (e) { /* ignore */ }
    const c = r.level === "low" && !dismissed ? swapCandidate() : null;
    if (!c) { el.hidden = true; el.innerHTML = ""; return; }
    const real = c.sessions.filter(x => x.type !== "rest");
    const what = real.length ? real.map(x => shortTitle(x.title).toLowerCase()).join(" + ") : "rest day";
    el.innerHTML = '<p>Your ' + esc(shortTitle(c.hard.title).toLowerCase()) + ' can wait. Swap today with ' +
      DOW_FULL[TP.weekdayMon0(c.day)] + '’s ' + esc(what) + '?</p>' +
      '<div class="hs-btns"><button class="hs-yes">Swap the days</button><button class="hs-no">Keep the plan</button></div>';
    el.hidden = false;
    el.querySelector(".hs-yes").addEventListener("click", () => { if (ensureEdit(() => swapDays(today, c.day))) swapDays(today, c.day); });
    el.querySelector(".hs-no").addEventListener("click", () => { try { localStorage.setItem("htp_sugg", today); } catch (e) { /* ignore */ } el.hidden = true; });
  }

  // the one instruction that matters, so the card stays short
  function mainStep(s) {
    const b = (s.blocks || []).filter(x => x.label === "Main")[0] || (s.blocks || [])[0];
    return b ? b.text : "";
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
      const isRest = s.type === "rest", done = !!state.done[keyFor(today, idx)], strip = stripFor(today, idx);
      const main = isRest ? "" : mainStep(s);
      return '<article class="tcard card' + (done ? " done" : "") + (isRest ? " t-rest" : "") + '" style="--acc:' + col(s.type) + '">' +
        '<div class="tc-top">' +
          '<div class="tc-badge">' + (ICONS[s.type] || "•") + '</div>' +
          '<div class="tc-meta"><div class="tc-type">' + meta(s.type).label + '</div><h3>' + esc(s.title) + '</h3>' + pills(s.sub, col(s.type)) + '</div>' +
          (isRest ? '' : '<button class="check-hit tc-tick" data-idx="' + idx + '" aria-label="' + (done ? "Done — tap to undo" : "Mark as done") + '"><span class="check lg' + (done ? " on" : "") + '">' + CHECK_SVG + '</span></button>') +
        '</div>' +
        (main && !strip ? '<p class="tc-main">' + esc(cssify(main)) + '</p>' : '') +
        strip +
        '<button class="tc-more">' + (isRest ? "Why rest matters" : "Full workout") + CHEV_SVG + '</button>' +
      '</article>';
    }).join("");

    const extra = extrasOn(today);
    if (extra.length) wrap.innerHTML += '<div class="card list extras"><div class="list-cap">Also on your watch today</div>' + extra.map(a => actRow(a, false)).join("") + '</div>';

    wrap.querySelectorAll(".tc-tick").forEach(b => b.addEventListener("click", () => {
      if (tick(today, Number(b.getAttribute("data-idx")))) {
        const nb = wrap.querySelector('.tc-tick[data-idx="' + b.getAttribute("data-idx") + '"] .check');
        if (nb) nb.classList.add("pop");
      }
    }));
    wrap.querySelectorAll(".tc-more").forEach(b => b.addEventListener("click", () => openDrawer(today)));
  }

  function sumWeek(monday) {
    const end = TP.addDays(monday, 6), out = { swim: 0, bike: 0, run: 0, secs: 0, n: 0 };
    acts.forEach(a => {
      const d = actIso(a); if (d < monday || d > end) return;
      const t = actType(a);
      if (out[t] !== undefined) out[t] += a.distance_m || 0;
      out.secs += a.moving_s || 0; out.n++;
    });
    return out;
  }
  const swimTxt = m => m >= 1000 ? (m / 1000).toFixed(1) + " km" : Math.round(m) + " m";

  function renderWeek() {
    const el = $("rhythm"), monday = mondayOf(anchorDay);
    let done = 0, total = 0, html = "";
    for (let i = 0; i < 7; i++) {
      const d = TP.addDays(monday, i), dt = TP.parse(d);
      const ss = sessionsOfDay(d), real = ss.filter(x => x.type !== "rest");
      const dn = ss.filter((x, j) => x.type !== "rest" && state.done[keyFor(d, j)]).length;
      done += dn; total += real.length;
      const st = !real.length ? "rest" : (dn === real.length ? "done" : (d < today ? "missed" : "todo"));
      const xs = extrasOn(d).slice(0, Math.max(0, 4 - Math.min(3, real.length)))
        .map(a => '<i class="xdot" style="--acc:' + col(actType(a)) + '"></i>').join("");
      const dots = (real.length
        ? real.slice(0, 3).map(x => '<i style="background:' + col(x.type) + '"></i>').join("")
        : (xs ? "" : '<i class="rest-dot"></i>')) + xs;
      html += '<button class="rh-day ' + st + (d === today ? " is-today" : "") + '" data-iso="' + d + '" aria-label="' + DOW_FULL[i] + " " + dt.getDate() + '">' +
        '<span class="rh-dow">' + DOW[i][0] + '</span><span class="rh-num">' + dt.getDate() + '</span><span class="rh-dots">' + dots + '</span></button>';
    }
    el.innerHTML = html;
    el.querySelectorAll(".rh-day").forEach(b => b.addEventListener("click", () => openDrawer(b.getAttribute("data-iso"))));
    $("rhythmLabel").textContent = total ? done + " of " + total + " done" : "";

    // what the watch recorded this week — hidden until there's anything to show
    const wk = sumWeek(monday), vol = $("weekVol");
    vol.hidden = !wk.n;
    const v = (type, label, val) => '<div class="wv"><span class="wv-l"><i class="dot" style="background:' + col(type) + '"></i>' + label + '</span><b>' + val + '</b></div>';
    vol.innerHTML = v("swim", "Swim", swimTxt(wk.swim)) + v("bike", "Bike", Math.round(wk.bike / 1000) + " km") +
      v("run", "Run", (wk.run / 1000).toFixed(1) + " km") + v("rest", "Time", fmtDur(wk.secs) || "0 min");
  }

  function renderLatest() {
    const sec = $("latest"), latest = acts.filter(a => actIso(a) >= TP.PLAN_START).slice(0, 4);
    sec.hidden = !latest.length;
    if (!latest.length) return;
    let at = 0; try { at = Number(localStorage.getItem(ACTS_AT_KEY)) || 0; } catch (e) { /* ignore */ }
    $("watchMeta").textContent = at ? "Synced " + ago(at) : "";
    $("latestActs").innerHTML = latest.map(a => actRow(a, true)).join("");
    wireRows($("latestActs"));
  }

  function renderToday() { renderHero(); renderTodaySessions(); renderWeek(); renderLatest(); }

  // ---------- PROGRESS ----------
  function renderProgress() {
    if ($("view-progress").hidden) return;
    $("progKicker").textContent = acts.length ? "Since " + prettyDate(TP.PLAN_START) : "From her watch";
    renderFitness(); renderHours(); renderPredict(); renderRaceReady(); renderCss();
  }

  // ---------- fitness / fatigue / form ----------
  // The standard impulse-response model, from each workout's training load:
  // fitness is a 42-day weighted average, fatigue a 7-day one, form the gap.
  // intervals.icu leaves load blank for a few activities; those count at a
  // middling 60 per hour rather than as zero, so a gap doesn't read as rest.
  function loadSeries() {
    if (!acts.length) return [];
    const daily = {};
    acts.forEach(a => {
      const l = typeof a.load === "number" ? a.load : (a.moving_s || 0) / 3600 * 60;
      daily[actIso(a)] = (daily[actIso(a)] || 0) + l;
    });
    const first = Object.keys(daily).sort()[0];
    const out = [];
    let ctl = 0, atl = 0;
    for (let d = first; d <= today; d = TP.addDays(d, 1)) {
      const l = daily[d] || 0;
      ctl += (l - ctl) / 42; atl += (l - atl) / 7;
      out.push({ iso: d, ctl: ctl, atl: atl, form: ctl - atl });
    }
    return out;
  }

  function formRead(ctl, form) {
    const pct = form / Math.max(ctl, 1) * 100;
    if (pct > 20) return { cls: "mid", label: "Very fresh", note: "Lots in the tank — fitness slowly fades if this lasts, so it's a good moment for a big session." };
    if (pct > 5) return { cls: "good", label: "Fresh", note: "Rested and ready — a good day to take on the hard session." };
    if (pct >= -10) return { cls: "good", label: "Balanced", note: "Training and recovery are in step. Carry on as planned." };
    if (pct >= -30) return { cls: "good", label: "Building", note: "This is the productive zone — tired legs are fitness being made. Sleep and fuel well." };
    return { cls: "low", label: "Overreaching", note: "Fatigue is well ahead of fitness. Keep the next day or two genuinely easy." };
  }

  function renderFitness() {
    const card = $("fitness"), series = loadSeries();
    if (series.length < 14) { card.hidden = true; return; }
    card.hidden = false;
    const now = series[series.length - 1], r = formRead(now.ctl, now.form);
    const v = $("fitVerdict"); v.textContent = r.label; v.className = "chip " + r.cls;
    $("fitCtl").textContent = Math.round(now.ctl);
    const dc = Math.round(now.ctl - series[Math.max(0, series.length - 8)].ctl);
    $("fitCtlSub").textContent = (dc > 0 ? "↑ " + dc : dc < 0 ? "↓ " + -dc : "→ 0") + " this week";
    $("fitAtl").textContent = Math.round(now.atl);
    $("fitForm").textContent = (now.form > 0 ? "+" : "") + Math.round(now.form);
    $("fitNote").textContent = r.note + " Fitness is your 6-week training average; fatigue is the last week; form is the gap.";
    drawFitness(series.slice(-84));
  }

  // shared hover readout for the charts — built with textContent, never HTML
  function chartTip(tip, lines, x, W) {
    tip.textContent = "";
    lines.forEach((l, i) => {
      const d = document.createElement("div");
      if (i === 0) { d.className = "tip-d"; d.textContent = l; }
      else { const b = document.createElement("b"); b.textContent = l[0]; d.append(b, " " + l[1]); }
      tip.appendChild(d);
    });
    tip.hidden = false;
    tip.style.left = Math.max(0, Math.min(W - tip.offsetWidth, x - tip.offsetWidth / 2)) + "px";
  }

  // One series (fitness) — a 2px line over a faint wash, end dot + value,
  // crosshair readout with all three numbers for the day under the finger.
  function drawFitness(pts) {
    const box = $("fitChart");
    const W = Math.max(240, box.clientWidth || 320), H = 140, padT = 14, padB = 20, padR = 30;
    const iw = W - padR, ih = H - padT - padB;
    const maxV = Math.max(10, Math.ceil(Math.max.apply(null, pts.map(p => p.ctl)) * 1.2 / 10) * 10);
    const x = i => i / Math.max(1, pts.length - 1) * iw;
    const y = v => padT + ih - v / maxV * ih;
    const line = pts.map((p, i) => (i ? "L" : "M") + x(i).toFixed(1) + " " + y(p.ctl).toFixed(1)).join("");
    const area = line + "L" + x(pts.length - 1).toFixed(1) + " " + (padT + ih) + "L0 " + (padT + ih) + "Z";
    const grid = [0, maxV / 2, maxV].map(g =>
      '<line class="cg" x1="0" x2="' + iw + '" y1="' + y(g) + '" y2="' + y(g) + '"/>' +
      (g ? '<text class="ct" x="0" y="' + (y(g) - 4) + '">' + g + '</text>' : '')).join("");
    const months = pts.map((p, i) => ({ p: p, i: i })).filter(o => o.p.iso.slice(8) === "01")
      .map(o => '<text class="ct" x="' + x(o.i) + '" y="' + (H - 4) + '" text-anchor="middle">' + MON_ABBR[TP.parse(o.p.iso).getMonth()] + '</text>').join("");
    const last = pts[pts.length - 1], lx = x(pts.length - 1), ly = y(last.ctl);
    box.innerHTML =
      '<svg width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Fitness over the last 12 weeks, now ' + Math.round(last.ctl) + '">' +
        grid + months +
        '<path class="ca" d="' + area + '"/><path class="cl" d="' + line + '"/>' +
        '<circle class="cd" cx="' + lx + '" cy="' + ly + '" r="4.5"/>' +
        '<text class="cv" x="' + (lx + 8) + '" y="' + (ly + 4) + '">' + Math.round(last.ctl) + '</text>' +
        '<line class="cx" x1="0" x2="0" y1="' + padT + '" y2="' + (padT + ih) + '" visibility="hidden"/>' +
        '<circle class="cd cdh" r="4.5" visibility="hidden"/>' +
        '<rect class="chit" x="0" y="0" width="' + iw + '" height="' + H + '"/>' +
      '</svg><div class="chart-tip" hidden></div>';
    const hit = box.querySelector(".chit"), xl = box.querySelector(".cx"), dot = box.querySelector(".cdh"), tip = box.querySelector(".chart-tip");
    const show = e => {
      const rect = hit.getBoundingClientRect();
      const i = Math.max(0, Math.min(pts.length - 1, Math.round((e.clientX - rect.left) / rect.width * (pts.length - 1))));
      const p = pts[i], px = x(i);
      xl.setAttribute("x1", px); xl.setAttribute("x2", px); xl.setAttribute("visibility", "visible");
      dot.setAttribute("cx", px); dot.setAttribute("cy", y(p.ctl)); dot.setAttribute("visibility", "visible");
      chartTip(tip, [DOW[TP.weekdayMon0(p.iso)] + " " + prettyDate(p.iso), [String(Math.round(p.ctl)), "fitness"], [String(Math.round(p.atl)), "fatigue"], [(p.form > 0 ? "+" : "") + Math.round(p.form), "form"]], px, W);
    };
    const hide = () => { xl.setAttribute("visibility", "hidden"); dot.setAttribute("visibility", "hidden"); tip.hidden = true; };
    hit.addEventListener("pointermove", show); hit.addEventListener("pointerdown", show);
    hit.addEventListener("pointerleave", hide); hit.addEventListener("pointercancel", hide);
  }

  // ---------- training time per week ----------
  // Columns, one per week: this week in the accent, the rest recessive; each
  // column's hover readout breaks the week down by discipline.
  function renderHours() {
    const card = $("hours");
    if (!acts.length) { card.hidden = true; return; }
    card.hidden = false;
    const mon0 = mondayOf(today), weeks = [];
    for (let i = 11; i >= 0; i--) { const m = TP.addDays(mon0, -7 * i); weeks.push(Object.assign({ monday: m }, sumWeek(m))); }
    const cur = weeks[weeks.length - 1], prev = weeks[weeks.length - 2];
    $("hoursNow").textContent = fmtDur(cur.secs) || "0 min";
    $("hoursSub").textContent = "this week · " + (fmtDur(prev.secs) || "0 min") + " last week";

    const box = $("hoursChart");
    const W = Math.max(240, box.clientWidth || 320), H = 130, padT = 14, padB = 20;
    const ih = H - padT - padB, slot = W / weeks.length, bw = Math.min(24, slot - 6);
    const maxH = Math.max(2, Math.ceil(Math.max.apply(null, weeks.map(w => w.secs / 3600)) / 2) * 2);
    const y = h => padT + ih - h / maxH * ih, base = padT + ih;
    const bar = (x, top) => {
      const r = Math.min(4, (base - top) / 2);
      return "M" + x + " " + base + "V" + (top + r) + "Q" + x + " " + top + " " + (x + r) + " " + top + "H" + (x + bw - r) + "Q" + (x + bw) + " " + top + " " + (x + bw) + " " + (top + r) + "V" + base + "Z";
    };
    let marks = "", labels = "";
    weeks.forEach((w, i) => {
      const x = i * slot + (slot - bw) / 2, h = w.secs / 3600;
      if (h > 0) marks += '<path class="' + (i === weeks.length - 1 ? "cb cur" : "cb") + '" d="' + bar(x, y(h)) + '"/>';
      if (i % 3 === 2 || i === weeks.length - 1) {
        const d = TP.parse(w.monday);
        labels += '<text class="ct" x="' + (x + bw / 2) + '" y="' + (H - 4) + '" text-anchor="middle">' + (i === weeks.length - 1 ? "Now" : d.getDate() + " " + MON_ABBR[d.getMonth()]) + '</text>';
      }
    });
    box.innerHTML = '<svg width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Training hours per week, last 12 weeks">' +
      '<line class="cg" x1="0" x2="' + W + '" y1="' + base + '" y2="' + base + '"/>' +
      '<line class="cg" x1="0" x2="' + W + '" y1="' + y(maxH) + '" y2="' + y(maxH) + '"/><text class="ct" x="0" y="' + (y(maxH) - 4) + '">' + maxH + 'h</text>' +
      marks + labels +
      weeks.map((w, i) => '<rect class="chit" data-i="' + i + '" x="' + (i * slot) + '" y="0" width="' + slot + '" height="' + H + '"/>').join("") +
      '</svg><div class="chart-tip" hidden></div>';
    const tip = box.querySelector(".chart-tip");
    box.querySelectorAll(".chit").forEach(r => {
      const show = () => {
        const w = weeks[Number(r.getAttribute("data-i"))];
        box.querySelectorAll(".cb").forEach(b => b.classList.remove("on"));
        const lines = ["Week of " + prettyDate(w.monday), [fmtDur(w.secs) || "0 min", "training"]];
        if (w.swim) lines.push([swimTxt(w.swim), "swim"]);
        if (w.bike) lines.push([Math.round(w.bike / 1000) + " km", "bike"]);
        if (w.run) lines.push([(w.run / 1000).toFixed(1) + " km", "run"]);
        chartTip(tip, lines, Number(r.getAttribute("x")) + slot / 2, W);
      };
      r.addEventListener("pointerenter", show); r.addEventListener("pointerdown", show);
      r.addEventListener("pointerleave", () => { tip.hidden = true; });
    });
  }

  // ---------- 70.3 estimate ----------
  // A rough finish time from what she's done in the last 8 weeks:
  //   swim — best sustained pool pace on a 1 km+ swim, +5% for open water
  //   bike — best average speed on a 40 km+ ride, 3% slower over 90 km
  //   run  — best 5 km+ run scaled to 21.1 km (Riegel, ^1.06), +8% off the bike
  //   transitions — 6 min + 4 min
  function predict() {
    const from = TP.addDays(today, -56);
    const recent = acts.filter(a => actIso(a) >= from && a.distance_m && a.moving_s);
    const swims = recent.filter(a => a.type === "Swim" && a.distance_m >= 1000);
    const rides = recent.filter(a => actType(a) === "bike" && a.distance_m >= 40000);
    const runs = recent.filter(a => actType(a) === "run" && a.distance_m >= 5000);
    if (!swims.length || !rides.length || !runs.length) return null;
    const swimPace = Math.min.apply(null, swims.map(a => a.moving_s / (a.distance_m / 100))) * 1.05;
    const bikeSpd = Math.max.apply(null, rides.map(a => a.distance_m / a.moving_s)) * 0.97;
    const runHalf = Math.min.apply(null, runs.map(a => a.moving_s * Math.pow(21097 / a.distance_m, 1.06))) * 1.08;
    const p = { swim: swimPace * 19, t1: 360, bike: 90000 / bikeSpd, t2: 240, run: runHalf, swimPace: swimPace, bikeKmh: bikeSpd * 3.6, runPace: runHalf / 21.097 };
    p.total = p.swim + p.t1 + p.bike + p.t2 + p.run;
    return p;
  }
  function renderPredict() {
    const p = predict(), card = $("predict");
    if (!p) { card.hidden = true; return; }
    card.hidden = false;
    const hm = s => { const m = Math.round(s / 60); return Math.floor(m / 60) + ":" + String(m % 60).padStart(2, "0"); };
    $("predTotal").textContent = hm(p.total);
    $("predRange").textContent = "± " + Math.round(p.total * 0.05 / 60) + " min";
    const leg = (type, label, time, sub) => '<div class="leg"><i class="dot" style="background:' + col(type) + '"></i><span class="leg-l">' + label + '</span><span class="leg-s">' + sub + '</span><b>' + time + '</b></div>';
    $("predLegs").innerHTML =
      leg("swim", "Swim 1.9 km", fmtClock(p.swim), TP.fmtPace(p.swimPace) + " /100m") +
      leg("rest", "T1", fmtClock(p.t1), "") +
      leg("bike", "Bike 90 km", fmtClock(p.bike), p.bikeKmh.toFixed(1) + " km/h") +
      leg("rest", "T2", fmtClock(p.t2), "") +
      leg("run", "Run 21.1 km", fmtClock(p.run), TP.fmtPace(p.runPace) + " /km");
    $("predFoot").textContent = "From her best swim, ride and run in the last 8 weeks, adjusted for open water, a longer ride and running off the bike. It moves as she trains.";
  }

  // ---------- race-distance check ----------
  // How close her longest recent swim / ride / run is to each 70.3 leg.
  const RACE_DIST = [["swim", "Swim", 1900], ["bike", "Bike", 90000], ["run", "Run", 21100]];
  function renderRaceReady() {
    const season = acts.filter(a => actIso(a) >= TP.PLAN_START);
    $("raceCard").hidden = !season.length;
    if (!season.length) return;
    const recentFrom = TP.addDays(today, -56);
    const best = (t, from) => season.filter(a => actType(a) === t && actIso(a) >= from).reduce((m, a) => Math.max(m, a.distance_m || 0), 0);
    const fmt = (t, m) => t === "swim" ? (m / 1000).toFixed(2).replace(/0$/, "") + " km" : (m / 1000).toFixed(1).replace(/\.0$/, "") + " km";
    $("raceReady").innerHTML = RACE_DIST.map(r => {
      const t = r[0], recent = best(t, recentFrom), top = best(t, TP.PLAN_START), pct = Math.min(1, recent / r[2]);
      return '<div class="rr" style="--acc:' + col(t) + '">' +
        '<div class="rr-top"><span class="rr-l"><i class="dot" style="background:' + col(t) + '"></i>' + r[1] + '</span>' +
        '<span class="rr-v"><b>' + fmt(t, recent) + '</b> / ' + fmt(t, r[2]) + (pct >= 1 ? ' <span class="ok">✓</span>' : '') + '</span></div>' +
        '<div class="rr-bar"><i style="width:' + Math.round(pct * 100) + '%"></i></div>' +
        (top > recent ? '<div class="rr-sub">Season best ' + fmt(t, top) + '</div>' : '') + '</div>';
    }).join("");
    const hrs = season.reduce((m, a) => m + (a.moving_s || 0), 0) / 3600;
    $("seasonTotals").textContent = season.length + " workouts · " + Math.round(hrs) + " hours since " + prettyDate(TP.PLAN_START);
  }

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

    const vol = sumWeek(rvMonday);
    let extraN = 0;
    for (let i = 0; i < 7; i++) extraN += extrasOn(TP.addDays(rvMonday, i)).length;
    const vp = (type, txt) => '<span class="pill" style="--acc:' + col(type) + '">' + txt + '</span>';
    $("rvWatch").innerHTML = vol.n
      ? '<span class="rv-watch-l">⌚ On the watch</span><span class="pills">' +
        vp("rest", fmtDur(vol.secs)) +
        (vol.swim ? vp("swim", "Swim " + (vol.swim >= 1000 ? (vol.swim / 1000).toFixed(1) + " km" : Math.round(vol.swim) + " m")) : "") +
        (vol.bike ? vp("bike", "Bike " + Math.round(vol.bike / 1000) + " km") : "") +
        (vol.run ? vp("run", "Run " + (vol.run / 1000).toFixed(1) + " km") : "") +
        (extraN ? vp("mobility", "+" + extraN + " extra") : "") + '</span>'
      : "";

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

  // ---------- health data ----------
  async function loadReadiness() {
    if (!ICU_SYNC_ENABLED) return;
    try {
      const r = await icuCall("wellness", { oldest: TP.addDays(today, -60), newest: today });
      wellness = (r && r.days) || [];
      renderHero();
    } catch (e) { /* readiness is a bonus — never block the app on it */ }
  }

  // ---------- the plan, on her watch ----------
  // The next two weeks go to her intervals.icu calendar as structured workouts,
  // and intervals.icu passes them to Garmin. A GitHub Actions job does this every
  // morning; the site does it too after a swap (so the watch follows the change)
  // and once a day from each device as a backstop.
  const PUSH_KEY = "htp_push";
  let pushTimer = null;
  function planWorkouts(from, to) {
    const out = [], css = state.css && state.css.s;
    for (let d = from; d <= to; d = TP.addDays(d, 1)) {
      sessionsOfDay(d).forEach((s, i) => TP.watchWorkouts(s, css, d).forEach(w =>
        out.push({ date: d, key: d + "-" + i + w.suffix, type: w.type, name: w.name, description: w.description })));
    }
    return out;
  }
  async function pushPlan(opts) {
    const quiet = opts && opts.quiet, from = today, to = TP.addDays(today, 13);
    if (!quiet) $("wpBtn").classList.add("busy");
    try {
      const r = await icuCall("push", { from: from, to: to, workouts: planWorkouts(from, to) });
      if (!r || r.error) throw new Error(r && r.error);
      try { localStorage.setItem(PUSH_KEY, JSON.stringify({ at: Date.now(), day: today, n: r.pushed })); } catch (e) { /* ignore */ }
      if (!quiet) toast("✓ " + r.pushed + " workouts sent to her watch");
    } catch (e) {
      if (!quiet) toast("Couldn't send to the watch");
    }
    $("wpBtn").classList.remove("busy");
    renderPushStatus();
  }
  function schedulePush() { clearTimeout(pushTimer); pushTimer = setTimeout(() => pushPlan({ quiet: true }), 1500); }
  function lastPush() { try { return JSON.parse(localStorage.getItem(PUSH_KEY)); } catch (e) { return null; } }
  function renderPushStatus() {
    const p = lastPush();
    $("wpSub").textContent = p
      ? p.n + " workouts for the next two weeks · sent " + ago(p.at)
      : "Sends the next two weeks to Garmin, via intervals.icu";
  }

  // ---------- swim pace (CSS) ----------
  // CSS = (400 m time − 200 m time) ÷ 2, per 100 m. The plan schedules a test
  // every six weeks over the winter; when one has a watch swim attached, its laps
  // are checked for the 400 and the 200, and every CSS target updates from it.
  function cssify(text) {
    if (!state.css || !state.css.s) return text;
    return String(text).replace(/\bCSS\b(?!\s*(?:test|\/|·))/g, "CSS (" + TP.fmtPace(state.css.s) + "/100m)");
  }
  function nextCssTest() {
    for (let d = today; d <= TP.RACE_703; d = TP.addDays(d, 1)) {
      if (sessionsOfDay(d).some(s => /CSS test/i.test(s.title))) return d;
    }
    return null;
  }
  function setCss(sec, iso, src, extra) {
    state.css = Object.assign({ s: Math.round(sec), date: iso, src: src }, extra || {});
    persist(); rerenderAll(); schedulePush();
    toast("Swim pace updated — CSS " + TP.fmtPace(sec) + " /100m");
  }
  async function detectCss() {
    let tried = {}; try { tried = JSON.parse(localStorage.getItem("htp_css_tried")) || {}; } catch (e) { /* ignore */ }
    for (const key of Object.keys(links.bySession)) {
      const iso = key.split(":")[0], s = sessionsOfDay(iso)[Number(key.split(":")[1])];
      const a = links.bySession[key][0];
      if (!s || !/CSS test/i.test(s.title) || tried[a.id] || (state.css && state.css.date >= iso)) continue;
      tried[a.id] = 1;
      try {
        const r = await icuCall("intervals", { id: a.id });
        const laps = (r && r.laps) || [];
        const best = m => laps.filter(l => l.distance_m && l.moving_s && Math.abs(l.distance_m - m) <= m * 0.05).reduce((x, l) => Math.min(x, l.moving_s), Infinity);
        const t4 = best(400), t2 = best(200);
        if (isFinite(t4) && isFinite(t2) && t4 > t2) setCss((t4 - t2) / 2, iso, "test", { t400: t4, t200: t2 });
      } catch (e) { delete tried[a.id]; }
    }
    try { localStorage.setItem("htp_css_tried", JSON.stringify(tried)); } catch (e) { /* ignore */ }
  }
  function renderCss() {
    const c = state.css, next = nextCssTest();
    $("cssVal").textContent = c ? TP.fmtPace(c.s) : "—";
    $("cssSub").textContent = c ? "/100m · " + (c.src === "test" ? "from the test on " : "entered ") + prettyDate(c.date) : "not tested yet";
    $("cssSrc").textContent = c ? (c.src === "test" ? "Auto" : "Manual") : "";
    $("cssSrc").hidden = !c;
    $("cssFoot").textContent = (next ? "Next test " + DOW[TP.weekdayMon0(next)] + " " + prettyDate(next) + " — swim it with the watch and this updates itself. " : "") +
      (c ? "Endurance sets on her watch now target " + TP.fmtPace(c.s + 3) + "–" + TP.fmtPace(c.s + 6) + " /100m." : "Until then, swims go to the watch without pace targets.");
  }
  function parseClock(t) {
    const m = String(t || "").trim().match(/^(\d{1,2})[:.](\d{2})$/);
    return m ? Number(m[1]) * 60 + Number(m[2]) : NaN;
  }

  async function initActivitySync() {
    const b = $("icuBtn"); if (!b) return;
    if (!ICU_SYNC_ENABLED) { b.hidden = true; return; }
    b.addEventListener("click", () => { if (ensureEdit()) syncActivities({}); });
    await syncActivities({ quiet: true });
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
    persist(); rerenderAll(); openDrawer(a); schedulePush();
    toast("Swapped with " + DOW[TP.weekdayMon0(b)] + " " + TP.parse(b).getDate() + " " + MON_ABBR[TP.parse(b).getMonth()]);
  }
  function resetDay(iso) {
    delete state.overrides[iso];
    sessionsOfDay(iso).forEach((_, i) => delete state.done[keyFor(iso, i)]);
    persist(); rerenderAll(); openDrawer(iso); schedulePush();
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
      const xs = extrasOn(iso);
      const dots = real.slice(0, 3).map(s => '<i style="background:' + col(s.type) + '"></i>').join("") +
        xs.slice(0, Math.max(0, 4 - Math.min(3, real.length))).map(a => '<i class="xdot" style="--acc:' + col(actType(a)) + '"></i>').join("");
      html += '<button class="' + cls.join(" ") + '" data-iso="' + iso + '" aria-label="' + prettyDate(iso) + (real.length ? ", " + real.length + " session" + (real.length > 1 ? "s" : "") : "") + (xs.length ? ", " + xs.length + " extra workout" + (xs.length > 1 ? "s" : "") : "") + '">' +
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
        pills(s.sub, col(s.type)) + rowActual(iso, idx) + '</span>' +
        (isRest ? CHEV_SVG : '<button class="check-hit" data-iso="' + iso + '" data-idx="' + idx + '" aria-label="Mark ' + esc(shortTitle(s.title)) + ' done"><span class="check' + (dn ? " on" : "") + '">' + CHECK_SVG + '</span></button>') +
      '</div>';
    }).join("");
  }
  // compact version of the actual strip, for list rows
  function rowActual(iso, idx) {
    const l = linkedTo(iso, idx);
    if (!l.length) return "";
    const moved = links.byAct[l[0].id].how === "moved";
    return '<span class="row-act">⌚ ' + (moved ? "Done " + DOW[TP.weekdayMon0(actIso(l[0]))] + " · " : "") +
      esc(l.map(a => actStats(a).slice(0, 2).join(" · ")).join(" + ")) + '</span>';
  }
  function extraRows(iso, cls) {
    return extrasOn(iso).map(a => actRow(a, false).replace('class="row act-row"', 'class="' + cls + ' act-row"')).join("");
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
      el.innerHTML = head + '<div class="card list"><div class="row"><span class="row-main"><span class="row-title">Nothing planned</span>' + pills(["Plan runs 27 Jul 2026 → 9 May 2027"]) + '</span></div>' + extraRows(selIso, "row") + '</div>';
      return;
    }
    const xs = extrasOn(selIso);
    el.innerHTML = head + '<div class="card list">' + sessionRows(selIso, "row").replace(/class="row"/g, 'class="row" data-open role="button" tabindex="0"') + '</div>' +
      (xs.length ? '<div class="card list extras"><div class="list-cap">Also on the watch</div>' + extraRows(selIso, "row") + '</div>' : '');
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
        extraRows(iso, "ag-sess") +
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
        '</div>' + stripFor(isoStr, idx);
      if (hasDetail) {
        html += '<div class="sess-detail">' + steps(s.blocks, col(s.type)) + '</div>' +
          '<button class="sess-toggle"><span class="st-l">' + (open ? "Hide workout" : "Show full workout") + '</span><svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg></button>';
      }
      html += '</div>';
    });
    const xs = extrasOn(isoStr);
    if (xs.length) html += '<div class="card list extras"><div class="list-cap">Also on the watch</div>' + xs.map(a => actRow(a, false)).join("") + '</div>';
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
  const TITLES = { today: "Today", calendar: "Plan", progress: "Progress", blocks: "Journey" };
  function showView(v) {
    document.querySelectorAll(".tab").forEach(t => t.classList.toggle("active", t.getAttribute("data-view") === v));
    $("view-today").hidden = v !== "today";
    $("view-calendar").hidden = v !== "calendar";
    $("view-progress").hidden = v !== "progress";
    $("view-blocks").hidden = v !== "blocks";
    $("nbTitle").textContent = TITLES[v];
    if (v === "blocks") renderBlocks();
    if (v === "today") renderToday();
    if (v === "calendar") { renderPlan(); renderPushStatus(); }
    if (v === "progress") { renderProgress(); renderReview(); }
    window.scrollTo(0, 0);
    try { sessionStorage.setItem("htp_tab", v); } catch (e) { /* ignore */ }
  }
  document.querySelectorAll(".tab").forEach(tab => tab.addEventListener("click", () => {
    const v = tab.getAttribute("data-view");
    if (tab.classList.contains("active")) { window.scrollTo({ top: 0, behavior: "smooth" }); return; }   // iOS: tap active tab → top
    showView(v);
  }));

  $("goalCard").addEventListener("click", () => setFocus(!focusRace));
  $("wpBtn").addEventListener("click", () => pushPlan({}));
  $("cssEdit").addEventListener("click", () => {
    const go = () => { const f = $("cssForm"); f.hidden = !f.hidden; if (!f.hidden) $("css400").focus(); };
    if (ensureEdit(go)) go();
  });
  $("cssSave").addEventListener("click", () => {
    const t4 = parseClock($("css400").value), t2 = parseClock($("css200").value);
    if (!(t4 > t2 && t2 > 0)) { toast("Times as m:ss — the 400 slower than the 200"); return; }
    const css = (t4 - t2) / 2;
    if (css < 60 || css > 240) { toast("That gives an unlikely pace — check the times"); return; }
    $("cssForm").hidden = true;
    setCss(css, today, "manual", { t400: t4, t200: t2 });
  });
  // charts are drawn to their container's width, so redraw when it changes
  let chartTimer = null;
  addEventListener("resize", () => { clearTimeout(chartTimer); chartTimer = setTimeout(renderProgress, 150); });
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
      .map(t => '<span><i class="dot" style="background:' + col(t) + '"></i>' + TP.TYPE_META[t].label + '</span>').join("") +
      '<span><i class="dot xdot" style="--acc:var(--ink-3)"></i>Extra workout</span>';
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
  relink();
  showView(TITLES[startTab] ? startTab : "today");
  renderReview(); renderUpNext(); recomputeStats();
  // Auto-ticking waits for the cloud copy of her ticks — otherwise a slow load
  // would land on top of fresh Garmin ticks and quietly undo them.
  cloudInit().then(initActivitySync).then(() => {
    const p = lastPush();
    if (!p || p.day !== today) pushPlan({ quiet: true });   // backstop for the morning job
  });
  loadReadiness();
})();
