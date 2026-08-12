/* ============================================================
   Strava bridge — Supabase Edge Function

   Garmin's own Connect API is business-only, so activities reach us
   the way most athletes already sync them: Garmin device → Garmin
   Connect → Strava → here.

   This function exists because the Strava client secret must never
   touch the browser. The static site calls these actions; only this
   function ever sees the secret or the stored tokens.

   Actions (POST { action, ... }):
     exchange   { code }  — swap an OAuth code for tokens, store them
     status     {}        — is an athlete connected?
     sync       { after } — refresh if needed, return recent activities
     disconnect {}        — revoke at Strava and drop stored tokens
   ============================================================ */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const CLIENT_ID = Deno.env.get("STRAVA_CLIENT_ID") ?? "";
const CLIENT_SECRET = Deno.env.get("STRAVA_CLIENT_SECRET") ?? "";
const SB_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

// Only these origins may call the function.
const ALLOWED = [
  "https://harriet.hiridjee.com",
  "https://alihiridjee-dot.github.io",
  "http://localhost:8000",
  "http://127.0.0.1:8000",
];

const ATHLETE_ID = "harriet";
const TOKEN_URL = "https://www.strava.com/oauth/token";
const API = "https://www.strava.com/api/v3";

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

const db = () => createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } });

/** Persist a Strava token payload. */
async function storeTokens(t: Record<string, unknown>) {
  const { error } = await db().from("strava_tokens").upsert({
    id: ATHLETE_ID,
    access_token: t.access_token,
    refresh_token: t.refresh_token,
    expires_at: t.expires_at,
    athlete: t.athlete ?? null,
    updated_at: new Date().toISOString(),
  });
  if (error) throw new Error("could not store tokens: " + error.message);
}

/** Read tokens, transparently refreshing when within 5 minutes of expiry. */
async function freshAccessToken(): Promise<string | null> {
  const { data } = await db().from("strava_tokens").select("*").eq("id", ATHLETE_ID).maybeSingle();
  if (!data) return null;

  const now = Math.floor(Date.now() / 1000);
  if (Number(data.expires_at) - now > 300) return data.access_token;

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      grant_type: "refresh_token",
      refresh_token: data.refresh_token,
    }),
  });
  if (!res.ok) return null;

  const t = await res.json();
  await storeTokens({ ...t, athlete: data.athlete });
  return t.access_token;
}

Deno.serve(async (req) => {
  const origin = req.headers.get("origin");
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(origin) });
  if (req.method !== "POST") return json({ error: "POST only" }, 405, origin);

  if (!CLIENT_ID || !CLIENT_SECRET || !SERVICE_KEY) {
    return json({ error: "Function is missing STRAVA_CLIENT_ID / STRAVA_CLIENT_SECRET secrets." }, 500, origin);
  }

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* empty body is fine */ }
  const action = String(body.action ?? "");

  try {
    // ---- swap the one-time OAuth code for tokens ----
    if (action === "exchange") {
      const code = String(body.code ?? "");
      if (!code) return json({ error: "missing code" }, 400, origin);

      const res = await fetch(TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_id: CLIENT_ID,
          client_secret: CLIENT_SECRET,
          grant_type: "authorization_code",
          code,
        }),
      });
      const t = await res.json();
      if (!res.ok) return json({ error: t.message ?? "exchange failed" }, 400, origin);

      await storeTokens(t);
      return json({ ok: true, athlete: t.athlete ?? null }, 200, origin);
    }

    // ---- connection status ----
    if (action === "status") {
      const { data } = await db().from("strava_tokens").select("athlete").eq("id", ATHLETE_ID).maybeSingle();
      return json({ connected: !!data, athlete: data?.athlete ?? null }, 200, origin);
    }

    // ---- pull recent activities ----
    if (action === "sync") {
      const token = await freshAccessToken();
      if (!token) return json({ connected: false, activities: [] }, 200, origin);

      // default window: the last 30 days
      const after = Number(body.after) || Math.floor(Date.now() / 1000) - 60 * 60 * 24 * 30;
      const res = await fetch(`${API}/athlete/activities?after=${after}&per_page=100`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) return json({ error: "strava rejected the request", status: res.status }, 502, origin);

      const raw = await res.json();
      // Send back only what the calendar actually needs.
      const activities = (Array.isArray(raw) ? raw : []).map((a) => ({
        id: a.id,
        name: a.name,
        type: a.sport_type ?? a.type,
        start_local: a.start_date_local,
        distance_m: a.distance,
        moving_s: a.moving_time,
        elapsed_s: a.elapsed_time,
        avg_hr: a.average_heartrate ?? null,
        elev_m: a.total_elevation_gain ?? null,
      }));
      return json({ connected: true, activities }, 200, origin);
    }

    // ---- revoke and forget ----
    if (action === "disconnect") {
      const token = await freshAccessToken();
      if (token) {
        await fetch("https://www.strava.com/oauth/deauthorize", {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
        }).catch(() => {});
      }
      await db().from("strava_tokens").delete().eq("id", ATHLETE_ID);
      return json({ ok: true }, 200, origin);
    }

    return json({ error: "unknown action" }, 400, origin);
  } catch (e) {
    return json({ error: String(e instanceof Error ? e.message : e) }, 500, origin);
  }
});
