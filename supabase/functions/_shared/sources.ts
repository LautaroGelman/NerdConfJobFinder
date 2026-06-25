// Adaptadores de fuentes de ofertas. Cada fuente -> NormalizedJob[].
// Todas son endpoints SIN auth. Usan fetch condicional (ETag/If-Modified-Since).
import { XMLParser } from "npm:fast-xml-parser@4";
import type { FetchResult, NormalizedJob, SourceRow } from "./types.ts";
import { stripHtml } from "./normalize.ts";

const UA = "job-agent/0.1 (+https://github.com/) hackathon";

async function conditionalFetch(
  url: string,
  etag: string | null,
  lastModified: string | null,
): Promise<{ status: number; body: string; etag: string | null; lastModified: string | null }> {
  const headers: Record<string, string> = { "User-Agent": UA, Accept: "*/*" };
  if (etag) headers["If-None-Match"] = etag;
  if (lastModified) headers["If-Modified-Since"] = lastModified;

  const res = await fetch(url, { headers });
  const newEtag = res.headers.get("etag");
  const newLM = res.headers.get("last-modified");
  if (res.status === 304) {
    return { status: 304, body: "", etag: newEtag ?? etag, lastModified: newLM ?? lastModified };
  }
  const body = await res.text();
  return { status: res.status, body, etag: newEtag, lastModified: newLM };
}

const xml = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });

function asArray<T>(v: T | T[] | undefined | null): T[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

function num(v: unknown): number | null {
  const n = typeof v === "string" ? parseInt(v.replace(/[^\d]/g, ""), 10) : Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// ---------- RSS (WeWorkRemotely, Hacker News whoishiring, etc.) ----------
function parseRss(body: string): NormalizedJob[] {
  const doc = xml.parse(body);
  const items = asArray(doc?.rss?.channel?.item ?? doc?.feed?.entry);
  return items.map((it: Record<string, unknown>): NormalizedJob => {
    const title = String(it.title ?? "").trim();
    const link =
      typeof it.link === "string"
        ? it.link
        : (it.link as Record<string, string> | undefined)?.["@_href"] ?? "";
    const guid =
      typeof it.guid === "string"
        ? it.guid
        : (it.guid as Record<string, string> | undefined)?.["#text"] ?? link ?? title;
    const desc = stripHtml(String(it.description ?? it.summary ?? ""));
    const pub = it.pubDate ?? it.published ?? it.updated;
    // WeWorkRemotely titula "Company: Role" -> separamos si se puede.
    let company: string | null = null;
    let role = title;
    const m = title.match(/^(.*?):\s*(.+)$/);
    if (m) {
      company = m[1].trim();
      role = m[2].trim();
    }
    return {
      external_id: String(guid),
      title: role,
      company,
      location: null,
      remote: /remote/i.test(title + " " + desc) ? true : null,
      candidate_region: null,
      url: String(link),
      description: desc.slice(0, 4000),
      tags: [],
      salary_min: null,
      salary_max: null,
      posted_at: pub ? new Date(String(pub)).toISOString() : null,
      raw: it,
    };
  });
}

// ---------- Get on Board (JSON:API) ----------
function parseGetonbrd(body: string): NormalizedJob[] {
  const doc = JSON.parse(body);
  const data = asArray(doc?.data);
  return data.map((d: Record<string, any>): NormalizedJob => {
    const a = d.attributes ?? {};
    const id = String(d.id ?? a.hashid ?? a.id ?? a.slug ?? crypto.randomUUID());
    const url =
      a.url ?? a.apply_url ?? d.links?.self ?? `https://www.getonbrd.com/jobs/${id}`;
    const remote =
      typeof a.remote === "boolean"
        ? a.remote
        : a.remote_modality
          ? /remote|hybrid/i.test(String(a.remote_modality))
          : null;
    return {
      external_id: id,
      title: String(a.title ?? "").trim(),
      company: a.company?.data?.attributes?.name ?? a.company_name ?? null,
      location: a.country ?? a.city ?? null,
      remote,
      candidate_region: a.remote_modality ?? null,
      url: String(url),
      description: stripHtml(a.description ?? a.functions ?? "").slice(0, 4000),
      tags: asArray(a.tags).map((t: any) => String(t)).slice(0, 10),
      salary_min: num(a.min_salary),
      salary_max: num(a.max_salary),
      posted_at: a.published_at ? new Date(String(a.published_at)).toISOString() : null,
      raw: d,
    };
  });
}

// ---------- Remotive ----------
function parseRemotive(body: string): NormalizedJob[] {
  const doc = JSON.parse(body);
  return asArray(doc?.jobs).map((j: Record<string, any>): NormalizedJob => ({
    external_id: String(j.id),
    title: String(j.title ?? "").trim(),
    company: j.company_name ?? null,
    location: j.candidate_required_location ?? null,
    remote: true,
    candidate_region: j.candidate_required_location ?? null,
    url: String(j.url),
    description: stripHtml(j.description ?? "").slice(0, 4000),
    tags: asArray(j.tags).map((t: any) => String(t)).slice(0, 10),
    salary_min: null,
    salary_max: null,
    posted_at: j.publication_date ? new Date(String(j.publication_date)).toISOString() : null,
    raw: j,
  }));
}

// ---------- ATS (Greenhouse / Lever / Ashby) ----------
function parseAts(body: string, provider: string): NormalizedJob[] {
  if (provider === "greenhouse") {
    const doc = JSON.parse(body);
    return asArray(doc?.jobs).map((j: Record<string, any>): NormalizedJob => ({
      external_id: String(j.id),
      title: String(j.title ?? "").trim(),
      company: j.company_name ?? null,
      location: j.location?.name ?? null,
      remote: /remote/i.test(j.location?.name ?? ""),
      candidate_region: j.location?.name ?? null,
      url: String(j.absolute_url),
      description: stripHtml(j.content ?? "").slice(0, 4000),
      tags: [],
      salary_min: null,
      salary_max: null,
      posted_at: j.updated_at ? new Date(String(j.updated_at)).toISOString() : null,
      raw: j,
    }));
  }
  if (provider === "lever") {
    const arr = JSON.parse(body);
    return asArray(arr).map((j: Record<string, any>): NormalizedJob => ({
      external_id: String(j.id),
      title: String(j.text ?? "").trim(),
      company: null,
      location: j.categories?.location ?? null,
      remote: /remote/i.test(j.categories?.location ?? ""),
      candidate_region: j.categories?.location ?? null,
      url: String(j.hostedUrl ?? j.applyUrl),
      description: stripHtml(j.descriptionPlain ?? j.description ?? "").slice(0, 4000),
      tags: [j.categories?.team, j.categories?.commitment].filter(Boolean) as string[],
      salary_min: null,
      salary_max: null,
      posted_at: j.createdAt ? new Date(j.createdAt).toISOString() : null,
      raw: j,
    }));
  }
  if (provider === "ashby") {
    const doc = JSON.parse(body);
    return asArray(doc?.jobs).map((j: Record<string, any>): NormalizedJob => ({
      external_id: String(j.id),
      title: String(j.title ?? "").trim(),
      company: null,
      location: j.location ?? null,
      remote: Boolean(j.isRemote),
      candidate_region: j.location ?? null,
      url: String(j.jobUrl ?? j.applyUrl),
      description: stripHtml(j.descriptionPlain ?? j.descriptionHtml ?? "").slice(0, 4000),
      tags: [j.employmentType, j.team].filter(Boolean) as string[],
      salary_min: null,
      salary_max: null,
      posted_at: j.publishedAt ? new Date(String(j.publishedAt)).toISOString() : null,
      raw: j,
    }));
  }
  return [];
}

// URL final a poolear según la fuente (ATS arma la URL desde config).
function buildUrl(source: SourceRow): string {
  if (source.type !== "ats") return source.base_url;
  const cfg = source.config as Record<string, string>;
  if (cfg.provider === "greenhouse") {
    return `${source.base_url}/v1/boards/${cfg.board_token}/jobs?content=true`;
  }
  if (cfg.provider === "lever") {
    return `${source.base_url}/v0/postings/${cfg.company}?mode=json`;
  }
  if (cfg.provider === "ashby") {
    return `${source.base_url}/posting-api/job-board/${cfg.name}`;
  }
  return source.base_url;
}

// Punto de entrada único: poolea una fuente y devuelve ofertas normalizadas.
export async function fetchSource(source: SourceRow): Promise<FetchResult> {
  const url = buildUrl(source);
  const r = await conditionalFetch(url, source.etag, source.last_modified);
  if (r.status === 304) {
    return { status: 304, jobs: [], etag: r.etag, lastModified: r.lastModified };
  }
  if (r.status >= 400) {
    throw new Error(`Fuente ${source.name} respondió ${r.status}`);
  }

  let jobs: NormalizedJob[] = [];
  if (source.type === "rss") {
    jobs = parseRss(r.body);
  } else if (source.name === "getonbrd") {
    jobs = parseGetonbrd(r.body);
  } else if (source.name === "remotive") {
    jobs = parseRemotive(r.body);
  } else if (source.type === "ats") {
    jobs = parseAts(r.body, String((source.config as Record<string, string>).provider));
  } else {
    // Fallback genérico para otras APIs JSON tipo Remotive.
    jobs = parseRemotive(r.body);
  }

  // Defensa: descartar items sin título o sin URL.
  jobs = jobs.filter((j) => j.title && j.url);
  return { status: r.status, jobs, etag: r.etag, lastModified: r.lastModified };
}
