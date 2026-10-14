-- ローカル／CI 用：Supabase の auth スキーマとロールの最小スタブ（本番では実行しない）
do $$ begin
  if not exists (select from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
end $$;
create schema if not exists auth;
create table if not exists auth.users (id uuid primary key default gen_random_uuid(), email text, last_sign_in_at timestamptz);
create or replace function auth.uid() returns uuid language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''),
                  (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid
$$;
grant usage on schema auth to authenticated, anon;
grant usage on schema public to authenticated, anon;
grant execute on function auth.uid() to authenticated, anon;
