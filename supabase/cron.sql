-- ============================================================================
-- CRON: dispara la Edge Function `poll` cada 2 minutos.
-- Ejecutar en el SQL Editor de Supabase DESPUÉS de deployar la función `poll`.
--
-- Reemplazá:
--   <PROJECT_REF>  -> el ref de tu proyecto (la parte de https://<PROJECT_REF>.supabase.co)
--   <SERVICE_ROLE_KEY> -> Project Settings > API > service_role key
--
-- (También podés hacerlo sin SQL desde el dashboard: Integrations > Cron > Create job,
--  apuntando a la función `poll` con schedule */2 * * * *.)
-- ============================================================================

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Borra el job si ya existía (para poder re-ejecutar este script sin error).
select cron.unschedule('poll-jobs') where exists (
  select 1 from cron.job where jobname = 'poll-jobs'
);

select cron.schedule(
  'poll-jobs',
  '*/2 * * * *',  -- cada 2 minutos
  $$
  select net.http_post(
    url     := 'https://<PROJECT_REF>.supabase.co/functions/v1/poll',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer <SERVICE_ROLE_KEY>'
    ),
    body    := '{}'::jsonb,
    timeout_milliseconds := 120000
  );
  $$
);

-- Para verificar:  select * from cron.job;
-- Para ver corridas: select * from cron.job_run_details order by start_time desc limit 10;
