// Obstgarten – Personen verwalten (nur Verwaltung).
// action "invite" (Standard): Supabase-Einladung per E-Mail, Eintrag in og_members mit Rolle;
//   ist die E-Mail schon registriert, wird die Person direkt freigeschaltet.
// action "create": Person mit echter E-Mail und Startpasswort anlegen (keine Mail); bei der ersten Anmeldung muss sie ein eigenes Passwort setzen.
// action "test": Testperson ohne echte E-Mail anlegen (Fantasie-Adresse, sofort bestätigt, Passwort von der Verwaltung).
// action "deletetest": Testperson samt Konto löschen (nur Konten mit Test-Merker).
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
  const action = String(body.action || "invite");

  if (action === "create") {
    const email = String(body.email || "").trim().toLowerCase();
    const name = String(body.name || "").trim().slice(0, 60) || email.split("@")[0];
    const password = String(body.password || "");
    const role = ROLES.includes(body.role) ? body.role : "lesen";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: "Bitte eine gültige E-Mail-Adresse angeben." }, 400);
    if (password.length < 6) return json({ error: "Das Startpasswort braucht mindestens 6 Zeichen." }, 400);
    const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { name, og_pw_pending: true } });
    if (error || !data.user) {
      const exists = /already|exists|registered/i.test(error?.message || "") || (error as any)?.code === "email_exists";
      if (!exists) return json({ error: "Anlegen fehlgeschlagen: " + (error?.message || "unbekannt") }, 400);
      // Konto gibt es schon → nur freischalten, Passwort bleibt unverändert
      let uid: string | null = null;
      for (let page = 1; page <= 20 && !uid; page++) {
        const { data: lu, error: le } = await admin.auth.admin.listUsers({ page, perPage: 200 });
        if (le || !lu.users.length) break;
        uid = lu.users.find((u) => (u.email || "").toLowerCase() === email)?.id || null;
      }
      if (!uid) return json({ error: "Konto zu dieser E-Mail nicht gefunden." }, 400);
      const { data: ex } = await admin.from("og_members").select("role").eq("user_id", uid).maybeSingle();
      if (ex?.role === "owner") return json({ status: "owner", user_id: uid });
      const { error: e3 } = await admin.from("og_members").upsert({ user_id: uid, name, role, rechte: null }, { onConflict: "user_id" });
      if (e3) return json({ error: "Freischalten fehlgeschlagen: " + e3.message }, 400);
      // Konto wartet noch auf sein erstes Passwort (z. B. Einladung nie abgeschlossen) → Startpasswort setzen
      const { data: gu } = await admin.auth.admin.getUserById(uid);
      if (gu?.user?.user_metadata?.og_pw_pending) {
        const { error: e4 } = await admin.auth.admin.updateUserById(uid, { password, email_confirm: true });
        if (e4) return json({ error: "Startpasswort setzen fehlgeschlagen: " + e4.message }, 400);
        return json({ status: "created", email, user_id: uid });
      }
      return json({ status: "existing", email, user_id: uid });
    }
    const { error: e2 } = await admin.from("og_members").insert({ user_id: data.user.id, name, role });
    if (e2) { await admin.auth.admin.deleteUser(data.user.id); return json({ error: "Anlegen fehlgeschlagen: " + e2.message }, 400); }
    return json({ status: "created", email, user_id: data.user.id });
  }

  if (action === "test") {
    const name = String(body.name || "").trim().slice(0, 40);
    const password = String(body.password || "");
    const role = ROLES.includes(body.role) ? body.role : "lesen";
    if (!name) return json({ error: "Bitte einen Namen angeben." }, 400);
    if (password.length < 6) return json({ error: "Das Passwort braucht mindestens 6 Zeichen." }, 400);
    const slug = name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "").slice(0, 16) || "person";
    const email = `test-${slug}-${crypto.randomUUID().slice(0, 4)}@example.com`;
    const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { name, og_test: true } });
    if (error || !data.user) return json({ error: "Anlegen fehlgeschlagen: " + (error?.message || "unbekannt") }, 400);
    const { error: e2 } = await admin.from("og_members").insert({ user_id: data.user.id, name: name + " (Test)", role, test: true, test_login: email });
    if (e2) { await admin.auth.admin.deleteUser(data.user.id); return json({ error: "Anlegen fehlgeschlagen: " + e2.message }, 400); }
    return json({ status: "test", email, user_id: data.user.id });
  }

  if (action === "deletetest") {
    const uid = String(body.user_id || "");
    const { data: m } = await admin.from("og_members").select("test").eq("user_id", uid).maybeSingle();
    const { data: u } = await admin.auth.admin.getUserById(uid);
    if (!m?.test || !u?.user?.user_metadata?.og_test) return json({ error: "Nur Testpersonen können so gelöscht werden." }, 400);
    const { error } = await admin.auth.admin.deleteUser(uid);
    if (error) return json({ error: "Löschen fehlgeschlagen: " + error.message }, 400);
    await admin.from("og_members").delete().eq("user_id", uid);
    return json({ status: "deleted" });
  }

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
  if (existing?.role === "owner") return json({ status: "owner", user_id: uid });
  const { error } = await admin.from("og_members").upsert({ user_id: uid, name, role, rechte: null }, { onConflict: "user_id" });
  if (error) return json({ error: "Freischalten fehlgeschlagen: " + error.message }, 400);
  return json({ status, user_id: uid });
});
