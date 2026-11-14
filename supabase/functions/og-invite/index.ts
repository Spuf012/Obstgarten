// Obstgarten – Person per E-Mail einladen (nur Verwaltung).
// Schickt eine Supabase-Einladung und trägt die Person mit der gewählten Rolle in og_members ein.
// Ist die E-Mail schon registriert, wird die Person direkt freigeschaltet.
import { createClient } from "npm:@supabase/supabase-js@2";

const APP_URL = "https://spuf012.github.io/Obstgarten/";
const ROLES = ["bearbeiten", "erfassen", "lesen"];
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Nur POST" }, 405);
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Aufrufer prüfen: angemeldet und Verwaltung
  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  const { data: caller } = await admin.auth.getUser(token);
  if (!caller?.user) return json({ error: "Bitte anmelden." }, 401);
  const { data: me } = await admin.from("og_members").select("role").eq("user_id", caller.user.id).maybeSingle();
  if (me?.role !== "owner") return json({ error: "Nur die Verwaltung kann Personen einladen." }, 403);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "Ungültige Anfrage." }, 400); }
  const email = String(body.email || "").trim().toLowerCase();
  const name = String(body.name || "").trim().slice(0, 60) || email.split("@")[0];
  const role = ROLES.includes(body.role) ? body.role : "lesen";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: "Bitte eine gültige E-Mail-Adresse angeben." }, 400);

  let uid: string | null = null, status = "invited";
  const inv = await admin.auth.admin.inviteUserByEmail(email, { redirectTo: APP_URL, data: { name, og_pw_pending: true } });
  if (inv.error) {
    // schon registriert → direkt freischalten
    if (!/already|exists|registered/i.test(inv.error.message || "") && (inv.error as any).code !== "email_exists") {
      return json({ error: "Einladung fehlgeschlagen: " + inv.error.message }, 400);
    }
    for (let page = 1; page <= 20 && !uid; page++) {
      const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
      if (error || !data.users.length) break;
      uid = data.users.find((u) => (u.email || "").toLowerCase() === email)?.id || null;
    }
    if (!uid) return json({ error: "Konto zu dieser E-Mail nicht gefunden." }, 400);
    status = "existing";
  } else {
    uid = inv.data.user.id;
  }

  const { data: existing } = await admin.from("og_members").select("role").eq("user_id", uid).maybeSingle();
  if (existing?.role === "owner") return json({ status: "owner" });
  const { error } = await admin.from("og_members").upsert({ user_id: uid, name, role, rechte: null }, { onConflict: "user_id" });
  if (error) return json({ error: "Freischalten fehlgeschlagen: " + error.message }, 400);
  return json({ status });
});
