/* Obstgarten – Web-Version: Supabase-Anbindung und Anmeldung.
   Stellt die gleiche Schnittstelle bereit wie der claude.ai-Datenspeicher (claude.use("db") / claude.use("user")). */
(function(){
"use strict";
const SUPABASE_URL = "https://geurcsvzxfqrzirobngz.supabase.co";
const SUPABASE_KEY = "sb_publishable_joz98vTnth83tg8Ux-65Sw_LiD8q46J";
const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {auth:{persistSession:true, autoRefreshToken:true}});

let session = null, member = null, members = {};
const listeners = {};          // collection -> Set(callback)
const cache = {};              // collection -> Map(id -> {data, updated_at})
const loaded = {};             // collection -> Promise
let channel = null;
const ready = {};
ready.promise = new Promise(r => ready.resolve = r);

const randomId = () => { const c = "abcdefghijklmnopqrstuvwxyz0123456789"; let s = ""; const a = crypto.getRandomValues(new Uint8Array(20)); for(const x of a) s += c[x % c.length]; return s; };
const withCreator = (d, by) => ({...(d || {}), _creator: by || null});
const mapErr = e => { const code = e && (e.code === "42501" || /row-level security|permission/i.test(e.message||"")) ? "invalid_argument" : "unavailable"; return {code, message: (e && e.message) || "Fehler"}; };

function snapshotFor(coll, opts){
  let rows = [...(cache[coll] || new Map()).entries()].map(([id, v]) => ({id, data: v.data, at: v.updated_at}));
  if(opts && opts.order){ const f = opts.order.field, dir = opts.order.dir === "desc" ? -1 : 1; rows.sort((a,b) => String(a.data[f]||a.at).localeCompare(String(b.data[f]||b.at)) * dir); }
  if(opts && opts.limit) rows = rows.slice(0, opts.limit);
  return {docs: rows.map(r => ({id: r.id, data: () => r.data})), metadata: {fromCache:false}};
}
function notify(coll){ (listeners[coll] || new Set()).forEach(fn => { try{ fn(); }catch(_){} }); }
async function load(coll){
  if(!loaded[coll]) loaded[coll] = (async () => {
    let q = sb.from("og_docs").select("id,data,updated_at,created_by").eq("collection", coll);
    if(coll === "protokoll") q = q.order("updated_at", {ascending:false}).limit(300);
    const {data, error} = await q;
    if(error){ delete loaded[coll]; throw mapErr(error); }
    cache[coll] = new Map(data.map(r => [r.id, {data: withCreator(r.data, r.created_by), updated_at: r.updated_at}]));
  })();
  return loaded[coll];
}
function startRealtime(){
  if(channel) return;
  channel = sb.channel("og_docs_changes")
    .on("postgres_changes", {event:"*", schema:"public", table:"og_docs"}, p => {
      const row = p.new && p.new.collection ? p.new : p.old;
      if(!row || !row.collection) return;
      const m = cache[row.collection] || (cache[row.collection] = new Map());
      if(p.eventType === "DELETE") m.delete(row.id); else m.set(row.id, {data: withCreator(p.new.data, p.new.created_by), updated_at: p.new.updated_at});
      notify(row.collection);
    })
    .on("postgres_changes", {event:"*", schema:"public", table:"og_members"}, () => loadMembers())
    .subscribe();
}
function subscribe(coll, opts, cb, err){
  (listeners[coll] ||= new Set());
  const fn = () => cb(snapshotFor(coll, opts));
  listeners[coll].add(fn);
  load(coll).then(fn, e => err && err(e));
  return () => listeners[coll].delete(fn);
}
function docRef(coll, id){
  id = id || randomId();
  return {
    id,
    async set(data){
      const {_creator, ...clean} = data || {};
      const {data: rows, error} = await sb.from("og_docs").upsert({collection: coll, id, data: clean}, {onConflict:"collection,id"}).select("data,updated_at,created_by");
      if(error) throw mapErr(error);
      const r = rows && rows[0];
      (cache[coll] ||= new Map()).set(id, {data: r ? withCreator(r.data, r.created_by) : data, updated_at: r ? r.updated_at : new Date().toISOString()});
      notify(coll);
    },
    async delete(){
      const {error} = await sb.from("og_docs").delete().eq("collection", coll).eq("id", id);
      if(error) throw mapErr(error);
      if(cache[coll]) cache[coll].delete(id); notify(coll);
    },
    onSnapshot(cb, err){
      const fn = () => { const v = cache[coll] && cache[coll].get(id); cb({exists: !!v, id, data: () => v ? v.data : undefined}); };
      (listeners[coll] ||= new Set()).add(fn);
      load(coll).then(fn, e => err && err(e));
      return () => listeners[coll].delete(fn);
    }
  };
}
function collection(coll){
  const q = opts => ({
    orderBy(field, dir){ return q({...opts, order:{field, dir}}); },
    limit(n){ return q({...opts, limit:n}); },
    onSnapshot(cb, err){ return subscribe(coll, opts, cb, err); }
  });
  return Object.assign(q({}), {doc: id => docRef(coll, id)});
}
const dbApi = {collection, doc(path){ const [c, id] = path.split("/"); return docRef(c, id); }};

/* ---------- Rollen & Rechte ---------- */
const BEREICHE = [["plan","Plan & Bäume"],["pflege","Pflege"],["ertrag","Ertrag"],["wein","Apfelwein"],["einstellungen","Einstellungen"]];
const STUFEN = [["none","kein Zugriff"],["read","lesen"],["write","schreiben"]];
const ROLLEN = {
  owner:      {label:"Verwaltung", text:"alles, auch Personen und Rechte"},
  bearbeiten: {label:"Bearbeiten", text:"alles eintragen und ändern, Einstellungen nur lesen"},
  erfassen:   {label:"Erfassen",   text:"Ernte, Erzeugnisse und Apfelwein eintragen, sonst lesen"},
  lesen:      {label:"Lesen",      text:"alles ansehen, nichts ändern"}
};
const TEMPLATES = {
  owner:      {bereiche:{plan:"write",pflege:"write",ertrag:"write",wein:"write",einstellungen:"write"}, grundstuecke:{"*":"write"}},
  bearbeiten: {bereiche:{plan:"write",pflege:"write",ertrag:"write",wein:"write",einstellungen:"read"},  grundstuecke:{"*":"write"}},
  erfassen:   {bereiche:{plan:"read",pflege:"read",ertrag:"write",wein:"write",einstellungen:"read"},    grundstuecke:{"*":"write"}},
  lesen:      {bereiche:{plan:"read",pflege:"read",ertrag:"read",wein:"read",einstellungen:"read"},      grundstuecke:{"*":"read"}}
};
const LVL = {none:0, read:1, write:2};
const rechteOf = m => !m ? null : m.role === "owner" ? TEMPLATES.owner : (m.rechte || TEMPLATES[m.role] || TEMPLATES.lesen);
const grundOf = (r, f) => { const g = (r && r.grundstuecke) || {}; return g[f] || g["*"] || "none"; };
window.OG_PERM = {
  get owner(){ return !!member && member.role === "owner"; },
  lvl(b){ const r = rechteOf(member); return r ? (LVL[r.bereiche[b]] || 0) : 0; },
  grund(f){ return LVL[grundOf(rechteOf(member), f || "*")] || 0; },
  anyWrite(){ const r = rechteOf(member); return !!r && Object.values(r.bereiche).includes("write"); }
};
let myRightsKey = null;
async function loadMembers(){
  const {data} = await sb.from("og_members").select("user_id,name,role,rechte");
  members = Object.fromEntries((data||[]).map(m => [m.user_id, m]));
  if(session) member = members[session.user.id] || member;
  // eigene Rechte geändert → neu laden, damit sichtbare Daten stimmen
  const key = member ? member.role + JSON.stringify(member.rechte) : "";
  if(myRightsKey !== null && key !== myRightsKey && ready.done){ location.reload(); return; }
  myRightsKey = key;
  if(window.OG_APP){ OG_APP.refreshPeople(); OG_APP.render(); }
}
const COLORS = ["#2f6b3a","#8a5a2b","#3b5f8f","#8f3b5f","#5f3b8f","#3b8f86","#a0662b","#6b7a2f"];
const colorFor = id => { let h = 0; for(const ch of String(id)) h = (h*31 + ch.charCodeAt(0)) >>> 0; return COLORS[h % COLORS.length]; };
const userApi = {
  async id(){ return session ? session.user.id : null; },
  async can(name){ if(name === "data.write") return OG_PERM.anyWrite(); const [b, l] = String(name).split("."); return OG_PERM.lvl(b) >= (l === "write" ? 2 : 1); },
  async isOwner(){ return !!member && member.role === "owner"; },
  async canEdit(){ return OG_PERM.anyWrite(); },
  async me(){ return {id: session && session.user.id, name: member ? member.name : "", avatarUrl:"", color: colorFor(session && session.user.id), email: session && session.user.email, isOwner: !!member && member.role==="owner", canEdit: OG_PERM.anyWrite()}; },
  async profiles(ids){ ids = [].concat(ids); return Object.fromEntries(ids.map(id => [id, {id, name: (members[id] && members[id].name) || "", avatarUrl:"", color: colorFor(id), email:null, isMe: !!session && id === session.user.id, guest:false}])); },
  async search(){ return []; }
};

window.claude = {use: async name => { await ready.promise; return name === "db" ? dbApi : name === "user" ? userApi : null; }};

/* ---------- Personen-Verwaltung in den Einstellungen ---------- */
const rolePill = m => `<span class="pill ${m.role === "owner" ? "ok" : m.role === "lesen" ? "" : "soon"}">${ROLLEN[m.role] ? ROLLEN[m.role].label : m.role}${m.role !== "owner" && m.rechte ? " · angepasst" : ""}</span>`;
function flaechen(){ try{ return (window.OG_APP && OG_APP.flaechen && OG_APP.flaechen()) || []; }catch(_){ return []; } }
function matrixHTML(m, esc){
  const r = rechteOf(m), uid = esc(m.user_id);
  const sel = (key, val) => `<select data-ogr="${esc(key)}" aria-label="${esc(key)}">${STUFEN.map(([v,l]) => `<option value="${v}" ${v === val ? "selected" : ""}>${l}</option>`).join("")}</select>`;
  const row = (label, key, val) => `<div class="field"><label>${esc(label)}</label>${sel(key, val)}</div>`;
  return `<form class="form ogrights" data-oguser="${uid}" style="border-top:1px solid var(--line);padding-top:10px;margin-top:6px">
    <div class="field full"><label>Rolle (Vorlage)</label><select data-ogrole>${["bearbeiten","erfassen","lesen"].map(k => `<option value="${k}" ${k === m.role ? "selected" : ""}>${ROLLEN[k].label} – ${ROLLEN[k].text}</option>`).join("")}</select></div>
    <p class="hint full" style="margin:0"><b>Bereiche</b></p>
    ${BEREICHE.map(([k, l]) => row(l, "b:" + k, r.bereiche[k] || "none")).join("")}
    <p class="hint full" style="margin:0"><b>Grundstücke</b> (gilt für Bäume, Pflege und Ertrag je Baum)</p>
    ${flaechen().map(f => row(f.name || f.id, "g:" + f.id, grundOf(r, f.id))).join("")}
    ${row("Neu angelegte Grundstücke", "g:*", grundOf(r, "*"))}
    <p class="hint full" style="margin:0">Mit Schreibrecht darf die Person Neues eintragen. Ändern oder löschen kann sie nur, was sie selbst eingetragen hat.</p>
    <div class="full row" style="gap:8px"><button class="btn primary small" type="submit">Rechte speichern</button><button class="btn small" type="button" data-ogreset="${uid}">Auf Vorlage zurücksetzen</button><span class="spacer"></span><button class="btn small danger" data-ogremove="${uid}" type="button">Person entfernen</button></div>
  </form>`;
}
function myRightsHTML(esc){
  const r = rechteOf(member); if(!r || member.role === "owner") return "";
  const t = {none:"–", read:"lesen", write:"schreiben"};
  return `<div class="tip" style="text-align:left"><b>Deine Rechte:</b> ${BEREICHE.map(([k,l]) => `${esc(l)}: ${t[r.bereiche[k]||"none"]}`).join(" · ")}<br>Grundstücke: ${flaechen().map(f => `${esc(f.name||f.id)}: ${t[grundOf(r, f.id)]}`).join(" · ")}<br><span class="hint">Ändern und löschen kannst du nur, was du selbst eingetragen hast.</span></div>`;
}
window.OG_HOST = {
  speicherText: "Die Daten liegen in der Supabase-Datenbank und sind auf jedem Gerät verfügbar, auf dem du dich anmeldest.",
  personenHTML({esc}){
    const isOwner = member && member.role === "owner";
    const order = {owner:0, bearbeiten:1, erfassen:2, lesen:3};
    const list = Object.values(members).sort((a,b) => (order[a.role] ?? 9) - (order[b.role] ?? 9) || a.name.localeCompare(b.name));
    return `<div class="card"><span class="eyebrow">Personen &amp; Rechte</span>
      <div class="list" style="border:0">${list.map(m => {
        const head = `<span style="display:inline-flex;gap:8px;align-items:center;color:var(--ink)"><span class="av av0" style="width:26px;height:26px;background:${colorFor(m.user_id)};color:#fff;border-color:transparent">${esc((m.name||"?").trim()[0]||"?").toUpperCase()}</span>${esc(m.name || "Ohne Namen")}${m.user_id === session.user.id ? " (du)" : ""} ${rolePill(m)}</span>`;
        if(isOwner && m.role !== "owner") return `<details class="ogperson" style="padding:6px 0"><summary class="who" style="cursor:pointer;list-style:none;justify-content:space-between">${head}<span class="hint">Rechte ›</span></summary>${matrixHTML(m, esc)}</details>`;
        return `<div class="who" style="padding:6px 0">${head}</div>`;
      }).join("")}</div>
      ${myRightsHTML(esc)}
      <details><summary class="hint" style="cursor:pointer">Was bedeuten die Rollen?</summary><dl class="kv">${Object.values(ROLLEN).map(r => `<dt>${r.label}</dt><dd>${r.text}</dd>`).join("")}</dl>
        <p class="hint" style="margin:0">Die Rolle ist eine Vorlage. Die Verwaltung kann danach für jede Person einzelne Bereiche und Grundstücke anpassen (kein Zugriff, lesen, schreiben). Ändern und löschen darf jede Person nur ihre eigenen Einträge; die Verwaltung darf alles.</p></details>
      <form class="form" id="ogNameForm"><div class="field"><label for="og_myname">Dein Anzeigename</label><input id="og_myname" value="${esc(member ? member.name : "")}"></div><div class="field" style="justify-content:flex-end"><button class="btn" type="submit">Namen speichern</button></div></form>
      ${isOwner ? `<form class="form" id="ogInviteForm" style="border-top:1px solid var(--line);padding-top:12px">
        <p class="full" style="margin:0"><b>Person einladen</b></p>
        <p class="hint full" style="margin:0">Die Person bekommt eine E-Mail mit einem Link, legt darüber ihr Passwort fest und ist sofort mit der gewählten Rolle freigeschaltet. Hat sie sich schon selbst registriert, wird sie direkt freigeschaltet.</p>
        <div class="field"><label for="og_email">E-Mail</label><input id="og_email" type="email" autocomplete="off" required></div>
        <div class="field"><label for="og_newname">Name</label><input id="og_newname" placeholder="Vorname"></div>
        <div class="field full"><label for="og_newrole">Rolle</label><select id="og_newrole">${["lesen","erfassen","bearbeiten"].map(k => `<option value="${k}">${ROLLEN[k].label} – ${ROLLEN[k].text}</option>`).join("")}</select></div>
        <div class="full"><button class="btn primary" type="submit">Einladung senden</button></div></form>` : ""}
      <div class="row"><span class="hint">Angemeldet als ${esc(session.user.email)}</span><span class="spacer"></span><button class="btn small" data-oglogout type="button">Abmelden</button></div>
    </div>`;
  },
  async onClick(el, d){
    if(el.hasAttribute("data-oglogout")){ await sb.auth.signOut(); location.reload(); return true; }
    if(d.ogremove){
      if(el.dataset.armed !== "1"){ el.dataset.armed = "1"; el.textContent = "Wirklich entfernen?"; return true; }
      const {data, error} = await sb.rpc("og_remove_member", {p_user: d.ogremove});
      window.OG_FRESH = true; OG_APP.toast(error || data !== "ok" ? "Entfernen fehlgeschlagen." : "Person entfernt"); await loadMembers(); OG_APP.closeSheet(); return true;
    }
    if(d.ogreset){
      const f = el.closest("form"), role = f.querySelector("[data-ogrole]").value;
      const {data, error} = await sb.rpc("og_set_member", {p_user: d.ogreset, p_role: role, p_rechte: null});
      window.OG_FRESH = true; OG_APP.toast(error || data !== "ok" ? "Speichern fehlgeschlagen." : `Rechte auf Vorlage „${ROLLEN[role].label}“ gesetzt`); await loadMembers(); OG_APP.closeSheet(); return true;
    }
    return false;
  }
};
// Rollenwechsel im Editor: Matrix auf die Vorlage setzen
document.addEventListener("change", e => {
  if(!e.target.matches || !e.target.matches("[data-ogrole]")) return;
  const t = TEMPLATES[e.target.value], f = e.target.closest("form");
  f.querySelectorAll("[data-ogr]").forEach(s => { const [kind, key] = s.dataset.ogr.split(/:(.*)/s); s.value = kind === "b" ? (t.bereiche[key] || "none") : grundOf(t, key); });
}, true);
document.addEventListener("submit", async e => {
  if(e.target.classList && e.target.classList.contains("ogrights")){
    e.preventDefault(); e.stopImmediatePropagation();
    const f = e.target, role = f.querySelector("[data-ogrole]").value, t = TEMPLATES[role];
    const r = {bereiche:{}, grundstuecke:{}};
    f.querySelectorAll("[data-ogr]").forEach(s => { const [kind, key] = s.dataset.ogr.split(/:(.*)/s); (kind === "b" ? r.bereiche : r.grundstuecke)[key] = s.value; });
    const same = BEREICHE.every(([k]) => r.bereiche[k] === t.bereiche[k]) && Object.entries(r.grundstuecke).every(([k, v]) => v === grundOf(t, k));
    const {data, error} = await sb.rpc("og_set_member", {p_user: f.dataset.oguser, p_role: role, p_rechte: same ? null : r});
    window.OG_FRESH = true; OG_APP.toast(error || data !== "ok" ? "Speichern fehlgeschlagen." : "Rechte gespeichert"); await loadMembers(); OG_APP.closeSheet(); return;
  }
  if(e.target.id === "ogInviteForm"){
    e.preventDefault(); e.stopImmediatePropagation();
    const btn = e.target.querySelector("button[type=submit]"); btn.disabled = true; btn.textContent = "Wird gesendet …";
    const {data, error} = await sb.functions.invoke("og-invite", {body: {email: document.getElementById("og_email").value, name: document.getElementById("og_newname").value, role: document.getElementById("og_newrole").value}});
    let msg;
    if(error){ msg = "Einladung fehlgeschlagen."; try{ msg = (await error.context.json()).error || msg; }catch(_){} }
    else msg = data.status === "invited" ? "Einladung verschickt" : data.status === "existing" ? "Person war schon registriert und ist jetzt freigeschaltet" : "Das bist du selbst";
    OG_APP.toast(msg); btn.disabled = false; btn.textContent = "Einladung senden";
    if(!error){ e.target.reset(); await loadMembers(); }
  }
  if(e.target.id === "ogNameForm"){
    e.preventDefault(); e.stopImmediatePropagation();
    const name = document.getElementById("og_myname").value.trim();
    if(!name){ OG_APP.toast("Bitte einen Namen eingeben."); return; }
    const {error} = await sb.from("og_members").update({name}).eq("user_id", session.user.id);
    OG_APP.toast(error ? "Speichern fehlgeschlagen." : "Name gespeichert"); await loadMembers();
  }
}, true);

/* ---------- Anmeldung ---------- */
const gate = document.getElementById("gate");
function showGate(html){ gate.innerHTML = html; gate.hidden = false; }
function loginHTML(mode, msg){
  const reg = mode === "register";
  return `<div class="gatecard">
    <div class="gatelogo">${document.getElementById("gateLogo").innerHTML}</div>
    <h1>Obstgarten</h1>
    <p class="hint">${reg ? "Neues Konto anlegen. Danach muss dich die Verwaltung in der App freischalten." : "Melde dich mit deiner E-Mail-Adresse an."}</p>
    ${msg ? `<div class="tip">${msg}</div>` : ""}
    <form id="loginForm" class="form" data-mode="${mode}">
      ${reg ? `<div class="field full"><label for="l_name">Dein Name</label><input id="l_name" autocomplete="name" required></div>` : ""}
      <div class="field full"><label for="l_mail">E-Mail</label><input id="l_mail" type="email" autocomplete="email" required></div>
      <div class="field full"><label for="l_pw">Passwort</label><input id="l_pw" type="password" autocomplete="${reg ? "new-password" : "current-password"}" minlength="6" required></div>
      <div class="full"><button class="btn primary" type="submit" style="width:100%">${reg ? "Registrieren" : "Anmelden"}</button></div>
    </form>
    <button class="linkbtn" id="toggleMode" type="button">${reg ? "Ich habe schon ein Konto" : "Noch kein Konto? Registrieren"}</button>
    ${reg ? "" : `<button class="linkbtn" id="forgotPw" type="button" style="font-size:.9rem">Passwort vergessen?</button>`}
  </div>`;
}
function waitingHTML(){
  return `<div class="gatecard">
    <div class="gatelogo">${document.getElementById("gateLogo").innerHTML}</div>
    <h1>Fast geschafft</h1>
    <p>Du bist als <b>${session.user.email.replace(/[<>&"]/g, "")}</b> angemeldet, aber noch nicht freigeschaltet.</p>
    <p class="hint">Bitte die Verwaltung, dich in der App unter ⚙︎ → Personen mit dieser E-Mail-Adresse freizuschalten. Danach diese Seite neu laden.</p>
    <div class="row" style="justify-content:center;gap:10px"><button class="btn primary" id="recheck" type="button">Erneut prüfen</button><button class="btn" id="logout2" type="button">Abmelden</button></div>
  </div>`;
}
gate.addEventListener("click", async e => {
  const b = e.target.closest("button"); if(!b) return;
  if(b.id === "toggleMode"){ const f = gate.querySelector("#loginForm"); showGate(loginHTML(f.dataset.mode === "register" ? "login" : "register")); }
  if(b.id === "forgotPw"){
    const mail = gate.querySelector("#l_mail").value.trim();
    if(!mail){ showGate(loginHTML("login", "Bitte zuerst deine E-Mail-Adresse eintragen.")); return; }
    await sb.auth.resetPasswordForEmail(mail, {redirectTo: location.origin + location.pathname});
    showGate(loginHTML("login", "Falls ein Konto existiert, ist eine E-Mail zum Zurücksetzen unterwegs."));
  }
  if(b.id === "logout2"){ await sb.auth.signOut(); showGate(loginHTML("login")); }
  if(b.id === "recheck"){ await afterLogin(); }
});
gate.addEventListener("submit", async e => {
  const f = e.target; if(f.id !== "loginForm") return;
  e.preventDefault();
  const mode = f.dataset.mode;
  const mail = gate.querySelector("#l_mail").value.trim(), pw = gate.querySelector("#l_pw").value;
  const btn = f.querySelector("button[type=submit]"); btn.disabled = true;
  if(mode === "register"){
    const name = gate.querySelector("#l_name").value.trim();
    const {data, error} = await sb.auth.signUp({email: mail, password: pw, options:{data:{name}, emailRedirectTo: location.origin + location.pathname}});
    btn.disabled = false;
    if(error){ showGate(loginHTML("register", error.message.includes("registered") ? "Diese E-Mail ist schon registriert. Bitte anmelden." : "Registrierung fehlgeschlagen: " + error.message.replace(/[<>&"]/g, ""))); return; }
    if(!data.session){ showGate(loginHTML("login", "Fast fertig: Bitte bestätige deine E-Mail-Adresse über den Link in der Mail, die du gerade bekommen hast. Danach hier anmelden.")); return; }
    session = data.session; await afterLogin();
  } else {
    const {data, error} = await sb.auth.signInWithPassword({email: mail, password: pw});
    btn.disabled = false;
    if(error){ showGate(loginHTML("login", /confirm/i.test(error.message) ? "Bitte bestätige zuerst deine E-Mail-Adresse über den Link in der Mail." : "Anmeldung fehlgeschlagen. E-Mail oder Passwort stimmen nicht.")); return; }
    session = data.session; await afterLogin();
  }
});
function setPasswordHTML(msg){
  return `<div class="gatecard">
    <div class="gatelogo">${document.getElementById("gateLogo").innerHTML}</div>
    <h1>Willkommen!</h1>
    <p class="hint">Du wurdest zum Obstgarten eingeladen. Lege jetzt dein Passwort fest – damit meldest du dich künftig mit ${session.user.email.replace(/[<>&"]/g, "")} an.</p>
    ${msg ? `<div class="tip">${msg}</div>` : ""}
    <form id="invitePwForm" class="form"><div class="field full"><label for="ip1">Passwort</label><input id="ip1" type="password" minlength="6" required autocomplete="new-password"></div>
      <div class="field full"><label for="ip2">Passwort wiederholen</label><input id="ip2" type="password" minlength="6" required autocomplete="new-password"></div>
      <div class="full"><button class="btn primary" type="submit" style="width:100%">Passwort speichern</button></div></form>
  </div>`;
}
gate.addEventListener("submit", async e => {
  if(e.target.id !== "invitePwForm") return;
  e.preventDefault(); e.stopImmediatePropagation();
  const a = gate.querySelector("#ip1").value, b = gate.querySelector("#ip2").value;
  if(a !== b){ showGate(setPasswordHTML("Die beiden Passwörter stimmen nicht überein.")); return; }
  const {data, error} = await sb.auth.updateUser({password: a, data: {og_pw_pending: false}});
  if(error){ showGate(setPasswordHTML("Speichern fehlgeschlagen: " + error.message.replace(/[<>&"]/g, ""))); return; }
  if(data && data.user) session = {...session, user: data.user};
  history.replaceState(null, "", location.pathname);
  await afterLogin();
}, true);
async function afterLogin(){
  if(session.user.user_metadata && session.user.user_metadata.og_pw_pending){ showGate(setPasswordHTML()); return; }
  await loadMembers();
  member = members[session.user.id] || null;
  if(!member){ showGate(waitingHTML()); return; }
  gate.hidden = true; gate.innerHTML = "";
  startRealtime();
  ready.done = true;
  ready.resolve();
}
(async () => {
  const {data} = await sb.auth.getSession();
  session = data.session;
  if(session) await afterLogin(); else showGate(loginHTML("login"));
  sb.auth.onAuthStateChange((ev, s) => {
    if(ev === "PASSWORD_RECOVERY"){
      showGate(`<div class="gatecard"><h1>Neues Passwort</h1><form id="newPwForm" class="form"><div class="field full"><label for="np">Neues Passwort</label><input id="np" type="password" minlength="6" required autocomplete="new-password"></div><div class="full"><button class="btn primary" type="submit">Speichern</button></div></form></div>`);
      gate.querySelector("#newPwForm").addEventListener("submit", async e => { e.preventDefault(); e.stopPropagation(); const {error} = await sb.auth.updateUser({password: gate.querySelector("#np").value}); if(!error){ location.hash = ""; location.reload(); } }, {once:true});
    }
    if(ev === "SIGNED_OUT"){ session = null; }
    if(s) session = s;
  });
})();
})();
