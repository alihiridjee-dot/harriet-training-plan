/* ============================================================
   Harriet's Training Plan — UI logic
   Renders the calendar, opens the day drawer, tracks completion
   and per-day notes in localStorage.
   ============================================================ */
(function () {
  "use strict";
  const STORE_KEY = "htp_v1";
  const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];
  const WD = ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"];

  // ---------- storage ----------
  function load() { try { return JSON.parse(localStorage.getItem(STORE_KEY)) || { done:{}, notes:{} }; } catch (e) { return { done:{}, notes:{} }; } }
  function save(s) { localStorage.setItem(STORE_KEY, JSON.stringify(s)); }
  let state = load();
  function keyFor(iso, idx) { return iso + ":" + idx; }

  // ---------- current view ----------
  const today = TP.iso(new Date());
  let view = new Date(TP.parse(today).getFullYear(), TP.parse(today).getMonth(), 1);
  // clamp initial view to plan start month if today is before the plan
  if (today < TP.PLAN_START) view = new Date(TP.parse(TP.PLAN_START).getFullYear(), TP.parse(TP.PLAN_START).getMonth(), 1);

  // ---------- helpers ----------
  function meta(type) { return TP.TYPE_META[type] || { label: type, color: "#888" }; }
  function dayIsActionable(day) { return day.sessions.some(s => s.type !== "rest" && s.type !== "mobility"); }

  function sessionsOfDay(iso) { return TP.getDay(iso).sessions; }
  function completedCount(iso) {
    const s = sessionsOfDay(iso); let c = 0;
    s.forEach((_, i) => { if (state.done[keyFor(iso, i)]) c++; });
    return c;
  }
  function allDone(iso) {
    const s = sessionsOfDay(iso);
    const real = s.filter(x => x.type !== "rest");
    if (!real.length) return false;
    return s.every((x, i) => x.type === "rest" || state.done[keyFor(iso, i)]);
  }

  // ---------- stats ----------
  function recomputeStats() {
    // sessions completed to date, current-week completion, streak
    let totalDone = 0;
    Object.keys(state.done).forEach(k => { if (state.done[k]) totalDone++; });

    // this week (Mon–Sun containing today or plan start)
    const anchor = today < TP.PLAN_START ? TP.PLAN_START : today;
    const monday = TP.addDays(anchor, -TP.weekdayMon0(anchor));
    let wkDone = 0, wkTotal = 0;
    for (let i = 0; i < 7; i++) {
      const d = TP.addDays(monday, i);
      const ss = sessionsOfDay(d).filter(x => x.type !== "rest");
      wkTotal += ss.length;
      sessionsOfDay(d).forEach((x, idx) => { if (x.type !== "rest" && state.done[keyFor(d, idx)]) wkDone++; });
    }

    // streak: consecutive past days (up to today) that are fully done (rest days count as done)
    let streak = 0;
    let cursor = today;
    for (let i = 0; i < 400; i++) {
      if (cursor < TP.PLAN_START) break;
      const ss = sessionsOfDay(cursor);
      if (!ss.length) { cursor = TP.addDays(cursor, -1); continue; }
      const ok = ss.every((x, idx) => x.type === "rest" || state.done[keyFor(cursor, idx)]);
      if (ok) { streak++; cursor = TP.addDays(cursor, -1); } else break;
    }

    document.getElementById("stat-total").textContent = totalDone;
    document.getElementById("stat-week").textContent = wkDone + "/" + wkTotal;
    document.getElementById("stat-streak").textContent = streak;
    const pct = wkTotal ? Math.round((wkDone / wkTotal) * 100) : 0;
    document.getElementById("week-bar").style.width = pct + "%";

    // days to next race
    let nextRace = null, nextName = "";
    [[TP.SPRINT_TRI, "Sprint Tri"], [TP.IPSWICH_HALF, "Ipswich Half"], [TP.RACE_703, "Ironman 70.3"]]
      .forEach(([d, n]) => { if (!nextRace && d >= today) { nextRace = d; nextName = n; } });
    const el = document.getElementById("stat-race");
    const lab = document.getElementById("stat-race-l");
    if (nextRace) { el.textContent = TP.daysBetween(today, nextRace); lab.textContent = "days to " + nextName; }
    else { el.textContent = "🎉"; lab.textContent = "season complete"; }
  }

  // ---------- calendar ----------
  function renderCalendar() {
    const y = view.getFullYear(), m = view.getMonth();
    document.getElementById("cal-title").textContent = MONTHS[m] + " " + y;
    const grid = document.getElementById("grid");
    grid.innerHTML = "";

    const first = new Date(y, m, 1);
    const startPad = (first.getDay() + 6) % 7; // Mon=0
    const daysInMonth = new Date(y, m + 1, 0).getDate();

    for (let i = 0; i < startPad; i++) {
      const c = document.createElement("div"); c.className = "cell empty"; grid.appendChild(c);
    }
    for (let d = 1; d <= daysInMonth; d++) {
      const isoStr = TP.iso(new Date(y, m, d));
      const day = TP.getDay(isoStr);
      const cell = document.createElement("div");
      cell.className = "cell";
      const real = day.sessions.filter(s => s.type !== "rest");
      if (!day.sessions.length) { cell.className = "cell empty"; cell.innerHTML = '<span class="dnum" style="color:var(--muted)">' + d + '</span>'; grid.appendChild(cell); continue; }

      cell.classList.add(day.phase.tint);
      if (isoStr === today) cell.classList.add("today");
      if (day.sessions.some(s => s.type === "race")) cell.classList.add("race-day");
      else if (real.length === 0) cell.classList.add("rest-day");
      if (allDone(isoStr)) cell.classList.add("all-done");

      let chips = "";
      day.sessions.slice(0, 3).forEach((s, idx) => {
        const done = state.done[keyFor(isoStr, idx)];
        const mm = meta(s.type);
        const shortT = s.title.replace(/^Run — |^Swim — |^Bike — /, "").replace(/^🏁 /, "");
        chips += '<div class="chip' + (done ? " done" : "") + '"><span class="dot" style="background:' + mm.color + '"></span>' + shortT + '</div>';
      });
      if (day.sessions.length > 3) chips += '<div class="chip" style="color:var(--muted)">+' + (day.sessions.length - 3) + ' more</div>';

      cell.innerHTML =
        '<span class="dnum">' + d + '</span>' +
        (day.sessions.some(s => s.type === "race") ? '<span class="star">★</span>' : '') +
        '<span class="done-ring"><svg viewBox="0 0 12 12"><path d="M2 6l3 3 5-6" stroke="#fff" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg></span>' +
        '<div class="chips">' + chips + '</div>';

      cell.addEventListener("click", () => openDrawer(isoStr));
      grid.appendChild(cell);
    }
  }

  // ---------- drawer ----------
  const scrim = document.getElementById("scrim");
  const drawer = document.getElementById("drawer");
  let currentIso = null;

  function openDrawer(isoStr) {
    currentIso = isoStr;
    const day = TP.getDay(isoStr);
    const dt = TP.parse(isoStr);
    document.getElementById("d-phase").textContent = day.phase.label + (day.weekNum ? " · Week " + day.weekNum : "");
    document.getElementById("d-title").textContent = day.dayName;
    document.getElementById("d-date").textContent = dt.getDate() + " " + MONTHS[dt.getMonth()] + " " + dt.getFullYear();
    const ev = document.getElementById("d-event");
    if (day.events.length) { ev.style.display = "inline-block"; ev.textContent = day.events.join(" · "); }
    else ev.style.display = "none";

    const body = document.getElementById("d-body");
    let html = "";
    if (day.banner) html += '<div class="banner">' + day.banner + '</div>';

    day.sessions.forEach((s, idx) => {
      const mm = meta(s.type);
      const done = !!state.done[keyFor(isoStr, idx)];
      const isRest = s.type === "rest";
      const icon = { run:"🏃", bike:"🚴", swim:"🏊", strength:"💪", mobility:"🧘", rest:"☾", race:"🏁" }[s.type] || "•";
      html += '<div class="sess' + (done ? " done" : "") + (isRest ? " rest-card" : "") + '" data-idx="' + idx + '">';
      html += '<div class="sess-top">';
      html += '<div class="sess-badge" style="background:' + mm.color + '">' + icon + '</div>';
      html += '<div class="sess-main"><div class="stype" style="color:' + mm.color + '">' + mm.label + '</div>';
      html += '<h4>' + s.title + '</h4>' + (s.sub ? '<div class="ssub">' + s.sub + '</div>' : '') + '</div>';
      if (!isRest) html += '<div class="sess-check"><input type="checkbox" class="chk" ' + (done ? "checked" : "") + ' data-idx="' + idx + '"></div>';
      html += '</div>';
      if (s.blocks && s.blocks.length) {
        html += '<div class="expand-hint">tap for the full workout ▾</div>';
        html += '<div class="sess-detail">';
        s.blocks.forEach(b => { html += '<div class="sblock"><div class="lab">' + b.label + '</div><div>' + b.text + '</div></div>'; });
        html += '</div>';
      }
      html += '</div>';
    });

    // notes
    html += '<div class="notes-wrap"><label for="d-notes">How did it go? — your notes</label>' +
            '<textarea id="d-notes" placeholder="Times, how the legs felt, anything to remember…"></textarea>' +
            '<div class="saved-tag" id="d-saved"></div></div>';

    body.innerHTML = html;

    // wire checkboxes
    body.querySelectorAll(".chk").forEach(cb => {
      cb.addEventListener("click", e => e.stopPropagation());
      cb.addEventListener("change", () => {
        const i = cb.getAttribute("data-idx");
        state.done[keyFor(isoStr, i)] = cb.checked;
        if (!cb.checked) delete state.done[keyFor(isoStr, i)];
        save(state);
        cb.closest(".sess").classList.toggle("done", cb.checked);
        recomputeStats(); renderCalendar();
      });
    });
    // expand/collapse on card tap (not on checkbox)
    body.querySelectorAll(".sess").forEach(card => {
      const detail = card.querySelector(".sess-detail");
      if (!detail) return;
      card.querySelector(".sess-top").addEventListener("click", () => card.classList.toggle("expanded"));
      const hint = card.querySelector(".expand-hint");
      if (hint) hint.addEventListener("click", () => card.classList.toggle("expanded"));
    });
    // notes
    const ta = document.getElementById("d-notes");
    ta.value = state.notes[isoStr] || "";
    let t = null;
    ta.addEventListener("input", () => {
      state.notes[isoStr] = ta.value;
      if (!ta.value) delete state.notes[isoStr];
      clearTimeout(t);
      t = setTimeout(() => { save(state); const sv = document.getElementById("d-saved"); sv.textContent = "saved ✓"; setTimeout(() => sv.textContent = "", 1400); }, 400);
    });

    scrim.classList.add("open");
    drawer.classList.add("open");
    body.scrollTop = 0;
  }
  function closeDrawer() { scrim.classList.remove("open"); drawer.classList.remove("open"); }

  // ---------- wire chrome ----------
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
      state = { done:{}, notes:{} }; save(state); recomputeStats(); renderCalendar();
    }
  });

  // ---------- legend ----------
  (function legend() {
    const el = document.getElementById("legend");
    Object.keys(TP.TYPE_META).forEach(t => {
      const m = TP.TYPE_META[t];
      el.innerHTML += '<span><span class="dot" style="background:' + m.color + '"></span>' + m.label + '</span>';
    });
  })();

  // ---------- go ----------
  renderCalendar();
  recomputeStats();
})();
