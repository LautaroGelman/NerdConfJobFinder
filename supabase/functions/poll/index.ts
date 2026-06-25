// Edge Function `poll` — el worker que corre por cron cada ~2 min.
// Flujo: fetch fuentes (due) -> normalizar + dedup -> Tier 1 -> Tier 2 (DeepSeek)
//        -> guardar match -> Realtime + Telegram.
import { adminClient } from "../_shared/db.ts";
import { fetchSource } from "../_shared/sources.ts";
import { tier1 } from "../_shared/matching.ts";
import { scoreJob } from "../_shared/llm.ts";
import { buildMatchMessage, sendMessage } from "../_shared/telegram.ts";
import { contentHash, fuzzyKey } from "../_shared/normalize.ts";
import { jsonResponse } from "../_shared/cors.ts";
import type { ProfileRow, SourceRow } from "../_shared/types.ts";

// Tope de llamadas a la IA por corrida (acota tiempo/costo de la función).
const MAX_SCORES_PER_RUN = 8;

Deno.serve(async () => {
  const supabase = adminClient();
  const summary = { sources: 0, jobs: 0, scored: 0, matches: 0, notified: 0, errors: [] as string[] };

  // Fuentes habilitadas que ya están "due" según su intervalo.
  const { data: sources, error: srcErr } = await supabase
    .from("sources")
    .select("*")
    .eq("enabled", true);
  if (srcErr) return jsonResponse({ error: srcErr.message }, 500);

  const now = Date.now();
  const due = (sources as SourceRow[]).filter((s) => {
    if (!s.last_polled_at) return true;
    return now - new Date(s.last_polled_at).getTime() >= s.poll_interval_sec * 1000;
  });

  // Perfiles (en el MVP suele ser 1).
  const { data: profiles } = await supabase.from("profiles").select("*");
  const profileList = (profiles ?? []) as ProfileRow[];

  let scoreBudget = MAX_SCORES_PER_RUN;

  for (const source of due) {
    try {
      const res = await fetchSource(source);
      summary.sources++;

      // Persistir estado de polling (etag/last_modified/last_polled_at).
      await supabase
        .from("sources")
        .update({
          etag: res.etag,
          last_modified: res.lastModified,
          last_polled_at: new Date(now).toISOString(),
        })
        .eq("id", source.id);

      if (res.status === 304 || res.jobs.length === 0) continue;

      for (const job of res.jobs) {
        const hash = await contentHash([job.title, job.company, job.location]);

        // Upsert de la oferta (dedup por source_id+external_id).
        const { data: jobRow, error: jobErr } = await supabase
          .from("jobs")
          .upsert(
            {
              source_id: source.id,
              source_name: source.name,
              external_id: job.external_id,
              title: job.title,
              company: job.company,
              location: job.location,
              remote: job.remote,
              candidate_region: job.candidate_region,
              url: job.url,
              description: job.description,
              tags: job.tags,
              salary_min: job.salary_min,
              salary_max: job.salary_max,
              posted_at: job.posted_at,
              content_hash: hash,
              raw: job.raw,
            },
            { onConflict: "source_id,external_id" },
          )
          .select("id")
          .single();
        if (jobErr || !jobRow) continue;
        summary.jobs++;

        for (const profile of profileList) {
          // Gate de dedup: ¿ya vimos esta oferta para este perfil?
          const { data: seenRow } = await supabase
            .from("seen")
            .select("id")
            .eq("profile_id", profile.id)
            .eq("content_hash", hash)
            .maybeSingle();
          if (seenRow) continue;

          // Tier 1 (gratis).
          const t1 = tier1(job, profile);
          if (!t1.pass) {
            await supabase
              .from("seen")
              .insert({ profile_id: profile.id, content_hash: hash, fuzzy_key: fuzzyKey(job.title, job.company) });
            continue;
          }

          // Sin presupuesto de IA: dejar la oferta para la próxima corrida.
          if (scoreBudget <= 0) continue;
          scoreBudget--;

          // Tier 2 (DeepSeek).
          let score = 5;
          let reasons = "";
          try {
            const r = await scoreJob(profile, job);
            score = r.score;
            reasons = r.reasons;
            summary.scored++;
          } catch (e) {
            summary.errors.push(`score: ${String(e)}`);
          }

          // Marcar como visto (ya evaluado).
          await supabase
            .from("seen")
            .insert({ profile_id: profile.id, content_hash: hash, fuzzy_key: fuzzyKey(job.title, job.company) });

          if (score < profile.score_threshold) continue;

          // Guardar match -> dispara Realtime en el front.
          const { data: matchRow, error: matchErr } = await supabase
            .from("matches")
            .upsert(
              { job_id: jobRow.id, profile_id: profile.id, score, tier: "llm", reasons },
              { onConflict: "job_id,profile_id" },
            )
            .select("id")
            .single();
          if (matchErr || !matchRow) continue;
          summary.matches++;

          // Telegram (si el perfil está vinculado).
          if (profile.telegram_chat_id) {
            const { text, keyboard } = buildMatchMessage(job, score, reasons, matchRow.id);
            const sent = await sendMessage(profile.telegram_chat_id, text, keyboard);
            await supabase.from("notifications").insert({
              match_id: matchRow.id,
              profile_id: profile.id,
              channel: "telegram",
              status: sent.ok ? "sent" : "error",
              error: sent.error ?? null,
            });
            if (sent.ok) summary.notified++;
          }
        }
      }
    } catch (e) {
      summary.errors.push(`${source.name}: ${String(e)}`);
    }
  }

  return jsonResponse(summary);
});
