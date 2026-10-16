-- Reuses the existing project URL / cron secret Vault entries when dedicated
-- notification entries have not been provisioned.
create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

create or replace function public.schedule_notification_workers()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_url_name text;
  v_secret_name text;
  v_poll_id bigint;
  v_send_id bigint;
begin
  v_url_name := case when exists (
    select 1 from vault.decrypted_secrets
    where name = 'notification_project_url' and nullif(decrypted_secret, '') is not null
  ) then 'notification_project_url' else 'lectio_keepalive_project_url' end;
  v_secret_name := case when exists (
    select 1 from vault.decrypted_secrets
    where name = 'notification_cron_secret' and nullif(decrypted_secret, '') is not null
  ) then 'notification_cron_secret' else 'lectio_keepalive_cron_secret' end;
  if not exists (
       select 1 from vault.decrypted_secrets
       where name = v_url_name and nullif(decrypted_secret, '') is not null
     ) or not exists (
       select 1 from vault.decrypted_secrets
       where name = v_secret_name and nullif(decrypted_secret, '') is not null
     ) then
    raise exception 'Missing notification project URL or cron secret in Vault';
  end if;

  perform cron.unschedule(jobid) from cron.job
   where jobname in ('schedule-notification-poller', 'schedule-notification-sender');

  select cron.schedule(
    'schedule-notification-poller', '*/5 * * * *',
    $cron$select net.http_post(
      url := rtrim((select decrypted_secret from vault.decrypted_secrets where name in ('notification_project_url','lectio_keepalive_project_url') and nullif(decrypted_secret, '') is not null order by (name = 'notification_project_url') desc, created_at desc limit 1), '/') || '/functions/v1/notification-poller',
      headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name in ('notification_cron_secret','lectio_keepalive_cron_secret') and nullif(decrypted_secret, '') is not null order by (name = 'notification_cron_secret') desc, created_at desc limit 1)),
      body := '{"source":"supabase-cron"}'::jsonb, timeout_milliseconds := 120000
    );$cron$
  ) into v_poll_id;

  select cron.schedule(
    'schedule-notification-sender', '* * * * *',
    $cron$select net.http_post(
      url := rtrim((select decrypted_secret from vault.decrypted_secrets where name in ('notification_project_url','lectio_keepalive_project_url') and nullif(decrypted_secret, '') is not null order by (name = 'notification_project_url') desc, created_at desc limit 1), '/') || '/functions/v1/notification-sender',
      headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name in ('notification_cron_secret','lectio_keepalive_cron_secret') and nullif(decrypted_secret, '') is not null order by (name = 'notification_cron_secret') desc, created_at desc limit 1)),
      body := '{"source":"supabase-cron"}'::jsonb, timeout_milliseconds := 120000
    );$cron$
  ) into v_send_id;
  return jsonb_build_object('poller_job_id', v_poll_id, 'sender_job_id', v_send_id);
end;
$$;

revoke all on function public.schedule_notification_workers() from public, anon, authenticated;
grant execute on function public.schedule_notification_workers() to service_role;

do $$
begin
  if (
    exists (
      select 1 from vault.decrypted_secrets
      where name in ('notification_project_url','lectio_keepalive_project_url')
        and nullif(decrypted_secret, '') is not null
    ) and exists (
      select 1 from vault.decrypted_secrets
      where name in ('notification_cron_secret','lectio_keepalive_cron_secret')
        and nullif(decrypted_secret, '') is not null
    )
  ) then
    perform public.schedule_notification_workers();
  else
    raise notice 'Notification workers not scheduled: add project URL and cron secret Vault entries, then call public.schedule_notification_workers()';
  end if;
end;
$$;

comment on function public.schedule_notification_workers() is
  'Schedules the five-minute Lectio poller and one-minute APNs outbox sender.';
