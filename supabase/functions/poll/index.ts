// Edge Function `poll` — el worker que corre por cron cada ~2 min.
// Flujo: fetch fuentes (due) -> normalizar + dedup -> Tier 1 -> Tier 2 (DeepSeek)
//        -> guardar match -> Realtime + Telegram.
// Además: pasada sobre el BACKLOG reciente para que un perfil nuevo reciba
//         matches del pool existente sin esperar ofertas nuevas.
import { adminClient } from "../_shared/db.ts";
import { fetchSource } from "../_shared/sources.ts";
import { tier1 } from "../_shared/matching.ts";
import { scoreJob } from "../_shared/llm.ts";
import { buildMatchMessage, sendMessage } from "../_shared/telegram.ts";
import { contentHash, fuzzyKey } from "../_shared/normalize.ts";
import { jsonResponse } from "../_shared/cors.ts";
import type { NormalizedJob, ProfileRow, SourceRow } from "../_shared/types.ts";

// Tope de llamadas a la IA por corrida (acota tiempo/costo de la función).
const MAX_SCORES_PER_RUN = 10;
// Cuántas ofertas recientes revisar para perfiles nuevos.
const BACKLOG_SIZE = 60;

function rowToJob(j: Record<string, any>): NormalizedJob {
  return {
    external_id: j.external_id,
    title: j.title,
    company: j.company,
    location: j.location,
    remote: j.remote,
    candidate_region: j.candidate_region,
    url: j.url,
    description: j.description,
    tags: j.tags ?? [],
    salary_min: j.salary_min,
    salary_max: j.salary_max,
    posted_at: j.posted_at,
    raw: j.raw,
  };
}

Deno.serve(async () => {
  const supabase = adminClient();
  const summary = { sources: 0, jobs: 0, scored: 0, matches: 0, notified: 0, errors: [] as string[] };
  const budget = { n: MAX_SCORES_PER_RUN };

  const { data: profiles } = await supabase.from("profiles").select("*");
  const profileList = (profiles ?? []) as ProfileRow[];

  // Evalúa una oferta para un perfil: dedup -> Tier1 -> Tier2 -> match -> notifica.
  async function tryEvaluate(profile: ProfileRow, job: NormalizedJob, jobId: string, hash: string) {
    const { data: seenRow } = await supabase
      .from("seen")
      .select("id")
      .eq("profile_id", profile.id)
      .eq("content_hash", hash)
      .maybeSingle();
    if (seenRow) return;

    const t1 = tier1(job, profile);
    if (!t1.pass) {
      await supabase
        .from("seen")
        .insert({ profile_id: profile.id, content_hash: hash, fuzzy_key: fuzzyKey(job.title, job.company) });
      return;
    }

    if (budget.n <= 0) return; // sin presupuesto IA: queda para la próxima corrida
    budget.n--;

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

    await supabase
      .from("seen")
      .insert({ profile_id: profile.id, content_hash: hash, fuzzy_key: fuzzyKey(job.title, job.company) });

    if (score < profile.score_threshold) return;

    const { data: matchRow, error: matchErr } = await supabase
      .from("matches")
      .upsert(
        { job_id: jobId, profile_id: profile.id, score, tier: "llm", reasons },
        { onConflict: "job_id,profile_id" },
      )
      .select("id")
      .single();
    if (matchErr || !matchRow) return;
    summary.matches++;

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

  // ---------- 1) Fuentes "due" ----------
  const { data: sources, error: srcErr } = await supabase.from("sources").select("*").eq("enabled", true);
  if (srcErr) return jsonResponse({ error: srcErr.message }, 500);

  const now = Date.now();
  const due = (sources as SourceRow[]).filter((s) => {
    if (!s.last_polled_at) return true;
    return now - new Date(s.last_polled_at).getTime() >= s.poll_interval_sec * 1000;
  });

  for (const source of due) {
    try {
      const res = await fetchSource(source);
      summary.sources++;
      await supabase
        .from("sources")
        .update({ etag: res.etag, last_modified: res.lastModified, last_polled_at: new Date(now).toISOString() })
        .eq("id", source.id);

      if (res.status === 304 || res.jobs.length === 0) continue;

      for (const job of res.jobs) {
        const hash = await contentHash([job.title, job.company, job.location]);
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
          await tryEvaluate(profile, job, jobRow.id, hash);
        }
      }
    } catch (e) {
      summary.errors.push(`${source.name}: ${String(e)}`);
    }
  }

  // ---------- 2) Backlog reciente (para perfiles nuevos) ----------
  if (budget.n > 0 && profileList.length > 0) {
    const { data: backlog } = await supabase
      .from("jobs")
      .select("*")
      .order("fetched_at", { ascending: false })
      .limit(BACKLOG_SIZE);
    for (const profile of profileList) {
      for (const row of backlog ?? []) {
        if (budget.n <= 0) break;
        await tryEvaluate(profile, rowToJob(row), row.id, row.content_hash);
      }
    }
  }

  return jsonResponse(summary);
});
