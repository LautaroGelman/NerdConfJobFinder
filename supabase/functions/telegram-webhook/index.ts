// Edge Function `telegram-webhook` — recibe updates del bot.
//  - "/start <token>"  -> vincula el chat con el perfil (telegram_chat_id).
//  - botón "Redactar carta" (callback draft:<matchId>) -> genera carta con DeepSeek.
//
// verify_jwt = false (ver config.toml): Telegram no manda JWT de Supabase.
// En su lugar verificamos el header secreto X-Telegram-Bot-Api-Secret-Token.
import { adminClient } from "../_shared/db.ts";
import { draftCoverLetter } from "../_shared/llm.ts";
import { answerCallbackQuery, sendMessage } from "../_shared/telegram.ts";
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

// Telegram limita los mensajes a ~4096 chars; partimos si hace falta.
async function sendLong(chatId: number, text: string): Promise<void> {
  const chunks = text.match(/[\s\S]{1,3500}/g) ?? [text];
  for (const c of chunks) await sendMessage(chatId, c);
}

Deno.serve(async (req) => {
  // Verificación del secreto del webhook.
  const expected = Deno.env.get("TELEGRAM_WEBHOOK_SECRET");
  const got = req.headers.get("x-telegram-bot-api-secret-token");
  if (expected && got !== expected) {
    return new Response("forbidden", { status: 403 });
  }

  let update: any;
  try {
    update = await req.json();
  } catch {
    return new Response("bad request", { status: 400 });
  }

  const supabase = adminClient();

  try {
    // --- /start <token>: vincular chat con perfil ---
    if (update.message?.text) {
      const text: string = update.message.text.trim();
      const chatId: number = update.message.chat.id;

      if (text.startsWith("/start")) {
        const parts = text.split(/\s+/);
        const linkToken = parts[1];
        if (linkToken) {
          const { data: prof } = await supabase
            .from("profiles")
            .update({ telegram_chat_id: chatId, updated_at: new Date().toISOString() })
            .eq("telegram_link_token", linkToken)
            .select("name")
            .maybeSingle();
          if (prof) {
            await sendMessage(
              chatId,
              `✅ ¡Listo, <b>${prof.name}</b>! Tu perfil quedó vinculado. ` +
                `Te voy a avisar acá apenas aparezca una oferta que matchee. 🚀`,
            );
          } else {
            await sendMessage(chatId, "⚠️ Código inválido o vencido. Volvé a generar el link desde la web.");
          }
        } else {
          await sendMessage(
            chatId,
            "👋 Soy tu agente de ofertas. Vinculá tu perfil desde la web con el botón \"Conectar Telegram\".",
          );
        }
      }
      return new Response("ok");
    }

    // --- callback de botones ---
    if (update.callback_query) {
      const cq = update.callback_query;
      const data: string = cq.data ?? "";
      const chatId: number = cq.message?.chat?.id;

      if (data.startsWith("draft:")) {
        const matchId = data.slice("draft:".length);
        await answerCallbackQuery(cq.id, "✍️ Redactando carta...");

        const { data: match } = await supabase
          .from("matches")
          .select("id, job_id, profile_id, jobs(*), profiles(*)")
          .eq("id", matchId)
          .maybeSingle();

        if (!match) {
          await sendMessage(chatId, "No encontré esa oferta. Puede que haya expirado.");
          return new Response("ok");
        }

        const job = rowToJob((match as any).jobs);
        const profile = (match as any).profiles as ProfileRow;

        const letter = await draftCoverLetter(profile, job);

        // Guardar como draft (postulación asistida).
        await supabase.from("applications").upsert(
          {
            job_id: (match as any).job_id,
            profile_id: (match as any).profile_id,
            status: "draft",
            cover_letter: letter,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "job_id,profile_id" },
        );

        await sendMessage(
          chatId,
          `✍️ <b>Borrador de carta</b> para <b>${job.title}</b>\n` +
            `(revisala, editá lo que quieras y postulá vos 👇)`,
        );
        await sendLong(chatId, letter);
      } else {
        await answerCallbackQuery(cq.id);
      }
      return new Response("ok");
    }
  } catch (e) {
    console.error("webhook error", e);
    // Respondemos 200 igual para que Telegram no reintente en loop.
  }

  return new Response("ok");
});
