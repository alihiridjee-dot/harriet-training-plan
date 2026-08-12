-- Strava OAuth tokens for the Garmin → Strava → app bridge.
--
-- RLS is enabled with NO policies on purpose: that makes the table
-- unreadable to the publishable/anon key used in the browser, so tokens
-- are reachable only by the edge function's service role.

create table if not exists public.strava_tokens (
  id            text primary key,
  access_token  text        not null,
  refresh_token text        not null,
  expires_at    bigint      not null,
  athlete       jsonb,
  updated_at    timestamptz not null default now()
);

alter table public.strava_tokens enable row level security;

revoke all on public.strava_tokens from anon, authenticated;
