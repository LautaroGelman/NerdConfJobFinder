-- ============================================================================
-- CRON: dispara la Edge Function `poll` cada 2 minutos.
-- `poll` está como verify_jwt = false (pública), así que el cron la llama
-- sin necesidad de credenciales.
--
-- Reemplazá <PROJECT_REF> por el ref de tu proyecto.
-- (También se puede crear desde el dashboard: Integrations > Cron.)
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
    headers := jsonb_build_object('Content-Type', 'application/json'),
    body    := '{}'::jsonb,
    timeout_milliseconds := 120000
  );
  $$
);

-- Para verificar:  select * from cron.job;
-- Para ver corridas: select * from cron.job_run_details order by start_time desc limit 10;
