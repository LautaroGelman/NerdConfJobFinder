// Tipos compartidos entre las Edge Functions (Deno).

export interface SourceRow {
  id: string;
  name: string;
  type: "api" | "rss" | "ats";
  base_url: string;
  config: Record<string, unknown>;
  etag: string | null;
  last_modified: string | null;
  last_polled_at: string | null;
  poll_interval_sec: number;
  enabled: boolean;
}

export interface ProfileRow {
  id: string;
  name: string;
  keywords_include: string[];
  keywords_exclude: string[];
  locations: string[];
  remote_pref: "any" | "remote" | "onsite";
  min_salary: number | null;
  seniority: string | null;
  cv_text: string;
  score_threshold: number;
  telegram_chat_id: number | null;
  telegram_link_token: string | null;
}

// Oferta ya normalizada (forma común a todas las fuentes).
export interface NormalizedJob {
  external_id: string;
  title: string;
  company: string | null;
  location: string | null;
  remote: boolean | null;
  candidate_region: string | null;
  url: string;
  description: string | null;
  tags: string[];
  salary_min: number | null;
  salary_max: number | null;
  posted_at: string | null; // ISO 8601
  raw: unknown;
}

export interface FetchResult {
  status: number;
  jobs: NormalizedJob[];
  etag: string | null;
  lastModified: string | null;
}
