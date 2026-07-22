# Harriet's Training Plan 🏊 🚴 🏃

A calm, aesthetic training-plan website for **Harriet Meers** — one continuous build across three races:

- **Sprint Triathlon** — 26 Sep 2026
- **Ipswich Half Marathon** (sub‑2) — 27 Sep 2026
- **Ironman 70.3** — Apr / May 2027

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
const PLAN_START  = "2026-07-27";              // Monday of week 1
const SPRINT_TRI  = "2026-09-26";
const IPSWICH_HALF= "2026-09-27";
const DOLOMITES   = ["2026-08-24", "2026-08-27"]; // camp window (assumed — edit!)
const RACE_703    = "2027-05-09";              // real Apr/May date once known
```

- **Dolomites dates are assumed** to be 24–27 August (you'd originally written 24–27 September, which
  clashes with race weekend). Change them to the true window and the camp sessions move automatically.
- Set `RACE_703` to the real 70.3 date and the whole build/taper re-flows around it.
- Weekly key sessions for the 9-week block live in the `P1` object; the workout library (`R2`, `S1`,
  `LOWER`, …) is just below — edit paces, distances or drills there and they update everywhere.

---

## Notes

- Progress/notes are stored per-device in `localStorage` (private, no account, no server). Using a new
  device or clearing site data starts fresh. There's a **reset** link at the bottom of the page.
- Paces are built from a 1:58:59 half; heart-rate guidance and the full rationale are in the companion PDF.

Made with care. Most of it easy, some of it hard, all of it fuelled. ♡
