// Tier 1: filtro booleano gratis. Corre sobre cada oferta nueva.
// Sólo las que pasan acá van a la IA (Tier 2 / Claude Haiku).
import type { NormalizedJob, ProfileRow } from "./types.ts";
import { normalizeText } from "./normalize.ts";

export interface Tier1Result {
  pass: boolean;
  reason: string;
}

// ¿Una oferta "remote" es tomable desde la región del usuario (AR/LATAM)?
// Heurística conservadora: sólo descarta si la región EXCLUYE explícitamente.
function regionEligible(job: NormalizedJob): boolean {
  const r = normalizeText(job.candidate_region ?? job.location ?? "");
  if (!r) return true;
  // Regiones que claramente excluyen LATAM:
  const excludes =
    /(us only|usa only|united states only|us-only|u\.s\. only|europe only|eu only|emea only|uk only|canada only|us based|must be located in the us)/;
  const inclusiveGlobal = /(worldwide|anywhere|global|latam|south america|americas|remote)/;
  if (excludes.test(r) && !inclusiveGlobal.test(r)) return false;
  return true;
}

export function tier1(job: NormalizedJob, profile: ProfileRow): Tier1Result {
  const hay = normalizeText(`${job.title} ${job.company ?? ""} ${job.description ?? ""} ${job.tags.join(" ")}`);

  // 1) Exclusiones: si aparece alguna keyword excluida -> fuera.
  for (const kw of profile.keywords_exclude) {
    const k = normalizeText(kw);
    if (k && hay.includes(k)) return { pass: false, reason: `excluida por keyword: ${kw}` };
  }

  // 2) Inclusiones: si el perfil definió includes, requerir al menos una.
  const includes = profile.keywords_include.map(normalizeText).filter(Boolean);
  if (includes.length > 0) {
    const hit = includes.some((k) => hay.includes(k));
    if (!hit) return { pass: false, reason: "no matchea ninguna keyword incluida" };
  }

  // 3) Preferencia remoto.
  if (profile.remote_pref === "remote" && job.remote === false) {
    return { pass: false, reason: "el perfil quiere remoto y la oferta es presencial" };
  }

  // 4) Salario mínimo (si la oferta declara salario).
  if (profile.min_salary && job.salary_max && job.salary_max < profile.min_salary) {
    return { pass: false, reason: `salario tope (${job.salary_max}) por debajo del mínimo (${profile.min_salary})` };
  }

  // 5) Elegibilidad por región.
  if (!regionEligible(job)) {
    return { pass: false, reason: `región no elegible: ${job.candidate_region ?? job.location}` };
  }

  return { pass: true, reason: "pasa Tier 1" };
}
