/* ============================================================
   Harriet's Training Plan — schedule engine & workout library
   Pure data + a deterministic day generator. No dependencies.
   ============================================================ */
(function (global) {
  "use strict";

  // ---------- config: edit these dates freely ----------
  const PLAN_START = "2026-07-27";   // Monday, week 1
  const SPRINT_TRI = "2026-09-26";   // Saturday
  const IPSWICH_HALF = "2026-09-27"; // Sunday
  const DOLOMITES = ["2026-08-24", "2026-08-27"]; // Mon–Thu camp (assumed; edit if needed)
  const RACE_703 = "2027-05-09";     // Ironman 70.3 (assumed Sunday in May — edit to real date)

  // ---------- date helpers (local, noon-anchored to avoid TZ drift) ----------
  function parse(iso) { const [y, m, d] = iso.split("-").map(Number); return new Date(y, m - 1, d, 12); }
  function iso(dt) { return dt.getFullYear() + "-" + String(dt.getMonth() + 1).padStart(2, "0") + "-" + String(dt.getDate()).padStart(2, "0"); }
  function addDays(isoStr, n) { const dt = parse(isoStr); dt.setDate(dt.getDate() + n); return iso(dt); }
  function daysBetween(a, b) { return Math.round((parse(b) - parse(a)) / 86400000); }
  function weekdayMon0(isoStr) { return (parse(isoStr).getDay() + 6) % 7; } // 0=Mon..6=Sun

  // ---------- session builder ----------
  function S(type, title, sub, blocks) { return { type: type, title: title, sub: sub || "", blocks: blocks || [] }; }

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

  const SWIM_S1 = (note) => S("swim", "Swim — technique & drills" + (note ? " · " + note : ""), "≈ 1,750 m · 25 m pool", [
    { label: "Warm-up", text: "300 m easy (100 free / 100 back / 100 free), relaxed breathing every 3." },
    { label: "Drills", text: "6 × 50 m as catch-up · single-arm (25 L / 25 R) · fingertip-drag, @ :20. Long reach, high elbow." },
    { label: "Kick", text: "4 × 50 m kick with board, easy, @ :20." },
    { label: "Drill/swim", text: "6 × 100 m = 25 drill + 75 smooth swim, @ :25." },
    { label: "DPS", text: "4 × 50 m counting strokes — take 1 fewer stroke each 50." },
    { label: "Cool-down", text: "100 m easy, bilateral breathing (every 3)." }
  ]);
  const SWIM_S2 = () => S("swim", "Swim — CSS test / threshold", "≈ 1,800 m", [
    { label: "Warm-up", text: "300 m easy + 4 × 50 build @ :20." },
    { label: "Test", text: "400 m time trial (record time) · 3–4 min rest · 200 m time trial (record). CSS/100m = (400 time − 200 time) ÷ 2." },
    { label: "Off-test weeks", text: "Replace the test with 8 × 100 m @ CSS pace, @ :15." },
    { label: "Loosen + cool-down", text: "200 m easy + 100 m easy." }
  ]);
  const SWIM_S3 = () => S("swim", "Swim — endurance / CSS", "≈ 2,000–2,400 m", [
    { label: "Warm-up", text: "300 m mixed + 4 × 50 drill @ :20." },
    { label: "Main", text: "Build across the block: 4 → 6 → 8 × 200 m @ CSS + 3–5 s, @ :20. Or a continuous 800 → 1,200 → 1,500 m." },
    { label: "Pull", text: "4 × 100 m pull-buoy, smooth & long, @ :20." },
    { label: "Cool-down", text: "200 m easy." }
  ]);

  const BIKE_B1 = (label, sub) => S("bike", label || "Bike — endurance", sub || "Z2 · cadence 85–95", [
    { label: "Main", text: "Ride at 22–25 km/h in Zone 2 — able to chat. Spin light gears at 85–95 rpm." },
    { label: "Skill", text: "Practise eating & drinking on the move, and spend time in a lower / aero-ish position." }
  ]);

  const EASY_RUN = (km, strides) => S("run", "Easy run" + (strides ? " + strides" : ""), km + " · Z2", [
    { label: "Main", text: "Run at 8.7–9.5 km/h (6:55–6:20/km), conversational. Let heart rate lead — slow down if it climbs out of Z2." },
    strides ? { label: "Strides", text: "Finish with 4–6 × 20 s pick-ups at ~12–13 km/h, full recovery between. Relaxed & fast, not a sprint." } : null
  ].filter(Boolean));

  const LONG_RUN = (km, extra) => S("run", "Long run", km + " · Z2", [
    { label: "Main", text: "Steady & easy at 8.7–9.5 km/h. This is aerobic base — keep it in Zone 2 the whole way." },
    extra ? { label: "Finish", text: extra } : null,
    { label: "Fuel", text: "Anything over ~75–90 min: take 30–60 g carbs/hour + water." }
  ].filter(Boolean));

  const LONG_BIKE = (title, sub, blocks) => S("bike", title, sub, blocks);
  const BRICK = (mins) => ({ label: "Brick run", text: "Straight off the bike, no rest: " + mins + " easy run holding form as the legs settle. Priceless for triathlon." });

  // ---------- run quality library (Tuesdays) ----------
  const R2 = () => S("run", "Run — VO₂ intervals", "6 × 400 m · Z5", [
    { label: "Warm-up", text: "12–15 min easy + 3–4 strides." },
    { label: "Main", text: "6 × 400 m @ 11.6–12.2 km/h (5:10–4:55/km), 90 s easy jog between. Build toward 8 × 400 across the block." },
    { label: "Cool-down", text: "8–10 min easy." }
  ]);
  const R3 = (reps) => S("run", "Run — threshold reps", (reps || "5 × 1 km") + " · Z4", [
    { label: "Warm-up", text: "12–15 min easy + 3 strides." },
    { label: "Main", text: (reps || "5 × 1 km") + " @ 10.7–11.3 km/h (5:35–5:20/km), 60–75 s jog between. Comfortably hard, even splits." },
    { label: "Cool-down", text: "8–10 min easy." }
  ]);
  const R4 = (fmt) => S("run", "Run — tempo", (fmt || "20 min continuous") + " · Z4", [
    { label: "Warm-up", text: "12–15 min easy." },
    { label: "Main", text: (fmt || "20 min continuous") + " @ 10.7–11.0 km/h. 'Comfortably hard' — short phrases only." },
    { label: "Cool-down", text: "8 min easy." }
  ]);
  const R5 = () => S("run", "Run — 10K cruise", "6 × 800 m · Z4", [
    { label: "Warm-up", text: "12–15 min easy + 3 strides." },
    { label: "Main", text: "6 × 800 m @ 11.3–11.6 km/h (5:20–5:10/km), 2 min jog between. A great sub-2 sharpener." },
    { label: "Cool-down", text: "8–10 min easy." }
  ]);
  const R6 = () => S("run", "Run — hill reps", "8 × 45 s · Z4–5", [
    { label: "Warm-up", text: "12 min easy on gentle ground." },
    { label: "Main", text: "8 × 45 s hard uphill, jog or walk down to recover. Tall, powerful posture — strength you can't get on the flat." },
    { label: "Cool-down", text: "10 min easy." }
  ]);

  // ---------- phase-1 key sessions per week ----------
  // Each: { tue, sat, sun }  (sat/sun are custom long sessions)
  const P1 = {
    1: { tue: R2(), sat: LONG_BIKE("Long ride · 45 km", "Z2 endurance", [{ label: "Main", text: "45 km at 22–25 km/h, Zone 2. Ease into the block — smooth and controlled." }]), sun: LONG_RUN("14 km"), swimNote: "technique reset" },
    2: { tue: R3("5 × 1 km"), sat: LONG_BIKE("Long ride · 55 km + brick", "Z2 + 10′ run", [{ label: "Main", text: "55 km Zone 2, cadence 85–95, fuelling on the move." }, BRICK("10 min")]), sun: LONG_RUN("16 km"), swimThuTest: true },
    3: { tue: R4("20 min continuous"), sat: LONG_BIKE("Sweet-spot ride · 40 km", "3 × 8′ @ Z3", [{ label: "Warm-up", text: "15 min easy." }, { label: "Main", text: "3 × 8 min @ 25–28 km/h (RPE 6–7), 5 min easy between, inside a 40 km ride." }, { label: "Cool-down", text: "easy spin home." }]), sun: LONG_RUN("12 km", "Final 4 km lifted to steady 9.7–10.1 km/h.") },
    4: { tue: R5(), sat: LONG_BIKE("Long ride · 65 km + brick", "Z2 + 15′ run (big week)", [{ label: "Main", text: "65 km Zone 2 — your longest so far. Fuel every 30–40 min." }, BRICK("15 min")]), sun: LONG_RUN("18 km", "Peak long run — keep it genuinely easy.") },
    6: { tue: R4("2 × 10 min"), sat: LONG_BIKE("Long ride · 60 km", "tempo blocks + brick", [{ label: "Main", text: "60 km with 2–3 × 10 min at sweet-spot (25–28 km/h) mixed in." }, BRICK("15 min")]), sun: LONG_RUN("16 km", "Final 5 km steady (9.7–10.1 km/h).") },
    7: { tue: R3("4 × 1.5 km"), sat: LONG_BIKE("Long ride · 70 km + brick", "Z2 · peak ride", [{ label: "Main", text: "70 km Zone 2 — the peak ride. Practise full race fuelling & hydration." }, BRICK("20 min")]), sun: LONG_RUN("18 km", "Last 5 km at half-marathon pace (10.7–10.9 km/h).") },
    8: { tue: S("run", "Run — sharpener", "5 × 2 min · Z5", [{ label: "Warm-up", text: "12 min easy + strides." }, { label: "Main", text: "5 × 2 min @ 5K effort (11.6–12.2 km/h), 2 min jog. Short & sharp — taper week." }, { label: "Cool-down", text: "8 min easy." }]), sat: LONG_BIKE("Ride · 45 km easy", "taper + a few surges", [{ label: "Main", text: "45 km easy with 4–5 × 30 s brisk surges to stay sharp." }]), sun: LONG_RUN("12 km", "Easy — legs should feel fresh, not worked.") }
  };

  // ---------- phase resolver ----------
  function phaseFor(isoStr, weekIdx) {
    if (parse(isoStr) < parse(PLAN_START)) return { id: "pre", label: "Before the plan", tint: "pre" };
    if (weekIdx <= 8) return { id: "p1", label: "Block 1 · Race Sharpen", tint: "p1" };
    const afterHalf = daysBetween(IPSWICH_HALF, isoStr);
    if (afterHalf >= 1 && afterHalf <= 14) return { id: "recovery", label: "Block 2 · Reset", tint: "recovery" };
    const toRace = daysBetween(isoStr, RACE_703);
    if (parse(isoStr) > parse(RACE_703)) return { id: "post", label: "After the 70.3", tint: "post" };
    if (toRace <= 20) return { id: "taper", label: "Block 4 · Peak & Taper", tint: "taper" };
    if (parse(isoStr) < parse("2027-01-01")) return { id: "base", label: "Block 2 · Base", tint: "base" };
    return { id: "build", label: "Block 3 · 70.3 Build", tint: "build" };
  }

  // ---------- day builders per phase ----------
  function p1Day(week, wd, isoStr) {
    // Week 5 — Dolomites camp (Mon–Thu = 24–27 Aug), lighter weekend
    if (week === 5) {
      const camp = [
        [MOB("30–40 min easy shakeout jog + mobility"), S("mobility", "Travel day", "Camp · Day 1", [{ label: "Note", text: "Arrive, unpack, legs loose. Nothing hard." }])],
        [LONG_BIKE("Big mountain ride · 3–4 h", "Camp · Day 2 · by time, not distance", [{ label: "Main", text: "3–4 hours on the climbs. Stay in Zone 2 on ascents — walk-pace spinning is fine. Fuel 40–60 g carbs/hour." }, BRICK("10 min (optional)")])],
        [S("run", "Hill run · 60–75 min", "Camp · Day 3", [{ label: "Main", text: "Easy up the climbs (walk the steep bits), plus 6–8 short uphill surges near the end." }]), SWIM_S1("easy technique if pool")],
        [S("mobility", "Recovery spin or hike", "Camp · Day 4", [{ label: "Main", text: "Easy recovery spin or a hike + mobility. Absorb the big days." }])],
        [BIKE_B1("Bike — easy", "post-camp / travel · 40 min or rest")],
        [LONG_BIKE("Easy long ride · 40–50 km", "Z2 (skip if still tired)", [{ label: "Main", text: "Only if recovered from camp — otherwise rest. Keep it easy Zone 2." }])],
        [LONG_RUN("12–14 km", "Easy — a gentle return to routine.")]
      ];
      return dayObj(week, wd, isoStr, camp[wd], "Dolomites camp week — go by effort, not pace or HR. Altitude & climbs will run your HR high; that's expected.");
    }
    // Week 9 — race week
    if (week === 9) {
      const rw = [
        [SWIM_S1("short & smooth, 20 min")],
        [S("run", "Openers", "3 × 1 min brisk", [{ label: "Main", text: "15 min easy + 3 × 1 min brisk (10K effort), full recovery. Wakes the legs up without tiring them." }]), MOB("light mobility only — no lifting")],
        [BIKE_B1("Easy spin · 25 km", "legs loose"), S("swim", "Optional short swim", "15 min easy", [{ label: "Note", text: "Optional — only if it helps you feel loose." }])],
        [S("run", "Shakeout · 5 km", "+ 4 strides", [{ label: "Main", text: "5 km very easy + 4 strides. Loose, not tiring." }])],
        [REST()],
        [S("race", "🏁 Sprint Triathlon", "Race smart — not empty", [
          { label: "Swim", text: "Start steady, settle breathing in the first 100 m, draft feet. Effort Z3, not a sprint." },
          { label: "Bike", text: "Strong but with a little in reserve — sweet-spot (25–28 km/h). Fuel & drink so you're not empty tomorrow." },
          { label: "Run", text: "A brick you've practised. Controlled Z3–Z4 — enjoy it, but leave something for the half." },
          { label: "Evening", text: "Refuel within the hour (carbs + protein), keep grazing carbs, hydrate, legs up, early night. This matters most." }
        ])],
        [S("race", "🏁 Ipswich Half — sub-2", "Banker 10.55 km/h · PB 10.7–10.9", [
          { label: "First 5 km", text: "Discipline. Start 10.4–10.5 km/h even if it feels easy — yesterday's fatigue hides until ~8 km." },
          { label: "5–16 km", text: "Settle on sub-2 pace (10.55 km/h / 5:41/km). Relax shoulders. Fuel ~45 & ~90 min." },
          { label: "16 km → home", text: "If comfortable, lift gradually. A negative split off tired legs sneaks the PB and guarantees sub-2." }
        ])]
      ];
      return dayObj(week, wd, isoStr, rw[wd], "Race week — everything is short. Rest is the priority; arrive fresh over fried.");
    }
    // Normal phase-1 week from template + weekly key sessions
    const k = P1[week];
    const tmpl = [
      [REST()],
      [k.tue, LOWER()],
      [SWIM_S1(k.swimNote), UPPER()],
      [EASY_RUN("6–8 km", week >= 3), k.swimThuTest ? SWIM_S2() : SWIM_S3()],
      [BIKE_B1("Bike — endurance", "45–60 min Z2 (or swap to rest)")],
      [k.sat],
      [k.sun]
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
      [LONG_BIKE("Easy ride · 40–60 min", "Z2, unstructured", [{ label: "Main", text: "Ride for enjoyment, no numbers. Let the body recover from the season." }])],
      [LONG_RUN("≤ 10 km", "Keep it very easy — no long runs over 10 km in these two weeks.")]
    ];
    return { sessions: t[wd], banner: "Reset block — deliberately easy. No hard sessions, no long runs over 10 km. Recharge." };
  }

  function baseDay(wd, weekIdx) {
    const bi = weekIdx - 11; // weeks into base
    const bikeKm = Math.min(50 + bi * 3, 70);
    const runKm = Math.min(12 + Math.floor(bi / 2), 16);
    const t = [
      [REST()],
      [EASY_RUN("6–8 km", true), LOWER()],
      [SWIM_S1("winter technique project"), UPPER()],
      [EASY_RUN("7–8 km", true), SWIM_S3()],
      [BIKE_B1("Bike — endurance", "60–75 min Z2")],
      [LONG_BIKE("Long ride · " + bikeKm + " km", "Z2 easy", [{ label: "Main", text: "Almost all Zone 2 — building the aerobic engine. Cadence 85–95." }])],
      [LONG_RUN(runKm + " km", "Easy — base miles.")]
    ];
    return { sessions: t[wd], banner: "Base block — mostly Zone 2. Aerobic engine + the winter swim project. Framework: we'll refine numbers nearer the time." };
  }

  function buildDay(wd, isoStr) {
    const bi = Math.floor(daysBetween("2027-01-01", isoStr) / 7); // weeks into build
    const bikeKm = Math.min(70 + bi * 5, 100);
    const brick = Math.min(15 + bi * 2, 30);
    const runKm = Math.min(16 + Math.floor(bi / 2), 20);
    const swimReps = Math.min(6 + bi, 12);
    const t = [
      [REST()],
      [R4("2 × 12 min tempo"), LOWER()],
      [SWIM_S1("+ open-water skills from spring"), UPPER()],
      [EASY_RUN("8–10 km", true), S("swim", "Swim — endurance", swimReps + " × 200 m @ CSS", [{ label: "Main", text: swimReps + " × 200 m @ CSS + 3–5 s, @ :20 — building toward the 1.9 km race distance." }, { label: "Then", text: "4 × 100 m pull, smooth. Cool-down 200 m." }])],
      [BIKE_B1("Bike — endurance", "75–90 min Z2")],
      [LONG_BIKE("Race brick · " + bikeKm + " km + " + brick + "′ run", "key 70.3 session", [{ label: "Bike", text: bikeKm + " km building toward 90 km, mostly Z2 with sweet-spot blocks." }, { label: "Fuel", text: "Rehearse race nutrition: 60–90 g carbs/hour." }, BRICK(brick + " min at 70.3 pace (Z3, ~9.7–10.1 km/h)")])],
      [LONG_RUN(runKm + " km", "Final third at steady / 70.3 pace.")]
    ];
    return { sessions: t[wd], banner: "70.3 Build — the weekend brick is the key session. Framework distances shown; we'll dial these to your spring fitness." };
  }

  function taperDay(wd, isoStr) {
    if (isoStr === RACE_703) {
      return { sessions: [[S("race", "🏁 Ironman 70.3", "1.9 km swim · 90 km bike · 21.1 km run", [
        { label: "Swim 1.9 km", text: "Steady, controlled breathing, draft where you can. Target ~40–48 min." },
        { label: "Bike 90 km", text: "Ride your plan — strong Z2/low-Z3 (24–27 km/h). Fuel 60–90 g carbs/hour from the start." },
        { label: "Run 21.1 km", text: "Off the bike, settle into steady Z3 (~9.7–10.1 km/h). Walk aid stations, take fuel, then reel it in." },
        { label: "You've got this", text: "One build, three races, all of it earned. Enjoy the finish line." }
      ])]][0].map(x => x), banner: "RACE DAY. Trust the training. Nothing new — just execution." };
    }
    const toRace = daysBetween(isoStr, RACE_703);
    const t = [
      [REST()],
      [R4("3 × 5 min @ race effort"), MOB("light legs only")],
      [SWIM_S1("short, smooth")],
      [EASY_RUN("6 km", true)],
      [BIKE_B1("Bike — easy openers", "40 min + 3 × 2 min brisk")],
      [toRace > 10 ? LONG_BIKE("Big brick · 75 km + 30′ run", "final race rehearsal", [{ label: "Main", text: "Last big one — full race kit & nutrition. 75 km + 30 min run at race effort." }]) : LONG_BIKE("Ride · 40 km easy", "openers, stay sharp", [{ label: "Main", text: "Easy with a few short surges. Legs fresh." }])],
      [toRace > 10 ? LONG_RUN("16 km", "Steady finish.") : EASY_RUN("8 km", true)]
    ];
    return { sessions: t[wd], banner: "Peak & Taper — volume drops, a little intensity stays so you feel sharp. Rehearse everything, then rest." };
  }

  function postDay() {
    return { sessions: [S("mobility", "Recover & celebrate", "as you feel", [{ label: "Note", text: "Season done. Rest properly, move gently, and be proud — that was a huge year of work." }])], banner: "After the 70.3 — recover, reflect, celebrate. 🎉" };
  }

  function dayObj(week, wd, isoStr, sessions, banner) {
    return { sessions: sessions, banner: banner || null, weekNum: week };
  }

  // ---------- public: full day for any ISO date ----------
  function getDay(isoStr) {
    const phase = phaseFor(isoStr, Math.floor(daysBetween(PLAN_START, isoStr) / 7));
    const weekIdx = Math.floor(daysBetween(PLAN_START, isoStr) / 7);
    const wd = weekdayMon0(isoStr);
    let body;
    if (phase.id === "pre") body = { sessions: [], banner: null };
    else if (phase.id === "p1") body = p1Day(weekIdx + 1, wd, isoStr);
    else if (phase.id === "recovery") body = recoveryDay(wd);
    else if (phase.id === "base") body = baseDay(wd, weekIdx);
    else if (phase.id === "build") body = buildDay(wd, isoStr);
    else if (phase.id === "taper") body = taperDay(wd, isoStr);
    else body = postDay();

    // events / labels
    const events = [];
    if (isoStr === SPRINT_TRI) events.push("Sprint Triathlon");
    if (isoStr === IPSWICH_HALF) events.push("Ipswich Half");
    if (isoStr === RACE_703) events.push("Ironman 70.3");
    if (isoStr >= DOLOMITES[0] && isoStr <= DOLOMITES[1]) events.push("Dolomites camp");

    return {
      iso: isoStr,
      phase: phase,
      weekNum: (phase.id === "p1") ? (weekIdx + 1) : null,
      dayName: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"][wd],
      banner: body.banner,
      events: events,
      sessions: body.sessions
    };
  }

  const TP = {
    PLAN_START, RACE_703, SPRINT_TRI, IPSWICH_HALF, DOLOMITES,
    getDay, addDays, daysBetween, parse, iso, weekdayMon0,
    TYPE_META: {
      run:      { label: "Run",      color: "#BC6A4C" },
      bike:     { label: "Bike",     color: "#43503C" },
      swim:     { label: "Swim",     color: "#4F7C77" },
      strength: { label: "Strength", color: "#B48A4E" },
      mobility: { label: "Mobility", color: "#9A968B" },
      rest:     { label: "Rest",     color: "#C2BDB1" },
      race:     { label: "Race",     color: "#A6432A" }
    }
  };
  global.TP = TP;
})(window);
