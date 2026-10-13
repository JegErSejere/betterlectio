-- Completes the server-owned schedule notification pipeline. Credentials stay
-- envelope-encrypted; workers lease both polling and delivery jobs so cron
-- overlap cannot duplicate Lectio requests or APNs pushes.

alter table public.lectio_tokens alter column encrypted_token drop not null;
alter table public.lectio_tokens
  add column if not exists school_id bigint references public.schools(id),
  add column if not exists key_version integer,
  add column if not exists ciphertext text,
  add column if not exists iv text,
  add column if not exists wrapped_dek text,
  add column if not exists wrap_iv text,
  add column if not exists next_poll_at timestamptz not null default now(),
  add column if not exists claimed_until timestamptz,
  add column if not exists claim_token uuid,
  add column if not exists last_error_code text;

alter table public.notification_outbox
  add column if not exists claimed_until timestamptz,
  add column if not exists claim_token uuid;

-- Expose only the signed-in student's health fields. The view intentionally
-- runs with its owner's table privileges because lectio_tokens has no SELECT
-- policy; the explicit ownership predicate is the access boundary.
create or replace view public.lectio_token_status
with (security_invoker = false, security_barrier = true) as
select t.student_id, t.disabled_at, t.last_used_at
from public.lectio_tokens t
join public.students s on s.id = t.student_id
where s.supabase_id = (select auth.uid());

revoke all on public.lectio_token_status from public, anon;
grant select on public.lectio_token_status to authenticated;

-- Credential creation and rotation must go through notification-register so
-- plaintext tokens are always envelope-encrypted. Keep DELETE for older app
-- versions whose opt-out path removed their own row directly.
revoke insert, update on public.lectio_tokens from anon, authenticated;
grant delete on public.lectio_tokens to authenticated;

create or replace function public.revoke_own_notification_registration(p_student_id text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.students s
    where s.id = p_student_id and s.supabase_id = auth.uid()
  ) then
    raise exception 'Unauthorized';
  end if;
  delete from public.device_tokens where student_id = p_student_id;
  delete from public.lectio_tokens where student_id = p_student_id;
  update public.notification_prefs
     set enabled = false, updated_at = now()
   where student_id = p_student_id;
  return true;
end;
$$;

revoke all on function public.revoke_own_notification_registration(text) from public, anon;
grant execute on function public.revoke_own_notification_registration(text) to authenticated;

create or replace function public.claim_due_notification_polls(
  p_batch_size integer default 20,
  p_lease_seconds integer default 120,
  p_student_ids text[] default array[]::text[]
)
returns table (
  student_id text, school_id bigint, key_version integer, ciphertext text,
  iv text, wrapped_dek text, wrap_iv text, claim_token uuid
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.role() <> 'service_role' then raise exception 'service_role required'; end if;
  return query
  with due as (
    select t.student_id
    from public.lectio_tokens t
    join public.notification_prefs p
      on p.student_id = t.student_id and p.enabled and p.cancellations
    where t.disabled_at is null
      and t.school_id is not null
      and t.key_version is not null
      and t.ciphertext is not null
      and t.iv is not null
      and t.wrapped_dek is not null
      and t.wrap_iv is not null
      and t.next_poll_at <= now()
      and (t.claimed_until is null or t.claimed_until < now())
      and (p_student_ids is null or t.student_id = any(p_student_ids))
      and exists (select 1 from public.device_tokens d where d.student_id = t.student_id)
    order by t.next_poll_at, t.last_used_at
    for update of t skip locked
    limit greatest(1, least(coalesce(p_batch_size, 20), 50))
  ), claimed as (
    update public.lectio_tokens t
       set claimed_until = now() + make_interval(secs => greatest(30, least(p_lease_seconds, 300))),
           claim_token = gen_random_uuid(), last_used_at = now(), updated_at = now()
      from due where t.student_id = due.student_id
    returning t.*
  )
  select c.student_id, c.school_id, c.key_version, c.ciphertext,
         c.iv, c.wrapped_dek, c.wrap_iv, c.claim_token
  from claimed c;
end;
$$;

create or replace function public.complete_notification_poll(
  p_student_id text, p_claim_token uuid, p_key_version integer,
  p_ciphertext text, p_iv text, p_wrapped_dek text, p_wrap_iv text
)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if auth.role() <> 'service_role' then raise exception 'service_role required'; end if;
  update public.lectio_tokens set
    key_version = p_key_version, ciphertext = p_ciphertext, iv = p_iv,
    wrapped_dek = p_wrapped_dek, wrap_iv = p_wrap_iv,
    next_poll_at = now() + interval '15 minutes', claimed_until = null,
    claim_token = null, consecutive_failures = 0, disabled_at = null,
    last_error_code = null, updated_at = now()
  where student_id = p_student_id and claim_token = p_claim_token;
  return found;
end;
$$;

create or replace function public.fail_notification_poll(
  p_student_id text, p_claim_token uuid, p_error_code text, p_terminal boolean default false
)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if auth.role() <> 'service_role' then raise exception 'service_role required'; end if;
  update public.lectio_tokens set
    consecutive_failures = consecutive_failures + 1,
    next_poll_at = now() + make_interval(secs => least(3600, 60 * power(2, least(consecutive_failures, 5))::int)),
    claimed_until = null, claim_token = null,
    -- Network/parser/backend failures back off but never permanently disable a
    -- registration. Only a known-dead session or undecryptable credential is
    -- terminal; otherwise an outage would silently opt every user out.
    disabled_at = case when p_terminal then now() else disabled_at end,
    last_error_code = left(coalesce(p_error_code, 'unknown'), 100), updated_at = now()
  where student_id = p_student_id and claim_token = p_claim_token;
  return found;
end;
$$;

create or replace function public.claim_due_notification_deliveries(
  p_batch_size integer default 50, p_lease_seconds integer default 120,
  p_student_ids text[] default array[]::text[]
)
returns table (outbox_id uuid, student_id text, payload jsonb, claim_token uuid)
language plpgsql security definer set search_path = '' as $$
declare v_burst bigint;
begin
  if auth.role() <> 'service_role' then raise exception 'service_role required'; end if;
  select count(*) into v_burst from public.notification_outbox o
   where o.kind = 'cancelled' and o.created_at > now() - interval '5 minutes'
     and o.sent_at is null and o.failed_at is null
     and (p_student_ids is null or o.student_id = any(p_student_ids));
  if v_burst > 200 then raise exception 'notification circuit breaker open'; end if;
  return query
  with due as (
    select o.id from public.notification_outbox o
    where o.kind = 'cancelled' and o.send_after <= now() and o.sent_at is null and o.failed_at is null
      and (o.claimed_until is null or o.claimed_until < now())
      and (p_student_ids is null or o.student_id = any(p_student_ids))
    order by o.send_after for update skip locked
    limit greatest(1, least(coalesce(p_batch_size, 50), 100))
  ), claimed as (
    update public.notification_outbox o set
      claimed_until = now() + make_interval(secs => greatest(30, least(p_lease_seconds, 300))),
      claim_token = gen_random_uuid(), attempts = attempts + 1
    from due where o.id = due.id returning o.*
  )
  select c.id, c.student_id, c.payload, c.claim_token from claimed c;
end;
$$;

create or replace function public.complete_notification_delivery(p_outbox_id uuid, p_claim_token uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if auth.role() <> 'service_role' then raise exception 'service_role required'; end if;
  update public.notification_outbox set sent_at = now(), claimed_until = null, claim_token = null
   where id = p_outbox_id and claim_token = p_claim_token;
  return found;
end;
$$;

create or replace function public.fail_notification_delivery(
  p_outbox_id uuid, p_claim_token uuid, p_terminal boolean default false
)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if auth.role() <> 'service_role' then raise exception 'service_role required'; end if;
  update public.notification_outbox set
    failed_at = case when p_terminal or attempts >= 5 then now() else null end,
    send_after = case when p_terminal or attempts >= 5 then send_after
                      else now() + make_interval(secs => least(3600, 30 * power(2, attempts)::int)) end,
    claimed_until = null, claim_token = null
  where id = p_outbox_id and claim_token = p_claim_token;
  return found;
end;
$$;

revoke all on function public.claim_due_notification_polls(integer, integer, text[]) from public, anon, authenticated;
revoke all on function public.complete_notification_poll(text, uuid, integer, text, text, text, text) from public, anon, authenticated;
revoke all on function public.fail_notification_poll(text, uuid, text, boolean) from public, anon, authenticated;
revoke all on function public.claim_due_notification_deliveries(integer, integer, text[]) from public, anon, authenticated;
revoke all on function public.complete_notification_delivery(uuid, uuid) from public, anon, authenticated;
revoke all on function public.fail_notification_delivery(uuid, uuid, boolean) from public, anon, authenticated;
grant execute on function public.claim_due_notification_polls(integer, integer, text[]) to service_role;
grant execute on function public.complete_notification_poll(text, uuid, integer, text, text, text, text) to service_role;
grant execute on function public.fail_notification_poll(text, uuid, text, boolean) to service_role;
grant execute on function public.claim_due_notification_deliveries(integer, integer, text[]) to service_role;
grant execute on function public.complete_notification_delivery(uuid, uuid) to service_role;
grant execute on function public.fail_notification_delivery(uuid, uuid, boolean) to service_role;

create index if not exists lectio_tokens_poll_due_idx on public.lectio_tokens(next_poll_at)
where disabled_at is null;

update public.notification_outbox set failed_at = now()
where kind <> 'cancelled' and sent_at is null and failed_at is null;

-- MVP safety gate. The parser carries all lesson fields so stored schedules stay
-- accurate, but only explicit Lectio cancellations may leave the outbox until
-- moved/room/teacher changes have soaked in production.
create or replace function public.notification_cancellations_only_gate()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.kind <> 'cancelled' then return null; end if;
  return new;
end;
$$;
drop trigger if exists notification_cancellations_only_gate on public.notification_outbox;
create trigger notification_cancellations_only_gate
before insert on public.notification_outbox
for each row execute function public.notification_cancellations_only_gate();
