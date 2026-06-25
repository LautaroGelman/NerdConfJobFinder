// Normalización de texto y hash de contenido para dedup.

export function normalizeText(s: string | null | undefined): string {
  return (s ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "") // saca acentos (diacríticos combinantes)
    .replace(/\s+/g, " ")
    .trim();
}

// SHA-256 de title+company+location normalizado -> dedup exacto cross-source.
export async function contentHash(
  parts: (string | null | undefined)[],
): Promise<string> {
  const text = parts.map(normalizeText).join("|");
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// Clave fuzzy aproximada (empresa + primeros tokens del título) para agrupar.
export function fuzzyKey(title: string, company: string | null): string {
  const t = normalizeText(title).split(" ").slice(0, 4).join(" ");
  return `${normalizeText(company)}::${t}`;
}

// Saca tags HTML de descripciones (RSS/ATS suelen venir en HTML).
export function stripHtml(html: string | null | undefined): string {
  if (!html) return "";
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}
