// Push the next two weeks of the plan to intervals.icu, which sends each
// workout to Harriet's Garmin. Run every morning by .github/workflows/watch.yml
// (and the site pushes again straight after a swap). Safe to re-run: workouts
// are keyed by date + slot, so a re-push updates rather than duplicates.
//   node scripts/push-plan.mjs            # next 14 days
//   DAYS=3 node scripts/push-plan.mjs     # a shorter window
import { readFileSync } from "node:fs";
import vm from "node:vm";

const SB_URL = "https://notibogaoeqakmeyxhar.supabase.co";
const SB_KEY = "sb_publishable_PzxYn1w0zQwHku16EPtTXQ_GGan7WEL";   // public by design, same as app.js
const DAYS = Number(process.env.DAYS || 14);

const ctx = { window: {} };
vm.createContext(ctx);
vm.runInContext(readFileSync(new URL("../data.js", import.meta.url), "utf8"), ctx);
const TP = ctx.window.TP;

const res = await fetch(`${SB_URL}/rest/v1/athlete_state?id=eq.harriet&select=data`, { headers: { apikey: SB_KEY } });
const state = ((await res.json())[0] || {}).data || {};
const css = state.css && state.css.s;

const today = TP.iso(new Date()), to = TP.addDays(today, DAYS - 1);
const workouts = [];
for (let d = today; d <= to; d = TP.addDays(d, 1)) {
  const sessions = (state.overrides && state.overrides[d]) || TP.getDay(d).sessions;
  sessions.forEach((s, i) => TP.watchWorkouts(s, css, d).forEach(w =>
    workouts.push({ date: d, key: d + "-" + i + w.suffix, type: w.type, name: w.name, description: w.description })));
}

const r = await fetch(`${SB_URL}/functions/v1/icu-sync`, {
  method: "POST",
  headers: { "Content-Type": "application/json", apikey: SB_KEY },
  body: JSON.stringify({ action: "push", from: today, to, workouts }),
});
const out = await r.json();
console.log(JSON.stringify(out, null, 1));
if (!r.ok || out.error) process.exit(1);
