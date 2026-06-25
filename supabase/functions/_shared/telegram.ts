// Helpers de la Bot API de Telegram (vía fetch). Sin dependencias.
import type { NormalizedJob } from "./types.ts";

function token(): string {
  const t = Deno.env.get("TELEGRAM_BOT_TOKEN");
  if (!t) throw new Error("Falta TELEGRAM_BOT_TOKEN");
  return t;
}

function api(method: string): string {
  return `https://api.telegram.org/bot${token()}/${method}`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export interface InlineKeyboard {
  inline_keyboard: Array<Array<Record<string, string>>>;
}

export async function sendMessage(
  chatId: number,
  text: string,
  replyMarkup?: InlineKeyboard,
): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(api("sendMessage"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
      reply_markup: replyMarkup,
    }),
  });
  if (!res.ok) {
    return { ok: false, error: `${res.status}: ${(await res.text()).slice(0, 200)}` };
  }
  return { ok: true };
}

export async function answerCallbackQuery(
  callbackQueryId: string,
  text?: string,
): Promise<void> {
  await fetch(api("answerCallbackQuery"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callback_query_id: callbackQueryId, text }),
  });
}

// Mensaje de alerta de match: título, empresa, puntaje, razón, botones.
// matchId va en el callback del botón "Redactar carta" (lo resuelve el webhook).
export function buildMatchMessage(
  job: NormalizedJob,
  score: number,
  reasons: string,
  matchId: string,
): { text: string; keyboard: InlineKeyboard } {
  const stars = "★".repeat(Math.round(score / 2)) + "☆".repeat(5 - Math.round(score / 2));
  const lines = [
    `💼 <b>${escapeHtml(job.title)}</b>`,
    job.company ? `🏢 ${escapeHtml(job.company)}` : "",
    job.location ? `📍 ${escapeHtml(job.location)}` : "",
    `⭐ Match: <b>${score}/10</b> ${stars}`,
    reasons ? `📝 ${escapeHtml(reasons)}` : "",
  ].filter(Boolean);
  return {
    text: lines.join("\n"),
    keyboard: {
      inline_keyboard: [
        [
          { text: "🔗 Ver oferta", url: job.url },
          { text: "✍️ Redactar carta", callback_data: `draft:${matchId}` },
        ],
      ],
    },
  };
}
