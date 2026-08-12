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
supabase link --project-ref notibogaoeqakmeyxhar
supabase functions deploy icu-sync
supabase secrets set ICU_API_KEY=your_key_here
```

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
- The default window is the last 45 days.

## How matching works

| intervals.icu type | Session |
|---|---|
| Run, TrailRun, VirtualRun, Treadmill | Run |
| Ride, VirtualRide, GravelRide, MountainBikeRide, EBikeRide | Bike |
| Swim, OpenWaterSwim | Swim |
| WeightTraining, Crossfit, Workout | Strength |
| Yoga, Walk, Hike, Elliptical | Mobility |

Rules that keep it safe:

- Only ticks a session on the **same calendar date** as the activity.
- **Never un-ticks** anything, and never overwrites something ticked by hand.
- Each activity is recorded once (`imported` in the saved state), so re-syncing won't
  re-tick a session she deliberately cleared.
- Anything unrecognised is ignored rather than guessed at.

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
