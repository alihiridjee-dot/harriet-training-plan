/* ============================================================
   Harriet's Ironman Journey — UI logic
   Splash · tabs (Calendar / Blocks) · Up Next · adaptive note
   · 80/20 gauge · calendar · drawer · completion + notes.
   Storage is abstracted in `store` for a later Supabase + Garmin swap.
   ============================================================ */
(function () {
  "use strict";
  const STORE_KEY = "htp_v2";
  const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];
  const MON_ABBR = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const DOW = ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"];

  // ---------- storage (swap for Supabase later) ----------
  const store = {
    load() { try { return JSON.parse(localStorage.getItem(STORE_KEY)) || { done:{}, notes:{} }; } catch (e) { return { done:{}, notes:{} }; } },
    save(s) { localStorage.setItem(STORE_KEY, JSON.stringify(s)); }
  };
  let state = store.load();
  function keyFor(iso, idx) { return iso + ":" + idx; }

  const today = TP.iso(new Date());
  let view = new Date(TP.parse(today).getFullYear(), TP.parse(today).getMonth(), 1);
  if (today < TP.PLAN_START) view = new Date(TP.parse(TP.PLAN_START).getFullYear(), TP.parse(TP.PLAN_START).getMonth(), 1);

  // ---------- helpers ----------
  function meta(type) { return TP.TYPE_META[type] || { label: type, color: "#888" }; }
  function sessionsOfDay(iso) { return TP.getDay(iso).sessions; }
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

  function weekAgg(anchorIso) {
    const monday = mondayOf(anchorIso);
    let done = 0, total = 0, easyDone = 0, hardDone = 0, easyPlan = 0, hardPlan = 0;
    for (let i = 0; i < 7; i++) {
      const d = TP.addDays(monday, i);
      sessionsOfDay(d).forEach((x, idx) => {
        if (x.type === "rest") return;
        total++;
        const it = TP.intensityOf(x), isDone = !!state.done[keyFor(d, idx)];
        if (isDone) done++;
        if (it === "easy") { easyPlan++; if (isDone) easyDone++; }
        else if (it === "hard") { hardPlan++; if (isDone) hardDone++; }
      });
    }
    return { done, total, easyDone, hardDone, easyPlan, hardPlan };
  }

  // ---------- stats ----------
  function recomputeStats() {
    let totalDone = 0;
    Object.keys(state.done).forEach(k => { if (state.done[k]) totalDone++; });
    const anchor = today < TP.PLAN_START ? TP.PLAN_START : today;
    const wk = weekAgg(anchor);

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
    document.getElementById("week-bar").style.width = (wk.total ? Math.round((wk.done / wk.total) * 100) : 0) + "%";

    let nextRace = null, nextName = "";
    [[TP.SPRINT_TRI,"Sprint Tri"],[TP.IPSWICH_HALF,"Ipswich Half"],[TP.RACE_703,"Ironman 70.3"]]
      .forEach(([d,n]) => { if (!nextRace && d >= today) { nextRace = d; nextName = n; } });
    const el = document.getElementById("stat-race"), lab = document.getElementById("stat-race-l");
    if (nextRace) { el.textContent = TP.daysBetween(today, nextRace); lab.textContent = "days to " + nextName; }
    else { el.textContent = "🎉"; lab.textContent = "season complete"; }

    renderPolar(anchor);
    renderCoachNote(anchor, wk, streak, wk.total ? Math.round((wk.done / wk.total) * 100) : 0);
  }

  function renderPolar(anchor) {
    const wk = weekAgg(anchor), planTotal = wk.easyPlan + wk.hardPlan;
    let easyPct = 80, hardPct = 20;
    if (planTotal) { easyPct = Math.round((wk.easyPlan / planTotal) * 100); hardPct = 100 - easyPct; }
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
    const lastWeekMon = TP.addDays(mondayOf(anchor), -7), lw = weekAgg(lastWeekMon);
    const lwHasPast = lastWeekMon >= TP.PLAN_START && lastWeekMon < today;
    let cls = "", msg = "";
    if (streak >= 5) { cls = "fire"; msg = streak + "-day streak — you are flying. Keep stacking them."; }
    else if (lwHasPast && lw.total && (lw.done / lw.total) < 0.5) { cls = "easy"; msg = "Last week was lighter — no guilt. We ease back in gently; consistency beats any one session."; }
    else if (pct >= 80 && wk.total) { cls = ""; msg = "This week's basically in the bag — proud of you already. Ready to progress."; }
    else if (wk.total) { cls = ""; msg = "One session at a time. Tick today off and the week takes care of itself."; }
    else { note.classList.add("hide"); return; }
    note.className = "coach-note " + cls; note.textContent = msg;
  }

  // ---------- up next (from today) ----------
  function renderUpNext() {
    const list = document.getElementById("upnextList");
    let html = "", found = 0, cursor = today;
    for (let i = 0; i < 30 && found < 6; i++) {
      const d = cursor, day = TP.getDay(d);
      const real = day.sessions.filter(s => s.type !== "rest");
      if (real.length) {
        const dt = TP.parse(d);
        let chips = "";
        real.slice(0, 2).forEach(s => {
          const mm = meta(s.type);
          chips += '<div class="un-sess"><span class="dot" style="background:' + mm.color + '"></span>' + shortTitle(s.title) + '</div>';
        });
        html += '<div class="un-card tint-' + day.phase.tint + (d === today ? ' is-today' : '') + '" data-iso="' + d + '">' +
          '<div class="un-day">' + (d === today ? 'Today' : DOW[TP.weekdayMon0(d)]) + ' <span>' + dt.getDate() + ' ' + MON_ABBR[dt.getMonth()] + '</span></div>' +
          chips + '</div>';
        found++;
      }
      cursor = TP.addDays(cursor, 1);
    }
    if (!found) { document.getElementById("upnext").style.display = "none"; return; }
    list.innerHTML = html;
    list.querySelectorAll(".un-card").forEach(c => c.addEventListener("click", () => openDrawer(c.getAttribute("data-iso"))));
  }

  // ---------- blocks (macro view) ----------
  function renderBlocks() {
    const wrap = document.getElementById("blocksList");
    const cur = TP.currentBlock(today);
    let html = "";
    TP.BLOCKS.forEach(b => {
      const weeks = Math.max(1, Math.round(TP.daysBetween(b.start, b.end) / 7));
      const s = TP.parse(b.start), e = TP.parse(b.end);
      const span = s.getDate() + " " + MON_ABBR[s.getMonth()] + " → " + e.getDate() + " " + MON_ABBR[e.getMonth()] + " " + e.getFullYear();
      const isNow = b.id === cur;
      html += '<div class="block tint-' + b.tint + '">' +
        '<div class="block-top"><span class="block-n">Block ' + b.n + '</span><h3>' + b.name + '</h3>' +
        (isNow ? '<span class="block-now">you are here</span>' : '') + '</div>' +
        '<div class="block-meta"><span><b>' + span + '</b></span><span>' + weeks + ' weeks</span><span>→ <b>' + b.points + '</b></span></div>' +
        '<div class="block-focus">' + b.focus + '</div>' +
        '<div class="block-key">' + b.key.map(k => '<span>' + k + '</span>').join('') + '</div>' +
        '</div>';
    });
    wrap.innerHTML = html;

    const quotes = [
      "Watching you chase this is the proudest I've ever been.",
      "You don't have to be fast. You just have to keep showing up. And you always do.",
      "Every early alarm, every hard set — I see all of it. You're incredible.",
      "One day I'll watch you cross that finish line and my heart will burst."
    ];
    document.getElementById("aliQuote").textContent = quotes[Math.floor(Math.random() * quotes.length)];
  }

  // ---------- calendar ----------
  function renderCalendar() {
    const y = view.getFullYear(), m = view.getMonth();
    document.getElementById("cal-title").textContent = MONTHS[m] + " " + y;
    const grid = document.getElementById("grid");
    grid.innerHTML = "";
    const first = new Date(y, m, 1), startPad = (first.getDay() + 6) % 7, daysInMonth = new Date(y, m + 1, 0).getDate();
    for (let i = 0; i < startPad; i++) { const c = document.createElement("div"); c.className = "cell empty"; grid.appendChild(c); }
    for (let d = 1; d <= daysInMonth; d++) {
      const isoStr = TP.iso(new Date(y, m, d)), day = TP.getDay(isoStr);
      const cell = document.createElement("div"); cell.className = "cell";
      const real = day.sessions.filter(s => s.type !== "rest");
      if (!day.sessions.length) { cell.className = "cell empty"; cell.innerHTML = '<span class="dnum" style="color:var(--muted)">' + d + '</span>'; grid.appendChild(cell); continue; }
      cell.classList.add(day.phase.tint);
      if (isoStr === today) cell.classList.add("today");
      if (day.sessions.some(s => s.type === "race")) cell.classList.add("race-day");
      else if (real.length === 0) cell.classList.add("rest-day");
      if (allDone(isoStr)) cell.classList.add("all-done");
      else if (isMissed(isoStr)) cell.classList.add("missed");
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

  // ---------- drawer ----------
  const scrim = document.getElementById("scrim"), drawer = document.getElementById("drawer");
  function openDrawer(isoStr) {
    const day = TP.getDay(isoStr), dt = TP.parse(isoStr);
    const head = document.getElementById("drawer-head");
    head.className = "drawer-head ph-" + (day.phase.tint || "");
    document.getElementById("d-phase").textContent = day.phase.label + (day.weekNum ? " · Week " + day.weekNum : "");
    document.getElementById("d-title").textContent = day.dayName;
    document.getElementById("d-date").textContent = dt.getDate() + " " + MONTHS[dt.getMonth()] + " " + dt.getFullYear();
    const ev = document.getElementById("d-event");
    if (day.events.length) { ev.style.display = "inline-block"; ev.textContent = day.events.join(" · "); } else ev.style.display = "none";
    const body = document.getElementById("d-body");
    let html = "";
    if (day.banner) html += '<div class="banner">' + day.banner + '</div>';
    day.sessions.forEach((s, idx) => {
      const mm = meta(s.type), done = !!state.done[keyFor(isoStr, idx)], isRest = s.type === "rest";
      const icon = { run:"🏃‍♀️", bike:"🚴‍♀️", swim:"🏊‍♀️", strength:"💪", mobility:"🧘‍♀️", rest:"🌙", race:"🏁" }[s.type] || "•";
      html += '<div class="sess' + (done ? " done" : "") + (isRest ? " rest-card" : "") + '" data-idx="' + idx + '"><div class="sess-top">' +
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
      '<textarea id="d-notes" placeholder="Times, how the legs felt, anything to remember…"></textarea><div class="saved-tag" id="d-saved"></div></div>';
    body.innerHTML = html;
    body.querySelectorAll(".chk").forEach(cb => {
      cb.addEventListener("click", e => e.stopPropagation());
      cb.addEventListener("change", () => {
        const i = cb.getAttribute("data-idx");
        state.done[keyFor(isoStr, i)] = cb.checked;
        if (!cb.checked) delete state.done[keyFor(isoStr, i)];
        store.save(state);
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
      state.notes[isoStr] = ta.value;
      if (!ta.value) delete state.notes[isoStr];
      clearTimeout(t);
      t = setTimeout(() => { store.save(state); const sv = document.getElementById("d-saved"); sv.textContent = "saved ✓"; setTimeout(() => sv.textContent = "", 1400); }, 400);
    });
    scrim.classList.add("open"); drawer.classList.add("open"); body.scrollTop = 0;
  }
  function closeDrawer() { scrim.classList.remove("open"); drawer.classList.remove("open"); }

  // ---------- tabs ----------
  document.querySelectorAll(".seg").forEach(seg => {
    seg.addEventListener("click", () => {
      document.querySelectorAll(".seg").forEach(s => s.classList.remove("active"));
      seg.classList.add("active");
      const v = seg.getAttribute("data-view");
      document.getElementById("view-calendar").hidden = v !== "calendar";
      document.getElementById("view-blocks").hidden = v !== "blocks";
      if (v === "blocks") renderBlocks();
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
  });

  // ---------- chrome ----------
  document.getElementById("prev").addEventListener("click", () => { view = new Date(view.getFullYear(), view.getMonth() - 1, 1); renderCalendar(); });
  document.getElementById("next").addEventListener("click", () => { view = new Date(view.getFullYear(), view.getMonth() + 1, 1); renderCalendar(); });
  document.getElementById("todayBtn").addEventListener("click", () => {
    const anchor = today < TP.PLAN_START ? TP.PLAN_START : today;
    view = new Date(TP.parse(anchor).getFullYear(), TP.parse(anchor).getMonth(), 1);
    renderCalendar();
    if (sessionsOfDay(anchor).length) openDrawer(anchor);
  });
  scrim.addEventListener("click", closeDrawer);
  document.getElementById("dclose").addEventListener("click", closeDrawer);
  document.addEventListener("keydown", e => { if (e.key === "Escape") closeDrawer(); });
  document.getElementById("resetBtn").addEventListener("click", () => {
    if (confirm("Clear all completed sessions and notes? This can't be undone.")) {
      state = { done:{}, notes:{} }; store.save(state); recomputeStats(); renderCalendar(); renderUpNext();
    }
  });

  (function legend() {
    const el = document.getElementById("legend");
    Object.keys(TP.TYPE_META).forEach(t => { const m = TP.TYPE_META[t]; el.innerHTML += '<span><span class="dot" style="background:' + m.color + '"></span>' + m.label + '</span>'; });
  })();

  // ---------- splash reveal ----------
  (function splash() {
    const el = document.getElementById("splash"), app = document.getElementById("app");
    const reveal = () => { el.classList.add("hidden"); app.classList.add("show"); };
    document.getElementById("splashSkip").addEventListener("click", reveal);
    setTimeout(reveal, 2600);
  })();

  // ---------- go ----------
  renderCalendar(); renderUpNext(); recomputeStats();
})();
