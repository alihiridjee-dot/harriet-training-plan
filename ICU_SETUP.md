# Activity sync — setup (intervals.icu)

Completed workouts reach the calendar like this:

```
Garmin watch → Garmin Connect → intervals.icu → this app
```

Each activity is matched to a planned session on the same date with the same
discipline, and that session is ticked off automatically.

**Why not Garmin directly?** Garmin's Connect Developer Program (Health + Activity
APIs) is approval-gated and, in their own FAQ, *"only for business use"* — there is no
self-serve or hobbyist tier.

**Why intervals.icu?** It's free, needs no approval, and already syncs from Garmin.
Unlike Strava it doesn't require a paid subscription to use the API.

---

## Setup — three steps, about ten minutes

### 1. Connect Garmin to intervals.icu

Create a free account at <https://intervals.icu>, then link Garmin from its settings.
It's a one-time OAuth and then runs on its own.

> If Harriet ever changes her Garmin password the link invalidates and has to be
> reconnected — that's an intervals.icu/Garmin quirk, not this app.

### 2. Generate an API key

In intervals.icu: **Settings → Developer Settings → generate API key**.

⚠️ **This key grants full read/write access to the intervals.icu account.** It must
never go in `app.js` or anywhere else in this repo — the repo is public. It only ever
lives in Supabase secrets, which is why the edge function exists.

### 3. Deploy the function and set the secret

```bash
supabase login
supabase functions deploy icu-sync --project-ref notibogaoeqakmeyxhar --no-verify-jwt
supabase secrets set ICU_API_KEY=your_key_here --project-ref notibogaoeqakmeyxhar
```

`--no-verify-jwt` is required: this site authenticates with a **publishable** key,
which is not a JWT. With JWT verification on, the platform rejects the call with 401
before the function runs. The key is sent on the `apikey` header only — putting a
publishable key on `Authorization: Bearer` causes the same 401.

The trade-off is that the function is then publicly callable by anyone who knows its
URL. It only ever returns a list of activities — the API key stays server-side and is
never included in a response — so the exposure is her workout list, not credentials.

No database migration is needed — there are no tokens to store, just the one key.

Then flip the switch in [`app.js`](app.js):

```js
const ICU_SYNC_ENABLED = true;
```

The **Sync** button appears in the top bar. Until then it stays hidden, so the app
never shows a control that would fail.

---

## Using it

- Syncs automatically on load, and the **Sync** button pulls on demand.
- It's behind the same PIN gate as any other change.
- It pulls everything from 90 days before the plan start, so old weeks get ticked too
  and the fitness curve has history to warm up on. Activities are cached on the device,
  so the page shows them instantly while the fresh copy loads.

## Readiness strip

Garmin syncs **wellness** (sleep, HRV, resting HR, steps) on a separate permission
from activities, and it arrives every day whether or not a workout was recorded. The
readiness card above the calendar shows last night's numbers with each metric compared
against a 28-day rolling baseline, plus a plain-English read:

- **Primed** — sleep and HRV where they should be; good day for the hard session.
- **Steady** — one signal off; start easy and reassess.
- **Go easy** — two or more signals off; lighten the day or move the hard session.

It's deliberately conservative: a metric only counts against her when there's actually
data for it, and a missing night shows `—` rather than being treated as zero. The
thresholds are HRV below 92% of baseline, resting HR more than 3bpm above it, or under
6 hours' sleep.

This works independently of activity sync — useful right now, since wellness is
flowing but no activities are.

## How matching works

| intervals.icu type | Session |
|---|---|
| Run, TrailRun, VirtualRun, Treadmill | Run |
| Ride, VirtualRide, GravelRide, MountainBikeRide, EBikeRide | Bike |
| Swim, OpenWaterSwim | Swim |
| WeightTraining, Crossfit, Workout, HighIntensityIntervalTraining | Strength |
| Yoga, Pilates, Walk, Hike, Elliptical | Mobility |

Matching runs in passes, longest workout first, so the main effort claims the session
and a 5-minute warm-up jog doesn't:

1. **Same day, same discipline.** On race day, every swim, bike and run attaches to the
   race. A brick ride also picks up the run done straight off the bike.
2. **Moved by a day.** A workout that still has no home claims a free session of the same
   discipline the day before or after (shown as "Done Mon instead"). It never claims a
   session she already ticked by hand.
3. **Everything else is an extra.** It doesn't tick anything, but it shows on the
   calendar as a hollow dot and in the day sheet under "Also on the watch".

Workouts under 10 minutes never claim a session. Matching is recalculated on every
render from the plan and the activity list, so swapping two days re-matches straight away.

Rules that keep it safe:

- **Never un-ticks** anything, and never overwrites something ticked by hand.
- Each activity is recorded once (`imported` in the saved state), so re-syncing won't
  re-tick a session she deliberately cleared.
- Auto-ticking waits until the saved state has loaded from Supabase, so a slow load can't
  overwrite fresh ticks with an older copy.

## What else the data drives

- **Session cards** show the real distance, time, pace and average HR under the plan.
- **From your watch** (Today): this week's swim/bike/run/time against last week, the
  latest workouts, and a fitness/fatigue/form chart. That uses the standard 42-day/7-day
  model on intervals.icu's training load; workouts with no load count at 60 per hour.
- **Week review** adds what the watch recorded that week.
- **Race-distance check** (Journey): the longest swim, ride and run in the last 8 weeks
  against the 70.3 distances.
- **Readiness** only shows when the newest sleep/HRV is at most 3 days old. If health
  data stops arriving, the watch section says when it last came through.

## Rate limits

5,000 requests/day and 2,500 per rolling 15 minutes — far beyond anything this app
does (one or two calls per page load).

## Troubleshooting

| Symptom | Cause |
|---|---|
| No Sync button | `ICU_SYNC_ENABLED` still `false` in `app.js` |
| "ICU_API_KEY secret is not set" | `supabase secrets set` not run |
| "API key rejected" | Key mistyped or regenerated in intervals.icu |
| Connects but ticks nothing | Garmin↔intervals.icu link dropped, or activities older than the 45-day window |
| Session not ticked | Discipline or date doesn't match the plan — tick it by hand |
