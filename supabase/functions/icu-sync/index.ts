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
     status    {}                          — is a key configured and working?
     sync      { oldest, newest }          — activities in a date window
     wellness  { oldest, newest }          — sleep / HRV / resting HR per day
     intervals { id }                      — one activity's laps (CSS test detection)
     push      { from, to, workouts[] }    — planned workouts onto her intervals.icu
                                             calendar, which sends them to Garmin
     notify    {}                          — ping Ali about new big sessions (run on a schedule)
   ============================================================ */

const ICU_API_KEY = Deno.env.get("ICU_API_KEY") ?? "";
// "0" means "the athlete this key belongs to" — no need to look up an id.
const ICU_ATHLETE_ID = Deno.env.get("ICU_ATHLETE_ID") ?? "0";
const ICU_BASE = "https://intervals.icu/api/v1";

// Only these origins may call the function.
const ALLOWED = [
  "https://harrietmeerstraining.co.uk",
  "https://www.harrietmeerstraining.co.uk",
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

// What counts as worth a "go Harriet!" — the long, the hard and the race-like.
function bigSession(a: Record<string, any>): { title: string; body: string; tag: string } | null {
  const t = String(a.type ?? ""), d = Number(a.distance ?? 0), s = Number(a.moving_time ?? 0), load = Number(a.icu_training_load ?? 0);
  const km = (d / 1000).toFixed(1) + " km";
  const hms = Math.floor(s / 3600) + ":" + String(Math.floor(s % 3600 / 60)).padStart(2, "0") + ":" + String(Math.round(s % 60)).padStart(2, "0");
  const hr = a.average_heartrate ? " · ♥ " + Math.round(a.average_heartrate) : "";
  const isRun = /Run/.test(t), isRide = /Ride/.test(t), isSwim = /Swim/.test(t);
  let what = "";
  if (isRun && (d >= 15000 || s >= 80 * 60)) what = "a " + km + " run";
  else if (isRide && (d >= 50000 || s >= 120 * 60)) what = "a " + km + " ride";
  else if (isSwim && (d >= 1500 || t === "OpenWaterSwim")) what = (t === "OpenWaterSwim" ? "an open-water swim, " : "a ") + Math.round(d) + " m" + (t === "OpenWaterSwim" ? "" : " swim");
  else if (load >= 100) what = "a big " + (isRun ? "run" : isRide ? "ride" : "session");
  if (!what) return null;
  return {
    title: "Harriet just finished " + what + " 🎉",
    body: hms + (d && !isSwim ? " · " + km : "") + hr + " — send her some love!",
    tag: isSwim ? "swimmer" : isRide ? "bike" : "runner",
  };
}

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
        max_hr: a.max_heartrate ?? null,
        load: a.icu_training_load ?? null,
        // seconds in each HR zone (Z1 first) — for "planned vs actual"
        hr_zone_times: Array.isArray(a.icu_hr_zone_times) ? a.icu_hr_zone_times : null,
        hr_zones: Array.isArray(a.icu_hr_zones) ? a.icu_hr_zones : null,   // top bpm of each zone
        lthr: a.lthr ?? null,
      }));
      return json({ connected: true, activities }, 200, origin);
    }

    // ---- wellness: sleep / HRV / resting HR for the readiness strip ----
    // Garmin syncs this daily even on days with no recorded workout.
    if (action === "wellness") {
      const now = new Date();
      const past = new Date(now.getTime() - 45 * 24 * 60 * 60 * 1000);
      const oldest = String(body.oldest ?? ymd(past));
      const newest = String(body.newest ?? ymd(now));

      const res = await fetch(
        `${ICU_BASE}/athlete/${ICU_ATHLETE_ID}/wellness?oldest=${encodeURIComponent(oldest)}&newest=${encodeURIComponent(newest)}`,
        { headers: { Authorization: authHeader() } },
      );
      if (res.status === 429) return json({ error: "rate limited, try again shortly" }, 429, origin);
      if (!res.ok) return json({ error: "intervals.icu error " + res.status }, 502, origin);

      const raw = await res.json();
      const days = (Array.isArray(raw) ? raw : [])
        .map((d) => ({
          date: d.id,
          sleep_s: d.sleepSecs ?? null,
          sleep_score: d.sleepScore ?? null,
          hrv: d.hrv ?? null,
          resting_hr: d.restingHR ?? null,
          steps: d.steps ?? null,
          readiness: d.readiness ?? null,
        }))
        // keep only days that carry at least one useful signal
        .filter((d) => d.sleep_s !== null || d.hrv !== null || d.resting_hr !== null);

      return json({ connected: true, days }, 200, origin);
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

      // 0. which fields an activity actually carries (names only, no values)
      try {
        const r = await fetch(`${ICU_BASE}/athlete/${ICU_ATHLETE_ID}/activities?oldest=2026-09-01&newest=2026-12-31`, { headers: { Authorization: authHeader() } });
        const list = await r.json();
        out.activity_keys = Array.isArray(list) && list[0] ? Object.keys(list[0]).sort() : [];
      } catch (e) { out.activity_keys = String(e); }

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

    // ---- one activity's laps, to find the 400 m and 200 m in a CSS test ----
    if (action === "intervals") {
      const id = String(body.id ?? "");
      if (!/^i?\d+$/.test(id)) return json({ error: "bad id" }, 400, origin);
      const res = await fetch(`${ICU_BASE}/activity/${id}?intervals=true`, { headers: { Authorization: authHeader() } });
      if (!res.ok) return json({ error: "intervals.icu error " + res.status }, 502, origin);
      const raw = await res.json();
      const laps = (Array.isArray(raw?.icu_intervals) ? raw.icu_intervals : []).map((i: Record<string, unknown>) => ({
        type: i.type ?? null,
        distance_m: i.distance ?? null,
        moving_s: i.moving_time ?? null,
        elapsed_s: i.elapsed_time ?? null,
      }));
      return json({ laps }, 200, origin);
    }

    // ---- planned workouts → her intervals.icu calendar → Garmin ----
    // The function is callable by anyone who knows its URL, so it only ever
    // writes WORKOUT events it owns (external_id "htp-…"), only inside a short
    // window around today, and replaces the whole window each time — so the
    // worst a stranger could do is briefly rewrite the next few weeks, which
    // the site puts right on its next push.
    if (action === "push") {
      const isDate = (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d);
      const today = ymd(new Date());
      const lo = ymd(new Date(Date.now() - 2 * 864e5)), hi = ymd(new Date(Date.now() + 22 * 864e5));
      const from = String(body.from ?? ""), to = String(body.to ?? "");
      if (!isDate(from) || !isDate(to) || from > to || from < lo || to > hi) {
        return json({ error: "window must sit between " + lo + " and " + hi }, 400, origin);
      }
      const TYPES = ["Run", "Ride", "Swim"];
      const list = Array.isArray(body.workouts) ? body.workouts.slice(0, 60) : [];
      const events = [];
      for (const w of list as Record<string, unknown>[]) {
        const date = String(w.date ?? ""), type = String(w.type ?? ""), key = String(w.key ?? "").replace(/[^A-Za-z0-9-]/g, "").slice(0, 40);
        if (!isDate(date) || date < from || date > to || !TYPES.includes(type) || !key) continue;
        events.push({
          category: "WORKOUT", start_date_local: date + "T00:00:00", type,
          name: String(w.name ?? "Workout").slice(0, 100),
          description: String(w.description ?? "").slice(0, 4000),
          external_id: "htp-" + key,
        });
      }
      const headers = { Authorization: authHeader(), "Content-Type": "application/json" };
      // how many structured steps intervals.icu read out of each description —
      // 0 means it couldn't parse it and the watch gets text only
      let parsed: { key: string; steps: number | null }[] = [];
      if (events.length) {
        const up = await fetch(`${ICU_BASE}/athlete/${ICU_ATHLETE_ID}/events/bulk?upsert=true`, { method: "POST", headers, body: JSON.stringify(events) });
        if (!up.ok) return json({ error: "intervals.icu error " + up.status, detail: (await up.text()).slice(0, 300) }, 502, origin);
        const back = await up.json().catch(() => []);
        parsed = (Array.isArray(back) ? back : []).map((e: Record<string, any>) => ({
          key: String(e.external_id ?? ""), steps: Array.isArray(e.workout_doc?.steps) ? e.workout_doc.steps.length : null,
        }));
      }
      // drop our own workouts in the window that aren't in the plan any more (a swap, a reset)
      let removed = 0;
      const keep = new Set(events.map((e) => e.external_id));
      const ls = await fetch(`${ICU_BASE}/athlete/${ICU_ATHLETE_ID}/events?oldest=${from}&newest=${to}&category=WORKOUT`, { headers });
      if (ls.ok) {
        const existing = await ls.json();
        const stale = (Array.isArray(existing) ? existing : [])
          .filter((e: Record<string, unknown>) => typeof e.external_id === "string" && e.external_id.startsWith("htp-") && !keep.has(e.external_id))
          .map((e: Record<string, unknown>) => ({ external_id: e.external_id }));
        if (stale.length) {
          const del = await fetch(`${ICU_BASE}/athlete/${ICU_ATHLETE_ID}/events/bulk-delete`, { method: "PUT", headers, body: JSON.stringify(stale) });
          if (del.ok) removed = stale.length;
        }
      }
      return json({ pushed: events.length, removed, parsed }, 200, origin);
    }

    // ---- tell Ali when Harriet finishes a big session ----
    // Run every 15 min by a GitHub Actions schedule. Remembers what it has
    // already seen in athlete_state (row "notify"), and on its very first run
    // just takes note of everything so it never sends a backlog.
    if (action === "notify") {
      const topic = Deno.env.get("NTFY_TOPIC") ?? "";
      if (!topic) return json({ error: "NTFY_TOPIC secret is not set" }, 200, origin);
      const sbUrl = Deno.env.get("SUPABASE_URL") ?? "", sbKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
      const sbHeaders: Record<string, string> = { apikey: sbKey, "Content-Type": "application/json" };
      if (sbKey.startsWith("eyJ")) sbHeaders.Authorization = "Bearer " + sbKey;

      const row = await fetch(`${sbUrl}/rest/v1/athlete_state?id=eq.notify&select=data`, { headers: sbHeaders });
      const rows = row.ok ? await row.json() : [];
      const first = !rows.length;
      const seen: string[] = first ? [] : (rows[0].data?.seen ?? []);

      const since = ymd(new Date(Date.now() - 3 * 864e5));
      const res = await fetch(`${ICU_BASE}/athlete/${ICU_ATHLETE_ID}/activities?oldest=${since}&newest=${ymd(new Date(Date.now() + 864e5))}`, { headers: { Authorization: authHeader() } });
      if (!res.ok) return json({ error: "intervals.icu error " + res.status }, 502, origin);
      const acts = await res.json();

      const sent: string[] = [];
      for (const a of (Array.isArray(acts) ? acts : []) as Record<string, any>[]) {
        const id = String(a.id);
        if (seen.includes(id)) continue;
        seen.push(id);
        if (first) continue;
        const msg = bigSession(a);
        if (!msg) continue;
        const r = await fetch("https://ntfy.sh/", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ topic, title: msg.title, message: msg.body, tags: [msg.tag], click: "https://harrietmeerstraining.co.uk/" }),
        });
        if (r.ok) sent.push(id);
      }
      await fetch(`${sbUrl}/rest/v1/athlete_state`, {
        method: "POST", headers: { ...sbHeaders, Prefer: "resolution=merge-duplicates" },
        body: JSON.stringify({ id: "notify", data: { seen: seen.slice(-300) }, updated_at: new Date().toISOString() }),
      });
      return json({ first, sent: sent.length }, 200, origin);
    }

    return json({ error: "unknown action" }, 400, origin);
  } catch (e) {
    return json({ error: String(e instanceof Error ? e.message : e) }, 500, origin);
  }
});
