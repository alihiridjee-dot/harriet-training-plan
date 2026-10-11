/* ============================================================
   Harriet's Training Plan — schedule engine & workout library
   Pure data + a deterministic day generator. No dependencies.
   ============================================================ */
(function (global) {
  "use strict";

  // ---------- config ----------
  const PLAN_START = "2026-07-27";   // Monday, week 1 of the season (summer Foundation block)
  const BLOCK1_END = "2026-09-27";   // Sunday — last day of the summer Foundation block
  const DOLOMITES = ["2026-08-24", "2026-08-27"]; // Mon–Thu camp (assumed; edit if needed)
  const PLAN24 = "2026-10-12";       // Monday, week 1 of Phil's 24-week plan (MyProCoach)
  const RACE_703 = "2027-03-28";     // Ironman 70.3 — the plan's race day, week 24 Sunday

  // ---------- date helpers (local, noon-anchored to avoid TZ drift) ----------
  function parse(iso) { const [y, m, d] = iso.split("-").map(Number); return new Date(y, m - 1, d, 12); }
  function iso(dt) { return dt.getFullYear() + "-" + String(dt.getMonth() + 1).padStart(2, "0") + "-" + String(dt.getDate()).padStart(2, "0"); }
  function addDays(isoStr, n) { const dt = parse(isoStr); dt.setDate(dt.getDate() + n); return iso(dt); }
  function daysBetween(a, b) { return Math.round((parse(b) - parse(a)) / 86400000); }
  function weekdayMon0(isoStr) { return (parse(isoStr).getDay() + 6) % 7; } // 0=Mon..6=Sun

  // ---------- session builder ----------
  function S(type, title, sub, blocks) { return { type: type, title: title, sub: sub || "", blocks: blocks || [] }; }

  // ---------- watch steps ----------
  // Run, bike and swim sessions carry `ws`: intervals.icu workout-builder text,
  // which intervals.icu turns into a structured workout and sends to her Garmin.
  // In that syntax "m" is minutes and "mtr" is metres; a line before a block of
  // steps ending in "Nx" repeats it, with a blank line either side. Run paces are
  // explicit pace ranges; swim paces use %CSS±N% placeholders that are filled
  // from her latest CSS (or dropped if she hasn't tested yet).
  function W(s, ws) { s.ws = ws; return s; }
  const PACE = {
    easy: "6:20/km-6:55/km Pace", jog: "6:55/km-8:00/km Pace", steady: "5:56/km-6:11/km Pace",
    tempo: "5:27/km-5:36/km Pace", thr: "5:20/km-5:35/km Pace", cruise: "5:10/km-5:20/km Pace",
    vo2: "4:55/km-5:10/km Pace", stride: "4:37/km-5:00/km Pace"
  };
  // "6–8 km" → "7km", "45–60 min" → "55m", "3–4 h" → "3h30m"; null if no amount
  function amount(txt) {
    const m = String(txt || "").match(/(\d+(?:\.\d+)?)(?:\s*[–-]\s*(\d+(?:\.\d+)?))?\s*(km|min|h)\b/);
    if (!m) return null;
    const v = m[2] ? (Number(m[1]) + Number(m[2])) / 2 : Number(m[1]);
    if (m[3] === "km") return Math.round(v) + "km";
    if (m[3] === "h") return Math.floor(v) + "h" + (v % 1 ? Math.round(v % 1 * 60) + "m" : "");
    return Math.round(v / 5) * 5 + "m";
  }
  const repeat = (label, n, steps) => "\n" + label + " " + n + "x\n" + steps.join("\n") + "\n\n";

  // ---------- reusable fixed sessions ----------
  const REST = () => S("rest", "Complete rest", "Optional 15-min walk or mobility", [
    { label: "Why", text: "Rest is training — this is where the weekend's work turns into fitness. Keep it truly easy: a gentle walk or 10–15 min of mobility at most." }
  ]);
  const MOB = (t) => S("mobility", "Mobility / easy", t || "20–30 min", [
    { label: "Do", text: "Gentle movement only — mobility, stretching, or an easy walk/jog. Nothing that leaves you tired." }
  ]);
  const LOWER = () => S("strength", "Lower-body strength", "45–55 min · 2–3 reps in reserve", [
    { label: "Warm-up", text: "Leg swings, glute bridges, banded lateral walks." },
    { label: "Squat", text: "Goblet or back squat — 3 × 6–8." },
    { label: "Hinge", text: "Romanian deadlift — 3 × 8." },
    { label: "Single-leg", text: "Bulgarian split squat — 3 × 8 / leg." },
    { label: "Lunge", text: "Step-ups or walking lunges — 3 × 10 / leg." },
    { label: "Calves", text: "Calf raises (straight + bent knee) — 3 × 12–15." },
    { label: "Glutes", text: "Single-leg glute bridge / hip thrust — 3 × 10 / leg." },
    { label: "Core", text: "Dead bug + side plank — 3 × 10 / 30 s." },
    { label: "Note", text: "Moderate load, controlled, always leaving 2–3 reps in the tank. Builds power & durability — not size." }
  ]);
  const UPPER = () => S("strength", "Upper-body strength", "40–45 min", [
    { label: "Push", text: "Press-ups (or DB bench) — 3 × 8–12." },
    { label: "Row", text: "Single-arm dumbbell row — 3 × 10 / side." },
    { label: "Pull", text: "Lat pulldown or band pulldown — 3 × 10." },
    { label: "Press", text: "Overhead press (light–moderate) — 3 × 8." },
    { label: "Posture", text: "Face pulls / band pull-aparts — 3 × 15." },
    { label: "Scap", text: "Scapular Y-T-W raises — 2 × 10 each." },
    { label: "Core", text: "Pallof press + hollow hold — 3 × 10 / 20 s." },
    { label: "Swim link", text: "Strong lats & back power your catch and hold body position late in the swim — this session serves your weakest discipline." }
  ]);

  const SWIM_S1 = (note) => W(S("swim", "Swim — technique & drills" + (note ? " · " + note : ""), "≈ 1,750 m · 25 m pool", [
    { label: "Warm-up", text: "300 m easy (100 free / 100 back / 100 free), relaxed breathing every 3." },
    { label: "Drills", text: "6 × 50 m as catch-up · single-arm (25 L / 25 R) · fingertip-drag, @ :20. Long reach, high elbow." },
    { label: "Kick", text: "4 × 50 m kick with board, easy, @ :20." },
    { label: "Drill/swim", text: "6 × 100 m = 25 drill + 75 smooth swim, @ :25." },
    { label: "DPS", text: "4 × 50 m counting strokes — take 1 fewer stroke each 50." },
    { label: "Cool-down", text: "100 m easy, bilateral breathing (every 3)." }
  ]), "- Warm-up 300mtr\n" + repeat("Drills", 6, ["- Drill 50mtr"]) + repeat("Kick", 4, ["- Kick 50mtr"]) +
      repeat("Drill/swim", 6, ["- 100mtr"]) + repeat("Count strokes", 4, ["- 50mtr"]) + "- Cool-down 100mtr");

  // ---------- Foundation-block swims (capped ~1,000–1,100 m) ----------
  // Harriet's max to date is ~1,100 m. Summer is for technique and confidence
  // at that distance; the volume toward the 1.9 km 70.3 swim comes in winter.
  const SWIM_P1_TECH = (note) => W(S("swim", "Swim — technique & drills" + (note ? " · " + note : ""), "≈ 1,000 m · 25 m pool", [
    { label: "Warm-up", text: "200 m easy, relaxed breathing every 3." },
    { label: "Drills", text: "6 × 50 m — catch-up · single-arm · fingertip-drag, @ :20. Long reach, high elbow." },
    { label: "Drill/swim", text: "4 × 100 m = 25 drill + 75 smooth swim, @ :25." },
    { label: "Cool-down", text: "100 m easy, bilateral breathing (every 3)." },
    { label: "Why capped", text: "Well within your 1,100 m best — summer is for technique; the distance toward the 1.9 km 70.3 swim comes in the winter swim project." }
  ]), "- Warm-up 200mtr\n" + repeat("Drills", 6, ["- Drill 50mtr"]) + repeat("Drill/swim", 4, ["- 100mtr"]) + "- Cool-down 100mtr");
  const SWIM_P1_CSS = () => W(S("swim", "Swim — CSS / pace", "≈ 1,000 m", [
    { label: "Warm-up", text: "200 m easy + 4 × 50 build @ :20." },
    { label: "Main", text: "8 × 75 m at strong, steady 'race' pace, @ :15. Even effort, controlled breathing." },
    { label: "Test option", text: "Now and then swap in a 200 m time-trial (record it) to track your CSS/100 m." },
    { label: "Cool-down", text: "200 m easy." }
  ]), "- Warm-up 200mtr\n" + repeat("Build", 4, ["- 50mtr"]) + repeat("Race pace", 8, ["- 75mtr %CSS%"]) + "- Cool-down 200mtr");
  const SWIM_P1_ENDUR = () => W(S("swim", "Swim — steady endurance", "≈ 1,000–1,100 m", [
    { label: "Warm-up", text: "200 m mixed + 4 × 50 drill @ :20." },
    { label: "Main", text: "Build across the block: 4 → 5 → 6 × 150 m steady, @ :20 — comfortable, repeatable pace." },
    { label: "Pull", text: "2 × 100 m pull-buoy, smooth & long, @ :20." },
    { label: "Cool-down", text: "100 m easy." },
    { label: "Goal", text: "Feel like 1,000 m is easy and repeatable by the end of summer — the platform for the 1.9 km 70.3 swim." }
  ]), "- Warm-up 200mtr\n" + repeat("Steady", 5, ["- 150mtr %CSS+8%"]) + repeat("Pull", 2, ["- 100mtr"]) + "- Cool-down 100mtr");

  const BIKE_B1 = (label, sub) => bikeWs(S("bike", label || "Bike — endurance", sub || "Z2 · cadence 85–95", [
    { label: "Main", text: "Ride at 22–25 km/h in Zone 2 — able to chat. Spin light gears at 85–95 rpm." },
    { label: "Skill", text: "Practise eating & drinking on the move, and spend time in a lower / aero-ish position." }
  ]));

  const EASY_RUN = (km, strides) => W(S("run", "Easy run" + (strides ? " + strides" : ""), km + " · Z2", [
    { label: "Main", text: "Run at 8.7–9.5 km/h (6:55–6:20/km), conversational. Let heart rate lead — slow down if it climbs out of Z2." },
    strides ? { label: "Strides", text: "Finish with 4–6 × 20 s pick-ups at ~12–13 km/h, full recovery between. Relaxed & fast, not a sprint." } : null
  ].filter(Boolean)), "- Easy " + (amount(km) || "40m") + " " + PACE.easy + (strides ? "\n" + repeat("Strides", 5, ["- 20s " + PACE.stride, "- 60s " + PACE.jog]) : ""));

  const LONG_RUN = (km, extra) => W(S("run", "Long run", km + " · Z2", [
    { label: "Main", text: "Steady & easy at 8.7–9.5 km/h. This is aerobic base — keep it in Zone 2 the whole way." },
    extra ? { label: "Finish", text: extra } : null,
    { label: "Fuel", text: "Anything over ~75–90 min: take 30–60 g carbs/hour + water." }
  ].filter(Boolean)), "- Long run " + (amount(km) || "60m") + " " + PACE.easy);

  const LONG_BIKE = (title, sub, blocks) => bikeWs(S("bike", title, sub, blocks));
  // Rides go by heart-rate zone (no power meter). A brick's run off the bike
  // becomes its own run workout (`wsBrick`), since a watch workout is one sport.
  function bikeWs(s) {
    const hay = s.title + " · " + s.sub, amt = amount(s.title) || amount(s.sub) || "60m";
    const zone = /Z1–2|Z1-2/.test(hay) ? "Z1-Z2 HR" : "Z2 HR";
    const ss = s.sub.match(/(\d+)\s*×\s*(\d+)′\s*@\s*Z3/);
    const opener = /(\d+)\s*×\s*2 min brisk/.exec(s.sub);
    if (ss) s.ws = "- Warm-up 15m Z2 HR\n" + repeat("Sweet spot", ss[1], ["- " + ss[2] + "m Z3 HR", "- 5m Z1-Z2 HR"]) + "- Easy spin home 20m Z2 HR";
    else if (opener) s.ws = "- Easy 25m Z2 HR\n" + repeat("Openers", opener[1], ["- 2m Z3-Z4 HR", "- 3m Z1-Z2 HR"]) + "- Cool-down 5m Z1-Z2 HR";
    else s.ws = "- Endurance " + amt + " " + zone;
    const bb = (s.blocks || []).filter(b => b.label === "Brick run")[0];
    const mins = (bb && /(\d+)\s*min/.exec(bb.text)) || /\+\s*(\d+)′\s*run/.exec(s.title);
    if (mins) s.wsBrick = "- Brick run " + mins[1] + "m " + (/70\.3 pace|race effort/.test((bb && bb.text) || s.title + s.blocks.map(b => b.text).join(" ")) ? PACE.steady : PACE.easy);
    return s;
  }
  const BRICK = (mins) => ({ label: "Brick run", text: "Straight off the bike, no rest: " + mins + " easy run holding form as the legs settle. Priceless for triathlon." });

  // ---------- run quality library (Tuesdays) ----------
  const R2 = () => W(S("run", "Run — VO₂ intervals", "6 × 400 m · Z5", [
    { label: "Warm-up", text: "12–15 min easy + 3–4 strides." },
    { label: "Main", text: "6 × 400 m @ 11.6–12.2 km/h (5:10–4:55/km), 90 s easy jog between. Build toward 8 × 400 across the block." },
    { label: "Cool-down", text: "8–10 min easy." }
  ]), "- Warm-up 15m " + PACE.easy + "\n" + repeat("Main set", 6, ["- 400mtr " + PACE.vo2, "- 90s " + PACE.jog]) + "- Cool-down 10m " + PACE.easy);
  const R3 = (reps) => W(S("run", "Run — threshold reps", (reps || "5 × 1 km") + " · Z4", [
    { label: "Warm-up", text: "12–15 min easy + 3 strides." },
    { label: "Main", text: (reps || "5 × 1 km") + " @ 10.7–11.3 km/h (5:35–5:20/km), 60–75 s jog between. Comfortably hard, even splits." },
    { label: "Cool-down", text: "8–10 min easy." }
  ]), (function () {
    const m = /(\d+)\s*×\s*([\d.]+)\s*km/.exec(reps || "5 × 1 km");
    return "- Warm-up 15m " + PACE.easy + "\n" + repeat("Main set", m[1], ["- " + m[2] + "km " + PACE.thr, "- 75s " + PACE.jog]) + "- Cool-down 10m " + PACE.easy;
  })());
  const R4 = (fmt) => W(S("run", "Run — tempo", (fmt || "20 min continuous") + " · Z4", [
    { label: "Warm-up", text: "12–15 min easy." },
    { label: "Main", text: (fmt || "20 min continuous") + " @ 10.7–11.0 km/h. 'Comfortably hard' — short phrases only." },
    { label: "Cool-down", text: "8 min easy." }
  ]), (function () {
    const m = /(\d+)\s*×\s*(\d+)\s*min/.exec(fmt || ""), c = /(\d+)\s*min continuous/.exec(fmt || "20 min continuous");
    const main = m ? repeat("Tempo", m[1], ["- " + m[2] + "m " + PACE.tempo, "- 2m " + PACE.jog]) : "- Tempo " + (c ? c[1] : 20) + "m " + PACE.tempo + "\n";
    return "- Warm-up 15m " + PACE.easy + "\n" + main + "- Cool-down 8m " + PACE.easy;
  })());
  const R5 = () => W(S("run", "Run — 10K cruise", "6 × 800 m · Z4", [
    { label: "Warm-up", text: "12–15 min easy + 3 strides." },
    { label: "Main", text: "6 × 800 m @ 11.3–11.6 km/h (5:20–5:10/km), 2 min jog between. Builds the speed that makes 70.3 run pace feel easy." },
    { label: "Cool-down", text: "8–10 min easy." }
  ]), "- Warm-up 15m " + PACE.easy + "\n" + repeat("Main set", 6, ["- 800mtr " + PACE.cruise, "- 2m " + PACE.jog]) + "- Cool-down 10m " + PACE.easy);
  const R6 = () => W(S("run", "Run — hill reps", "8 × 45 s · Z4–5", [
    { label: "Warm-up", text: "12 min easy on gentle ground." },
    { label: "Main", text: "8 × 45 s hard uphill, jog or walk down to recover. Tall, powerful posture — strength you can't get on the flat." },
    { label: "Cool-down", text: "10 min easy." }
  ]), "- Warm-up 12m " + PACE.easy + "\n" + repeat("Hills", 8, ["- Hard uphill 45s Z4-Z5 HR", "- Jog down 90s Z1-Z2 HR"]) + "- Cool-down 10m " + PACE.easy);

  // ---------- summer run framework (Runna-style) ----------
  // 3 runs a week through the summer Foundation block: one QUALITY (rotating
  // hills / tempo / intervals), one EASY, one LONG that builds up.
  // Placed Tue = quality, Thu = easy, Sun = long.
  function weeklyRuns(isoStr) {
    const wk = Math.floor(daysBetween(PLAN_START, isoStr) / 7); // 0-based plan week
    // quality rotation — hills, tempo, intervals, threshold, cruise
    const quality = [R6(), R4("20 min continuous"), R2(), R3("5 × 1 km"), R6(), R5()][wk % 6];
    const easy = EASY_RUN("6–8 km", wk % 2 === 0);
    // long run — progressive build with a step-back every 4th week
    const cyc = wk % 4;
    let km = Math.min(12 + wk * 0.4, 20);
    if (cyc === 3) km = Math.max(10, km - 4); // recovery / step-back week
    km = Math.round(km);
    const long = LONG_RUN(km + " km", cyc === 2 ? "Final 3–4 km lifted to steady 70.3 run effort — controlled, not a sprint." : (cyc === 3 ? "Easy step-back week — let the build settle in." : null));
    return { quality: quality, easy: easy, long: long };
  }

  // ---------- phase-1 key sessions per week ----------
  // Each: { tue, sat, sun }  (sat/sun are custom long sessions)
  const P1 = {
    1: { tue: R2(), sat: LONG_BIKE("Long ride · 45 km", "Z2 endurance", [{ label: "Main", text: "45 km at 22–25 km/h, Zone 2. Ease into the block — smooth and controlled." }]), sun: LONG_RUN("14 km"), swimNote: "technique reset" },
    2: { tue: R3("5 × 1 km"), sat: LONG_BIKE("Long ride · 55 km + brick", "Z2 + 10′ run", [{ label: "Main", text: "55 km Zone 2, cadence 85–95, fuelling on the move." }, BRICK("10 min")]), sun: LONG_RUN("16 km"), swimThuTest: true },
    3: { tue: R4("20 min continuous"), sat: LONG_BIKE("Sweet-spot ride · 40 km", "3 × 8′ @ Z3", [{ label: "Warm-up", text: "15 min easy." }, { label: "Main", text: "3 × 8 min @ 25–28 km/h (RPE 6–7), 5 min easy between, inside a 40 km ride." }, { label: "Cool-down", text: "easy spin home." }]), sun: LONG_RUN("12 km", "Final 4 km lifted to steady 9.7–10.1 km/h.") },
    4: { tue: R5(), sat: LONG_BIKE("Long ride · 65 km + brick", "Z2 + 15′ run (big week)", [{ label: "Main", text: "65 km Zone 2 — your longest so far. Fuel every 30–40 min." }, BRICK("15 min")]), sun: LONG_RUN("18 km", "Peak long run — keep it genuinely easy.") },
    6: { tue: R4("2 × 10 min"), sat: LONG_BIKE("Long ride · 60 km", "tempo blocks + brick", [{ label: "Main", text: "60 km with 2–3 × 10 min at sweet-spot (25–28 km/h) mixed in." }, BRICK("15 min")]), sun: LONG_RUN("16 km", "Final 5 km steady (9.7–10.1 km/h).") },
    7: { tue: R3("4 × 1.5 km"), sat: LONG_BIKE("Long ride · 70 km + brick", "Z2 · peak ride", [{ label: "Main", text: "70 km Zone 2 — the peak ride. Practise full race fuelling & hydration." }, BRICK("20 min")]), sun: LONG_RUN("18 km", "Last 5 km at 70.3 run effort (9.7–10.1 km/h).") },
    8: { tue: W(S("run", "Run — sharpener", "5 × 2 min · Z5", [{ label: "Warm-up", text: "12 min easy + strides." }, { label: "Main", text: "5 × 2 min @ 5K effort (11.6–12.2 km/h), 2 min jog. Short & sharp — keeps the legs quick." }, { label: "Cool-down", text: "8 min easy." }]), "- Warm-up 12m " + PACE.easy + "\n" + repeat("Main set", 5, ["- 2m " + PACE.vo2, "- 2m " + PACE.jog]) + "- Cool-down 8m " + PACE.easy), sat: LONG_BIKE("Ride · 45 km easy", "easy + a few surges", [{ label: "Main", text: "45 km easy with 4–5 × 30 s brisk surges to stay sharp." }]), sun: LONG_RUN("12 km", "Easy — legs should feel fresh, not worked.") }
  };

  // ---------- phase resolver ----------
  function phaseFor(isoStr, weekIdx) {
    if (parse(isoStr) < parse(PLAN_START)) return { id: "pre", label: "Before the plan", tint: "pre" };
    if (weekIdx <= 8) return { id: "p1", label: "Block 1 · Foundation", tint: "p1" };
    if (isoStr < PLAN24) return { id: "recovery", label: "Block 2 · Reset", tint: "recovery" };
    if (isoStr > RACE_703) return { id: "post", label: "After the 70.3", tint: "post" };
    const b = blockOf(WEEKS[Math.floor(daysBetween(PLAN24, isoStr) / 7)].b);
    return { id: b.id, label: b.name, tint: b.tint };
  }

  // ---------- day builders per phase ----------
  function p1Day(week, wd, isoStr) {
    // Week 5 — Dolomites camp (Mon–Thu = 24–27 Aug), lighter weekend
    if (week === 5) {
      const camp = [
        [MOB("30–40 min easy shakeout jog + mobility"), S("mobility", "Travel day", "Camp · Day 1", [{ label: "Note", text: "Arrive, unpack, legs loose. Nothing hard." }])],
        [LONG_BIKE("Big mountain ride · 3–4 h", "Camp · Day 2 · by time, not distance", [{ label: "Main", text: "3–4 hours on the climbs. Stay in Zone 2 on ascents — walk-pace spinning is fine. Fuel 40–60 g carbs/hour." }, BRICK("10 min (optional)")])],
        [S("run", "Hill run · 60–75 min", "Camp · Day 3", [{ label: "Main", text: "Easy up the climbs (walk the steep bits), plus 6–8 short uphill surges near the end." }]), SWIM_P1_TECH("easy technique if pool")],
        [S("mobility", "Recovery spin or hike", "Camp · Day 4", [{ label: "Main", text: "Easy recovery spin or a hike + mobility. Absorb the big days." }])],
        [BIKE_B1("Bike — easy", "post-camp / travel · 40 min or rest")],
        [LONG_BIKE("Easy long ride · 40–50 km", "Z2 (skip if still tired)", [{ label: "Main", text: "Only if recovered from camp — otherwise rest. Keep it easy Zone 2." }])],
        [LONG_RUN("12–14 km", "Easy — a gentle return to routine.")]
      ];
      return dayObj(week, wd, isoStr, camp[wd], "Dolomites camp week — go by effort, not pace or HR. Altitude & climbs will run your HR high; that's expected.");
    }
    // Week 9 — lighter week to close out the Foundation block before the Reset
    if (week === 9) {
      const run = weeklyRuns(isoStr);
      const cw = [
        [REST()],
        [run.quality, LOWER()],
        [SWIM_P1_TECH("smooth"), UPPER()],
        [run.easy, SWIM_P1_ENDUR()],
        [REST()],
        [LONG_BIKE("Long ride · 50 km + brick", "Z2 + 10′ run", [{ label: "Main", text: "50 km Zone 2, relaxed — fuel on the move." }, BRICK("10 min")])],
        [LONG_RUN("14 km", "Easy — close out the summer block feeling strong.")]
      ];
      return dayObj(week, wd, isoStr, cw[wd], "Last week of the Foundation block — a lighter week so you finish the summer fresh, ready to reset before the 70.3 build.");
    }
    // Normal phase-1 week from template + weekly key sessions
    const k = P1[week], run = weeklyRuns(isoStr);
    const tmpl = [
      [REST()],
      [run.quality, LOWER()],
      [SWIM_P1_TECH(k.swimNote), UPPER()],
      [run.easy, k.swimThuTest ? SWIM_P1_CSS() : SWIM_P1_ENDUR()],
      [BIKE_B1("Bike — endurance", "45–60 min Z2 (or swap to rest)")],
      [k.sat],
      [run.long]
    ];
    return dayObj(week, wd, isoStr, tmpl[wd]);
  }

  function recoveryDay(wd) {
    const t = [
      [REST()],
      [EASY_RUN("30–40 min", false)],
      [SWIM_S1("easy, technique only")],
      [EASY_RUN("30–40 min", false), MOB("optional easy swim")],
      [BIKE_B1("Bike — easy", "45 min Z1–2 or rest")],
      [LONG_BIKE("Easy ride · 40–60 min", "Z2, unstructured", [{ label: "Main", text: "Ride for enjoyment, no numbers. Let the body absorb the summer block." }])],
      [LONG_RUN("≤ 10 km", "Keep it very easy — no long runs over 10 km in these two weeks.")]
    ];
    return { sessions: t[wd], banner: "Reset block — deliberately easy. No hard sessions, no long runs over 10 km. Recharge." };
  }

  // ============================================================
  // Phil's 24-week plan (MyProCoach) — 12 Oct 2026 → race day
  // ============================================================
  // "Phil's Intermediate Half Distance Triathlon 24-Week Plan", as it sits in her
  // TrainingPeaks calendar. The PDF export cut most workouts' text short, so the
  // steps after the cut were read off each workout's chart in the PDF, whose bars
  // give every step's length and relative effort (each bike and run session adds
  // up to its listed time). Swim charts only show distance and effort, so swim
  // sets are rebuilt from them and say so on the site (`est`).

  // Threshold run pace in seconds per km, behind every run pace on her watch.
  // ~5:27/km from her 1:58:59 half; after each run test (plan weeks 1, 8 and
  // 16) set it to her average pace for the 30-minute effort.
  const RUN_THR = 327;

  // The plan's zones: [words, run pace as % of threshold pace (slowest, fastest),
  // heart-rate zone for rides on her watch, swim seconds per 100 m off CSS, effort]
  const ZONE = {
    Z1:     ["Z1", 140, 129, "Z1", 15, 1],
    Z12:    ["Z1–2", 135, 114, "Z1-Z2", 12, 1.5],
    lZ2:    ["low Z2", 129, 122, "Z2", 12, 2],
    mZ2:    ["mid Z2", 124, 117, "Z2", 10, 2],
    Z2:     ["Z2", 129, 114, "Z2", 10, 2],
    uZ2:    ["upper Z2", 118, 112, "Z2", 7, 2.5],
    uZ2lZ3: ["upper Z2 to low Z3", 114, 108, "Z2-Z3", 6, 2.7],
    lZ3:    ["low Z3", 113, 108, "Z3", 5, 3],
    lmZ3:   ["low to mid Z3", 112, 106, "Z3", 5, 3],
    mZ3:    ["mid Z3", 110, 105, "Z3", 4, 3],
    Z3:     ["Z3", 113, 105, "Z3", 4, 3],
    uZ3:    ["upper Z3", 106, 103, "Z3", 2, 3.5],
    uZ3lZ4: ["upper Z3 to low Z4", 105, 101, "Z3-Z4", 1, 3.7],
    lZ4:    ["low Z4", 104, 101, "Z4", 1, 4],
    Z4:     ["Z4", 104, 98, "Z4", 0, 4],
    uZ4:    ["upper Z4", 100, 97, "Z4", -1, 4.3],
    Z45:    ["Z4–5", 100, 93, "Z4-Z5", -2, 4.5],
    lZ5:    ["low Z5", 98, 95, "Z5", -3, 5],
    Z5:     ["Z5", 97, 91, "Z5", -4, 5],
    uZ5:    ["upper Z5", 93, 88, "Z5", -5, 5]
  };

  // ---------- step notation ----------
  // A step is "10m Z2", "90s uZ4", "1h30m Z2", "9m Z3 60rpm" (a big gear at
  // 60 rpm), "20m TT" (a flat-out test effort), or for swims "200 FS Z2" —
  // metres, stroke, zone. rep(n, steps, rest) repeats a block; swim rests (in
  // seconds) are written out on the site but left off the watch.
  const rep = (n, steps, rest) => ({ n: n, steps: steps, rest: rest || 0 });
  function step(str) {
    const p = str.split(" ");
    if (/^\d+$/.test(p[0])) return { m: Number(p[0]), kind: p[1], z: p[2] || null };
    const t = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(p[0]);
    return { sec: (Number(t[1] || 0) * 60 + Number(t[2] || 0)) * 60 + Number(t[3] || 0), z: p[1] || null, rpm: p[2] ? parseInt(p[2], 10) : 0 };
  }
  function flat(list) {
    const out = [];
    (list || []).forEach(x => {
      if (typeof x === "string") out.push(step(x));
      else for (let i = 0; i < x.n; i++) x.steps.forEach(s => out.push(step(s)));
    });
    return out;
  }

  // on the site, in the plan's own shorthand: "10 min in Z2, 5 × (15 s in upper Z3 + 45 s in Z2)"
  const STROKE = { FS: "FS", FSb3: "FS breathing every 3", Pull: "pull", Pullb5: "pull breathing every 5", Drill: "drill", Kick: "kick", Breast: "breaststroke", Back: "backstroke", Mix: "mixed strokes" };
  const thou = n => String(n).replace(/\B(?=(\d{3})+$)/g, ",");
  function hms(sec) {
    if (sec < 120) return sec + " s";
    const h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s = sec % 60;
    return [h ? h + " h" : "", m ? m + " min" : "", s ? s + " s" : ""].filter(Boolean).join(" ");
  }
  function say(st) {
    const z = st.z === "TT" ? " flat out" : st.z ? " in " + ZONE[st.z][0] : "";
    if (st.m) return thou(st.m) + " m " + STROKE[st.kind] + z;
    return hms(st.sec) + (st.rpm ? " in a big gear at " + st.rpm + " rpm" : "") + z;
  }
  function sayList(list) {
    return list.map(x => {
      if (typeof x === "string") return say(step(x));
      const body = x.steps.map(s => say(step(s))).concat(x.rest ? [x.rest + " s rest"] : []).join(" + ");
      return x.n > 1 ? x.n + " × (" + body + ")" : body;
    }).join(", ");
  }

  // the same steps as data for the site to draw: a profile (width = time,
  // height = effort) over a step list. `sec` is the step's length, with swims
  // at about 2:00 per 100 m; `eff` is ZONE's effort, 5.5 for a flat-out test.
  function view(st) {
    const z = st.z && st.z !== "TT" ? ZONE[st.z] : null;
    return {
      amt: st.m ? thou(st.m) + " m" : hms(st.sec), m: st.m || 0, sec: st.m ? st.m * 1.2 : st.sec,
      what: st.m ? STROKE[st.kind] : st.rpm ? "big gear, " + st.rpm + " rpm" : "",
      zone: st.z === "TT" ? "time trial" : z ? z[0] : "", eff: st.z === "TT" ? 5.5 : z ? z[5] : 2
    };
  }
  // parts → [{ label, note, items: [{ n, steps, rest }] }]
  function planOf(parts, label, notes) {
    return SECTIONS.filter(p => parts[p[0]]).map(p => ({
      label: label(p[0]), note: notes[p[0]] || "",
      items: parts[p[0]].map(x => typeof x === "string" ? { n: 1, steps: [view(step(x))], rest: 0 }
        : { n: x.n, steps: x.steps.map(s => view(step(s))), rest: x.rest || 0 })
    }));
  }

  // on the watch: runs by pace, rides by heart rate (no power meter — and no
  // target at all on efforts too short for heart rate to follow), swims by CSS
  const clock = sec => { sec = Math.round(sec); return Math.floor(sec / 60) + ":" + String(sec % 60).padStart(2, "0"); };
  const runPace = z => clock(RUN_THR * ZONE[z][2] / 100) + "/km-" + clock(RUN_THR * ZONE[z][1] / 100) + "/km Pace";
  const icuDur = sec => sec < 120 ? sec + "s" : (Math.floor(sec / 3600) ? Math.floor(sec / 3600) + "h" : "") +
    (Math.floor(sec % 3600 / 60) ? Math.floor(sec % 3600 / 60) + "m" : "") + (sec % 60 ? sec % 60 + "s" : "");
  const SWIM_CUE = { Pull: "Pull", Pullb5: "Pull", Drill: "Drill", Kick: "Kick", Breast: "Breaststroke", Back: "Backstroke" };
  function wsStep(st, sport, cue) {
    if (st.m) {
      const off = /^(FS|FSb3|Pull|Pullb5)$/.test(st.kind) && st.z ? ZONE[st.z][4] : null;
      return "- " + (SWIM_CUE[st.kind] || cue ? (SWIM_CUE[st.kind] || cue) + " " : "") + st.m + "mtr" +
        (off === null ? "" : " %CSS" + (off ? (off > 0 ? "+" : "") + off : "") + "%");
    }
    const d = icuDur(st.sec), name = cue ? cue + " " : "";
    if (st.z === "TT") return "- Time trial " + d;
    if (sport === "run") return "- " + name + d + " " + runPace(st.z);
    if (st.sec < 120) return "- " + (ZONE[st.z][5] >= 3 ? "Hard " : "Easy ") + d + (st.rpm ? " " + st.rpm + "rpm" : "");
    return "- " + name + d + " " + ZONE[st.z][3] + " HR" + (st.rpm ? " " + st.rpm + "rpm" : "");
  }
  function wsList(list, sport, label) {
    const cue = label === "Main" ? "" : label;
    return list.map(x => typeof x === "string" ? wsStep(step(x), sport, cue) + "\n"
      : x.n > 1 ? repeat(label, x.n, x.steps.map(s => wsStep(step(s), sport)))
      : x.steps.map(s => wsStep(step(s), sport, cue)).join("\n") + "\n").join("");
  }

  // ---------- session builders ----------
  // parts: { wu, main, cd } step lists, `say` to word a section by hand,
  // `note` for a line under a section's steps on the site (defaults to `say`)
  // and `labels` to rename one. opts: { tip, more (extra blocks), est (how it
  // was rebuilt), optional }
  const SECTIONS = [["wu", "Warm-up"], ["main", "Main"], ["cd", "Cool-down"]];
  function build(type, title, sub, parts, opts) {
    opts = opts || {};
    const said = parts.say || {}, label = k => (parts.labels || {})[k] || SECTIONS.filter(p => p[0] === k)[0][1], blocks = [];
    SECTIONS.forEach(p => { if (parts[p[0]]) blocks.push({ label: label(p[0]), text: said[p[0]] || sayList(parts[p[0]]) }); });
    (opts.more || []).forEach(b => blocks.push(b));
    if (opts.tip) blocks.push({ label: "Tip", text: opts.tip });
    const s = S(type, title, sub, blocks);
    s.ws = SECTIONS.filter(p => parts[p[0]]).map(p => wsList(parts[p[0]], type, label(p[0]))).join("");
    s.plan = planOf(parts, label, Object.assign({}, said, parts.note));
    // planned minutes [easy, hard] for the 80/20 check: Z1–Z2 is easy, Z3 and
    // up is hard; swims count at about 2:00 per 100 m
    const z = [0, 0];
    SECTIONS.forEach(p => flat(parts[p[0]]).forEach(st => {
      const hard = st.z === "TT" || (!!st.z && ZONE[st.z][5] >= 3 && !/Drill|Kick|Breast|Back/.test(st.kind || ""));
      z[hard ? 1 : 0] += st.m ? st.m / 50 : st.sec / 60;
    }));
    s.zmin = z.map(Math.round);
    if (opts.optional) s.optional = true;
    if (opts.est) s.est = opts.est;
    return s;
  }
  // "45 min", "62½ min", "2 h 15"
  const hm = min => min < 90 ? (min % 1 ? Math.floor(min) + "½" : min) + " min" : Math.floor(min / 60) + " h" + (min % 60 ? " " + String(min % 60).padStart(2, "0") : "");
  const run = (title, min, sub, parts, opts) => build("run", title, hm(min) + (sub ? " · " + sub : ""), parts, opts);
  const ride = (title, min, sub, parts, opts) => build("bike", title, hm(min) + (sub ? " · " + sub : ""), parts, opts);
  const DRILLS = { label: "Drills", text: "Choose them from MyProCoach's swim-drills guide — it's linked in each swim in TrainingPeaks." };
  function swim(title, sub, parts, opts) {
    const all = SECTIONS.reduce((a, p) => a.concat(flat(parts[p[0]])), []);
    const m = all.reduce((a, st) => a + (st.m || 0), 0);
    opts = Object.assign({}, opts);
    if (all.some(st => st.kind === "Drill")) opts.more = (opts.more || []).concat([DRILLS]);
    return build("swim", title, "≈ " + thou(m) + " m" + (sub ? " · " + sub : ""), parts, opts);
  }

  const EST_SWIM = "Rebuilt from this workout's chart in the plan — the PDF cut most of the text off. Distances and efforts follow the chart; TrainingPeaks has Phil's exact set and drills.";
  const EST_GUESS = "The PDF hides this whole set, so it's modelled on the plan's other swims of this kind — check TrainingPeaks for Phil's exact set.";

  // ---------- fitness tests (plan weeks 1, 8 and 16) ----------
  const CSS_TEST = () => {
    const s = W(S("swim", "Swim — CSS test", "≈ 1,200 m · fitness test", [
      { label: "Warm-up", text: "6 × (50 m steady in Z2 + 15 s rest), then a couple of minutes' easy rest." },
      { label: "Main", text: "400 m time trial — the fastest pace you can hold evenly. 5–10 min of easy swimming to recover. 200 m time trial — flat out." },
      { label: "Cool-down", text: "300 m easy, mixing strokes." },
      { label: "Result", text: "CSS per 100 m = (400 time − 200 time) ÷ 2. Swim it with your watch and this site works it out from the laps; every swim pace on your watch then follows it." },
      { label: "Then", text: "Set your thresholds in TrainingPeaks too (easiest on a computer), so the plan's zones match." }
    ]), "\nWarm-up 6x\n- 50mtr\n\n- Rest 2m\n- Time trial 400mtr\n- Rest 5m\n- Time trial 200mtr\n- Cool-down 300mtr");
    s.est = "Warm-up and cool-down rebuilt from this workout's chart in the plan — the PDF cut the text off.";
    s.zmin = [20, 10];
    s.plan = planOf({ wu: [rep(6, ["50 FS Z2"], 15)], main: ["400 FS TT", "5m Z12", "200 FS TT"], cd: ["300 Mix Z12"] },
      k => SECTIONS.filter(p => p[0] === k)[0][1],
      { wu: "Then a couple of minutes' easy rest.", main: "Swim the 400 m at the fastest pace you can hold evenly, recover with 5–10 min of easy swimming, then the 200 m flat out." });
    return s;
  };
  const FTP_TEST = () => ride("Bike — FTP & threshold HR test", 42, "20-min test", {
    wu: ["12m Z12", rep(5, ["20s Z4", "40s Z12"])], main: ["20m TT"], cd: ["5m Z12"],
    say: { main: "20 min time trial — the hardest effort you can hold evenly for the full 20 minutes. Don't start too fast." }
  }, { more: [{ label: "Result", text: "Use it to set your bike thresholds and zones in TrainingPeaks (easiest on a computer). Note your average heart rate for the 20 minutes — rides on your watch are guided by heart rate." }] });
  const RUN_TEST = () => run("Run — threshold pace & HR test", 44, "30-min test", {
    wu: ["5m Z2", rep(4, ["30s Z4", "30s Z1"])], main: ["30m TT"], cd: ["5m Z12"],
    say: { main: "30 min time trial — as hard as you can hold evenly for the whole 30 minutes, somewhere flat if you can." }
  }, { more: [{ label: "Result", text: "Your threshold pace is your average pace for the 30 minutes; your threshold heart rate is your average for the last 20. Set both in TrainingPeaks (easiest on a computer)." }] });

  // ---------- endurance, bricks and the recurring key sessions ----------
  const Z2_RIDE = (min, words, tip) => ride(min >= 120 ? "Long ride" : "Bike — aerobic endurance", min, "Z2",
    { main: [min + "m Z2"], say: { main: words } }, { tip: tip });
  const Z2_RUN = (min, title, words, tip) => run(title, min, "Z1–Z2",
    { main: [min + "m Z12"], say: { main: words || "A nice steady run, mainly in Z1–Z2 — you should be able to chat." } }, { tip: tip });
  const LONG = (min, words, tip) => Z2_RUN(min, "Long run", words, tip);
  const OFF_BIKE = (min, words) => run("Run off the bike", min, "Z2 · brick",
    { main: [min + "m Z2"], say: { main: words || "Straight off the bike: an easy, steady run in Z2." } });
  const OFF_BIKE_FAST = (min, fast, z, words) => run("Run off the bike — faster at first", min, "Z2 · first " + fast + "′ " + ZONE[z][0] + " · brick",
    { main: [fast + "m " + z, (min - fast) + "m Z2"], say: { main: words || "Get off the bike and run: the first " + fast + " min in " + ZONE[z][0] + ", then ease down into Z2 for the last " + (min - fast) + "." },
      note: { main: "Straight off the bike — start faster, then ease down." } },
    { tip: "Running off the bike harder at first gets your body used to the switch from cycling." });
  const THRESH_BIKE = (min, sub, parts) => ride("Bike — threshold efforts", min, sub, parts,
    { tip: "These tough sessions gradually raise your threshold on the bike." });
  const SPEED_RUN = (min, sub, parts, opts) => run("Run — speed workout", min, sub, parts,
    Object.assign({ tip: "Speed work builds leg speed and running economy — over time it teaches your body to run faster for less effort." }, opts));
  const SPEED_BIKE = (min, sub, parts, title) => ride(title || "Bike — speed workout", min, sub, parts);
  const AE_BIKE = (min, parts, tip, optional) => ride("Bike — aerobic endurance" + (optional ? " (optional)" : ""), min, "upper Z2", parts,
    { optional: optional, tip: tip || "Works well on an indoor trainer, or outside. It's aerobic — it isn't meant to feel hard." });
  const TORQUE = (min, wu, main, cd) => ride("Bike — torque session (optional)", min, "big gear · Z3",
    { wu: wu, main: main, cd: cd, say: { wu: sayList(wu) + ", at your normal cadence" }, note: { wu: "At your normal cadence — the big gear is only for the efforts." } },
    { optional: true, tip: "Think of it as a bike-specific gym session — it builds cycling strength." });
  // long ride: Z2 until warmed up, the efforts, then Z2 to the end
  const SUB_RIDE = (min, before, n, len, rec, sub) => ride("Long ride + sub-threshold efforts", min, "Z2 + " + sub, {
    wu: [before + "m Z2"], main: [rep(n, [len + "m uZ3lZ4"].concat(rec ? [rec + "m Z2"] : []))], cd: [(min - before - n * (len + rec)) + "m Z2"],
    labels: { cd: "To finish" }
  }, { tip: "These long rides are mostly easy Z2, with one main set of harder efforts once you're warmed up." });
  // 70.3 power slope: Z3 rising straight into Z4, three times
  function SLOPE(min, sets) {
    const main = [];
    sets.forEach((s, i) => { main.push(s[0] + "m Z3", s[1] + "m Z4"); if (i < 2) main.push((i ? 3 : 4) + "m Z12"); });
    return ride("Bike — IRONMAN 70.3 power slope", min, "Z3 → Z4", {
      wu: ["5m Z12", rep(5, ["15s Z3", "15s Z12", "15s Z4", "15s Z12"]), "5m Z12"], main: main, cd: ["7m Z12"],
      say: { main: sets.map((s, i) => s[0] + " min in Z3 rising straight into " + s[1] + " min in Z4" + (i < 2 ? ", " + (i ? 3 : 4) + " min in Z1–2" : "")).join(", ") },
      note: { main: "Each Z3 block rises straight into its Z4 block — no easing off in between." }
    });
  }
  const SUSTAINED = (min, n, len, rec) => run("Run — IRONMAN 70.3 sustained efforts", min, n + " × " + len + "′ mid Z3",
    { wu: ["5m Z12", "3m Z3", "5m Z2"], main: [rep(n, [len + "m mZ3", rec + "m Z2"])], cd: ["5m Z12"] });
  const SUB_BIKE = (min, sub, parts) => ride("Bike — sub-threshold efforts", min, sub, parts,
    { tip: "Short midweek rides like this suit an indoor trainer, but you can ride outside too." });
  const THRESH_RUN = (min, sub, parts) => run("Run — threshold efforts", min, sub, parts);
  const RACE_RIDE = (min, wu, n, len, rec, cd) => ride("Race practice ride", min, n + " × " + len + "′ low–mid Z3",
    { wu: [wu + "m Z2"], main: [rep(n, [len + "m lmZ3", rec + "m Z2"])], cd: [cd + "m Z2"] },
    { tip: "Built to rehearse race day: race-pace efforts with short recoveries. Use your race bike, kit and fuelling." });
  const PEAK_MON = (min, parts, tip) => [AE_BIKE(min, parts, tip), OFF_BIKE(15, "Hop off the bike and do a short, steady run — all in Z2.")];

  // ---------- swims ----------
  const SW_AE = (parts, est) => swim("Swim — aerobic endurance", "Z2", parts,
    { tip: "Lower intensities that progress in duration — this is where your swim endurance comes from.", est: est || EST_SWIM });
  const SW_SE = (parts, est) => swim("Swim — speed endurance", "Z3–Z5", parts,
    { tip: "Efforts at or above race pace with regular recoveries — builds speed you can hold.", est: est || EST_SWIM });
  const SW_TH = (parts, est) => swim("Swim — threshold efforts", "Z4", parts,
    { tip: "A main set at threshold (CSS) pace — lifts your pace and how long you can hold it.", est: est || EST_SWIM });
  const SW_REC = parts => swim("Swim — recovery", "easy Z2", parts,
    { tip: "Easy swimming — a chance to recover and to work on technique.", est: EST_SWIM });
  const SW_TECH = parts => swim("Swim — endurance & technique", "Z2", parts,
    { tip: "Steady swimming with the focus on good technique.", est: EST_SWIM });
  const OPEN_WATER = (parts, tip, est) => swim("Open-water swim", "Z2", parts,
    { tip: tip || "If open water isn't an option yet, swim it in the pool instead — continuously where you can.", est: est });
  const WU_FB = (r) => [rep(1, ["100 FSb3 Z2"], r), rep(1, ["100 Pull Z2", "100 Drill Z2"], r), rep(1, ["100 FS Z2"], r)];
  const WU_REC = n => [rep(1, ["100 FS Z2", "100 Drill Z2"], 10), rep(n, ["50 Breast Z2", "50 Back Z2"], 10)];
  const WU_OW = [rep(1, ["100 FS Z2"], 10), rep(1, ["100 Drill Z2"], 10)];

  const AE_1400 = () => SW_AE({ wu: [rep(1, ["200 FSb3 Z2"], 15), rep(1, ["100 Pull Z2", "100 Drill Z2"], 15), rep(1, ["200 FS Z2"], 15)],
    main: [rep(2, ["100 FS uZ2"], 15), rep(2, ["100 FS Z2"], 15), rep(2, ["100 FS uZ2"], 15), rep(1, ["100 FS Z2"], 15)], cd: ["100 FS Z12"] });
  const AE_1600 = () => SW_AE({ wu: WU_FB(15),
    main: [rep(2, ["200 FS Z2", "50 FS Z4"], 15), rep(2, ["100 FS Z2", "100 FS Z3"], 15), rep(2, ["50 FS Z2", "50 FS Z4"], 15)], cd: ["100 FS Z12"] });
  const AE_1800 = () => SW_AE({ wu: [rep(1, ["100 FS Z2", "100 Drill Z2"], 10), rep(1, ["200 Pull Z2"], 10)],
    main: [rep(2, ["400 FS Z2"], 20), rep(4, ["100 FS uZ2"], 15)], cd: ["200 FS Z12"] }, EST_GUESS);
  // 2 × (a Z2 + 50 Z4), 2 × (b Z2 + 100 Z3), then short Z4 pick-ups
  const AE_2000 = (a, b) => SW_AE({ wu: WU_FB(15),
    main: [rep(2, [a + " FS Z2", "50 FS Z4"], 15), rep(2, [b + " FS Z2", "100 FS Z3"], 15), rep(2, ["50 FS Z2", "50 FS Z4"], 15), rep(1, ["100 FS Z2", "50 FS Z4"], 15)],
    cd: ["150 FS Z12"] });
  // one long Z2 swim, 4 × `reps` m in upper Z2, then k × 200 m Z2 and k × 200 m upper Z2
  const AE_LONG = (wu, first, reps, k, cd) => SW_AE({ wu: wu,
    main: [rep(1, [first + " FS Z2"], 20), rep(4, [reps + " FS uZ2"], 20), rep(k, ["200 FS Z2"], 20), rep(k, ["200 FS uZ2"], 20), rep(1, ["200 FS Z2"], 20)],
    cd: [cd + " FS Z12"] });
  const WU_FP = [rep(1, ["100 FS Z2", "100 Pull Z2"], 20)];
  const AE_2400 = () => AE_LONG(WU_FP.concat([rep(1, ["100 FS Z2", "100 Drill Z2"], 20)]), 400, 100, 2, 200);
  const AE_2600 = () => AE_LONG(WU_FP.concat([rep(2, ["100 FS Z2", "100 Drill Z2"], 20)]), 400, 100, 2, 200);
  const AE_3200 = () => AE_LONG(WU_FP.concat([rep(2, ["100 FS Z2", "100 Drill Z2"], 20)]), 400, 150, 3, 200);
  const AE_3400 = () => AE_LONG(WU_FP.concat([rep(1, ["200 FS Z2", "200 Drill Z2"], 20)]), 500, 150, 3, 300);
  const AE_2750 = () => SW_AE({ wu: [rep(2, ["100 FSb3 Z2"], 15), rep(2, ["100 Pull Z2", "100 Drill Z2"], 15), rep(2, ["100 FS Z2"], 15)],
    main: [rep(1, ["350 FS Z2", "50 FS Z4"], 20), rep(1, ["400 FS Z2"], 20), rep(1, ["150 FS Z2", "100 FS Z3"], 20), rep(1, ["200 FS Z2", "100 FS Z3"], 20), rep(3, ["100 FS Z2", "50 FS Z4"], 15)],
    cd: ["150 FS Z12"] });
  const SE_1600 = est => SW_SE({ wu: [rep(1, ["100 FS Z2", "100 Drill Z2"], 15), rep(1, ["50 Pull Z2", "50 Pull Z3"], 15)],
    main: [rep(2, ["200 FS uZ2"], 15), rep(4, ["100 FS Z3"], 15), rep(6, ["50 FS Z5"], 15)], cd: [rep(2, ["100 FS Z12"], 15)] }, est);
  const SE_1800 = () => SW_SE({ wu: [rep(1, ["100 FS Z2", "100 Kick Z2"], 15), rep(1, ["100 Drill Z2", "100 Pull Z2"], 15)],
    main: [rep(4, ["50 FS Z2", "50 FS Z3"], 15), rep(4, ["50 FS Z2", "50 FS Z4"], 15), rep(4, ["50 FS Z2", "50 FS Z5"], 15)], cd: ["200 FS Z12"] });
  const SE_1800B = () => SW_SE({ wu: [rep(1, ["100 FS Z2", "100 Drill Z2"], 15), rep(2, ["50 Pull Z2", "50 Pull Z3"], 15)],
    main: [rep(2, ["200 FS uZ2"], 15), rep(4, ["100 FS Z3"], 15), rep(8, ["50 FS Z5"], 15)], cd: ["200 FS Z12"] }, EST_GUESS);
  const SE_2200 = () => SW_SE({ wu: [rep(1, ["100 FS Z2", "100 Kick Z2"], 15), rep(1, ["100 Drill Z2", "100 Pull Z2"], 15)],
    main: [rep(3, ["100 FS Z2", "100 FS Z3"], 15), rep(3, ["100 FS Z2", "100 FS Z4"], 15), rep(2, ["100 FS Z2", "100 FS Z5"], 15)], cd: ["200 FS Z12"] });
  // 2 × 400 m and 4 × 200 m at threshold
  const TH_LONG = (wu, cd) => SW_TH({ wu: wu, main: [rep(2, ["400 FS Z4"], 20), rep(4, ["200 FS Z4"], 20)], cd: [cd + " FS Z12"] });
  const TH_2400 = () => TH_LONG([rep(1, ["200 FS Z2"], 20), rep(1, ["50 FS Z2", "50 FS Z3"], 20), rep(1, ["100 FS Z2", "100 FS Z4"], 20)], 300);
  const TH_2600 = () => TH_LONG([rep(1, ["100 FS Z2", "100 Pull Z2"], 10), rep(1, ["100 FS Z2", "100 Pull Z3"], 10), rep(1, ["100 FS Z2", "100 FS Z4"], 20)], 400);
  // one threshold swim, then three ladders from Z2 up to Z5
  const TH_LADDER = (wu, first) => SW_TH({ wu: wu,
    main: [rep(1, [first + " FS Z4"], 20), rep(3, ["100 FS Z2", "100 FS Z3", "100 FS Z4", "50 FS Z5"], 20)], cd: ["300 FS Z12"] });
  const TH_1900 = () => TH_LADDER([rep(1, ["100 FS Z2", "100 FS Z4"], 20), rep(1, ["50 FS Z2", "150 FS Z4"], 20)], 150);
  const TH_2150 = () => TH_LADDER([rep(1, ["150 FS Z2", "50 FS Z4"], 20), rep(1, ["100 FS Z2", "100 FS Z4"], 20), rep(1, ["50 FS Z2", "150 FS Z4"], 20)], 200);
  const TH_2200 = () => SW_TH({ wu: [rep(1, ["100 FS Z2", "100 Pull Z2"], 10), rep(1, ["50 FS Z2", "50 FS Z3"], 10), rep(1, ["50 FS Z2", "50 FS Z4"], 10)],
    main: [rep(1, ["400 FS Z4"], 20), rep(1, ["300 FS Z4"], 20), rep(4, ["200 FS Z4"], 20)], cd: ["300 FS Z12"] });
  const REC_1800 = () => SW_REC({ wu: WU_REC(2), main: [rep(1, ["200 FS Z2"], 10), rep(2, ["400 FS Z2"], 10), rep(1, ["200 Pull Z2"], 10)], cd: ["200 FS Z12"] });
  const REC_1600 = () => SW_REC({ wu: WU_REC(1), main: [rep(1, ["200 FS Z2"], 10), rep(2, ["400 FS Z2"], 10), rep(1, ["200 Pull Z2"], 10)], cd: ["100 FS Z12"] });
  const REC_2000 = (first, mid, pull, cd) => SW_REC({ wu: WU_REC(2),
    main: [rep(1, [first + " FS Z2"], 10), rep(2, [mid + " FS Z2"], 10), rep(1, [pull + " Pull Z2"], 10)], cd: [cd + " FS Z12"] });
  const TECH_1800A = () => SW_TECH({ wu: [rep(1, ["100 Pull Z2", "100 Drill Z2"], 15), rep(1, ["100 Drill Z2", "100 Pull Z2"], 15)],
    main: [rep(2, ["200 FS Z2"], 15), rep(1, ["50 FS Z2", "50 FS Z4"], 15), rep(2, ["300 FS Z2"], 15), rep(1, ["50 FS Z2", "50 FS Z4"], 15)], cd: ["200 FS Z12"] });
  const TECH_1800B = () => SW_TECH({ wu: [rep(1, ["200 FSb3 Z2"], 15), rep(1, ["200 Pullb5 Z2"], 15), rep(1, ["200 Drill Z2"], 15)],
    main: [rep(4, ["100 FS Z2", "100 FS Z3"], 15), rep(4, ["50 Drill Z2"], 15)], cd: ["200 FS Z12"] });
  const OW_2000 = () => OPEN_WATER({ main: ["2000 FS Z2"],
    say: { main: "2,000 m all in Z2. Take as many rests as you want — this first one is just to get used to open water again." } },
    "Swimming in open water in training builds confidence and technique for race day. If it isn't an option yet, swim it in the pool.");
  const OW_2200 = () => OPEN_WATER({ wu: WU_OW, main: [rep(2, ["800 FS Z3"], 60)], cd: ["400 FS Z2"] }, null, EST_SWIM);
  const OW_2550 = () => OPEN_WATER({ wu: WU_OW, main: [rep(3, ["750 FS Z3"], 60)], cd: ["100 FS Z2"] }, null, EST_SWIM);
  const OW_STARTS = () => OPEN_WATER({ wu: [rep(1, ["400 FS Z2"], 30)], main: [rep(4, ["50 FS Z5"], 30), "1000 FS uZ2"], cd: ["400 FS Z2"],
    say: { main: "4 × (50 m FS in Z5 + 30 s rest) — practise race starts, from the beach or deep water — then 1,000 m FS in upper Z2." },
    note: { main: "Make the 50s race starts — from the beach or deep water." } }, null, EST_SWIM);
  const RACE_PACE_SWIM = () => swim("Swim — race pace", "1.5 km at Z3", { wu: [rep(1, ["300 FS Z2"], 30)], main: [rep(1, ["1500 FS Z3"], 60)], cd: ["100 FS Z12"] },
    { tip: "Race distance at race effort — settle into the rhythm you want on the day.", est: "Cool-down read from this workout's chart in the plan — the PDF cut the text off." });
  const OW_RACE_WEEK = () => OPEN_WATER({ main: ["1500 FS Z2"],
    say: { main: "1,500 m easy/steady in Z2 — at the race venue if you can, to get a feel for the conditions." } });

  const RACE = () => S("race", "🏁 Ironman 70.3", "1.9 km swim · 90 km bike · 21.1 km run", [
    { label: "Swim 1.9 km", text: "Steady and controlled: settle your breathing early, sight often and draft where you can. Race pace is the Z3 you practised." },
    { label: "Bike 90 km", text: "Ride the effort from your race-practice rides — low to mid Z3, never above. Fuel 60–90 g of carbs an hour from the start." },
    { label: "Run 21.1 km", text: "Off the bike, let the first few km feel easy, then hold a steady Z3. Walk the aid stations, take fuel, then reel them in." },
    { label: "You've got this", text: "One build, one goal, all of it earned. Enjoy the finish line." }
  ]);

  // ---------- the 24 weeks ----------
  // b: block (see BLOCKS) · easy: an active-recovery week · tips: MyProCoach
  // reading per weekday (0 = Mon) · days(): Monday → Sunday sessions
  const TIPS = {
    "base-phase": "Base phase — week 1", "day-one-triathlon": "Day one of your 24-week plan",
    "thresholds_and_zones": "Thresholds and training zones", "nutrition-in-training": "Nutrition in training",
    "swim-workouts": "Swim workouts", "optional-workouts": "Optional workouts", "zone-2": "Training in Zone 2",
    "making-adjustments": "Adjusting workouts", "recovery-weeks": "Recovery weeks", "build-phase": "Build phase",
    "swim-tips": "Swim tips", "half-ironman-brick-sessions": "Brick sessions for IRONMAN 70.3", "cycling": "Cycling",
    "how-long-to-get-fit": "How long does it take to get fit?", "toughest-weeks": "Managing the toughest training weeks",
    "halfway": "Halfway!", "balance": "Balancing training with life", "peak-phase": "Peak phase",
    "triathlon-pacing": "Triathlon pacing", "open-water-swimming": "Open-water swimming",
    "ironman-70-3-race-day": "Race preparation — IRONMAN 70.3", "taper-phase": "The taper",
    "final-taper-week": "Your final week of training", "rewards": "Rewards!", "triathlon-good-luck": "Good luck at your triathlon!"
  };
  const BUILD1 = "Build 1 — speed and strength: speed sessions on the bike and run, big-gear torque rides, and 3-hour rides with a run off the bike.";
  const BUILD2 = "Build 2 — race-specific: 70.3 power slopes on the bike, sustained Z3 runs, threshold swims and 3 h 15 rides.";
  const BUILD3 = "Build 3 — the biggest weeks: 3 h 30 rides with a faster run off the bike, and 2-hour long runs.";
  const PEAK1 = "Peak 1 — race practice: race-effort rides with long runs off the bike, threshold runs and open-water swims.";
  const PEAK2 = "Peak 2 — sharpen up: speed sessions on the bike and run, race-practice bricks and open water.";
  const RETEST = "Recovery and retest week — lighter training, then the three tests again to update your zones.";
  const WEEKS = [
    { b: "base", banner: "Test week — the CSS swim, FTP bike and 30-minute run tests set your zones for everything that follows.",
      tips: { 0: ["base-phase", "day-one-triathlon"], 3: ["thresholds_and_zones"], 5: ["nutrition-in-training"] }, days: () => [
      [CSS_TEST()], [FTP_TEST()], [REST()], [RUN_TEST()], [AE_1400()],
      [Z2_RIDE(135, "Ride at an easy/steady effort, mainly in Z2 — you should be able to chat.", "Past about 1 h 20 min you need to eat and drink as you go — practise your race fuelling now.")],
      [LONG(55, "A steady run, mainly in Z1–Z2 — you should be able to chat. This is your long run.", "Your pace on these runs depends on terrain, weather and tiredness — run by zone, not pace.")]] },
    { b: "base", banner: "Base — the aerobic engine: a long Z2 ride and run, one threshold bike, one speed run and two swims.",
      tips: { 0: ["swim-workouts"], 3: ["optional-workouts"], 5: ["zone-2"] }, days: () => [
      [AE_1600()],
      [THRESH_BIKE(55, "Z3–Z4 efforts", { wu: ["10m Z2", rep(5, ["15s uZ3", "45s Z2"])],
        main: ["5m uZ3", "1m Z1", "6m Z4", "1m Z1", "7m uZ3", "2m Z2", "6m Z4", "1m Z1", "5m uZ3", "1m Z1"], cd: ["5m Z2"] })],
      [SPEED_RUN(45, "16 × 40 s fast", { wu: ["12m Z2", rep(3, ["10s Z4", "50s Z2"])],
        main: [rep(8, ["40s Z5", "20s Z1"]), "4m Z2", rep(8, ["40s Z5", "20s Z1"])], cd: ["10m Z2"] })],
      [AE_BIKE(62.5, { wu: ["15m Z2"], main: [rep(4, ["1m lZ2", "5m uZ2"]), "1m lZ2", rep(5, ["3m uZ2", "30s lZ2"])], cd: ["5m lZ2"] }, null, true), SE_1600(EST_GUESS)],
      [REST()],
      [Z2_RIDE(150, "Ride mainly in Z2 today.", "You don't have to ride alone — club or group rides count, as long as you keep it in Z2.")],
      [LONG(60, null, "Don't panic if you can't complete every workout — do your best and keep going.")]] },
    { b: "base", banner: "Base — same shape, a little longer. Thursday's ride is optional.",
      tips: { 6: ["making-adjustments"] }, days: () => [
      [AE_1600()],
      [THRESH_BIKE(58, "Z4 efforts", { wu: ["10m Z2", rep(5, ["15s uZ3", "45s Z2"])], main: ["9m Z4", "2m Z1", "8m Z4", "2m Z1", "7m Z4"], cd: ["15m Z2"] })],
      [SPEED_RUN(46, "12 × 60 s fast", { wu: ["15m Z2"], main: [rep(6, ["60s lZ5", "30s Z1"]), "3m Z1", rep(6, ["60s lZ5", "30s Z1"])], cd: ["10m Z2"] })],
      [AE_BIKE(64, { wu: ["10m Z2"], main: [rep(4, ["10m uZ2", "1m lZ2"])], cd: ["10m lZ2"] }, null, true), SE_1600()],
      [REST()],
      [Z2_RIDE(165, "Ride mainly in Z2 today.", "Riding indoors is a little harder than outside — there's no freewheeling — so it's fine to cut an indoor ride a bit shorter.")],
      [LONG(65)]] },
    { b: "base", easy: true, banner: "Active recovery week — lighter, so the first block sinks in. Keep the easy days easy.",
      tips: { 1: ["recovery-weeks"] }, days: () => [
      [REC_1800()],
      [THRESH_BIKE(39, "low Z4 efforts", { wu: ["5m Z2", rep(5, ["10s Z4", "50s Z2"])], main: [rep(4, ["5m lZ4", "1m Z2"])], cd: ["5m Z2"] })],
      [run("Run — aerobic speed session", 35, "10 × 60 s fast", { wu: ["15m Z2"], main: [rep(10, ["60s lZ5", "30s Z1"])], cd: ["5m Z2"] })],
      [TECH_1800A()],
      [REST()],
      [Z2_RUN(45, "Run — aerobic endurance", "Nice and easy, at a chatty pace, mainly in Z1–Z2.")],
      [Z2_RIDE(90, "Nice and easy today — enjoy it, and stop for a coffee if you like!", "Cadence is how many pedal revolutions you do per minute — keep it light and spinning on easy rides.")]] },
    { b: "build1", banner: BUILD1,
      tips: { 0: ["build-phase"], 3: ["swim-tips"], 5: ["half-ironman-brick-sessions"] }, days: () => [
      [SE_1800()],
      [SPEED_BIKE(56, "1–6′ pyramid", { wu: ["15m Z2"], main: ["1m Z45", "1m Z1", "2m Z45", "90s Z1", "3m Z45", "2m Z1", "4m Z45", "150s Z1", "5m Z4", "3m Z1", "6m Z4"], cd: ["10m Z2"] })],
      [SPEED_RUN(50, "10 × 90 s hard", { wu: ["10m Z2"], main: [rep(10, ["90s uZ4", "2m Z12"])], cd: ["5m Z2"] })],
      [TORQUE(49, ["10m Z2"], ["9m Z3 60rpm", "1m Z1", "9m Z3 60rpm", "1m Z1", "9m Z3 60rpm"], ["10m Z2"]), AE_1800()],
      [REST()],
      [SUB_RIDE(180, 80, 3, 10, 3, "3 × 10′ upper Z3–low Z4"), OFF_BIKE(10)],
      [LONG(70)]] },
    { b: "build1", banner: BUILD1,
      tips: { 3: ["zone-2"], 5: ["cycling"] }, days: () => [
      [AE_2000(200, 200)],
      [SPEED_BIKE(56, "7-6-5-4′ upper Z4", { wu: ["15m Z2"], main: ["7m uZ4", "3m Z2", "6m uZ4", "3m Z2", "5m uZ4", "3m Z2", "4m uZ4"], cd: ["10m Z2"] })],
      [SPEED_RUN(50, "5 × 3′ upper Z4", { wu: ["15m Z2"], main: [rep(5, ["3m uZ4", "2m Z2"])], cd: ["10m Z2"] })],
      [TORQUE(53, ["10m Z2"], ["9m Z3 60rpm", "1m Z1", "8m Z3 60rpm", "1m Z1", "7m Z3 60rpm", "1m Z1", "6m Z3 60rpm"], ["10m Z2"]), SE_1800B()],
      [REST()],
      [SUB_RIDE(180, 90, 2, 15, 3, "2 × 15′ upper Z3–low Z4"), OFF_BIKE(15)],
      [LONG(80)]] },
    { b: "build1", banner: BUILD1, days: () => [
      [AE_2000(250, 150)],
      [SPEED_BIKE(59, "36 × 30 s sprints", { wu: ["10m Z2"], main: [rep(20, ["30s Z5", "30s Z2"]), "3m Z2", rep(16, ["30s Z5", "30s Z2"])], cd: ["10m Z2"] })],
      [SPEED_RUN(52, "9 × 2′ hard", { wu: ["15m Z2"], main: [rep(9, ["2m uZ4", "60s Z1"])], cd: ["10m Z2"] })],
      [TORQUE(52, ["10m Z2"], ["12m Z3 60rpm", "1m Z1", "10m Z3 60rpm", "1m Z1", "8m Z3 60rpm"], ["10m Z2"]), SE_2200()],
      [REST()],
      [SUB_RIDE(180, 80, 3, 10, 3, "3 × 10′ upper Z3–low Z4"), OFF_BIKE(20)],
      [LONG(90)]] },
    { b: "build1", easy: true, banner: RETEST,
      tips: { 1: ["how-long-to-get-fit"] }, days: () => [
      [CSS_TEST()], [FTP_TEST()], [REST()], [RUN_TEST()], [REC_1600()],
      [Z2_RIDE(90, "Easy/steady Z2 ride — feel free to stop for a coffee or a snack. Enjoy it and save your legs.")],
      [Z2_RUN(45, "Run — aerobic endurance", "Nice steady run in Z1–Z2.")]] },
    { b: "build2", banner: BUILD2, tips: { 6: ["toughest-weeks"] }, days: () => [
      [AE_2400()],
      [SLOPE(62, [[8, 5], [7, 4], [5, 4]])],
      [SUSTAINED(51, 3, 8, 3)],
      [TORQUE(59, ["10m Z2"], ["10m lZ3 50rpm", "1m Z1", "9m lZ3 50rpm", "1m Z1", "8m lZ3 50rpm", "1m Z1", "7m lZ3 50rpm", "1m Z1", "6m lZ3 50rpm"], ["5m Z2"]), TH_2400()],
      [REST()],
      [SUB_RIDE(195, 90, 3, 12, 3, "3 × 12′ upper Z3–low Z4"), OFF_BIKE(20)],
      [LONG(100)]] },
    { b: "build2", banner: BUILD2, days: () => [
      [AE_2600()],
      [SLOPE(63, [[9, 5], [7, 4], [5, 4]])],
      [SUSTAINED(54, 3, 9, 3)],
      [TORQUE(54, ["10m Z2"], ["12m Z3 60rpm", "2m Z2", "10m Z3 60rpm", "2m Z2", "8m Z3 60rpm"], ["10m Z2"]), TH_1900()],
      [REST()],
      [SUB_RIDE(195, 90, 2, 20, 3, "2 × 20′ upper Z3–low Z4"), OFF_BIKE(25)],
      [LONG(110)]] },
    { b: "build2", banner: BUILD2 + " Christmas Day is a rest day.", days: () => [
      [AE_2600()],
      [SLOPE(64, [[9, 6], [7, 4], [5, 4]])],
      [SUSTAINED(57, 3, 10, 3)],
      [TORQUE(56, ["15m Z2"], [rep(2, ["15m Z3 60rpm", "3m Z2"])], ["5m Z2"]), TH_2600()],
      [REST()],
      [SUB_RIDE(195, 95, 1, 40, 0, "40′ upper Z3–low Z4"), OFF_BIKE(30)],
      [LONG(120)]] },
    { b: "build2", easy: true, banner: "Active recovery over New Year — easy sessions. You're halfway through the plan.",
      tips: { 5: ["halfway"] }, days: () => [
      [REC_1600()],
      [SPEED_BIKE(43, "9-7-5′ low Z4", { wu: ["15m Z2"], main: ["9m lZ4", "1m Z1", "7m lZ4", "1m Z1", "5m lZ4"], cd: ["5m Z2"] })],
      [SPEED_RUN(40, "10 × 60 s", { wu: ["15m Z2"], main: [rep(10, ["60s Z4", "60s Z2"])], cd: ["5m Z2"] }, { tip: null })],
      [TECH_1800B()],
      [REST()],
      [Z2_RUN(50, "Run — aerobic endurance", "Nice steady run in Z1–Z2.", "Be patient — fitness improves drip by drip, not all at once.")],
      [Z2_RIDE(90, "Easy/steady Z2 ride — feel free to stop for a coffee. Enjoy it and save your legs for next week.")]] },
    { b: "build3", banner: BUILD3, days: () => [
      [AE_3200()],
      [SLOPE(65, [[9, 6], [7, 5], [5, 4]])],
      [SUSTAINED(58, 4, 8, 2)],
      [TORQUE(59, ["5m Z2"], ["11m lZ3 50rpm", "1m Z1", "10m mZ3 50rpm", "1m Z1", "9m mZ3 50rpm", "1m Z1", "8m mZ3 50rpm", "1m Z1", "7m mZ3 50rpm"], ["5m Z2"]), TH_2150()],
      [REST()],
      [SUB_RIDE(210, 90, 4, 10, 3, "4 × 10′ upper Z3–low Z4"), OFF_BIKE_FAST(30, 10, "Z3")],
      [LONG(120)]] },
    { b: "build3", banner: BUILD3, tips: { 6: ["balance"] }, days: () => [
      [AE_2750()],
      [SLOPE(66, [[10, 6], [7, 5], [5, 4]])],
      [SUSTAINED(62, 4, 9, 2)],
      [TORQUE(57, ["10m Z2"], ["13m Z3 60rpm", "2m Z2", "11m Z3 60rpm", "2m Z2", "9m Z3 60rpm"], ["10m Z2"]), TH_2200()],
      [REST()],
      [SUB_RIDE(210, 90, 3, 15, 3, "3 × 15′ upper Z3–low Z4"), OFF_BIKE_FAST(30, 10, "Z3")],
      [LONG(120)]] },
    { b: "build3", banner: BUILD3, days: () => [
      [AE_3400()],
      [SLOPE(68, [[10, 6], [8, 5], [6, 4]])],
      [SUSTAINED(66, 4, 10, 2)],
      [TORQUE(56, ["15m Z2"], [rep(2, ["15m Z3 60rpm", "3m Z2"])], ["5m Z2"]), TH_2150()],
      [REST()],
      [SUB_RIDE(210, 90, 2, 20, 3, "2 × 20′ upper Z3–low Z4"), OFF_BIKE_FAST(30, 10, "Z3")],
      [LONG(120)]] },
    { b: "build3", easy: true, banner: "Recovery and final retest week — the last tests before the peak phase.", days: () => [
      [CSS_TEST()], [FTP_TEST()], [REST()], [RUN_TEST()], [REC_2000(300, 450, 250, 150)],
      [Z2_RIDE(90, "Easy/steady Z2 ride. Save your legs for next week.")],
      [Z2_RUN(45, "Run — aerobic endurance", "Nice steady run in Z1–Z2.")]] },
    { b: "peak1", banner: PEAK1,
      tips: { 0: ["peak-phase"], 5: ["triathlon-pacing"], 6: ["open-water-swimming"] }, days: () => [
      PEAK_MON(53, { wu: ["10m Z2"], main: [rep(4, ["5m uZ2", "60s lZ2"]), rep(4, ["3m uZ2", "30s lZ2"])], cd: ["5m lZ2"] }),
      [THRESH_RUN(63, "7 × 4′ low Z4", { wu: ["15m Z2"], main: [rep(4, ["4m lZ4", "60s Z1"]), "3m Z2", rep(3, ["4m lZ4", "60s Z1"])], cd: ["10m Z2"] })],
      [SUB_BIKE(64, "18-15-10′ upper Z3", { wu: ["5m mZ2", "4m uZ2", "60s lZ2"], main: ["18m uZ3", "2m Z1", "15m uZ3", "2m Z1", "10m uZ3", "2m Z1"], cd: ["5m Z2"] })],
      [AE_2750()],
      [REST()],
      [RACE_RIDE(165, 30, 6, 15, 5, 15), OFF_BIKE_FAST(75, 15, "Z3")],
      [OW_2000()]] },
    { b: "peak1", banner: PEAK1, days: () => [
      PEAK_MON(57, { wu: ["10m Z2"], main: [rep(7, ["5m uZ2", "1m lZ2"])], cd: ["5m lZ2"] }),
      [THRESH_RUN(63, "8 × 4′ low Z4", { wu: ["10m Z2"], main: [rep(4, ["4m lZ4", "60s Z1"]), "3m Z2", rep(4, ["4m lZ4", "60s Z1"])], cd: ["10m Z2"] })],
      [SUB_BIKE(66, "20-15-10′ upper Z3", { wu: ["5m mZ2", "4m uZ2", "60s lZ2"], main: ["20m uZ3", "2m Z1", "15m uZ3", "2m Z1", "10m uZ3", "2m Z1"], cd: ["5m Z2"] })],
      [AE_3200()],
      [REST()],
      [RACE_RIDE(165, 15, 7, 15, 5, 10), OFF_BIKE_FAST(80, 20, "Z3")],
      [OW_2200()]] },
    { b: "peak1", banner: PEAK1, tips: { 5: ["ironman-70-3-race-day"] }, days: () => [
      PEAK_MON(59, { wu: ["10m Z2"], main: [rep(4, ["10m uZ2", "1m lZ2"])], cd: ["5m lZ2"] }),
      [THRESH_RUN(70, "8 × 4′ low Z4", { wu: ["15m Z2"], main: [rep(8, ["4m lZ4", "60s Z1"])], cd: ["15m Z2"] })],
      [SUB_BIKE(70, "20-16-12′ upper Z3", { wu: ["5m mZ2", "4m uZ2", "2m lZ2"], main: ["20m uZ3", "2m Z1", "16m uZ3", "2m Z1", "12m uZ3", "2m Z1"], cd: ["5m Z2"] })],
      [AE_2750()],
      [REST()],
      [RACE_RIDE(165, 15, 7, 15, 5, 10), OFF_BIKE_FAST(90, 20, "Z3")],
      [OW_2550()]] },
    { b: "peak1", easy: true, banner: "Active recovery week — easy before the final peak.", days: () => [
      [REST()],
      [THRESH_RUN(40, "10′ Z4", { wu: ["15m Z2"], main: ["10m Z4"], cd: ["15m Z2"] })],
      [SUB_BIKE(49, "2 × 10′ upper Z3", { wu: ["5m mZ2", "5m uZ2", "5m mZ2"], main: [rep(2, ["10m uZ3", "2m Z1"])], cd: ["10m Z2"] })],
      [REC_2000(200, 500, 200, 200)],
      [REST()],
      [Z2_RIDE(120, "Easy/steady Z2 ride today."), OFF_BIKE(60, "A steady Z2 run off the bike.")],
      [OW_STARTS()]] },
    { b: "peak2", banner: PEAK2, days: () => [
      PEAK_MON(55, { wu: ["5m Z2"], main: ["15m uZ2", "60s Z12", "12m uZ2", "60s Z12", "10m uZ2", "60s Z12"], cd: ["10m Z12"] },
        "An aerobic endurance session — it's not supposed to feel hard."),
      [SPEED_RUN(52, "4 × 90 s + 2 × 3′ + 6′", { wu: ["15m Z2"], main: [rep(4, ["90s uZ5", "2m Z12"]), rep(2, ["3m Z4", "2m Z12"]), "6m Z3"], cd: ["7m Z12"] })],
      [SPEED_BIKE(62, "6-7-8-7-6′ Z4", { wu: ["15m Z2"], main: ["6m Z4", "2m Z2", "7m Z4", "2m Z2", "8m Z4", "2m Z2", "7m Z4", "2m Z2", "6m Z4"], cd: ["5m Z2"] })],
      [AE_3400()],
      [REST()],
      [RACE_RIDE(123, 30, 6, 10, 3, 15), OFF_BIKE(105, "Straight off the bike — all in Z2, nice and steady.")],
      [OW_2200()]] },
    { b: "peak2", banner: PEAK2, days: () => [
      PEAK_MON(55, { wu: ["5m mZ2"], main: ["10m uZ2", "60s lZ2", "9m uZ2", "60s lZ2", "8m uZ2", "60s lZ2", "7m uZ2", "60s lZ2", "6m uZ2", "60s lZ2"], cd: ["5m lZ2"] }),
      [SPEED_RUN(47, "8 × 2′ hard", { wu: ["10m Z2"], main: [rep(8, ["2m Z5", "2m Z1"])], cd: ["5m Z2"] })],
      [SPEED_BIKE(57, "6 × 5′ Z4", { wu: ["10m Z2"], main: [rep(6, ["5m Z4", "2m Z2"])], cd: ["5m Z2"] })],
      [AE_2750()],
      [REST()],
      [RACE_RIDE(126, 30, 4, 16, 3, 20), OFF_BIKE_FAST(90, 15, "uZ2lZ3", "Do the first 15 min in upper Z2 to low Z3, then settle into a steady Z2 for the rest.")],
      [OW_2200()]] },
    { b: "taper", banner: "Taper — volume drops, intensity stays. A race-pace swim and one last brick.",
      tips: { 0: ["taper-phase"] }, days: () => [
      PEAK_MON(59, { wu: ["5m lZ2"], main: ["20m uZ2", "2m Z12", "15m uZ2", "2m Z12", "10m uZ2"], cd: ["5m Z12"] }),
      [SPEED_RUN(38, "3 × 3′ hard", { wu: ["15m Z2"], main: [rep(3, ["3m Z5", "2m Z2"])], cd: ["8m Z2"] },
        { tip: "Technique focus today: drive the thigh of your swing leg forwards." })],
      [SPEED_BIKE(42.5, "4-5-6-5-4′ low Z4", { wu: ["10m Z2"], main: ["4m lZ4", "30s Z1", "5m lZ4", "30s Z1", "6m lZ4", "2m Z1", "5m lZ4", "30s Z1", "4m lZ4"], cd: ["5m Z2"] })],
      [RACE_PACE_SWIM()],
      [REST()],
      [RACE_RIDE(91, 30, 2, 20, 3, 15), OFF_BIKE_FAST(40, 15, "Z3", "Straight after the ride, grab your running shoes: 15 min in Z3, then ease down into Z2 for the last 25.")],
      [OW_2550()]] },
    { b: "taper", banner: "Race week — short, sharp and rested. Ironman 70.3 on Sunday.",
      tips: { 0: ["final-taper-week"], 3: ["rewards"], 6: ["triathlon-good-luck"] }, days: () => [
      [REST()],
      [SPEED_BIKE(35, "4 × 3′ Z4", { wu: ["15m Z2"], main: [rep(4, ["3m Z4", "60s Z12"])], cd: ["4m Z2"] }, "Bike — short speed workout")],
      [run("Run — short speed workout", 30, "10′ low Z4", { wu: ["15m Z2"], main: ["10m lZ4"], cd: ["5m Z2"] }), REC_1800()],
      [run("Run — easy", 25, "Z2", { main: ["25m Z2"], say: { main: "Nice and easy in Z2 — at the race venue if you can." } })],
      [ride("Bike — easy spin", 30, "Z2", { main: ["30m Z2"], say: { main: "On your race bike, all in Z2 — on the race route if you can. Just checking the bike's working well." } }), OW_RACE_WEEK()],
      [REST()],
      [RACE()]] }
  ];

  function plan24Day(isoStr) {
    const wi = Math.floor(daysBetween(PLAN24, isoStr) / 7), wd = weekdayMon0(isoStr), w = WEEKS[wi];
    return {
      sessions: w.days()[wd],
      banner: isoStr === RACE_703 ? "RACE DAY. Trust the training. Nothing new — just execution." : w.banner,
      weekNum: wi + 1, weekOf: WEEKS.length, easyWeek: !!w.easy,
      tips: ((w.tips || {})[wd] || []).map(slug => ({ title: TIPS[slug], url: "https://www.myprocoach.net/trainingtips/" + slug + "/" }))
    };
  }

  function postDay() {
    return { sessions: [S("mobility", "Recover & celebrate", "as you feel", [{ label: "Note", text: "Season done. Rest properly, move gently, and be proud — that was a huge year of work." }])], banner: "After the 70.3 — recover, reflect, celebrate. 🎉" };
  }

  function dayObj(week, wd, isoStr, sessions, banner) {
    return { sessions: sessions, banner: banner || null, weekNum: week };
  }

  // ---------- public: full day for any ISO date ----------
  function getDay(isoStr) {
    const weekIdx = Math.floor(daysBetween(PLAN_START, isoStr) / 7);
    const phase = phaseFor(isoStr, weekIdx);
    const wd = weekdayMon0(isoStr);
    let body;
    if (phase.id === "pre") body = { sessions: [], banner: null };
    else if (phase.id === "p1") body = p1Day(weekIdx + 1, wd, isoStr);
    else if (phase.id === "recovery") body = Object.assign(recoveryDay(wd), { easyWeek: true });
    else if (phase.id === "post") body = postDay();
    else body = plan24Day(isoStr);

    // events / labels
    const events = [];
    if (isoStr === RACE_703) events.push("Ironman 70.3");
    if (isoStr >= DOLOMITES[0] && isoStr <= DOLOMITES[1]) events.push("Dolomites camp");

    return {
      iso: isoStr,
      phase: phase,
      weekNum: phase.id === "p1" ? weekIdx + 1 : (body.weekNum || null),
      weekOf: body.weekOf || null,     // "Week 3 of 24" in Phil's plan
      easyWeek: !!body.easyWeek,       // a recovery week — the plan wants it easy
      dayName: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"][wd],
      banner: body.banner,
      events: events,
      tips: body.tips || [],           // MyProCoach reading for the day: [{ title, url }]
      sessions: body.sessions
    };
  }

  // ---------- 80/20 polarized intensity classifier (Seiler model) ----------
  // Returns 'easy' | 'hard' | 'strength' | 'rest'. Only easy vs hard feed the
  // polarized ratio; strength & rest are shown separately.
  function intensityOf(s) {
    if (!s) return "rest";
    const t = s.type;
    if (t === "rest") return "rest";
    if (t === "strength") return "strength";
    if (t === "race") return "hard";
    if (t === "mobility") return "easy";
    const hay = ((s.title || "") + " " + (s.sub || "")).toLowerCase();
    if (/z5|z4|z3|threshold|tempo|vo|interval|sweet|reps|sharpen|cruise|hill|surge|brisk|openers|test|speed|slope|sustained|race practice|race pace|sprint/.test(hay)) return "hard";
    return "easy";
  }

  // A session's planned [easy, hard] minutes, for the 80/20 check. Phil's plan
  // knows them step by step; the summer sessions count as an hour of their kind.
  function zoneSplit(s) {
    if (s && s.zmin) return s.zmin;
    const it = intensityOf(s);
    return it === "easy" ? [60, 0] : it === "hard" ? [0, 60] : [0, 0];
  }

  // ---------- macro training blocks (for the overview tab) ----------
  const BLOCKS = [
    { id: "p1", n: 1, name: "Foundation", start: PLAN_START, end: BLOCK1_END,
      points: "70.3 groundwork", tint: "p1",
      focus: "Lay the swim–bike–run groundwork for the 70.3. One quality run midweek, a long ride + brick at the weekend, swim technique twice a week.",
      key: ["Tue quality run", "Sat long ride + brick", "Sun long run", "2× swim"] },
    { id: "recovery", n: 2, name: "Reset", start: "2026-09-28", end: "2026-10-11",
      points: "Recover & absorb", tint: "recovery",
      focus: "Two deliberately easy weeks. Nothing hard, nothing over 10 km — let the summer block soak in before the 70.3 build.",
      key: ["Easy movement", "Short swims", "No long runs"] },
    // Phil's 24-week plan, phase by phase
    { id: "base", n: 3, name: "Base", start: PLAN24, end: "2026-11-08",
      points: "Aerobic engine", tint: "base",
      focus: "Three fitness tests set your zones, then the aerobic engine: a long Z2 ride and run, one threshold bike, one speed run and two swims a week. Week 4 is easy.",
      key: ["3 fitness tests", "Threshold bike", "Speed run", "Long Z2 ride & run"] },
    { id: "build1", n: 4, name: "Build 1", start: "2026-11-09", end: "2026-12-06",
      points: "Speed & strength", tint: "build",
      focus: "Speed sessions on the bike and run, big-gear torque rides, and 3-hour rides with sub-threshold efforts and a run off the bike. Week 8: easy week and retests.",
      key: ["Speed bike & run", "Torque ride", "3 h ride + brick", "Long run to 90 min"] },
    { id: "build2", n: 5, name: "Build 2", start: "2026-12-07", end: "2027-01-03",
      points: "Race-specific", tint: "build",
      focus: "70.3 power slopes on the bike, sustained Z3 runs, threshold swims and 3 h 15 rides with longer efforts. Easy over New Year.",
      key: ["70.3 power slope", "Sustained Z3 run", "Threshold swim", "Long run to 2 h"] },
    { id: "build3", n: 6, name: "Build 3", start: "2027-01-04", end: "2027-01-31",
      points: "Biggest weeks", tint: "build",
      focus: "3 h 30 rides with sub-threshold blocks and a faster run off the bike, 2-hour long runs and the longest swims. Week 16: easy week and final retests.",
      key: ["3 h 30 ride + fast brick", "2 h long run", "Long swims"] },
    { id: "peak1", n: 7, name: "Peak 1", start: "2027-02-01", end: "2027-02-28",
      points: "Race practice", tint: "taper",
      focus: "Rides at race effort followed by long runs off the bike, threshold runs, and open-water swims. Week 20 is easy.",
      key: ["Race-practice brick", "Threshold run", "Open-water swim"] },
    { id: "peak2", n: 8, name: "Peak 2", start: "2027-03-01", end: "2027-03-14",
      points: "Sharpen", tint: "taper",
      focus: "Speed sessions on the bike and run, race-practice bricks and open water every Sunday.",
      key: ["Speed bike & run", "Race-practice brick", "Open water"] },
    { id: "taper", n: 9, name: "Taper", start: "2027-03-15", end: RACE_703,
      points: "Ironman 70.3", tint: "taper",
      focus: "Volume drops, intensity stays: a race-pace swim and one last brick, then race week. Rest is the work now.",
      key: ["Race-pace swim", "Short openers", "Race day 28 Mar"] }
  ];
  const blockOf = id => BLOCKS.filter(b => b.id === id)[0];
  function currentBlock(isoStr) {
    for (let i = 0; i < BLOCKS.length; i++) {
      if (isoStr >= BLOCKS[i].start && isoStr <= BLOCKS[i].end) return BLOCKS[i].id;
    }
    return isoStr > RACE_703 ? "post" : "pre";
  }

  // ---------- a session as watch workouts ----------
  // What gets pushed to intervals.icu (and from there to her Garmin). Strength,
  // mobility, rest and race day stay off the watch. cssSec is her CSS in seconds
  // per 100 m; without it swims still go over, just without pace targets.
  const SPORT = { run: "Run", bike: "Ride", swim: "Swim" };
  function fmtPace(sec) { sec = Math.round(sec); return Math.floor(sec / 60) + ":" + String(sec % 60).padStart(2, "0"); }
  // A swapped day is a saved copy that may predate a newer field (`ws`, `plan`),
  // so look the same session up in the plan around `near`, its date.
  function fromPlan(s, near, field) {
    for (let k = -28; k <= 28; k++) {
      const x = getDay(addDays(near, k)).sessions.filter(x => x[field] && x.type === s.type && x.title === s.title && x.sub === s.sub)[0];
      if (x) return x;
    }
    return null;
  }
  function watchWorkouts(s, cssSec, near) {
    const x = s && !s.ws && near && SPORT[s.type] ? fromPlan(s, near, "ws") : null;
    if (x) s = Object.assign({}, s, { ws: x.ws, wsBrick: x.wsBrick });
    if (!s || !s.ws || !SPORT[s.type]) return [];
    const fill = txt => txt.replace(/ ?%CSS([+-]\d+)?%/g, (m, off) => {
      if (!cssSec) return "";
      const c = cssSec + (off ? Number(off) : 0);
      return " " + fmtPace(c - 1) + "/100m-" + fmtPace(c + 2) + "/100m Pace";
    });
    const tidy = txt => txt.replace(/\n{3,}/g, "\n\n").trim();
    const out = [{ suffix: "", type: SPORT[s.type], name: s.title.replace(/^🏁 /, ""), description: tidy(fill(s.ws)) }];
    if (s.wsBrick) out.push({ suffix: "-brick", type: "Run", name: "Brick run — straight off the bike", description: tidy(s.wsBrick) });
    return out;
  }

  const TP = {
    PLAN_START, PLAN24, RACE_703, DOLOMITES, BLOCKS, currentBlock, watchWorkouts, fromPlan, fmtPace,
    getDay, addDays, daysBetween, parse, iso, weekdayMon0, intensityOf, zoneSplit,
    TYPE_META: {
      run:      { label: "Run",      color: "#B0603A" },
      bike:     { label: "Bike",     color: "#4C6249" },
      swim:     { label: "Swim",     color: "#3F6C7B" },
      strength: { label: "Strength", color: "#A17A3E" },
      mobility: { label: "Mobility", color: "#6E6480" },
      rest:     { label: "Rest",     color: "#9C978E" },
      race:     { label: "Race",     color: "#B4232F" }
    }
  };
  global.TP = TP;
})(window);
