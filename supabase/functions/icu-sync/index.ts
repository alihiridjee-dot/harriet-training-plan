/* ============================================================
   intervals.icu bridge — Supabase Edge Function

   Garmin's own Connect API is business-only, so activities reach us
   via a service that already holds a Garmin connection:

       Garmin watch → Garmin Connect → intervals.icu → here

   intervals.icu syncs from Garmin automatically after a one-time
   OAuth link in their settings, and offers a free public API.

   This function exists so the API key never reaches the browser —
   that key grants full read/write access to the intervals.icu
   account, so it lives only in Supabase secrets.

   Actions (POST { action, ... }):
     status {}                  — is a key configured and working?
     sync   { oldest, newest }  — return activities in a date window
   ============================================================ */

const ICU_API_KEY = Deno.env.get("ICU_API_KEY") ?? "";
// "0" means "the athlete this key belongs to" — no need to look up an id.
const ICU_ATHLETE_ID = Deno.env.get("ICU_ATHLETE_ID") ?? "0";
const ICU_BASE = "https://intervals.icu/api/v1";

// Only these origins may call the function.
const ALLOWED = [
  "https://harriet.hiridjee.com",
  "https://alihiridjee-dot.github.io",
  "http://localhost:8000",
  "http://127.0.0.1:8000",
];

function cors(origin: string | null) {
  const allow = origin && ALLOWED.includes(origin) ? origin : ALLOWED[0];
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

const json = (body: unknown, status: number, origin: string | null) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...cors(origin), "Content-Type": "application/json" },
  });

/** intervals.icu uses HTTP Basic with the literal username "API_KEY". */
const authHeader = () => "Basic " + btoa("API_KEY:" + ICU_API_KEY);

const ymd = (d: Date) => d.toISOString().slice(0, 10);

Deno.serve(async (req) => {
  const origin = req.headers.get("origin");
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(origin) });
  if (req.method !== "POST") return json({ error: "POST only" }, 405, origin);

  if (!ICU_API_KEY) {
    return json({ connected: false, error: "ICU_API_KEY secret is not set on the function." }, 200, origin);
  }

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* empty body is fine */ }
  const action = String(body.action ?? "");

  try {
    // ---- is the key valid? ----
    if (action === "status") {
      const res = await fetch(`${ICU_BASE}/athlete/${ICU_ATHLETE_ID}/profile`, {
        headers: { Authorization: authHeader() },
      });
      if (!res.ok) {
        return json({ connected: false, error: res.status === 401 ? "API key rejected" : "intervals.icu error " + res.status }, 200, origin);
      }
      const p = await res.json().catch(() => ({}));
      return json({ connected: true, athlete: p?.athlete?.name ?? p?.name ?? null }, 200, origin);
    }

    // ---- pull activities in a window ----
    if (action === "sync") {
      const now = new Date();
      const past = new Date(now.getTime() - 45 * 24 * 60 * 60 * 1000);
      const oldest = String(body.oldest ?? ymd(past));
      const newest = String(body.newest ?? ymd(now));

      const url = `${ICU_BASE}/athlete/${ICU_ATHLETE_ID}/activities`
        + `?oldest=${encodeURIComponent(oldest)}&newest=${encodeURIComponent(newest)}`;
      const res = await fetch(url, { headers: { Authorization: authHeader() } });

      if (res.status === 429) {
        return json({ error: "rate limited by intervals.icu, try again shortly" }, 429, origin);
      }
      if (!res.ok) {
        return json({ error: "intervals.icu error " + res.status }, 502, origin);
      }

      const raw = await res.json();
      // Send back only what the calendar needs.
      const activities = (Array.isArray(raw) ? raw : []).map((a) => ({
        id: a.id,
        name: a.name,
        type: a.type,
        start_local: a.start_date_local,
        distance_m: a.distance ?? null,
        moving_s: a.moving_time ?? null,
        elapsed_s: a.elapsed_time ?? null,
        avg_hr: a.average_heartrate ?? null,
        load: a.icu_training_load ?? null,
      }));
      return json({ connected: true, activities }, 200, origin);
    }

    // ---- diagnostics: what is intervals.icu actually returning? ----
    // Never echoes the API key. Safe to call; read-only.
    if (action === "debug") {
      const out: Record<string, unknown> = {};
      const probe = async (label: string, url: string) => {
        try {
          const r = await fetch(url, { headers: { Authorization: authHeader() } });
          const t = await r.text();
          out[label] = { status: r.status, len: t.length, body: t.slice(0, 400) };
          return t;
        } catch (e) {
          out[label] = { error: String(e) };
          return "";
        }
      };

      // 1. who does this key belong to, and what is the numeric athlete id?
      const prof = await probe("profile", `${ICU_BASE}/athlete/${ICU_ATHLETE_ID}/profile`);
      let numericId = "";
      try {
        const p = JSON.parse(prof);
        numericId = String(p?.athlete?.id ?? p?.id ?? "");
      } catch { /* leave blank */ }
      out.resolved_athlete_id = numericId || "(could not parse)";

      // 2. activities with the date window we normally use
      await probe("activities_windowed", `${ICU_BASE}/athlete/${ICU_ATHLETE_ID}/activities?oldest=2015-01-01&newest=2026-12-31`);
      // 3. activities with no params at all
      await probe("activities_noparams", `${ICU_BASE}/athlete/${ICU_ATHLETE_ID}/activities`);
      // 4. same, but against the resolved numeric id rather than "0"
      if (numericId) {
        await probe("activities_numeric_id", `${ICU_BASE}/athlete/${numericId}/activities?oldest=2015-01-01&newest=2026-12-31`);
      }
      // 5. wellness (sleep / HRV / steps) — Garmin syncs this separately from
      //    activities, so data here with none above proves the link is alive
      //    and the account simply has no recorded workouts.
      await probe("wellness", `${ICU_BASE}/athlete/${ICU_ATHLETE_ID}/wellness?oldest=2026-08-01&newest=2026-08-12`);

      return json(out, 200, origin);
    }

    return json({ error: "unknown action" }, 400, origin);
  } catch (e) {
    return json({ error: String(e instanceof Error ? e.message : e) }, 500, origin);
  }
});
