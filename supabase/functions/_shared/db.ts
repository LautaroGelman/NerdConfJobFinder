// Cliente Supabase con SERVICE ROLE (salta RLS). Sólo para uso server-side
// dentro de las Edge Functions. SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY los
// inyecta Supabase automáticamente en el runtime de las funciones.
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";

export function adminClient(): SupabaseClient {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) {
    throw new Error("Faltan SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY en el entorno");
  }
  return createClient(url, key, { auth: { persistSession: false } });
}
