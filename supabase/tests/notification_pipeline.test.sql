-- pgTAP coverage for notification leases, safety gates, and revocation.
--
-- Run: supabase test db

begin;
select plan(10);

insert into public.schools (id, name)
values (9913, 'Notification pipeline test')
on conflict (id) do nothing;

insert into auth.users (id, instance_id, aud, role, email)
values (
  '00000000-0000-0000-0000-000000009913',
  '00000000-0000-0000-0000-000000000000',
  'authenticated',
  'authenticated',
  'notification-pipeline@test.invalid'
)
on conflict (id) do nothing;

insert into public.students (id, school_id, name, supabase_id)
values (
  'notification-test-student',
  9913,
  'Notification Test Student',
  '00000000-0000-0000-0000-000000009913'
)
on conflict (id) do nothing;

insert into public.notification_prefs (student_id, enabled, cancellations)
values ('notification-test-student', true, true);

insert into public.device_tokens (student_id, apns_token, environment)
values ('notification-test-student', 'notification-test-device', 'sandbox');

-- A row created by the legacy credential shape must never reach the worker.
insert into public.lectio_tokens (student_id, encrypted_token)
values ('notification-test-student', decode('00', 'hex'));

select set_config('request.jwt.claim.role', 'service_role', true);

select is(
  (select count(*) from public.claim_due_notification_polls(p_student_ids => null)),
  0::bigint,
  'legacy/incomplete credentials are not claimable'
);

update public.lectio_tokens set
  encrypted_token = null,
  school_id = 9913,
  key_version = 1,
  ciphertext = 'YQ==',
  iv = 'YQ==',
  wrapped_dek = 'YQ==',
  wrap_iv = 'YQ==',
  next_poll_at = now()
where student_id = 'notification-test-student';

create temporary table notification_first_claim as
select * from public.claim_due_notification_polls(p_student_ids => null);

select is(
  (select count(*) from notification_first_claim),
  1::bigint,
  'a complete consented credential is leased once'
);

select public.fail_notification_poll(
  student_id,
  claim_token,
  'timeout',
  false
)
from notification_first_claim;

select is(
  (select disabled_at from public.lectio_tokens where student_id = 'notification-test-student'),
  null::timestamptz,
  'a transient poll failure backs off without disabling consent'
);

update public.lectio_tokens
set next_poll_at = now()
where student_id = 'notification-test-student';

create temporary table notification_second_claim as
select * from public.claim_due_notification_polls(p_student_ids => null);

select public.fail_notification_poll(
  student_id,
  claim_token,
  'session_expired',
  true
)
from notification_second_claim;

select isnt(
  (select disabled_at from public.lectio_tokens where student_id = 'notification-test-student'),
  null::timestamptz,
  'a terminal credential failure disables polling'
);

select set_config(
  'request.jwt.claim.sub',
  '00000000-0000-0000-0000-000000009913',
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);

select is(
  (select count(*) from public.lectio_token_status),
  1::bigint,
  'the status view exposes the signed-in student own row'
);

insert into public.notification_outbox (
  student_id, lesson_key, kind, payload, idempotency_key
) values (
  'notification-test-student', 'moved-test', 'moved', '{}'::jsonb, 'moved-test'
);

select is(
  (select count(*) from public.notification_outbox where kind = 'moved'),
  0::bigint,
  'the MVP gate silently rejects non-cancellation rows'
);

insert into public.notification_outbox (
  student_id, lesson_key, kind, payload, idempotency_key
) values (
  'notification-test-student', 'cancel-test', 'cancelled', '{}'::jsonb, 'cancel-test'
);

select is(
  (select count(*) from public.notification_outbox where kind = 'cancelled'),
  1::bigint,
  'the MVP gate accepts explicit cancellations'
);

update public.notification_prefs
set enabled = false
where student_id = 'notification-test-student';

insert into public.notification_outbox (
  student_id, lesson_key, kind, payload, idempotency_key
) values (
  'notification-test-student', 'no-consent-test', 'cancelled', '{}'::jsonb, 'no-consent-test'
);

select is(
  (select count(*) from public.notification_outbox where lesson_key = 'no-consent-test'),
  0::bigint,
  'the gate rejects cancellations without active notification consent'
);

update public.notification_prefs
set enabled = true
where student_id = 'notification-test-student';

insert into public.notification_outbox (
  student_id, lesson_key, kind, payload, idempotency_key
)
select
  'notification-test-student',
  'burst-' || n,
  'cancelled',
  '{}'::jsonb,
  'burst-' || n
from generate_series(1, 200) n;

select set_config('request.jwt.claim.role', 'service_role', true);
select throws_ok(
  $$ select * from public.claim_due_notification_deliveries(p_student_ids => null) $$,
  'P0001',
  'notification circuit breaker open',
  'more than 200 fresh pending cancellations opens the circuit breaker'
);

select set_config('request.jwt.claim.role', 'authenticated', true);
select ok(
  public.revoke_own_notification_registration('notification-test-student')
  and not exists (
    select 1 from public.lectio_tokens where student_id = 'notification-test-student'
  )
  and not exists (
    select 1 from public.device_tokens where student_id = 'notification-test-student'
  )
  and not (
    select enabled from public.notification_prefs
    where student_id = 'notification-test-student'
  ),
  'logout/opt-out atomically removes credentials and devices and disables preferences'
);

select * from finish();
rollback;
