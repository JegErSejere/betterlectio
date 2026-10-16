begin;

create or replace function public.get_auth_health_filtered(
  p_since timestamptz default now() - interval '7 days',
  p_function_name text default null,
  p_platform text default null,
  p_version text default null,
  p_status text default null,
  p_limit integer default 500
)
returns table (
  request_id uuid,
  function_name text,
  started_at timestamptz,
  finished_at timestamptz,
  duration_ms integer,
  outcome text,
  failure_stage text,
  http_status integer,
  school_id bigint,
  school_name text,
  student_id text,
  platform text,
  app_version text,
  app_build text,
  profile_source text,
  schedule_ok boolean,
  student_card_status integer,
  has_name boolean,
  has_class boolean,
  has_birthdate boolean,
  has_picture boolean,
  session_state text,
  client_completion_kind text,
  client_completed_at timestamptz
)
language sql
security definer
set search_path = ''
stable
as $$
  with classified as (
    select
      a.*,
      case
        when a.client_completed_at is not null then 'confirmed'
        when a.auth_user_id is not null and exists (
          select 1
          from auth.sessions ses
          where ses.user_id = a.auth_user_id
            and ses.created_at >= a.started_at
            and ses.created_at <= coalesce(a.finished_at, a.started_at) + interval '1 hour'
        ) then 'observed'
        when a.outcome in ('success', 'degraded') and a.started_at > now() - interval '1 hour' then 'pending'
        when a.outcome in ('success', 'degraded') then 'unverified'
        else 'not_applicable'
      end as computed_session_state
    from public.auth_attempts a
    where a.started_at >= greatest(p_since, now() - interval '30 days')
      and (p_function_name is null or a.function_name = p_function_name)
      and (p_platform is null or a.platform = p_platform)
      and (p_version is null or a.app_version = p_version)
  )
  select
    a.request_id,
    a.function_name,
    a.started_at,
    a.finished_at,
    a.duration_ms,
    a.outcome,
    a.failure_stage,
    a.http_status,
    a.school_id,
    coalesce(s.display_name, s.name) as school_name,
    a.student_id,
    a.platform,
    a.app_version,
    a.app_build,
    a.profile_source,
    a.schedule_ok,
    a.student_card_status,
    a.has_name,
    a.has_class,
    a.has_birthdate,
    a.has_picture,
    a.computed_session_state as session_state,
    a.client_completion_kind,
    a.client_completed_at
  from classified a
  left join public.schools s on s.id = a.school_id
  where p_status is null
    or a.outcome = p_status
    or a.computed_session_state = p_status
  order by a.started_at desc
  limit least(greatest(coalesce(p_limit, 500), 1), 500);
$$;

revoke all on function public.get_auth_health_filtered(timestamptz, text, text, text, text, integer)
  from public, anon, authenticated;
grant execute on function public.get_auth_health_filtered(timestamptz, text, text, text, text, integer)
  to service_role;

revoke all on function public.get_student_lesson_mappings_v2(integer, text)
  from public, anon;
grant execute on function public.get_student_lesson_mappings_v2(integer, text)
  to authenticated, service_role;

revoke all on function public.upsert_user_lesson_override_v2(
  integer, text, text, text, smallint, text, smallint, text, timestamptz, text
) from public, anon;
grant execute on function public.upsert_user_lesson_override_v2(
  integer, text, text, text, smallint, text, smallint, text, timestamptz, text
) to authenticated, service_role;

revoke all on function public.touch_student_last_seen(text, integer)
  from public, anon;
grant execute on function public.touch_student_last_seen(text, integer)
  to authenticated, service_role;

alter table public.auth_attempts
  drop constraint if exists auth_attempts_platform_check;
alter table public.auth_attempts
  add constraint auth_attempts_platform_check
  check (
    platform in (
      'ios',
      'android',
      'extension',
      'admin-ios',
      'admin-android',
      'unknown'
    )
  ) not valid;
alter table public.auth_attempts
  validate constraint auth_attempts_platform_check;

commit;
