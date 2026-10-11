# Harriet's Training Plan 🏊 🚴 🏃

A calm, aesthetic training-plan website for **Harriet Meers** — one continuous build toward a single goal:

- **Ironman 70.3** — 28 March 2027 (1.9 km swim · 90 km bike · 21.1 km run)

From 12 October 2026 the plan is MyProCoach's *Phil's Intermediate Half Distance Triathlon 24-Week Plan*,
exactly as it sits in her TrainingPeaks calendar; the summer Foundation and Reset blocks before it stay as they were.

It's a single-page site with a **dynamic calendar**. Tap any day to see the exact sessions, open a
workout for the full breakdown (sets, paces, drills), tick things off as complete, and jot notes on how
it went. Progress is saved in the browser on the device you use.

No build step, no framework, no backend — just HTML, CSS and vanilla JS. It runs anywhere, including
GitHub Pages.

---

## Files

| File | What it is |
|------|------------|
| `index.html` | Page shell |
| `styles.css` | Styling (the cream/sage/clay look from the PDF) |
| `data.js` | The whole plan: schedule engine + workout library. **Edit dates & sessions here.** |
| `app.js` | Calendar, day drawer, completion + notes (localStorage) |

---

## Run it locally

Just open `index.html` in a browser. For everything to work smoothly (fonts, etc.), serve it:

```bash
# from inside the project folder
python3 -m http.server 8000
# then visit http://localhost:8000
```

---

## Put it on GitHub + publish with GitHub Pages

The repo is already initialised with a first commit. To push it to your own GitHub and get a live URL:

**Option A — GitHub CLI (easiest):**
```bash
gh repo create harriet-training-plan --public --source=. --push
```

**Option B — manually:**
1. Create a new empty repo on github.com (no README/licence).
2. Then:
```bash
git remote add origin https://github.com/<your-username>/harriet-training-plan.git
git branch -M main
git push -u origin main
```

**Enable the live site:** on GitHub → **Settings → Pages → Source: `main` / root → Save**.
Your site appears at `https://<your-username>.github.io/harriet-training-plan/` within a minute or two.

> Signing in / creating the repo needs your GitHub login, so that step is yours to run — everything
> else is ready to go.

---

## Customise the plan (all in `data.js`)

At the top of `data.js`:

```js
const PLAN_START  = "2026-07-27";              // Monday of week 1 of the season (summer block)
const BLOCK1_END  = "2026-09-27";              // last day of the summer Foundation block
const DOLOMITES   = ["2026-08-24", "2026-08-27"]; // camp window
const PLAN24      = "2026-10-12";              // Monday, week 1 of Phil's 24-week plan
const RACE_703    = "2027-03-28";              // race day — week 24's Sunday
```

- **Phil's 24-week plan** lives in the `WEEKS` list: one entry per week, Monday → Sunday, built from a
  short step notation (`"10m Z2"`, `rep(5, ["15s uZ3", "45s Z2"])`, `"200 FS Z2"`). The same steps
  produce the text on the site and the structured workout on her watch, so they can't drift apart.
- The PDF it came from cut most workouts' text short; the missing steps were read off each workout's
  chart in the PDF. Swim sets are rebuilt from their charts and say so on the site.
- **`RUN_THR`** is her threshold run pace (seconds per km) behind every run pace on the watch. Update it
  after each run test (plan weeks 1, 8 and 16) — it's her average pace for the 30-minute effort.
- The summer block's sessions (`P1`, `R2`, `LOWER`, …) are untouched so her ticks and notes still line up.

---

## Notes

- Progress/notes are stored per-device in `localStorage` (private, no account, no server). Using a new
  device or clearing site data starts fresh. There's a **reset** link at the bottom of the page.
- Paces are built from a 1:58:59 half; heart-rate guidance and the full rationale are in the companion PDF.

Made with care. Most of it easy, some of it hard, all of it fuelled. Built by her best friend, Ali.
