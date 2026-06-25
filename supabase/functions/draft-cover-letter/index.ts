// Edge Function `draft-cover-letter` — invocada desde el front web.
// Recibe { matchId } y devuelve { coverLetter }, guardándola como draft.
import { adminClient } from "../_shared/db.ts";
import { draftCoverLetter } from "../_shared/llm.ts";
import { corsHeaders, jsonResponse } from "../_shared/cors.ts";
import type { NormalizedJob, ProfileRow } from "../_shared/types.ts";

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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  let matchId: string | undefined;
  try {
    const body = await req.json();
    matchId = body.matchId;
  } catch {
    return jsonResponse({ error: "body inválido" }, 400);
  }
  if (!matchId) return jsonResponse({ error: "falta matchId" }, 400);

  const supabase = adminClient();
  const { data: match, error } = await supabase
    .from("matches")
    .select("id, job_id, profile_id, jobs(*), profiles(*)")
    .eq("id", matchId)
    .maybeSingle();
  if (error || !match) return jsonResponse({ error: "match no encontrado" }, 404);

  const job = rowToJob((match as any).jobs);
  const profile = (match as any).profiles as ProfileRow;

  try {
    const coverLetter = await draftCoverLetter(profile, job);
    await supabase.from("applications").upsert(
      {
        job_id: (match as any).job_id,
        profile_id: (match as any).profile_id,
        status: "draft",
        cover_letter: coverLetter,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "job_id,profile_id" },
    );
    return jsonResponse({ coverLetter });
  } catch (e) {
    return jsonResponse({ error: String(e) }, 500);
  }
});
