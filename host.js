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

// „Ansicht als …“ (nur Verwaltung): zeigt die App mit den Rechten einer Person/Rolle, speichert nichts
let preview = null;   // {label, member:{user_id, role, rechte}}
const effMember = () => preview ? preview.member : member;
function previewSees(coll, d){
  if(!preview) return true;
  if(coll === "trees") return OG_PERM.grund(d && d.flaeche, "sehen");
  if(coll === "verarbeitung") return OG_PERM.can("ertrag", "sehen");
  if(coll === "keller") return OG_PERM.can("wein", "sehen");
  return true;
}
const PREVIEW_ERR = {code: "invalid_argument", message: "Vorschau – es wird nichts gespeichert"};
function snapshotFor(coll, opts){
  let rows = [...(cache[coll] || new Map()).entries()].map(([id, v]) => ({id, data: v.data, at: v.updated_at})).filter(r => previewSees(coll, r.data));
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
      if(preview) throw PREVIEW_ERR;
      const {_creator, ...clean} = data || {};
      const {data: rows, error} = await sb.from("og_docs").upsert({collection: coll, id, data: clean}, {onConflict:"collection,id"}).select("data,updated_at,created_by");
      if(error) throw mapErr(error);
      const r = rows && rows[0];
      (cache[coll] ||= new Map()).set(id, {data: r ? withCreator(r.data, r.created_by) : data, updated_at: r ? r.updated_at : new Date().toISOString()});
      notify(coll);
    },
    async delete(){
      if(preview) throw PREVIEW_ERR;
      const {error} = await sb.from("og_docs").delete().eq("collection", coll).eq("id", id);
      if(error) throw mapErr(error);
      if(cache[coll]) cache[coll].delete(id); notify(coll);
    },
    onSnapshot(cb, err){
      const fn = () => { const v = cache[coll] && cache[coll].get(id); const ok = !!v && previewSees(coll, v.data); cb({exists: ok, id, data: () => ok ? v.data : undefined}); };
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
const AKTIONEN = [["sehen","Sehen"],["anlegen","Anlegen"],["aendern","Ändern"],["loeschen","Löschen"]];
const NUR_SEHEN_AENDERN = {einstellungen: true};
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
// Wert je Bereich/Grundstück: {sehen,anlegen,aendern,loeschen} oder (Vorlage) "none" | "read" | "write"
function act(v, a){
  if(typeof v === "string") return v === "write" || (v === "read" && a === "sehen");
  if(v && typeof v === "object") return !!v[a] || (a === "sehen" && Object.values(v).some(Boolean));
  return false;
}
const normRecht = (v, nurSA) => { const o = {}; AKTIONEN.forEach(([a]) => o[a] = act(v, a) && !(nurSA && (a === "anlegen" || a === "loeschen"))); if(o.anlegen || o.aendern || o.loeschen) o.sehen = true; return o; };
const rechteOf = m => !m ? null : m.role === "owner" ? TEMPLATES.owner : (m.rechte || TEMPLATES[m.role] || TEMPLATES.lesen);
const grundOf = (r, f) => { const g = (r && r.grundstuecke) || {}; return g[f] !== undefined ? g[f] : g["*"]; };
window.OG_PERM = {
  get owner(){ return !preview && !!member && member.role === "owner"; },
  get uid(){ return preview ? preview.member.user_id : (session ? session.user.id : null); },
  get preview(){ return preview ? preview.label : null; },
  can(b, a){ const r = rechteOf(effMember()); return !!r && act(r.bereiche[b], a); },
  grund(f, a){ return act(grundOf(rechteOf(effMember()), f || "*"), a); },
  anyWrite(){ const r = rechteOf(effMember()); return !!r && Object.values(r.bereiche).some(v => ["anlegen","aendern","loeschen"].some(a => act(v, a))); }
};
let myRightsKey = null;
async function loadMembers(){
  const {data} = await sb.from("og_members").select("user_id,name,role,rechte,test,test_login");
  members = Object.fromEntries((data||[]).map(m => [m.user_id, m]));
  if(session) member = members[session.user.id] || member;
  if(preview && preview.member.user_id && members[preview.member.user_id]) preview.member = members[preview.member.user_id];
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
  async can(name){ if(name === "data.write") return OG_PERM.anyWrite(); const [b, a] = String(name).split("."); return OG_PERM.can(b, a === "write" ? "anlegen" : a || "sehen"); },
  async isOwner(){ return !!member && member.role === "owner"; },
  async canEdit(){ return OG_PERM.anyWrite(); },
  async me(){ return {id: session && session.user.id, name: member ? member.name : "", avatarUrl:"", color: colorFor(session && session.user.id), email: session && session.user.email, isOwner: !!member && member.role==="owner", canEdit: OG_PERM.anyWrite()}; },
  async profiles(ids){ ids = [].concat(ids); return Object.fromEntries(ids.map(id => [id, {id, name: (members[id] && members[id].name) || "", avatarUrl:"", color: colorFor(id), email:null, isMe: !!session && id === session.user.id, guest:false}])); },
  async search(){ return []; }
};

window.claude = {use: async name => { await ready.promise; return name === "db" ? dbApi : name === "user" ? userApi : null; }};

/* ---------- Personen-Verwaltung in den Einstellungen ---------- */
const testPill = m => m.test ? ` <span class="pill">Test</span>` : "";
const rolePill = m => `<span class="pill ${m.role === "owner" ? "ok" : m.role === "lesen" ? "" : "soon"}">${ROLLEN[m.role] ? ROLLEN[m.role].label : m.role}${m.role !== "owner" && m.rechte ? " · angepasst" : ""}</span>`;
function flaechen(){ try{ return (window.OG_APP && OG_APP.flaechen && OG_APP.flaechen()) || []; }catch(_){ return []; } }
const MATRIX_CSS = `<style>.ogtab{width:100%;border-collapse:collapse;font-size:.9rem}.ogtab th,.ogtab td{padding:7px 4px;border-bottom:1px solid var(--line);text-align:center}.ogtab th:first-child,.ogtab td:first-child{text-align:left}.ogtab thead th{font-size:.72rem;color:var(--muted);font-weight:600}.ogtab tr.grp td{font-weight:700;font-size:.75rem;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;padding-top:12px}.ogtab input{width:20px;height:20px;accent-color:var(--accent)}.ogtab .na{color:var(--muted)}</style>`;
function rowsOf(r){
  return [
    ["grp", "Seiten"],
    ...BEREICHE.map(([k, l]) => ["b:" + k, l, r.bereiche[k], !!NUR_SEHEN_AENDERN[k]]),
    ["grp", "Grundstücke"],
    ...flaechen().map(f => ["g:" + f.id, f.name || f.id, grundOf(r, f.id), false]),
    ["g:*", "Neu angelegte Grundstücke", grundOf(r, "*"), false]
  ];
}
function tableHTML(r, esc, readonly){
  return `${MATRIX_CSS}<table class="ogtab"><thead><tr><th></th>${AKTIONEN.map(([, l]) => `<th>${l}</th>`).join("")}</tr></thead><tbody>
    ${rowsOf(r).map(row => row[0] === "grp" ? `<tr class="grp"><td colspan="5">${row[1]}</td></tr>`
      : `<tr><td>${esc(row[1])}</td>${AKTIONEN.map(([a, al]) => row[3] && (a === "anlegen" || a === "loeschen") ? `<td class="na">–</td>`
        : `<td><input type="checkbox" data-ogr="${esc(row[0])}" data-oga="${a}" aria-label="${esc(row[1])}: ${al}" ${act(row[2], a) ? "checked" : ""} ${readonly ? "disabled" : ""}></td>`).join("")}</tr>`).join("")}
  </tbody></table>`;
}
function matrixHTML(m, esc){
  const uid = esc(m.user_id);
  return `<form class="form ogrights" data-oguser="${uid}" style="border-top:1px solid var(--line);padding-top:10px;margin-top:6px">
    <div class="field full"><label>Rolle (Vorlage – setzt die Häkchen)</label><select data-ogrole>${["bearbeiten","erfassen","lesen"].map(k => `<option value="${k}" ${k === m.role ? "selected" : ""}>${ROLLEN[k].label} – ${ROLLEN[k].text}</option>`).join("")}</select></div>
    <div class="full" style="overflow-x:auto">${tableHTML(rechteOf(m), esc, false)}</div>
    <p class="hint full" style="margin:0">Ändern und Löschen gelten nur für Einträge, die die Person selbst angelegt hat. Bei Einstellungen gibt es nur Sehen und Ändern. Für Bäume, Pflege und Ertrag je Baum braucht es das Häkchen bei der Seite <b>und</b> beim Grundstück.</p>
    ${m.test ? `<div class="tip full" style="text-align:left">Testperson – Anmeldung im privaten Fenster mit <b>${esc(m.test_login || "")}</b> und dem Passwort, das du beim Anlegen vergeben hast.</div>` : ""}
    <div class="full row" style="gap:8px;flex-wrap:wrap"><button class="btn primary small" type="submit">Rechte speichern</button><button class="btn small" type="button" data-ogreset="${uid}">Auf Vorlage zurücksetzen</button><button class="btn small" type="button" data-ogpreview="${uid}">Ansicht als ${esc(m.name || "Person")}</button><span class="spacer"></span>${m.test ? `<button class="btn small danger" data-ogdeltest="${uid}" type="button">Testperson löschen</button>` : `<button class="btn small danger" data-ogremove="${uid}" type="button">Person entfernen</button>`}</div>
  </form>`;
}
function myRightsHTML(esc){
  const em = effMember(), r = rechteOf(em); if(!r || em.role === "owner") return "";
  return `<div style="text-align:left;margin-top:6px"><b>${preview ? "Rechte in der Vorschau" : "Deine Rechte"}</b>${tableHTML(r, esc, true)}<p class="hint" style="margin:4px 0 0">Ändern und löschen kannst du nur, was du selbst eingetragen hast.</p></div>`;
}
let lastTest = null, newMode = "invite";
function setPreview(p){
  preview = p;
  let bar = document.getElementById("ogPreviewBar");
  if(p){
    if(!bar){ bar = document.createElement("div"); bar.id = "ogPreviewBar"; bar.setAttribute("role", "status"); document.body.appendChild(bar); }
    bar.style.cssText = "position:fixed;left:50%;transform:translateX(-50%);bottom:calc(env(safe-area-inset-bottom,0px) + 76px);z-index:60;white-space:nowrap;background:var(--ink);color:var(--surface);border-radius:999px;padding:6px 8px 6px 14px;display:flex;gap:10px;align-items:center;font-size:.85rem;box-shadow:0 4px 14px rgba(0,0,0,.25);max-width:calc(100vw - 24px)";
    bar.innerHTML = `<span style="overflow:hidden;text-overflow:ellipsis">👁 Ansicht als <b>${p.label.replace(/[<>&"]/g, "")}</b></span><button type="button" id="ogPreviewEnd" style="border:0;border-radius:999px;padding:5px 10px;font-weight:600;background:var(--surface);color:var(--ink)">Beenden</button>`;
  } else if(bar) bar.remove();
  Object.keys(listeners).forEach(notify);
  OG_APP.closeSheet();
}
document.addEventListener("click", e => { if(e.target.closest && e.target.closest("#ogPreviewEnd")){ setPreview(null); OG_APP.goto && OG_APP.goto("verwaltung"); OG_APP.toast("Vorschau beendet"); } });
window.OG_HOST = {
  speicherText: "Die Daten liegen in der Supabase-Datenbank und sind auf jedem Gerät verfügbar, auf dem du dich anmeldest.",
  logout: async () => { await sb.auth.signOut(); location.reload(); },
  personenHTML({esc}){
    if(!OG_PERM.owner) return `<div class="card"><span class="eyebrow">Zugang</span>${myRightsHTML(esc)}<div class="row"><span class="hint">Angemeldet als ${esc(session.user.email)}</span><span class="spacer"></span><button class="btn small" data-oglogout type="button">Abmelden</button></div></div>`;
    const order = {owner:0, bearbeiten:1, erfassen:2, lesen:3};
    const list = Object.values(members).sort((a,b) => (order[a.role] ?? 9) - (order[b.role] ?? 9) || a.name.localeCompare(b.name));
    const avatarOf = m => `<span class="av av0" style="width:26px;height:26px;background:${colorFor(m.user_id)};color:#fff;border-color:transparent">${esc((m.name||"?").trim()[0]||"?").toUpperCase()}</span>`;
    const roleOpts = sel => ["lesen","erfassen","bearbeiten"].map(k => `<option value="${k}" ${k === sel ? "selected" : ""}>${ROLLEN[k].label} – ${ROLLEN[k].text}</option>`).join("");
    const test = newMode === "test";
    return `<div class="card"><span class="eyebrow">Personen</span>
      <p class="hint" style="margin:0">Person antippen, um ihre Rechte zu sehen und zu ändern.</p>
      <div class="list" style="border:0">${list.map(m => {
        const head = `<span style="display:inline-flex;gap:8px;align-items:center;color:var(--ink)">${avatarOf(m)}${esc(m.name || "Ohne Namen")}${m.user_id === session.user.id ? " (du)" : ""} ${rolePill(m)}${testPill(m)}</span>`;
        if(m.role !== "owner") return `<details class="ogperson" style="padding:6px 0;border-bottom:1px solid var(--line)"><summary class="who" style="cursor:pointer;list-style:none;justify-content:space-between">${head}<span class="btn small" style="pointer-events:none">Rechte ›</span></summary>${matrixHTML(m, esc)}</details>`;
        return `<div class="who" style="padding:8px 0;border-bottom:1px solid var(--line)">${head}<span class="hint">darf alles</span></div>`;
      }).join("")}</div>
      <details><summary class="hint" style="cursor:pointer">Was bedeuten die Rollen?</summary><dl class="kv">${Object.values(ROLLEN).map(r => `<dt>${r.label}</dt><dd>${r.text}</dd>`).join("")}</dl>
        <p class="hint" style="margin:0">Die Rolle ist eine Vorlage für die Häkchen. Danach kannst du für jede Person pro Seite und Grundstück anhaken, was erlaubt ist. Ändern und Löschen gelten nur für eigene Einträge; die Verwaltung darf alles.</p></details>
    </div>
    <div class="card"><span class="eyebrow">Neue Person</span>
      <div class="ogseg" role="tablist" style="width:100%;box-sizing:border-box;display:flex;gap:4px;background:var(--line);border-radius:10px;padding:3px">
        ${[["invite","Per E-Mail einladen"],["test","Testperson"]].map(([k, l]) => `<button type="button" data-ognewmode="${k}" aria-pressed="${newMode === k}" style="flex:1;border:0;border-radius:8px;padding:8px 4px;font-weight:600;background:${newMode === k ? "var(--surface)" : "transparent"};color:${newMode === k ? "var(--ink)" : "var(--muted)"}">${l}</button>`).join("")}
      </div>
      ${test && lastTest ? `<div class="tip" style="text-align:left">Testperson angelegt. Anmeldung: <b>${esc(lastTest.email)}</b> · Passwort: <b>${esc(lastTest.password)}</b><br><span class="hint">Notier dir die Daten – das Passwort wird nicht noch einmal angezeigt. Anmelden am besten in einem privaten Browserfenster.</span></div>` : ""}
      <form class="form" id="ogNewForm" data-mode="${newMode}">
        <p class="hint full" style="margin:0">${test ? "Die App vergibt eine Fantasie-Adresse zum Anmelden. Damit probierst du die Rechte in einem privaten Browserfenster wirklich aus." : "Die Person bekommt eine E-Mail mit Link, legt darüber ihr Passwort fest und ist sofort mit diesen Rechten freigeschaltet."}</p>
        <div class="field"><label for="og_newname">Name</label><input id="og_newname" placeholder="${test ? "z. B. Test Erfassen" : "Vorname"}" ${test ? "required" : ""}></div>
        ${test ? `<div class="field"><label for="og_tpw">Passwort</label><input id="og_tpw" type="text" minlength="6" autocomplete="off" required placeholder="mind. 6 Zeichen"></div>`
               : `<div class="field"><label for="og_email">E-Mail</label><input id="og_email" type="email" autocomplete="off" required></div>`}
        <div class="field full"><label>Rolle (Vorlage – setzt die Häkchen)</label><select data-ogrole id="og_newrole">${roleOpts("lesen")}</select></div>
        <div class="full" style="overflow-x:auto">${tableHTML(TEMPLATES.lesen, esc, false)}</div>
        <div class="full"><button class="btn primary" type="submit">${test ? "Testperson anlegen" : "Einladung senden"}</button></div>
      </form>
    </div>
    <div class="card"><span class="eyebrow">Ansicht als …</span>
      <p class="hint" style="margin:0">Zeigt die App so, wie eine Rolle sie sieht (für eine bestimmte Person: Person antippen → „Ansicht als“). In der Vorschau wird nichts gespeichert.</p>
      <div class="row" style="gap:8px;flex-wrap:wrap">${["bearbeiten","erfassen","lesen"].map(k => `<button class="btn small" type="button" data-ogpreviewrole="${k}">${ROLLEN[k].label}</button>`).join("")}</div>
    </div>
    <div class="card"><span class="eyebrow">Mein Zugang</span>
      <form class="form" id="ogNameForm"><div class="field"><label for="og_myname">Dein Anzeigename</label><input id="og_myname" value="${esc(member ? member.name : "")}"></div><div class="field" style="justify-content:flex-end"><button class="btn" type="submit">Namen speichern</button></div></form>
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
    if(d.ognewmode){ newMode = d.ognewmode; OG_APP.render(); return true; }
    if(d.ogpreview){ const m = members[d.ogpreview]; if(m){ setPreview({label: m.name || "Person", member: m}); OG_APP.toast(`Ansicht als ${m.name || "Person"}`); } return true; }
    if(d.ogpreviewrole){ setPreview({label: "Rolle " + ROLLEN[d.ogpreviewrole].label, member: {user_id: "preview-" + d.ogpreviewrole, role: d.ogpreviewrole, rechte: null}}); OG_APP.toast(`Ansicht als Rolle ${ROLLEN[d.ogpreviewrole].label}`); return true; }
    if(d.ogdeltest){
      if(el.dataset.armed !== "1"){ el.dataset.armed = "1"; el.textContent = "Wirklich löschen?"; return true; }
      el.disabled = true;
      const {error} = await sb.functions.invoke("og-invite", {body: {action: "deletetest", user_id: d.ogdeltest}});
      let msg = "Testperson gelöscht"; if(error){ msg = "Löschen fehlgeschlagen."; try{ msg = (await error.context.json()).error || msg; }catch(_){} }
      window.OG_FRESH = true; OG_APP.toast(msg); await loadMembers(); OG_APP.closeSheet(); return true;
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
  f.querySelectorAll("[data-ogr]").forEach(c => { const [kind, key] = c.dataset.ogr.split(/:(.*)/s); c.checked = act(kind === "b" ? t.bereiche[key] : grundOf(t, key), c.dataset.oga); });
}, true);
// Häkchen-Logik: ohne „Sehen“ keine anderen Aktionen, mit Aktion automatisch „Sehen“
document.addEventListener("change", e => {
  const c = e.target; if(!c.matches || !c.matches("input[data-oga]")) return;
  const row = [...c.closest("tr").querySelectorAll("input[data-oga]")];
  if(c.dataset.oga === "sehen" && !c.checked) row.forEach(x => x.checked = false);
  if(c.dataset.oga !== "sehen" && c.checked){ const s = row.find(x => x.dataset.oga === "sehen"); if(s) s.checked = true; }
}, true);
// Rolle + Häkchen aus einem Formular lesen; rechte = null, wenn genau die Vorlage
function rechteFromForm(f){
  const role = f.querySelector("[data-ogrole]").value, t = TEMPLATES[role];
  const r = {bereiche:{}, grundstuecke:{}};
  f.querySelectorAll("input[data-ogr]").forEach(c => { const [kind, key] = c.dataset.ogr.split(/:(.*)/s); const box = kind === "b" ? r.bereiche : r.grundstuecke; (box[key] ||= {sehen:false, anlegen:false, aendern:false, loeschen:false})[c.dataset.oga] = c.checked; });
  const eq = (x, y, nurSA) => { const a = normRecht(x, nurSA), b = normRecht(y, nurSA); return AKTIONEN.every(([k]) => a[k] === b[k]); };
  const same = BEREICHE.every(([k]) => eq(r.bereiche[k], t.bereiche[k], !!NUR_SEHEN_AENDERN[k])) && Object.entries(r.grundstuecke).every(([k, v]) => eq(v, grundOf(t, k), false));
  return {role, rechte: same ? null : r};
}
document.addEventListener("submit", async e => {
  if(e.target.classList && e.target.classList.contains("ogrights")){
    e.preventDefault(); e.stopImmediatePropagation();
    const f = e.target, {role, rechte} = rechteFromForm(f);
    const {data, error} = await sb.rpc("og_set_member", {p_user: f.dataset.oguser, p_role: role, p_rechte: rechte});
    window.OG_FRESH = true; OG_APP.toast(error || data !== "ok" ? "Speichern fehlgeschlagen." : "Rechte gespeichert"); await loadMembers(); OG_APP.closeSheet(); return;
  }
  if(e.target.id === "ogNewForm"){
    e.preventDefault(); e.stopImmediatePropagation();
    const f = e.target, test = f.dataset.mode === "test", {role, rechte} = rechteFromForm(f);
    const btn = f.querySelector("button[type=submit]"), label = btn.textContent; btn.disabled = true; btn.textContent = test ? "Wird angelegt …" : "Wird gesendet …";
    const name = document.getElementById("og_newname").value, password = test ? document.getElementById("og_tpw").value : "";
    const body = test ? {action: "test", name, password, role} : {email: document.getElementById("og_email").value, name, role};
    const {data, error} = await sb.functions.invoke("og-invite", {body});
    if(error){ let msg = "Fehlgeschlagen."; try{ msg = (await error.context.json()).error || msg; }catch(_){} OG_APP.toast(msg); btn.disabled = false; btn.textContent = label; return; }
    let warn = "";
    if(rechte && data.user_id && data.status !== "owner"){
      const r2 = await sb.rpc("og_set_member", {p_user: data.user_id, p_role: role, p_rechte: rechte});
      if(r2.error || r2.data !== "ok") warn = " – angepasste Häkchen bitte noch einmal speichern";
    }
    if(test) lastTest = {email: data.email, password};
    const msg = test ? "Testperson angelegt" : data.status === "invited" ? "Einladung verschickt" : data.status === "existing" ? "Person war schon registriert und ist jetzt freigeschaltet" : "Das bist du selbst";
    window.OG_FRESH = true; OG_APP.toast(msg + warn); await loadMembers(); OG_APP.closeSheet();
    return;
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
  return `<div class="gatecard">
    <div class="gatelogo">${document.getElementById("gateLogo").innerHTML}</div>
    <h1>Obstgarten</h1>
    <p class="hint">Melde dich mit deiner E-Mail-Adresse an. Einen Zugang bekommst du per Einladung von der Verwaltung.</p>
    ${msg ? `<div class="tip">${msg}</div>` : ""}
    <form id="loginForm" class="form" data-mode="login">
      <div class="field full"><label for="l_mail">E-Mail</label><input id="l_mail" type="email" autocomplete="email" required></div>
      <div class="field full"><label for="l_pw">Passwort</label><input id="l_pw" type="password" autocomplete="current-password" minlength="6" required></div>
      <div class="full"><button class="btn primary" type="submit" style="width:100%">Anmelden</button></div>
    </form>
    <button class="linkbtn" id="forgotPw" type="button" style="font-size:.9rem">Passwort vergessen?</button>
  </div>`;
}
function waitingHTML(){
  return `<div class="gatecard">
    <div class="gatelogo">${document.getElementById("gateLogo").innerHTML}</div>
    <h1>Fast geschafft</h1>
    <p>Du bist als <b>${session.user.email.replace(/[<>&"]/g, "")}</b> angemeldet, aber noch nicht freigeschaltet.</p>
    <p class="hint">Bitte die Verwaltung, dich mit dieser E-Mail-Adresse einzuladen. Danach diese Seite neu laden.</p>
    <div class="row" style="justify-content:center;gap:10px"><button class="btn primary" id="recheck" type="button">Erneut prüfen</button><button class="btn" id="logout2" type="button">Abmelden</button></div>
  </div>`;
}
gate.addEventListener("click", async e => {
  const b = e.target.closest("button"); if(!b) return;
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
  const {data, error} = await sb.auth.signInWithPassword({email: mail, password: pw});
  btn.disabled = false;
  if(error){ showGate(loginHTML("login", /confirm/i.test(error.message) ? "Bitte bestätige zuerst deine E-Mail-Adresse über den Link in der Mail." : "Anmeldung fehlgeschlagen. E-Mail oder Passwort stimmen nicht.")); return; }
  session = data.session; await afterLogin();
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
