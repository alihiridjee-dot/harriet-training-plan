/* ============================================================
   Harriet's Ironman Journey — UI logic
   Cloud sync (Supabase) · PIN-gated editing · calendar roller
   intro · day swapping · race spotlight · agenda view · blocks.
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

  // ---------- state ----------
  function normalize(d) { d = d || {}; return { done: d.done || {}, notes: d.notes || {}, overrides: d.overrides || {} }; }
  function loadLocal() { try { return normalize(JSON.parse(localStorage.getItem(LOCAL_KEY))); } catch (e) { return normalize(); } }
  function saveLocal() { localStorage.setItem(LOCAL_KEY, JSON.stringify(state)); }
  let state = loadLocal();
  const today = TP.iso(new Date());
  let view = new Date(TP.parse(today).getFullYear(), TP.parse(today).getMonth(), 1);
  if (today < TP.PLAN_START) view = new Date(TP.parse(TP.PLAN_START).getFullYear(), TP.parse(TP.PLAN_START).getMonth(), 1);
  let currentIso = null, focusRace = null, agView = null, rolled = false;

  // ---------- Supabase sync ----------
  let sb = null;
  function setSync(s, label) {
    const pill = document.getElementById("syncPill");
    pill.className = "sync-pill " + s;
    document.getElementById("syncText").textContent = label || ({ live: "synced", saving: "saving…", offline: "offline" }[s] || s);
  }
  let saveTimer = null;
  function persist() {
    saveLocal();
    if (!sb) return;
    setSync("saving");
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      try {
        const { error } = await sb.from("athlete_state").upsert({ id: ATHLETE_ID, data: state, updated_at: new Date().toISOString() });
        setSync(error ? "offline" : "live");
      } catch (e) { setSync("offline"); }
    }, 500);
  }
  async function cloudInit() {
    if (!window.supabase) { setSync("offline", "on-device"); return; }
    try {
      sb = window.supabase.createClient(SB_URL, SB_KEY);
      const { data, error } = await sb.from("athlete_state").select("data").eq("id", ATHLETE_ID).single();
      if (!error && data && data.data) { state = normalize(data.data); saveLocal(); rerenderAll(); }
      setSync(error ? "offline" : "live");
      sb.channel("athlete").on("postgres_changes",
        { event: "*", schema: "public", table: "athlete_state", filter: "id=eq." + ATHLETE_ID },
        payload => { if (payload.new && payload.new.data) { state = normalize(payload.new.data); saveLocal(); rerenderAll(); } }
      ).subscribe();
    } catch (e) { setSync("offline"); }
  }
  function rerenderAll() { renderCalendar(); renderUpNext(); recomputeStats(); if (!document.getElementById("agenda").hidden) renderAgenda(); }

  // ---------- PIN / edit lock ----------
  let editing = sessionStorage.getItem("htp_edit") === "1" || localStorage.getItem("htp_trust") === "1";
  function setLockUI() {
    const b = document.getElementById("editLock"), app = document.getElementById("app");
    if (editing) { b.textContent = "🔓 Editing"; b.classList.add("unlocked"); app.classList.remove("locked"); }
    else { b.textContent = "🔒 View only"; b.classList.remove("unlocked"); app.classList.add("locked"); }
  }
  function openPin() {
    document.getElementById("pinErr").textContent = "";
    document.getElementById("pinInput").value = "";
    document.getElementById("pinScrim").hidden = false;
    setTimeout(() => document.getElementById("pinInput").focus(), 50);
  }
  function closePin() { document.getElementById("pinScrim").hidden = true; }
  function tryPin() {
    if (document.getElementById("pinInput").value === EDIT_PIN) {
      editing = true; sessionStorage.setItem("htp_edit", "1");
      if (document.getElementById("pinTrust").checked) localStorage.setItem("htp_trust", "1");
      setLockUI(); closePin();
      if (currentIso) openDrawer(currentIso);
    } else { document.getElementById("pinErr").textContent = "Wrong PIN — try again"; document.getElementById("pinInput").value = ""; }
  }
  function ensureEdit() { if (editing) return true; openPin(); return false; }

  // ---------- day helpers (with overrides) ----------
  function meta(type) { return TP.TYPE_META[type] || { label: type, color: "#888" }; }
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
  function shortTitle(t) { return t.replace(/^Run — |^Swim — |^Bike — /, "").replace(/^🏁 /, ""); }

  function toggleDone(iso, idx, val) {
    state.done[keyFor(iso, idx)] = val;
    if (!val) delete state.done[keyFor(iso, idx)];
    persist();
  }

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
  }
  function resetDay(iso) {
    delete state.overrides[iso];
    sessionsOfDay(iso).forEach((_, i) => delete state.done[keyFor(iso, i)]);
    persist(); rerenderAll(); openDrawer(iso);
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
        const it = TP.intensityOf(x), isDone = !!state.done[keyFor(d, idx)];
        if (isDone) done++;
        if (it === "easy") easyPlan++; else if (it === "hard") hardPlan++;
      });
    }
    return { done, total, easyPlan, hardPlan };
  }
  function recomputeStats() {
    let totalDone = 0; Object.keys(state.done).forEach(k => { if (state.done[k]) totalDone++; });
    const anchor = today < TP.PLAN_START ? TP.PLAN_START : today, wk = weekAgg(anchor);
    let streak = 0, cursor = today;
    for (let i = 0; i < 400; i++) {
      if (cursor < TP.PLAN_START) break;
      const ss = sessionsOfDay(cursor);
      if (!ss.length) { cursor = TP.addDays(cursor, -1); continue; }
      const ok = ss.every((x, idx) => x.type === "rest" || state.done[keyFor(cursor, idx)]);
      if (ok) { streak++; cursor = TP.addDays(cursor, -1); } else break;
    }
    document.getElementById("stat-total").textContent = totalDone;
    document.getElementById("stat-week").textContent = wk.done + "/" + wk.total;
    document.getElementById("stat-streak").textContent = streak;
    document.getElementById("week-bar").style.width = (wk.total ? Math.round(wk.done / wk.total * 100) : 0) + "%";
    let nextRace = null, nextName = "";
    [[TP.SPRINT_TRI,"Sprint Tri"],[TP.IPSWICH_HALF,"Ipswich Half"],[TP.RACE_703,"Ironman 70.3"]]
      .forEach(([d,n]) => { if (!nextRace && d >= today) { nextRace = d; nextName = n; } });
    const el = document.getElementById("stat-race"), lab = document.getElementById("stat-race-l");
    if (nextRace) { el.textContent = TP.daysBetween(today, nextRace); lab.textContent = "days to " + nextName; }
    else { el.textContent = "🎉"; lab.textContent = "season complete"; }
    renderPolar(anchor); renderCoachNote(anchor, wk, streak, wk.total ? Math.round(wk.done / wk.total * 100) : 0);
  }
  function renderPolar(anchor) {
    const wk = weekAgg(anchor), planTotal = wk.easyPlan + wk.hardPlan;
    let easyPct = 80; if (planTotal) easyPct = Math.round(wk.easyPlan / planTotal * 100);
    const hardPct = 100 - easyPct;
    document.getElementById("pbEasy").style.width = easyPct + "%";
    document.getElementById("pbHard").style.width = hardPct + "%";
    document.getElementById("pbEasyPct").textContent = easyPct + "%";
    document.getElementById("pbHardPct").textContent = hardPct + "%";
    const badge = document.getElementById("polarBadge"), sub = document.getElementById("polarSub");
    if (!planTotal) { badge.textContent = "rest week"; badge.className = "polar-badge off"; sub.textContent = "Recovery — the easy weeks are where fitness sticks."; return; }
    if (easyPct >= 75) { badge.textContent = "polarized ✓"; badge.className = "polar-badge"; sub.textContent = "Textbook Seiler — mostly easy so the hard days land hard."; }
    else { badge.textContent = easyPct + "/" + hardPct; badge.className = "polar-badge off"; sub.textContent = "A punchier week — a little more quality than usual."; }
  }
  function renderCoachNote(anchor, wk, streak, pct) {
    const note = document.getElementById("coachNote");
    const lwMon = TP.addDays(mondayOf(anchor), -7), lw = weekAgg(lwMon);
    const lwPast = lwMon >= TP.PLAN_START && lwMon < today;
    let cls = "", msg = "";
    if (streak >= 5) { cls = "fire"; msg = streak + "-day streak — you are flying. Keep stacking them."; }
    else if (lwPast && lw.total && lw.done / lw.total < 0.5) { cls = "easy"; msg = "Last week was lighter — no guilt. We ease back in gently; consistency beats any one session."; }
    else if (pct >= 80 && wk.total) { msg = "This week's basically in the bag — proud of you already. Ready to progress."; }
    else if (wk.total) { msg = "One session at a time. Tick today off and the week takes care of itself."; }
    else { note.classList.add("hide"); return; }
    note.className = "coach-note " + cls; note.textContent = msg;
  }

  // ---------- up next ----------
  function renderUpNext() {
    const list = document.getElementById("upnextList");
    let html = "", found = 0, cursor = today;
    for (let i = 0; i < 30 && found < 6; i++) {
      const d = cursor, day = dayOf(d), real = day.sessions.filter(s => s.type !== "rest");
      if (real.length) {
        const dt = TP.parse(d);
        let chips = "";
        real.slice(0, 2).forEach(s => { const mm = meta(s.type); chips += '<div class="un-sess"><span class="dot" style="background:' + mm.color + '"></span>' + shortTitle(s.title) + '</div>'; });
        html += '<div class="un-card tint-' + day.phase.tint + (d === today ? ' is-today' : '') + '" data-iso="' + d + '">' +
          '<div class="un-day">' + (d === today ? 'Today' : DOW[TP.weekdayMon0(d)]) + ' <span>' + dt.getDate() + ' ' + MON_ABBR[dt.getMonth()] + '</span></div>' + chips + '</div>';
        found++;
      }
      cursor = TP.addDays(cursor, 1);
    }
    if (!found) { document.getElementById("upnext").style.display = "none"; return; }
    list.innerHTML = html;
    list.querySelectorAll(".un-card").forEach(c => c.addEventListener("click", () => openDrawer(c.getAttribute("data-iso"))));
  }

  // ---------- race spotlight ----------
  function isKeyDay(race, iso, day) {
    if (!day.sessions.length) return false;
    const hardLong = day.sessions.some(s => s.type === "race" || TP.intensityOf(s) === "hard" || /long|brick/i.test(s.title));
    if (!hardLong) return false;
    const tint = day.phase.tint;
    if (race === "iron") return tint === "build" || tint === "taper";
    return tint === "p1"; // sprint & half both sit in the sharpen block
  }
  function setFocus(race) {
    if (focusRace === race) { focusRace = null; } else { focusRace = race; }
    document.querySelectorAll(".goal-btn").forEach(b => b.classList.toggle("active", b.getAttribute("data-race") === focusRace));
    const banner = document.getElementById("focusBanner");
    if (focusRace) {
      const label = { sprint: "Sprint Triathlon", half: "Ipswich Half", iron: "Ironman 70.3" }[focusRace];
      const raceIso = { sprint: TP.SPRINT_TRI, half: TP.IPSWICH_HALF, iron: TP.RACE_703 }[focusRace];
      document.getElementById("focusText").textContent = "Spotlighting the key sessions building to your " + label;
      banner.hidden = false;
      view = new Date(TP.parse(raceIso).getFullYear(), TP.parse(raceIso).getMonth(), 1);
    } else banner.hidden = true;
    renderCalendar();
  }

  // ---------- calendar ----------
  function renderCalendar() {
    const y = view.getFullYear(), m = view.getMonth();
    document.getElementById("cal-title").textContent = MONTHS[m] + " " + y;
    const grid = document.getElementById("grid"); grid.innerHTML = "";
    const first = new Date(y, m, 1), startPad = (first.getDay() + 6) % 7, daysInMonth = new Date(y, m + 1, 0).getDate();
    for (let i = 0; i < startPad; i++) { const c = document.createElement("div"); c.className = "cell empty"; grid.appendChild(c); }
    for (let d = 1; d <= daysInMonth; d++) {
      const isoStr = TP.iso(new Date(y, m, d)), day = dayOf(isoStr);
      const cell = document.createElement("div"); cell.className = "cell";
      const real = day.sessions.filter(s => s.type !== "rest");
      if (!day.sessions.length) { cell.className = "cell empty"; cell.innerHTML = '<span class="dnum" style="color:var(--muted)">' + d + '</span>'; grid.appendChild(cell); continue; }
      cell.classList.add(day.phase.tint);
      if (isoStr === today) cell.classList.add("today");
      if (day.sessions.some(s => s.type === "race")) cell.classList.add("race-day");
      else if (real.length === 0) cell.classList.add("rest-day");
      if (allDone(isoStr)) cell.classList.add("all-done");
      else if (isMissed(isoStr)) cell.classList.add("missed");
      if (day.swapped) cell.classList.add("swapped");
      if (focusRace) cell.classList.add(isKeyDay(focusRace, isoStr, day) ? "focus" : "dim");
      let chips = "";
      day.sessions.slice(0, 3).forEach((s, idx) => {
        const done = state.done[keyFor(isoStr, idx)], mm = meta(s.type);
        chips += '<div class="chip' + (done ? " done" : "") + '"><span class="dot" style="background:' + mm.color + '"></span>' + shortTitle(s.title) + '</div>';
      });
      if (day.sessions.length > 3) chips += '<div class="chip" style="color:var(--muted)">+' + (day.sessions.length - 3) + ' more</div>';
      cell.innerHTML = '<span class="dnum">' + d + '</span>' +
        (day.sessions.some(s => s.type === "race") ? '<span class="star">🏁</span>' : '') +
        '<span class="heart-bloom">♥</span><div class="chips">' + chips + '</div>';
      cell.addEventListener("click", () => openDrawer(isoStr));
      grid.appendChild(cell);
    }
  }

  // ---------- flip-calendar (lives inside the calendar card) ----------
  const WD_FULL = ["SUNDAY","MONDAY","TUESDAY","WEDNESDAY","THURSDAY","FRIDAY","SATURDAY"];
  function fcSet(d) {
    document.getElementById("fcWeekday").textContent = WD_FULL[d.getDay()];
    document.getElementById("fcDay").textContent = d.getDate();
    document.getElementById("fcMonth").textContent = MONTHS[d.getMonth()].toUpperCase();
    document.getElementById("fcYear").textContent = d.getFullYear();
  }
  function fcRandom() { const y = Math.random() < 0.5 ? 2026 : 2027; return new Date(y, Math.floor(Math.random() * 12), 1 + Math.floor(Math.random() * 28), 12); }
  // Flips smoothly through dates, lands on today, then the card opens into the month grid.
  function openCalendar() {
    if (rolled) return; rolled = true;
    const page = document.getElementById("fcPage"), flip = document.getElementById("flipCal"), stage = document.getElementById("calStage");
    const todayDt = TP.parse(today);
    const seq = []; for (let i = 0; i < 9; i++) seq.push(150 + i * i * 3.4); // fewer, decelerating = smoother
    const DOWN = "cubic-bezier(.32,0,.67,0)", UP = "cubic-bezier(.33,1,.68,1)";
    let i = 0;
    (function step() {
      const last = i >= seq.length, dur = last ? 460 : seq[i];
      page.style.transition = "transform " + (dur * 0.52) + "ms " + DOWN;
      page.style.transform = "rotateX(-90deg)";                     // page falls at the binding
      setTimeout(() => {
        fcSet(last ? todayDt : fcRandom());
        page.style.transition = "transform " + (dur * 0.48) + "ms " + UP;
        page.style.transform = "rotateX(0deg)";                     // new page settles
        if (last) { page.classList.add("land"); setTimeout(() => { flip.classList.add("gone"); stage.classList.add("opened"); }, 640); }
        else { i++; setTimeout(step, dur * 0.48 + 26); }
      }, dur * 0.52);
    })();
  }
  function armCalendarFlip() {
    // bring the calendar into view first, then flip it open — so the animation is always seen
    document.querySelector(".cal-card").scrollIntoView({ behavior: "smooth", block: "start" });
    setTimeout(openCalendar, 720);
  }

  // ---------- blocks ----------
  function renderBlocks() {
    const wrap = document.getElementById("blocksList"), cur = TP.currentBlock(today);
    let html = "";
    TP.BLOCKS.forEach(b => {
      const weeks = Math.max(1, Math.round(TP.daysBetween(b.start, b.end) / 7));
      const s = TP.parse(b.start), e = TP.parse(b.end);
      const span = s.getDate() + " " + MON_ABBR[s.getMonth()] + " → " + e.getDate() + " " + MON_ABBR[e.getMonth()] + " " + e.getFullYear();
      html += '<div class="block tint-' + b.tint + '"><div class="block-top"><span class="block-n">Block ' + b.n + '</span><h3>' + b.name + '</h3>' +
        (b.id === cur ? '<span class="block-now">you are here</span>' : '') + '</div>' +
        '<div class="block-meta"><span><b>' + span + '</b></span><span>' + weeks + ' weeks</span><span>→ <b>' + b.points + '</b></span></div>' +
        '<div class="block-focus">' + b.focus + '</div><div class="block-key">' + b.key.map(k => '<span>' + k + '</span>').join('') + '</div></div>';
    });
    wrap.innerHTML = html;
    document.getElementById("aliQuote").textContent = "There is no way around the hard work. Embrace it.";
  }

  // ---------- drawer ----------
  const scrim = document.getElementById("scrim"), drawer = document.getElementById("drawer");
  function buildSwapPicker(isoStr) {
    const picker = document.getElementById("swapPicker");
    let days = "";
    for (let off = -42; off <= 42; off++) {
      if (off === 0) continue;
      const d = TP.addDays(isoStr, off);
      if (!sessionsOfDay(d).filter(s => s.type !== "rest").length) continue;
      const dt = TP.parse(d);
      days += '<button class="sp-day" data-iso="' + d + '"><small>' + DOW[TP.weekdayMon0(d)] + '</small>' + dt.getDate() + ' ' + MON_ABBR[dt.getMonth()] + '</button>';
    }
    picker.innerHTML = '<div class="sp-label">Swap this whole day with any day…</div><div class="swap-days">' + days + '</div>';
    picker.querySelectorAll(".sp-day").forEach(b => b.addEventListener("click", () => { if (ensureEdit()) swapDays(isoStr, b.getAttribute("data-iso")); }));
  }
  function openDrawer(isoStr) {
    currentIso = isoStr;
    const day = dayOf(isoStr), dt = TP.parse(isoStr);
    document.getElementById("drawer-head").className = "drawer-head ph-" + (day.phase.tint || "");
    document.getElementById("d-phase").textContent = day.phase.label + (day.weekNum ? " · Week " + day.weekNum : "") + (day.swapped ? " · swapped" : "");
    document.getElementById("d-title").textContent = day.dayName;
    document.getElementById("d-date").textContent = dt.getDate() + " " + MONTHS[dt.getMonth()] + " " + dt.getFullYear();
    const ev = document.getElementById("d-event");
    if (day.events.length) { ev.style.display = "inline-block"; ev.textContent = day.events.join(" · "); } else ev.style.display = "none";
    document.getElementById("resetDayBtn").hidden = !day.swapped;
    document.getElementById("swapPicker").hidden = true;
    buildSwapPicker(isoStr);

    const body = document.getElementById("d-body");
    let html = "";
    if (day.banner) html += '<div class="banner">' + day.banner + '</div>';
    day.sessions.forEach((s, idx) => {
      const mm = meta(s.type), done = !!state.done[keyFor(isoStr, idx)], isRest = s.type === "rest";
      const icon = { run:"🏃‍♀️", bike:"🚴‍♀️", swim:"🏊‍♀️", strength:"💪", mobility:"🧘‍♀️", rest:"🌙", race:"🏁" }[s.type] || "•";
      html += '<div class="sess' + (done ? " done" : "") + (isRest ? " rest-card" : "") + '"><div class="sess-top">' +
        '<div class="sess-badge" style="background:' + mm.color + '">' + icon + '</div>' +
        '<div class="sess-main"><div class="stype" style="color:' + mm.color + '">' + mm.label + '</div><h4>' + s.title + '</h4>' +
        (s.sub ? '<div class="ssub">' + s.sub + '</div>' : '') + '</div>' +
        (!isRest ? '<div class="sess-check"><input type="checkbox" class="chk" ' + (done ? "checked" : "") + ' data-idx="' + idx + '"></div>' : '') + '</div>';
      if (s.blocks && s.blocks.length) {
        html += '<div class="expand-hint">tap for the full workout ▾</div><div class="sess-detail">';
        s.blocks.forEach(b => { html += '<div class="sblock"><div class="lab">' + b.label + '</div><div>' + b.text + '</div></div>'; });
        html += '</div>';
      }
      html += '</div>';
    });
    html += '<div class="notes-wrap"><label for="d-notes">How did it go? — your notes</label>' +
      '<textarea id="d-notes" placeholder="Times, how the legs felt, anything to remember…"' + (editing ? "" : " readonly") + '></textarea><div class="saved-tag" id="d-saved"></div></div>';
    body.innerHTML = html;

    body.querySelectorAll(".chk").forEach(cb => {
      cb.addEventListener("click", e => e.stopPropagation());
      cb.addEventListener("change", () => {
        if (!editing) { cb.checked = !cb.checked; openPin(); return; }
        toggleDone(isoStr, cb.getAttribute("data-idx"), cb.checked);
        cb.closest(".sess").classList.toggle("done", cb.checked);
        recomputeStats(); renderCalendar(); renderUpNext();
      });
    });
    body.querySelectorAll(".sess").forEach(card => {
      if (!card.querySelector(".sess-detail")) return;
      card.querySelector(".sess-top").addEventListener("click", () => card.classList.toggle("expanded"));
      const hint = card.querySelector(".expand-hint");
      if (hint) hint.addEventListener("click", () => card.classList.toggle("expanded"));
    });
    const ta = document.getElementById("d-notes"); ta.value = state.notes[isoStr] || "";
    let t = null;
    ta.addEventListener("input", () => {
      if (!editing) return;
      state.notes[isoStr] = ta.value; if (!ta.value) delete state.notes[isoStr];
      clearTimeout(t); t = setTimeout(() => { persist(); const sv = document.getElementById("d-saved"); sv.textContent = "saved ✓"; setTimeout(() => sv.textContent = "", 1400); }, 400);
    });
    ta.addEventListener("focus", () => { if (!editing) openPin(); });

    scrim.classList.add("open"); drawer.classList.add("open"); body.scrollTop = 0;
  }
  function closeDrawer() { scrim.classList.remove("open"); drawer.classList.remove("open"); document.getElementById("swapPicker").hidden = true; }

  // ---------- agenda (full day-by-day) ----------
  function renderAgenda() {
    const y = agView.getFullYear(), m = agView.getMonth();
    document.getElementById("agTitle").textContent = MONTHS[m] + " " + y;
    const body = document.getElementById("agendaBody"); body.innerHTML = "";
    const daysInMonth = new Date(y, m + 1, 0).getDate();
    let any = false;
    for (let d = 1; d <= daysInMonth; d++) {
      const iso = TP.iso(new Date(y, m, d)), day = dayOf(iso);
      if (!day.sessions.length) continue;
      any = true;
      const dt = TP.parse(iso), done = allDone(iso);
      const card = document.createElement("div");
      card.className = "ag-day tint-" + day.phase.tint + (iso === today ? " is-today" : "") + (done ? " done" : "");
      let h = '<div class="ag-date"><b>' + DOW[TP.weekdayMon0(iso)] + " " + d + '</b><span>' + MON_ABBR[m] + " · " + day.phase.label + (day.weekNum ? " · Wk " + day.weekNum : "") + '</span>' +
        (day.events.length ? '<span class="ag-ev">' + day.events.join(" · ") + '</span>' : '') + '</div>';
      day.sessions.forEach((s, idx) => {
        const mm = meta(s.type), isRest = s.type === "rest", dn = !!state.done[keyFor(iso, idx)];
        const icon = { run:"🏃‍♀️", bike:"🚴‍♀️", swim:"🏊‍♀️", strength:"💪", mobility:"🧘‍♀️", rest:"🌙", race:"🏁" }[s.type] || "•";
        h += '<div class="ag-sess"><div class="ag-badge" style="background:' + mm.color + '">' + icon + '</div><div class="ag-info"><h4>' + s.title + '</h4>' +
          (s.sub ? '<div class="ssub">' + s.sub + '</div>' : '');
        if (s.blocks && s.blocks.length) { h += '<div class="ag-blocks">' + s.blocks.map(b => '<b>' + b.label + ':</b> ' + b.text).join("<br>") + '</div>'; }
        h += '</div>' + (!isRest ? '<input type="checkbox" class="ag-chk" data-iso="' + iso + '" data-idx="' + idx + '" ' + (dn ? "checked" : "") + '>' : '') + '</div>';
      });
      card.innerHTML = h;
      body.appendChild(card);
    }
    if (!any) body.innerHTML = '<p class="hint" style="text-align:center;padding:40px">No sessions this month — the plan runs 27 Jul 2026 → 9 May 2027.</p>';
    body.querySelectorAll(".ag-chk").forEach(cb => cb.addEventListener("change", () => {
      if (!editing) { cb.checked = !cb.checked; openPin(); return; }
      toggleDone(cb.getAttribute("data-iso"), cb.getAttribute("data-idx"), cb.checked);
      cb.closest(".ag-day").classList.toggle("done", allDone(cb.getAttribute("data-iso")));
      recomputeStats(); renderCalendar(); renderUpNext();
    }));
  }
  function openAgenda() { agView = new Date(view.getFullYear(), view.getMonth(), 1); document.getElementById("agenda").hidden = false; renderAgenda(); }
  function closeAgenda() { document.getElementById("agenda").hidden = true; }

  // ---------- wiring ----------
  document.querySelectorAll(".seg").forEach(seg => seg.addEventListener("click", () => {
    document.querySelectorAll(".seg").forEach(s => s.classList.remove("active"));
    seg.classList.add("active");
    const v = seg.getAttribute("data-view");
    document.getElementById("view-calendar").hidden = v !== "calendar";
    document.getElementById("view-blocks").hidden = v !== "blocks";
    if (v === "blocks") renderBlocks();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }));
  document.querySelectorAll(".goal-btn").forEach(b => b.addEventListener("click", () => setFocus(b.getAttribute("data-race"))));
  document.getElementById("focusClear").addEventListener("click", () => setFocus(focusRace));
  document.getElementById("prev").addEventListener("click", () => { view = new Date(view.getFullYear(), view.getMonth() - 1, 1); renderCalendar(); });
  document.getElementById("next").addEventListener("click", () => { view = new Date(view.getFullYear(), view.getMonth() + 1, 1); renderCalendar(); });
  document.getElementById("todayBtn").addEventListener("click", () => {
    const anchor = today < TP.PLAN_START ? TP.PLAN_START : today;
    view = new Date(TP.parse(anchor).getFullYear(), TP.parse(anchor).getMonth(), 1);
    renderCalendar(); if (sessionsOfDay(anchor).length) openDrawer(anchor);
  });
  document.getElementById("expandBtn").addEventListener("click", openAgenda);
  document.getElementById("agClose").addEventListener("click", closeAgenda);
  document.getElementById("agPrev").addEventListener("click", () => { agView = new Date(agView.getFullYear(), agView.getMonth() - 1, 1); renderAgenda(); });
  document.getElementById("agNext").addEventListener("click", () => { agView = new Date(agView.getFullYear(), agView.getMonth() + 1, 1); renderAgenda(); });
  document.getElementById("swapBtn").addEventListener("click", () => { const p = document.getElementById("swapPicker"); p.hidden = !p.hidden; });
  document.getElementById("resetDayBtn").addEventListener("click", () => { if (ensureEdit() && currentIso) resetDay(currentIso); });
  scrim.addEventListener("click", closeDrawer);
  document.getElementById("dclose").addEventListener("click", closeDrawer);
  document.addEventListener("keydown", e => { if (e.key === "Escape") { closeDrawer(); closeAgenda(); closePin(); } });
  document.getElementById("resetBtn").addEventListener("click", () => {
    if (!ensureEdit()) return;
    if (confirm("Clear all completed sessions, notes and swaps? This can't be undone.")) {
      state = normalize(); persist(); rerenderAll();
    }
  });
  document.getElementById("editLock").addEventListener("click", () => {
    if (editing) { editing = false; sessionStorage.removeItem("htp_edit"); setLockUI(); if (currentIso && drawer.classList.contains("open")) openDrawer(currentIso); }
    else openPin();
  });
  document.getElementById("pinOk").addEventListener("click", tryPin);
  document.getElementById("pinCancel").addEventListener("click", closePin);
  document.getElementById("pinScrim").addEventListener("click", e => { if (e.target.id === "pinScrim") closePin(); });
  document.getElementById("pinInput").addEventListener("keydown", e => { if (e.key === "Enter") tryPin(); });

  (function legend() {
    const el = document.getElementById("legend");
    Object.keys(TP.TYPE_META).forEach(t => { const m = TP.TYPE_META[t]; el.innerHTML += '<span><span class="dot" style="background:' + m.color + '"></span>' + m.label + '</span>'; });
  })();

  // ---------- splash + init ----------
  (function splash() {
    const el = document.getElementById("splash"), app = document.getElementById("app");
    const reveal = () => { if (app.classList.contains("show")) return; el.classList.add("hidden"); app.classList.add("show"); setTimeout(armCalendarFlip, 340); };
    document.getElementById("splashSkip").addEventListener("click", reveal);   // user actively enters
  })();

  setLockUI();
  fcSet(TP.parse(today));                 // seed the flip card so it's never blank
  renderCalendar(); renderUpNext(); recomputeStats();
  cloudInit();
})();
