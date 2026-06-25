// Integración con DeepSeek (API compatible con OpenAI).
//  - scoreJob:        deepseek-chat (DeepSeek-V3) -> puntaje 1-10 + razón (JSON mode)
//  - draftCoverLetter: deepseek-chat              -> carta editable (texto)
//
// Endpoint:  https://api.deepseek.com/chat/completions
// Auth:      Authorization: Bearer $DEEPSEEK_API_KEY
// Modelos:   deepseek-chat (rápido/barato), deepseek-reasoner (R1, razonador).
// Caché:     DeepSeek cachea el PREFIJO del input automáticamente (context caching),
//            así que poner la rúbrica + perfil al principio abarata las llamadas
//            siguientes sin ningún parámetro extra.
import type { NormalizedJob, ProfileRow } from "./types.ts";

const DEEPSEEK_URL = "https://api.deepseek.com/chat/completions";
const MODEL_CHAT = "deepseek-chat";

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

async function deepseek(opts: {
  messages: ChatMessage[];
  max_tokens: number;
  temperature: number;
  json?: boolean;
}): Promise<string> {
  const apiKey = Deno.env.get("DEEPSEEK_API_KEY");
  if (!apiKey) throw new Error("Falta DEEPSEEK_API_KEY");

  const body: Record<string, unknown> = {
    model: MODEL_CHAT,
    messages: opts.messages,
    max_tokens: opts.max_tokens,
    temperature: opts.temperature,
    stream: false,
  };
  if (opts.json) body.response_format = { type: "json_object" };

  const res = await fetch(DEEPSEEK_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`DeepSeek ${res.status}: ${txt.slice(0, 300)}`);
  }
  const data = await res.json();
  return String(data?.choices?.[0]?.message?.content ?? "");
}

// ---------------------------------------------------------------------------
// Prefijo estable (rúbrica + few-shot + perfil) -> aprovecha el cache de DeepSeek.
// ---------------------------------------------------------------------------
const SCORING_RUBRIC = `
Sos un asistente experto en reclutamiento técnico. Tu tarea es evaluar qué tan
relevante es UNA oferta de trabajo para UN candidato, devolviendo un puntaje de
relevancia entero del 1 al 10 y una razón breve en español (máx. 25 palabras).

Criterios y peso aproximado:
- Coincidencia de rol/seniority con el perfil del candidato (40%).
- Coincidencia de tecnologías/keywords incluidas y ausencia de las excluidas (25%).
- Modalidad y ubicación: respeta la preferencia de remoto y la región del candidato (15%).
- Salario: si la oferta lo declara, qué tan bien cumple el mínimo del candidato (10%).
- Calidad/seriedad de la oferta y claridad de la descripción (10%).

Guía de puntajes:
- 9-10: encaje excelente, el candidato debería postular ya.
- 7-8: muy buen encaje, vale la pena revisar.
- 5-6: encaje parcial, depende del interés del candidato.
- 3-4: encaje débil, probablemente no.
- 1-2: irrelevante o claramente no apto (rol distinto, región excluyente, etc.).

Reglas:
- Sé estricto: la mayoría de las ofertas genéricas deberían caer en 4-6.
- Si la oferta es claramente de otro rubro o nivel, puntaje 1-3.
- Penalizá fuerte si aparece una keyword EXCLUIDA por el candidato.
- No inventes datos que no estén en la oferta.

Respondé en formato JSON, un único objeto, exactamente con esta forma:
{"score": <entero 1-10>, "reasons": "<razón breve en español>"}

Ejemplos:
Perfil: React, TypeScript, remoto, AR. Oferta: "Senior React Engineer (Remote, LATAM)".
-> {"score": 9, "reasons": "Rol senior React remoto abierto a LATAM, encaje casi perfecto."}

Perfil: React, TypeScript, remoto, AR. Oferta: "Contador Senior - Presencial Buenos Aires".
-> {"score": 1, "reasons": "Rol contable presencial, no coincide con perfil de desarrollo."}

Perfil: React, TypeScript, remoto, AR. Oferta: "Full Stack Developer (Node/React) - Remote US only".
-> {"score": 4, "reasons": "Stack coincide pero la oferta restringe a EE.UU., región no elegible."}
`.trim();

function profileBlock(profile: ProfileRow): string {
  return [
    "PERFIL DEL CANDIDATO:",
    `- Keywords incluidas (busca): ${profile.keywords_include.join(", ") || "(ninguna)"}`,
    `- Keywords excluidas (evita): ${profile.keywords_exclude.join(", ") || "(ninguna)"}`,
    `- Ubicaciones/aceptables: ${profile.locations.join(", ") || "(no especificado)"}`,
    `- Preferencia de modalidad: ${profile.remote_pref}`,
    `- Salario mínimo: ${profile.min_salary ?? "(no especificado)"}`,
    `- Seniority: ${profile.seniority ?? "(no especificado)"}`,
    "",
    "RESUMEN DE CV / EXPERIENCIA DEL CANDIDATO:",
    profile.cv_text?.slice(0, 4000) || "(no provisto)",
  ].join("\n");
}

function jobBlock(job: NormalizedJob): string {
  return [
    `Título: ${job.title}`,
    `Empresa: ${job.company ?? "(desconocida)"}`,
    `Ubicación: ${job.location ?? "(no especificada)"}`,
    `Remoto: ${job.remote === null ? "(desconocido)" : job.remote ? "sí" : "no"}`,
    `Región del candidato requerida: ${job.candidate_region ?? "(no especificada)"}`,
    `Salario: ${job.salary_min ?? "?"} - ${job.salary_max ?? "?"}`,
    `Tags: ${job.tags.join(", ") || "(ninguno)"}`,
    "",
    "Descripción:",
    (job.description ?? "(sin descripción)").slice(0, 3000),
  ].join("\n");
}

function extractScore(text: string): { score: number; reasons: string } {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return { score: 5, reasons: "no se pudo parsear la respuesta de la IA" };
  try {
    const obj = JSON.parse(m[0]);
    const score = Math.max(1, Math.min(10, Math.round(Number(obj.score))));
    return {
      score: Number.isFinite(score) ? score : 5,
      reasons: String(obj.reasons ?? "").slice(0, 280),
    };
  } catch {
    return { score: 5, reasons: "respuesta de IA inválida" };
  }
}

// Tier 2: puntúa una oferta con DeepSeek (JSON mode).
export async function scoreJob(
  profile: ProfileRow,
  job: NormalizedJob,
): Promise<{ score: number; reasons: string }> {
  const text = await deepseek({
    max_tokens: 200,
    temperature: 0.2,
    json: true,
    messages: [
      // Prefijo estable primero (rúbrica + perfil) -> cache automático de DeepSeek.
      { role: "system", content: `${SCORING_RUBRIC}\n\n${profileBlock(profile)}` },
      { role: "user", content: `Evaluá esta oferta y respondé en JSON:\n\n${jobBlock(job)}` },
    ],
  });
  return extractScore(text);
}

// Postulación asistida: redacta una carta de presentación adaptada (editable).
export async function draftCoverLetter(
  profile: ProfileRow,
  job: NormalizedJob,
): Promise<string> {
  const system =
    "Sos un coach de carrera. Redactás cartas de presentación en español, " +
    "concretas y personalizadas, en primera persona, tono profesional y cálido. " +
    "Entre 150 y 220 palabras. Conectá la experiencia real del candidato (de su CV) " +
    "con los requisitos de la oferta. No inventes experiencia que no esté en el CV. " +
    "No uses placeholders tipo [Nombre] salvo que falte el dato. Devolvé sólo la carta.";

  const user = [
    "OFERTA:",
    jobBlock(job),
    "",
    "CV / EXPERIENCIA DEL CANDIDATO:",
    profile.cv_text?.slice(0, 6000) || "(no provisto)",
    "",
    "Escribí la carta de presentación.",
  ].join("\n");

  return (
    await deepseek({
      max_tokens: 1200,
      temperature: 1.0,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    })
  ).trim();
}
