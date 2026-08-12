# Strava sync — setup

Activities reach the calendar like this:

```
Garmin watch → Garmin Connect → Strava → this app
```

**Why not Garmin directly?** Garmin's Connect Developer Program (Health + Activity
APIs) is approval-gated and, in their own FAQ, *"only for business use"* — there is no
self-serve or hobbyist tier. Strava is the supported bridge, and Garmin already
auto-syncs to it.

When it runs, each activity is matched to a planned session on the same date with the
same discipline, and that session is ticked off automatically.

---

## What you need to do

Four steps. Two of them involve credentials, so they need to be done by you — I can't
create a Strava account or handle the secret.

### 1. Confirm Garmin → Strava auto-sync is on

In Garmin Connect: **Settings → Connected Apps → Strava**. Without this, nothing flows.

> Strava now requires a **paid Strava subscription** to use the API as a Standard Tier
> developer (changed 1 June 2026). Worth confirming before going further.

### 2. Create a Strava API application

Go to <https://www.strava.com/settings/api> and create an app:

| Field | Value |
|---|---|
| Category | Training |
| Website | `https://harriet.hiridjee.com` |
| **Authorization Callback Domain** | `harriet.hiridjee.com` |

Use `localhost` as the callback domain while testing locally.

You'll get a **Client ID** (public) and a **Client Secret** (private).

### 3. Add the Client ID to the app

In [`app.js`](app.js), set:

```js
const STRAVA_CLIENT_ID = "YOUR_CLIENT_ID";
```

This one is safe to commit — it's public by design.

### 4. Deploy the backend and set the secret

The **Client Secret must never go in `app.js`** — anything in the repo is public, and a
leaked secret lets anyone act as your app. It lives only in the edge function.

```bash
supabase link --project-ref notibogaoeqakmeyxhar
supabase db push
supabase functions deploy strava-sync
supabase secrets set STRAVA_CLIENT_ID=xxxx STRAVA_CLIENT_SECRET=yyyy
```

`supabase db push` creates the `strava_tokens` table. It has RLS on with **no policies**
on purpose: the browser key cannot read it, so tokens are only ever reachable by the
edge function's service role.

---

## Using it

- Press **Strava** in the top bar → unlock with the PIN → approve on Strava.
- After that it syncs automatically on load, and pressing the button re-syncs on demand.
- Pressing it while connected offers **sync now** or **disconnect** (which also revokes
  the token at Strava's end).

## How matching works

| Strava type | Session |
|---|---|
| Run, TrailRun, VirtualRun, Treadmill | Run |
| Ride, VirtualRide, GravelRide, MountainBikeRide, EBikeRide | Bike |
| Swim | Swim |
| WeightTraining, Crossfit, Workout | Strength |
| Yoga, Walk, Hike, Elliptical | Mobility |

Rules that keep it safe:

- Only ticks a session on the **same calendar date** as the activity.
- Never un-ticks anything, and never overwrites something ticked by hand.
- Each activity is recorded once, so re-syncing won't re-tick a session she deliberately
  cleared.
- Anything unrecognised is ignored rather than guessed at.

## Troubleshooting

| Symptom | Cause |
|---|---|
| "Strava isn't configured yet" | `STRAVA_CLIENT_ID` still blank in `app.js` |
| "missing STRAVA_CLIENT_ID / SECRET" | `supabase secrets set` not run |
| Redirects to Strava then errors | Callback domain doesn't match the site's domain |
| Connects but syncs nothing | Garmin → Strava link off, or activities older than the 30-day window |
