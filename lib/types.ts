// Tipos del front (espejo de las tablas que usa la UI).

export interface Profile {
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

export interface Job {
  id: string;
  source_name: string;
  title: string;
  company: string | null;
  location: string | null;
  remote: boolean | null;
  url: string;
  description: string | null;
  tags: string[];
  posted_at: string | null;
}

export interface MatchWithJob {
  id: string;
  score: number;
  reasons: string | null;
  created_at: string;
  jobs: Job;
}
