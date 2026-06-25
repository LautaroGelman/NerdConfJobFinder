"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { supabase, supabaseConfigured } from "@/lib/supabaseClient";
import type { MatchWithJob, Profile } from "@/lib/types";

const BOT_USERNAME = process.env.NEXT_PUBLIC_TELEGRAM_BOT_USERNAME ?? "";

const STORAGE_KEY = "job-agent-profile-id";

type FormState = {
  name: string;
  keywordsInclude: string;
  keywordsExclude: string;
  locations: string;
  remotePref: "any" | "remote" | "onsite";
  minSalary: string;
  seniority: string;
  cvText: string;
  threshold: number;
};

const emptyForm: FormState = {
  name: "Mi perfil",
  keywordsInclude: "",
  keywordsExclude: "",
  locations: "",
  remotePref: "any",
  minSalary: "",
  seniority: "",
  cvText: "",
  threshold: 6,
};

function csvToArray(s: string): string[] {
  return s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

function profileToForm(p: Profile): FormState {
  return {
    name: p.name,
    keywordsInclude: p.keywords_include.join(", "),
    keywordsExclude: p.keywords_exclude.join(", "),
    locations: p.locations.join(", "),
    remotePref: p.remote_pref,
    minSalary: p.min_salary ? String(p.min_salary) : "",
    seniority: p.seniority ?? "",
    cvText: p.cv_text,
    threshold: p.score_threshold,
  };
}

export default function Home() {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [matches, setMatches] = useState<MatchWithJob[]>([]);
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState<{ open: boolean; loading: boolean; title: string; letter: string }>(
    { open: false, loading: false, title: "", letter: "" },
  );
  const channelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);

  const loadMatches = useCallback(async (profileId: string) => {
    const { data } = await supabase
      .from("matches")
      .select("id, score, reasons, created_at, jobs(*)")
      .eq("profile_id", profileId)
      .order("created_at", { ascending: false })
      .limit(50);
    if (data) setMatches(data as unknown as MatchWithJob[]);
  }, []);

  const subscribe = useCallback(
    (profileId: string) => {
      if (channelRef.current) supabase.removeChannel(channelRef.current);
      const ch = supabase
        .channel(`matches-${profileId}`)
        .on(
          "postgres_changes",
          { event: "INSERT", schema: "public", table: "matches", filter: `profile_id=eq.${profileId}` },
          () => loadMatches(profileId),
        )
        .subscribe();
      channelRef.current = ch;
    },
    [loadMatches],
  );

  // Carga inicial: si hay un perfil guardado, lo traemos.
  useEffect(() => {
    if (!supabaseConfigured) return;
    const id = localStorage.getItem(STORAGE_KEY);
    if (!id) return;
    (async () => {
      const { data } = await supabase.from("profiles").select("*").eq("id", id).maybeSingle();
      if (data) {
        const p = data as Profile;
        setProfile(p);
        setForm(profileToForm(p));
        loadMatches(p.id);
        subscribe(p.id);
      } else {
        localStorage.removeItem(STORAGE_KEY);
      }
    })();
    return () => {
      if (channelRef.current) supabase.removeChannel(channelRef.current);
    };
  }, [loadMatches, subscribe]);

  async function saveProfile() {
    setSaving(true);
    const payload = {
      name: form.name || "Mi perfil",
      keywords_include: csvToArray(form.keywordsInclude),
      keywords_exclude: csvToArray(form.keywordsExclude),
      locations: csvToArray(form.locations),
      remote_pref: form.remotePref,
      min_salary: form.minSalary ? parseInt(form.minSalary, 10) : null,
      seniority: form.seniority || null,
      cv_text: form.cvText,
      score_threshold: form.threshold,
      updated_at: new Date().toISOString(),
    };

    if (profile) {
      const { data } = await supabase
        .from("profiles")
        .update(payload)
        .eq("id", profile.id)
        .select("*")
        .maybeSingle();
      if (data) setProfile(data as Profile);
    } else {
      const { data } = await supabase.from("profiles").insert(payload).select("*").maybeSingle();
      if (data) {
        const p = data as Profile;
        setProfile(p);
        localStorage.setItem(STORAGE_KEY, p.id);
        loadMatches(p.id);
        subscribe(p.id);
      }
    }
    setSaving(false);
  }

  async function makeDraft(match: MatchWithJob) {
    setDraft({ open: true, loading: true, title: match.jobs.title, letter: "" });
    const { data, error } = await supabase.functions.invoke("draft-cover-letter", {
      body: { matchId: match.id },
    });
    if (error) {
      setDraft((d) => ({ ...d, loading: false, letter: `Error: ${error.message}` }));
    } else {
      setDraft((d) => ({ ...d, loading: false, letter: (data as { coverLetter: string }).coverLetter }));
    }
  }

  const tgLinked = Boolean(profile?.telegram_chat_id);
  const deepLink =
    profile?.telegram_link_token && BOT_USERNAME
      ? `https://t.me/${BOT_USERNAME}?start=${profile.telegram_link_token}`
      : "";

  return (
    <div className="container">
      <div className="header">
        <div>
          <h1>🛰️ Agente de Ofertas</h1>
          <div className="sub">Cargá tu perfil y recibí al instante ofertas que matchean — en la web y por Telegram.</div>
        </div>
      </div>

      {!supabaseConfigured && (
        <div className="notice">
          Faltan las variables <code>NEXT_PUBLIC_SUPABASE_URL</code> y{" "}
          <code>NEXT_PUBLIC_SUPABASE_ANON_KEY</code>. Copiá <code>.env.example</code> a{" "}
          <code>.env.local</code> y completalas.
        </div>
      )}

      <div className="grid">
        {/* ----------------- Columna izquierda: perfil ----------------- */}
        <div className="panel">
          <h2>Tu perfil</h2>

          <label>Nombre</label>
          <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />

          <label>Keywords que buscás (separadas por coma)</label>
          <input
            placeholder="react, typescript, node, remoto"
            value={form.keywordsInclude}
            onChange={(e) => setForm({ ...form, keywordsInclude: e.target.value })}
          />

          <label>Keywords que querés evitar</label>
          <input
            placeholder="php, senior manager, presencial"
            value={form.keywordsExclude}
            onChange={(e) => setForm({ ...form, keywordsExclude: e.target.value })}
          />

          <label>Ubicaciones aceptables</label>
          <input
            placeholder="Argentina, LATAM, Remote"
            value={form.locations}
            onChange={(e) => setForm({ ...form, locations: e.target.value })}
          />

          <div className="row">
            <div>
              <label>Modalidad</label>
              <select
                value={form.remotePref}
                onChange={(e) => setForm({ ...form, remotePref: e.target.value as FormState["remotePref"] })}
              >
                <option value="any">Cualquiera</option>
                <option value="remote">Sólo remoto</option>
                <option value="onsite">Presencial</option>
              </select>
            </div>
            <div>
              <label>Salario mínimo (USD)</label>
              <input
                inputMode="numeric"
                placeholder="opcional"
                value={form.minSalary}
                onChange={(e) => setForm({ ...form, minSalary: e.target.value })}
              />
            </div>
          </div>

          <label>Seniority</label>
          <input
            placeholder="junior / semi / senior"
            value={form.seniority}
            onChange={(e) => setForm({ ...form, seniority: e.target.value })}
          />

          <label>Umbral de match (1-10): {form.threshold}</label>
          <input
            type="range"
            min={1}
            max={10}
            value={form.threshold}
            onChange={(e) => setForm({ ...form, threshold: parseInt(e.target.value, 10) })}
          />

          <label>Tu CV / experiencia (pegá el texto)</label>
          <textarea
            placeholder="Resumen de tu experiencia, stack, logros..."
            value={form.cvText}
            onChange={(e) => setForm({ ...form, cvText: e.target.value })}
          />

          <div className="btn-row">
            <button onClick={saveProfile} disabled={saving || !supabaseConfigured}>
              {saving ? "Guardando..." : profile ? "Actualizar perfil" : "Crear perfil"}
            </button>
          </div>

          {/* ----------------- Conectar Telegram ----------------- */}
          {profile && (
            <div className="tg-box">
              <strong>📲 Telegram</strong>{" "}
              {tgLinked ? <span className="pill ok">conectado</span> : <span className="pill">sin conectar</span>}
              <div style={{ marginTop: 8 }}>
                {!BOT_USERNAME ? (
                  <span className="muted">
                    Configurá <code>NEXT_PUBLIC_TELEGRAM_BOT_USERNAME</code> para mostrar el link.
                  </span>
                ) : tgLinked ? (
                  <span className="muted">Vas a recibir las alertas en tu chat de Telegram.</span>
                ) : (
                  <>
                    <a href={deepLink} target="_blank" rel="noreferrer">
                      <button className="secondary" style={{ width: "100%" }}>
                        Conectar mi Telegram
                      </button>
                    </a>
                    <div className="muted" style={{ marginTop: 6 }}>
                      Abrí el link, tocá <em>Iniciar</em> en el bot y volvé. (Refrescá para ver el estado.)
                    </div>
                  </>
                )}
              </div>
            </div>
          )}
        </div>

        {/* ----------------- Columna derecha: feed en vivo ----------------- */}
        <div>
          <div className="feed-head">
            <h2 style={{ margin: 0 }}>
              <span className="live-dot" /> Ofertas en vivo
            </h2>
            <span className="muted">{matches.length} matches</span>
          </div>

          {!profile ? (
            <div className="empty">Creá tu perfil para empezar a recibir ofertas.</div>
          ) : matches.length === 0 ? (
            <div className="empty">
              Todavía no hay matches. El agente está pooleando ofertas cada ~2 min — las que superen tu umbral
              aparecen acá automáticamente.
            </div>
          ) : (
            matches.map((m) => (
              <div className="match" key={m.id}>
                <div className="title">{m.jobs.title}</div>
                <div className="meta">
                  {[m.jobs.company, m.jobs.location, m.jobs.source_name].filter(Boolean).join(" · ")}
                </div>
                <div>
                  <span className="score">⭐ {m.score}/10</span>
                </div>
                {m.reasons && <div className="reasons">{m.reasons}</div>}
                <div className="match-actions">
                  <a href={m.jobs.url} target="_blank" rel="noreferrer">
                    <button className="secondary">🔗 Ver oferta</button>
                  </a>
                  <button onClick={() => makeDraft(m)}>✍️ Redactar carta</button>
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {/* ----------------- Modal de carta ----------------- */}
      {draft.open && (
        <div className="modal-backdrop" onClick={() => setDraft({ ...draft, open: false })}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>✍️ Carta para: {draft.title}</h2>
            {draft.loading ? (
              <div className="muted">Generando con DeepSeek...</div>
            ) : (
              <>
                <textarea
                  value={draft.letter}
                  onChange={(e) => setDraft({ ...draft, letter: e.target.value })}
                />
                <div className="muted" style={{ marginTop: 6 }}>
                  Revisá y editá. La postulación final la hacés vos en el sitio de la oferta.
                </div>
              </>
            )}
            <div className="btn-row">
              <button
                className="secondary"
                onClick={() => navigator.clipboard.writeText(draft.letter)}
                disabled={draft.loading}
              >
                Copiar
              </button>
              <button onClick={() => setDraft({ ...draft, open: false })}>Cerrar</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
