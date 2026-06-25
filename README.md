# 🛰️ Agente de Ofertas de Trabajo

Agente de automatización que **poolea ofertas de trabajo continuamente**, las **matchea con IA (DeepSeek)** contra el perfil que cargás en la web, y te avisa **al instante** — en un **feed web en vivo** y por **Telegram**. Además **asiste la postulación**: genera una carta de presentación adaptada que revisás y enviás vos.

> Proyecto de hackathon: rápido de montar, funcional en la web y **gratis** (Supabase free + Vercel free + DeepSeek pago por uso, centavos).

---

## 🧱 Arquitectura

Todo el backend vive **dentro de Supabase** (serverless, sin nada prendido). El front es Next.js en Vercel.

```
   [Navegador] ──(Supabase Realtime: feed en vivo)──┐
   [Next.js / Vercel: perfil + feed + carta]         │
            │ supabase-js                             ▼
            ▼                              ┌────────────────────────┐
   ┌────────────────────┐  cron */2 min   │  Edge Function `poll`  │
   │ Supabase Postgres  │◄────────────────┤  fetch fuentes (no-auth)│
   │ sources jobs       │                 │  → dedup → Tier1 filtro │
   │ profiles matches   │                 │  → Tier2 DeepSeek score │
   │ applications seen  │                 │  → INSERT match         │
   │ notifications      │                 │  → Realtime + Telegram  │
   │ (Realtime ON en    │                 └────────────────────────┘
   │  matches)          │   ┌────────────────────────┐
   └────────────────────┘   │ `telegram-webhook`     │  /start <token> vincula chat
            ▲                │ + botón Redactar carta │
            │ Bot API        └────────────────────────┘
   [Bot de Telegram]        ┌────────────────────────┐
                            │ `draft-cover-letter`    │  carta con DeepSeek (desde la web)
                            └────────────────────────┘
```

- **IA:** DeepSeek (`deepseek-chat`). Scoring de relevancia (1-10 + razón) y redacción de cartas.
- **Postulación:** **asistida** (vos hacés el clic final). No hay auto-submit ni automatización de LinkedIn (riesgo de baneo/spam).
- **Fuentes (sin auth):** Get on Board, WeWorkRemotely (RSS), Hacker News "Who is hiring" (RSS), Remotive, y ATS (Greenhouse/Lever/Ashby) cuando cargás board tokens.

---

## ✅ Requisitos

- Node.js 18+ y npm
- Cuenta en [Supabase](https://supabase.com) (free)
- Cuenta en [DeepSeek](https://platform.deepseek.com) con saldo (la API key)
- Un bot de Telegram (lo crea **@BotFather**)
- (Opcional para deploy) Cuenta en [Vercel](https://vercel.com)

---

## 🚀 Setup paso a paso

### 1) Crear el proyecto en Supabase
1. Entrá a supabase.com → **New project**. Anotá la **password** de la base.
2. En **Project Settings → API** copiá:
   - **Project URL** → `https://<PROJECT_REF>.supabase.co`
   - **anon public** key (para el front)
   - **service_role** key (secreta, para el cron)

### 2) Conseguir las API keys
- **DeepSeek:** platform.deepseek.com → **API Keys** → creá una. (Necesita saldo.)
- **Telegram:** en Telegram, hablá con **@BotFather** → `/newbot` → te da el **token**. Guardá también el **username** del bot (termina en `bot`).
- **Webhook secret:** inventá un string aleatorio (ej. salida de `openssl rand -hex 16`). Lo usamos para que sólo Telegram pueda llamar a la función.

### 3) Front local
```bash
npm install
cp .env.example .env.local
# Editá .env.local con NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY
# y NEXT_PUBLIC_TELEGRAM_BOT_USERNAME (el username del bot, sin @)
npm run dev      # http://localhost:3000
```

### 4) Base de datos + Edge Functions (Supabase CLI)
> No hace falta instalar nada global: se usa vía `npx supabase`.

```bash
# Login y link al proyecto
npx supabase login
npx supabase link --project-ref <PROJECT_REF>

# Crear el esquema (tablas, RLS, Realtime en matches)
npx supabase db push

# Cargar los secretos de las funciones
npx supabase secrets set \
  DEEPSEEK_API_KEY=sk-xxxxx \
  TELEGRAM_BOT_TOKEN=123456:ABC... \
  TELEGRAM_WEBHOOK_SECRET=tu-string-aleatorio

# Deployar las 3 funciones (config.toml ya define verify_jwt por función)
npx supabase functions deploy poll
npx supabase functions deploy telegram-webhook
npx supabase functions deploy draft-cover-letter
```

### 5) Conectar el webhook de Telegram
Esto le dice a Telegram que mande los updates a tu función (y exige el secret):
```bash
curl "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook" \
  -d "url=https://<PROJECT_REF>.supabase.co/functions/v1/telegram-webhook" \
  -d "secret_token=<TELEGRAM_WEBHOOK_SECRET>"
```
Verificá con: `curl "https://api.telegram.org/bot<TOKEN>/getWebhookInfo"`

### 6) Programar el cron del worker `poll`
Abrí **SQL Editor** en Supabase y ejecutá `supabase/cron.sql` (reemplazando `<PROJECT_REF>` y `<SERVICE_ROLE_KEY>`).
También podés hacerlo desde el dashboard: **Integrations → Cron → Create job**, apuntando a la función `poll` con schedule `*/2 * * * *`.

---

## 🧪 Probar (verificación end-to-end)

1. Abrí `http://localhost:3000`, completá el perfil (ej. keywords `react, typescript`, modalidad `remoto`, pegá un CV) y **Crear perfil**.
2. Tocá **Conectar mi Telegram** → se abre el bot con el deep-link → tocá **Iniciar** → debería llegar un mensaje de bienvenida. (Refrescá la web para ver "conectado".)
3. Dispará un poll a mano (o esperá al cron):
   ```bash
   curl -X POST "https://<PROJECT_REF>.supabase.co/functions/v1/poll" \
     -H "Authorization: Bearer <SERVICE_ROLE_KEY>"
   ```
   Devuelve un resumen `{ sources, jobs, scored, matches, notified, errors }`.
4. Las ofertas que superen tu **umbral** aparecen **solas en el feed web** (sin refrescar, vía Realtime) y **llegan por Telegram** con puntaje + razón + link.
5. Tocá **✍️ Redactar carta** (en la web o en Telegram) → DeepSeek genera una carta editable, guardada como `draft`. **No se envía nada automáticamente.**
6. Corré el poll dos veces seguidas: **no** deberían llegar duplicados (gate `seen`).

> Logs de las funciones: `npx supabase functions logs poll` (o en el dashboard → Edge Functions → Logs).

---

## ☁️ Deploy del front a Vercel
1. Subí el repo a GitHub.
2. En Vercel → **New Project** → importá el repo.
3. Cargá las env vars: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `NEXT_PUBLIC_TELEGRAM_BOT_USERNAME`.
4. Deploy. (El backend ya corre en Supabase; Vercel sólo sirve el front.)

---

## ⚙️ Fuentes de ofertas

Las fuentes viven en la tabla `sources` (se cargan con la migración). Para agregar **ATS** reales,
editá las filas `greenhouse-example` / `lever-example` con tokens reales y `enabled = true`:

```sql
update sources set enabled = true,
  config = '{"provider":"greenhouse","board_token":"<TOKEN_DE_LA_EMPRESA>"}'
where name = 'greenhouse-example';
```
- Greenhouse: el token está en `https://boards.greenhouse.io/<TOKEN>`.
- Lever: `config = {"provider":"lever","company":"<COMPANY>"}` (de `jobs.lever.co/<COMPANY>`).
- Ashby: `config = {"provider":"ashby","name":"<NAME>"}` (de `jobs.ashbyhq.com/<NAME>`).

---

## 💸 Costos y límites
- **Supabase free:** alcanza para el demo. El proyecto se **pausa tras ~1 semana** de inactividad (reactivalo antes de mostrarlo).
- **DeepSeek:** pago por uso, muy barato; sólo se llama a la IA sobre las ofertas que pasan el filtro Tier 1, con tope de `MAX_SCORES_PER_RUN` por corrida (en `poll/index.ts`).
- **"Instantáneo"** real en Get on Board / RSS / Hacker News / ATS. Remotive y agregadores tienen cupos chicos → poll más espaciado.

## 🔐 Seguridad
- Los secretos (`DEEPSEEK_API_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `service_role`) van en **secrets de Supabase**, nunca en el repo ni en el front.
- El front sólo usa la **anon key** (pública). El cron usa la **service_role** desde el SQL del cron.
- RLS está activado. Las políticas del demo son permisivas (1 usuario). Para multiusuario real, cambialas por políticas basadas en `auth.uid()` con Supabase Auth.

## 🛣️ Próximos pasos (stretch)
- Más fuentes (ATS curados, Jooble/Careerjet para cobertura AR indirecta).
- Dedup fuzzy cross-source (misma oferta en varios portales → 1 sola alerta).
- Autofill del formulario ATS (Greenhouse/Lever/Ashby) con clic humano obligatorio.
- Multiusuario con Supabase Auth + RLS por usuario.
- Resumen diario por email.
