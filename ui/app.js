"use strict";

const invoke = window.__TAURI__.core.invoke;
const $ = (s) => document.querySelector(s);

// ---------------------------------------------------------------- Zustand
const S = {
  cfg: { accounts: [], focus_folders: [], focus_active: false },
  accId: null,          // aktives Konto
  folders: {},          // accId -> [Ordner]
  cur: null,            // { id, folder }
  heads: {},            // "id|folder" -> [MsgHead]
  bodies: {},           // "id|folder|uid" -> Body
  selUid: null,
  search: "",
  editFocus: false,
  loading: new Set(),   // Schlüssel, die gerade laden
  showImages: false,
  fmeta: {},            // "id|folder" -> { label, depth }
};

const key = (id, folder) => `${id}|${folder}`;
const curKey = () => (S.cur ? key(S.cur.id, S.cur.folder) : null);
const account = (id) => S.cfg.accounts.find((a) => a.id === id);

// ---------------------------------------------------------------- Helfer
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const PALETTE = ["#5b5bf0", "#10b981", "#ec4899", "#f59e0b", "#0ea5e9", "#ef4444", "#8b5cf6", "#14b8a6"];
function colorFor(s) {
  let h = 0;
  for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
}
const accColor = (a) => PALETTE[Number(BigInt(a.id) % 8n)];
function initials(s) {
  const parts = String(s || "?").replace(/[<>"]/g, "").split(/[\s.@_-]+/).filter(Boolean);
  return ((parts[0]?.[0] || "?") + (parts.length > 1 ? parts[1][0] : "")).toUpperCase();
}

const DAY = 86400000;
function startOfDay(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x.getTime(); }
function fmtTime(ts) {
  if (!ts) return "";
  const d = new Date(ts * 1000);
  const today = startOfDay(Date.now());
  if (d.getTime() >= today) return d.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
  if (d.getTime() >= today - 6 * DAY) return d.toLocaleDateString("de-DE", { weekday: "short" });
  return d.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "2-digit" });
}
function dayGroup(ts) {
  if (!ts) return "Älter";
  const t = ts * 1000, today = startOfDay(Date.now());
  if (t >= today) return "Heute";
  if (t >= today - DAY) return "Gestern";
  if (t >= today - 6 * DAY) return "Diese Woche";
  if (t >= today - 30 * DAY) return "Diesen Monat";
  return "Älter";
}
function fmtLong(ts) {
  return ts ? new Date(ts * 1000).toLocaleString("de-DE", { weekday: "short", day: "2-digit", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "";
}

let toastTimer;
function toast(msg, type = "") {
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.textContent = msg;
  $("#toasts").appendChild(el);
  setTimeout(() => el.remove(), type === "err" ? 6000 : 2800);
}

// Ordner-Anzeige: Name + Icon
const ICONS = {
  inbox: '<path d="M3 13h5l1.5 3h5L16 13h5"/><path d="M5.5 5h13L21 13v6H3v-6z"/>',
  sent: '<path d="M21 3 10 14"/><path d="m21 3-7 18-4-7-7-4z"/>',
  drafts: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m13.5 6.5 4 4"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
  junk: '<circle cx="12" cy="12" r="9"/><path d="m5.6 5.6 12.8 12.8"/>',
  archive: '<rect x="3" y="4" width="18" height="5" rx="1"/><path d="M5 9v11h14V9M10 13h4"/>',
  folder: '<path d="M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2.5h8.5A1.5 1.5 0 0 1 21 9v9.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5z"/>',
};
const svg = (p) => `<svg viewBox="0 0 24 24">${p}</svg>`;
function folderInfo(name, id) {
  const meta = S.fmeta[key(id, name)];
  const leaf = meta ? meta.label : name.split(/[/.]/).filter(Boolean).pop() || name;
  const depth = meta ? meta.depth : 0;
  const l = leaf.toLowerCase();
  if (name.toUpperCase() === "INBOX") return { label: "Posteingang", icon: "inbox", rank: 0, depth: 0 };
  if (depth === 0) {
    if (/^(sent|gesendet|sent items|sent messages|gesendete)/.test(l)) return { label: "Gesendet", icon: "sent", rank: 1, depth };
    if (/^(drafts|entw)/.test(l)) return { label: "Entwürfe", icon: "drafts", rank: 2, depth };
    if (/^(archive|archiv|all mail|alle nachrichten)/.test(l)) return { label: "Archiv", icon: "archive", rank: 3, depth };
    if (/^(junk|spam|junk-e-mail|bulk)/.test(l)) return { label: "Spam", icon: "junk", rank: 4, depth };
    if (/^(trash|papierkorb|gelöscht|deleted|bin)/.test(l)) return { label: "Papierkorb", icon: "trash", rank: 5, depth };
  }
  return { label: leaf, icon: "folder", rank: 9, depth };
}

// ---------------------------------------------------------------- Daten
async function saveCfg() {
  try { await invoke("save_config", { cfg: S.cfg }); } catch (e) { toast(String(e), "err"); }
}

async function loadFolders(id) {
  try {
    const list = await invoke("folders", { accountId: id });
    for (const f of list) S.fmeta[key(id, f.name)] = { label: f.label, depth: f.depth };
    // Systemordner nach oben, Unterordner direkt unter ihrem Elternordner
    const top = (n) => { const m = list.find((f) => f.depth === 0 && (n === f.name || (n.startsWith(f.name) && /[/.]/.test(n[f.name.length])))); return m ? m.name : n; };
    list.sort((a, b) => {
      const ta = top(a.name), tb = top(b.name);
      return folderInfo(ta, id).rank - folderInfo(tb, id).rank || ta.localeCompare(tb) || a.depth - b.depth || a.name.localeCompare(b.name);
    });
    S.folders[id] = list.map((f) => f.name);
  } catch (e) {
    S.folders[id] = [];
    toast(`${account(id)?.email}: ${e}`, "err");
  }
  renderSidebar();
}

async function loadHeads(id, folder) {
  const k = key(id, folder);
  if (S.loading.has(k)) return;
  S.loading.add(k);
  renderListHead();
  if (!S.heads[k]) renderList();
  try {
    S.heads[k] = await invoke("headers", { accountId: id, folder });
  } catch (e) {
    toast(String(e), "err");
    S.heads[k] = S.heads[k] || [];
  }
  S.loading.delete(k);
  if (curKey() === k) { renderList(); renderListHead(); }
  renderSidebar();
  renderRail();
}

function openFolder(id, folder) {
  S.accId = id;
  S.cur = { id, folder };
  S.selUid = null;
  S.search = "";
  $("#search").value = "";
  renderAll();
  loadHeads(id, folder); // Cache wird sofort angezeigt, dann im Hintergrund aktualisiert
}

function switchAccount(id) {
  if (!account(id)) return;
  if (S.cfg.focus_active) {
    // Im Fokus-Modus: erstes Fokus-Postfach dieses Kontos, sonst Posteingang
    const f = S.cfg.focus_folders.find((k) => k.startsWith(id + "|"));
    if (f) return openFolder(id, f.slice(f.indexOf("|") + 1));
  }
  openFolder(id, "INBOX");
}

async function openMessage(uid) {
  if (!S.cur) return;
  S.selUid = uid;
  S.showImages = false;
  const { id, folder } = S.cur;
  const h = (S.heads[key(id, folder)] || []).find((m) => m.uid === uid);
  if (h && h.unread) { h.unread = false; renderRail(); renderSidebar(); }
  renderList();
  renderReader();
  const bk = `${id}|${folder}|${uid}`;
  if (S.bodies[bk]) return;
  try {
    S.bodies[bk] = await invoke("body", { accountId: id, folder, uid });
  } catch (e) {
    S.bodies[bk] = { text: `Fehler beim Laden: ${e}`, html: null, reply_to: "" };
  }
  if (S.selUid === uid) renderReader();
}

// ---------------------------------------------------------------- Rendering
function renderAll() { renderRail(); renderSidebar(); renderListHead(); renderList(); renderReader(); }

function unreadFor(id) {
  const h = S.heads[key(id, "INBOX")];
  return h ? h.filter((m) => m.unread).length : 0;
}

function renderRail() {
  const accs = S.cfg.accounts.map((a, i) => {
    const n = unreadFor(a.id);
    const c = accColor(a);
    return `<button class="avatar-btn ${a.id === S.accId ? "active" : ""}" data-acc="${a.id}"
      style="--c:${c};background:linear-gradient(135deg, ${c}, ${c}cc)" title="${esc(a.name)} – ${esc(a.email)}  (Strg+${i + 1})">
      ${esc(initials(a.name || a.email))}${n ? `<span class="badge">${n > 99 ? "99+" : n}</span>` : ""}</button>`;
  }).join("");
  $("#rail").innerHTML = `${accs}
    <button class="rail-btn" data-act="add-account" title="Konto hinzufügen">${svg('<path d="M12 5v14M5 12h14"/>')}</button>
    <div class="rail-spacer"></div>
    <button class="rail-btn solid" data-act="contacts" title="Kontakte">${svg('<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14a6.5 6.5 0 0 1 3.5 6"/>')}</button>
    <button class="rail-btn solid" data-act="settings" title="Einstellungen">${svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>')}</button>`;
}

function folderRow(id, name, { showAcc = false } = {}) {
  const info = folderInfo(name, id);
  const k = key(id, name);
  const active = curKey() === k;
  const isFocus = S.cfg.focus_folders.includes(k);
  const h = S.heads[k];
  const n = h ? h.filter((m) => m.unread).length : 0;
  const acc = account(id);
  const lead = showAcc
    ? `<span class="dot" style="background:${accColor(acc)}"></span>`
    : svg(ICONS[info.icon]);
  const label = showAcc ? `${esc(info.label)} <span class="muted">· ${esc(acc.name || acc.email)}</span>` : esc(info.label);
  return `<div class="folder ${active ? "active" : ""}" data-open="${esc(k)}" style="padding-left:${10 + info.depth * 14}px" title="${esc(name)}">
    ${lead}<span class="fname">${label}</span>
    ${n ? `<span class="count">${n}</span>` : ""}
    <button class="star ${isFocus ? "on" : ""}" data-star="${esc(k)}" title="Als Fokus-Postfach markieren">${svg('<path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z"/>')}</button>
  </div>`;
}

function renderSidebar() {
  const acc = account(S.accId);
  const focus = S.cfg.focus_active;
  let body = "";

  if (!acc) {
    $("#sidebar").innerHTML = `<div class="empty-hint">Noch kein Konto eingerichtet.</div>
      <button class="compose-btn" data-act="add-account">Konto hinzufügen</button>`;
    return;
  }

  if (focus && !S.editFocus) {
    const items = S.cfg.focus_folders
      .map((k) => { const i = k.indexOf("|"); return [Number(k.slice(0, i)), k.slice(i + 1)]; })
      .filter(([id]) => account(id));
    body = `<div class="section-label">Fokus-Postfächer <button data-act="edit-focus">Bearbeiten</button></div>
      <div class="folders">${items.length
        ? items.map(([id, f]) => folderRow(id, f, { showAcc: true })).join("")
        : `<div class="empty-hint">Noch keine Fokus-Postfächer.<br>Tippe auf <b>Bearbeiten</b> und markiere Ordner mit ★ – egal aus welchem Konto.</div>`}</div>`;
  } else {
    const list = S.folders[acc.id];
    body = `<div class="section-label">Ordner ${S.editFocus
        ? `<button data-act="edit-focus">Fertig</button>`
        : `<button data-act="edit-focus" title="Fokus-Postfächer auswählen">★ Fokus wählen</button>`}</div>
      <div class="folders ${S.editFocus ? "editing" : ""}">${list
        ? list.map((f) => folderRow(acc.id, f)).join("")
        : `<div class="skel" style="height:30px"></div><div class="skel" style="height:30px"></div><div class="skel" style="height:30px"></div>`}</div>`;
  }

  $("#sidebar").innerHTML = `
    <div class="acc-head"><div class="name">${esc(acc.name || acc.email)}</div><div class="mail">${esc(acc.email)}</div></div>
    <button class="compose-btn" data-act="compose">${svg('<path d="M4 20h4L19 9l-4-4L4 16z"/>')} Neue Nachricht</button>
    <div class="focus-toggle" data-act="toggle-focus" title="Strg+Umschalt+F">
      ${svg('<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4"/>')}
      <span class="lbl">Fokus-Modus<span class="sub">${focus ? "Nur ausgewählte Postfächer" : "Alle Postfächer sichtbar"}</span></span>
      <span class="switch ${focus ? "on" : ""}"></span>
    </div>
    ${body}`;
}

function renderListHead() {
  const k = curKey();
  const title = S.cur ? folderInfo(S.cur.folder, S.cur.id).label : "";
  $("#folder-title").textContent = title;
  const h = S.heads[k];
  const n = h ? h.filter((m) => m.unread).length : 0;
  $("#folder-meta").textContent = h ? (n ? `${n} ungelesen` : `${h.length} Nachrichten`) : "";
  $("#refresh").classList.toggle("spin", S.loading.has(k));
}

function visibleHeads() {
  const h = S.heads[curKey()] || [];
  if (!S.search) return h;
  const q = S.search.toLowerCase();
  return h.filter((m) => m.subject.toLowerCase().includes(q) || m.from.toLowerCase().includes(q) || m.from_addr.toLowerCase().includes(q));
}

function renderList() {
  const el = $("#messages");
  const k = curKey();
  if (!k) { el.innerHTML = ""; return; }
  if (!S.heads[k]) { el.innerHTML = '<div class="skel"></div>'.repeat(8); return; }
  const list = visibleHeads();
  if (!list.length) {
    el.innerHTML = `<div class="empty-hint" style="text-align:center;padding-top:40px">${S.search ? "Keine Treffer." : "Dieser Ordner ist leer."}</div>`;
    return;
  }
  let last = null, html = "";
  for (const m of list) {
    const g = dayGroup(m.ts);
    if (g !== last) { html += `<div class="day-sep">${g}</div>`; last = g; }
    const c = colorFor(m.from_addr || m.from);
    html += `<div class="msg ${m.unread ? "unread" : ""} ${m.uid === S.selUid ? "active" : ""}" data-uid="${m.uid}">
      <div class="av" style="background:${c}">${esc(initials(m.from))}</div>
      <div class="from">${esc(m.from || m.from_addr || "(unbekannt)")}</div>
      <div class="time">${fmtTime(m.ts)}</div>
      <div class="subj">${esc(m.subject)}</div></div>`;
  }
  el.innerHTML = html;
}

function htmlDoc(html, images) {
  const csp = images
    ? "default-src 'none'; img-src data: cid: https: http:; style-src 'unsafe-inline' https:; font-src data: https:"
    : "default-src 'none'; img-src data: cid:; style-src 'unsafe-inline'; font-src data:";
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}">
    <base target="_blank"><style>body{margin:0;padding:24px 28px;font:14.5px/1.6 "Segoe UI",system-ui,sans-serif;color:#1a1c23;word-wrap:break-word}
    img{max-width:100%;height:auto}table{max-width:100%}blockquote{margin:0 0 0 4px;padding-left:12px;border-left:3px solid #ddd;color:#555}</style></head><body>${html}</body></html>`;
}

function fmtSize(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1).replace(".", ",")} MB`;
}
function fileIcon(mime, name) {
  const ext = (name.split(".").pop() || "").toUpperCase().slice(0, 4);
  const col = /pdf/.test(mime) ? "#e5484d" : /image/.test(mime) ? "#10b981" : /sheet|excel|csv/.test(mime) ? "#2fa36b"
    : /word|document/.test(mime) ? "#3b82f6" : /zip|compressed/.test(mime) ? "#f59e0b" : "#8a8f9e";
  return `<span class="ficon" style="background:${col}">${esc(ext || "?")}</span>`;
}

const curHead = () => S.cur && (S.heads[curKey()] || []).find((m) => m.uid === S.selUid);
const curBodyKey = () => `${S.cur.id}|${S.cur.folder}|${S.selUid}`;
const isContact = (addr) => S.cfg.contacts.some((c) => c.email.toLowerCase() === String(addr).toLowerCase());

function renderReader() {
  const el = $("#reader");
  const h = curHead();
  if (!h) {
    const n = S.cfg.accounts.length;
    el.innerHTML = `<div class="reader-empty"><div>
      <div class="big">${svg(ICONS.inbox)}</div>
      <h2>${n ? "Keine Nachricht ausgewählt" : "Willkommen bei MailLine"}</h2>
      <div>${n ? `<span class="kbd">↑</span> <span class="kbd">↓</span> zum Blättern · <span class="kbd">Strg+N</span> neue Nachricht`
                : `<button class="btn primary" data-act="add-account" style="margin-top:10px">Erstes Konto hinzufügen</button>`}</div>
    </div></div>`;
    return;
  }
  const b = S.bodies[curBodyKey()];
  const c = colorFor(h.from_addr || h.from);
  let content;
  if (!b) content = `<div class="reader-body"><div class="text"><div class="skel" style="height:14px;width:60%"></div><div class="skel" style="height:14px;width:80%"></div><div class="skel" style="height:14px;width:45%"></div></div></div>`;
  else if (b.html) {
    const hasRemote = /<img[^>]+src=["']?https?:/i.test(b.html);
    content = `<div class="reader-body html">
      ${hasRemote && !S.showImages ? `<div class="img-bar">Externe Bilder wurden zum Schutz deiner Privatsphäre blockiert. <button data-act="images">Bilder laden</button></div>` : ""}
      <iframe sandbox="allow-same-origin" referrerpolicy="no-referrer"></iframe></div>`;
  } else content = `<div class="reader-body"><div class="text">${esc(b.text)}</div></div>`;

  const atts = b?.attachments || [];
  const attHtml = atts.length ? `<div class="attachments">
      ${atts.map((a) => `<div class="att" data-att-open="${a.index}" title="Öffnen">
        ${fileIcon(a.mime, a.name)}<span class="att-meta"><b>${esc(a.name)}</b><span>${fmtSize(a.size)}</span></span>
        <button class="icon-btn sm" data-att-save="${a.index}" title="In Downloads speichern">${svg('<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>')}</button>
      </div>`).join("")}
    </div>` : "";

  const quick = S.cfg.contacts.filter((x) => x.quick);
  const others = S.cfg.contacts.filter((x) => !x.quick);
  const menu = `<div class="menu" id="fwd-menu" hidden>
      ${quick.length ? `<div class="menu-label">Schnell-Weiterleiten${atts.length ? ` · inkl. ${atts.length} Anhang${atts.length > 1 ? "e" : ""}` : ""}</div>` : ""}
      ${quick.map((x) => `<button class="menu-item" data-quickfwd="${x.id}"><span class="mav" style="background:${colorFor(x.email)}">${esc(initials(x.name || x.email))}</span><span><b>${esc(x.name || x.email)}</b><small>${esc(x.email)}</small></span></button>`).join("")}
      ${others.length ? `<div class="menu-label">Weitere Kontakte</div>` : ""}
      ${others.slice(0, 8).map((x) => `<button class="menu-item" data-quickfwd="${x.id}"><span class="mav" style="background:${colorFor(x.email)}">${esc(initials(x.name || x.email))}</span><span><b>${esc(x.name || x.email)}</b><small>${esc(x.email)}</small></span></button>`).join("")}
      ${!S.cfg.contacts.length ? `<div class="menu-empty">Noch keine Kontakte. Lege unter <b>Kontakte</b> z. B. deine Buchhaltung an und aktiviere „Schnell-Weiterleiten“.</div>` : ""}
      <div class="menu-sep"></div>
      <button class="menu-item" data-act="forward">${svg('<path d="M4 20h4L19 9l-4-4L4 16z"/>')}<span><b>Bearbeiten & weiterleiten …</b></span></button>
      <button class="menu-item" data-act="contacts">${svg('<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0M17 11h5M19.5 8.5v5"/>')}<span><b>Kontakte verwalten …</b></span></button>
    </div>`;

  el.innerHTML = `
    <div class="reader-head">
      <h2>${esc(h.subject)}</h2>
      <div class="sender">
        <div class="av" style="background:${c}">${esc(initials(h.from))}</div>
        <div class="who"><b>${esc(h.from)}</b><span>${esc(h.from_addr)} · ${fmtLong(h.ts)}</span></div>
        <div class="actions">
          ${h.from_addr && !isContact(h.from_addr) ? `<button class="icon-btn" data-act="save-sender" title="Absender als Kontakt speichern">${svg('<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0M19 8v6M16 11h6"/>')}</button>` : ""}
          <button class="btn" data-act="reply" title="Antworten (R)">${svg('<path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 5 5v6"/>')} Antworten</button>
          <div class="menu-wrap">
            <button class="btn" data-act="fwd-menu" title="Weiterleiten (W)">${svg('<path d="m15 14 5-5-5-5"/><path d="M20 9H9a5 5 0 0 0-5 5v6"/>')} Weiterleiten an ${svg('<path d="m6 9 6 6 6-6"/>')}</button>
            ${menu}
          </div>
        </div>
      </div>
    </div>${attHtml}${content}`;
  if (b && b.html) {
    const frame = el.querySelector("iframe");
    wireIframe(frame);
    frame.srcdoc = htmlDoc(b.html, S.showImages);
  }
}

async function ensureBody() {
  const k = curBodyKey();
  if (!S.bodies[k]) S.bodies[k] = await invoke("body", { accountId: S.cur.id, folder: S.cur.folder, uid: S.selUid });
  return S.bodies[k];
}

function forwardText(h, b) {
  return `---------- Weitergeleitete Nachricht ----------\nVon: ${h.from} <${h.from_addr}>\nDatum: ${fmtLong(h.ts)}\nBetreff: ${h.subject}\n\n${b.text || ""}`;
}
function fwdSubject(h) { return /^(fwd?|wg):/i.test(h.subject) ? h.subject : "WG: " + h.subject; }

async function quickForward(contactId) {
  const ct = S.cfg.contacts.find((c) => c.id === contactId);
  const h = curHead();
  if (!ct || !h) return;
  closeMenus();
  const acc = account(S.cur.id);
  const src = { accountId: S.cur.id, folder: S.cur.folder, uid: h.uid };
  toast(`Leite weiter an ${ct.name || ct.email} …`);
  try {
    const b = await ensureBody();
    let body = forwardText(h, b);
    const sig = signatureOf(acc, acc.default_signature);
    if (sig && sig.text) body = `\n\n-- \n${sig.text}\n\n` + body;
    await invoke("send_mail", { accountId: acc.id, to: ct.email, subject: fwdSubject(h), body, attachments: [], forward: src });
    const n = (b.attachments || []).length;
    toast(`Weitergeleitet an ${ct.name || ct.email}${n ? ` (inkl. ${n} Anhang${n > 1 ? "e" : ""})` : ""}`, "ok");
  } catch (e) {
    toast(`Weiterleiten fehlgeschlagen: ${e}`, "err");
  }
}

async function attachmentAction(index, open) {
  try {
    const p = await invoke("save_attachment", { accountId: S.cur.id, folder: S.cur.folder, uid: S.selUid, index, open });
    if (!open) toast(`Gespeichert: ${p}`, "ok");
  } catch (e) { toast(String(e), "err"); }
}

function closeMenus() { document.querySelectorAll(".menu").forEach((m) => (m.hidden = true)); }

// ---------------------------------------------------------------- Verfassen
function signatureOf(acc, i) { return acc?.signatures?.[i]; }

function suggestions(q) {
  q = q.trim().toLowerCase();
  if (!q) return [];
  const seen = new Set(), out = [];
  const add = (name, email, contact) => {
    const k = email.toLowerCase();
    if (!email || seen.has(k)) return;
    if (!(name.toLowerCase().includes(q) || k.includes(q))) return;
    seen.add(k); out.push({ name, email, contact });
  };
  for (const c of S.cfg.contacts) add(c.name, c.email, true);
  for (const list of Object.values(S.heads)) for (const m of list) add(m.from, m.from_addr, false);
  return out.slice(0, 7);
}

function openCompose({ to = "", cc = "", subject = "", quote = "", forward = null, fwdAtts = [] } = {}) {
  if (!S.cfg.accounts.length) return openSettings("accounts");
  const st = { accId: S.accId ?? S.cfg.accounts[0].id, sig: account(S.accId)?.default_signature ?? 0, files: [], forward, fwdAtts: [...fwdAtts], sugg: [], si: 0 };
  const root = $("#modal-root");
  root.innerHTML = `<div class="overlay"><div class="modal">
    <div class="modal-head"><h3>${forward ? "Weiterleiten" : "Neue Nachricht"}</h3><button class="icon-btn" data-close>${svg('<path d="M6 6l12 12M18 6 6 18"/>')}</button></div>
    <div class="modal-body">
      <div class="field"><label>Von</label><select id="c-from">${S.cfg.accounts.map((a) => `<option value="${a.id}" ${a.id === st.accId ? "selected" : ""}>${esc(a.name)} &lt;${esc(a.email)}&gt;</option>`).join("")}</select></div>
      <div class="field rel"><label>An</label><input id="c-to" class="rcpt" value="${esc(to)}" placeholder="Name oder Adresse – mehrere mit Komma" autocomplete="off" />
        <button class="link-btn" id="c-ccbtn" title="CC / BCC hinzufügen">CC/BCC</button></div>
      <div class="field rel" id="c-ccrow" hidden><label>CC</label><input id="c-cc" class="rcpt" placeholder="Kopie an" autocomplete="off" /></div>
      <div class="field rel" id="c-bccrow" hidden><label>BCC</label><input id="c-bcc" class="rcpt" placeholder="Blindkopie an (für andere unsichtbar)" autocomplete="off" /></div>
      <div id="c-sugg" class="menu sugg" hidden></div>
      <div class="field"><label>Betreff</label><input id="c-subj" value="${esc(subject)}" /></div>
      <textarea id="c-body" class="compose-text" placeholder="Nachricht schreiben …">${esc(quote)}</textarea>
      <div id="c-sigprev" class="sig-preview"></div>
      <div id="c-atts" class="compose-atts"></div>
    </div>
    <div class="modal-foot">
      <span class="muted" style="font-size:12.5px">Signatur</span><div id="c-sigs" class="segmented"></div>
      <span class="grow"></span>
      <label class="btn" title="Datei anhängen">${svg('<path d="m21 11-8.5 8.5a5 5 0 0 1-7-7L14 4a3.5 3.5 0 0 1 5 5l-8.5 8.5a2 2 0 0 1-3-3L15 7"/>')} Anhang<input type="file" id="c-file" multiple hidden /></label>
      <button class="btn primary" id="c-send">${svg('<path d="M21 3 10 14"/><path d="m21 3-7 18-4-7-7-4z"/>')} Senden</button>
    </div></div></div>`;

  const renderSigs = () => {
    const acc = account(st.accId);
    const sigs = acc?.signatures || [];
    $("#c-sigs").innerHTML = sigs.map((s, i) => `<button class="${i === st.sig ? "on" : ""}" data-sig="${i}">${esc(s.name)}</button>`).join("")
      + `<button class="${st.sig === -1 ? "on" : ""}" data-sig="-1">Keine</button>`;
    const s = signatureOf(acc, st.sig);
    $("#c-sigprev").textContent = s && s.text ? `-- \n${s.text}` : "";
    $("#c-sigprev").style.display = s && s.text ? "" : "none";
  };
  const renderAtts = () => {
    const chip = (name, size, mime, attr) => `<span class="chip">${fileIcon(mime, name)}<span>${esc(name)}</span><small>${fmtSize(size)}</small>
      <button class="x" ${attr} title="Entfernen">${svg('<path d="M6 6l12 12M18 6 6 18"/>')}</button></span>`;
    $("#c-atts").innerHTML = st.fwdAtts.map((a, i) => chip(a.name, a.size, a.mime, `data-rm-fwd="${i}"`)).join("")
      + st.files.map((f, i) => chip(f.name, f.size, f.mime, `data-rm-file="${i}"`)).join("");
  };
  renderSigs(); renderAtts();
  $("#c-from").onchange = (e) => { st.accId = Number(e.target.value); st.sig = account(st.accId)?.default_signature ?? 0; renderSigs(); };
  $("#c-sigs").onclick = (e) => { const b = e.target.closest("[data-sig]"); if (b) { st.sig = Number(b.dataset.sig); renderSigs(); } };
  $("#c-atts").onclick = (e) => {
    const f = e.target.closest("[data-rm-fwd]"), g = e.target.closest("[data-rm-file]");
    if (f) { st.fwdAtts.splice(Number(f.dataset.rmFwd), 1); if (!st.fwdAtts.length) st.forward = null; }
    if (g) st.files.splice(Number(g.dataset.rmFile), 1);
    renderAtts();
  };
  $("#c-file").onchange = async (e) => {
    for (const file of e.target.files) {
      const data = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(",")[1] || ""); r.onerror = rej; r.readAsDataURL(file); });
      st.files.push({ name: file.name, mime: file.type || "application/octet-stream", size: file.size, data });
    }
    e.target.value = "";
    renderAtts();
  };

  // CC/BCC einblenden
  const showCc = () => { $("#c-ccrow").hidden = false; $("#c-bccrow").hidden = false; $("#c-ccbtn").hidden = true; };
  $("#c-ccbtn").onclick = () => { showCc(); $("#c-cc").focus(); };
  if (cc) { $("#c-cc").value = cc; showCc(); }

  // Empfänger-Autovervollständigung (Kontakte + bekannte Absender) für An/CC/BCC
  const toEl = $("#c-to"), sg = $("#c-sugg");
  let active = toEl;
  const showSugg = (inp) => {
    active = inp;
    st.sugg = suggestions(inp.value.split(/[,;]/).pop()); st.si = 0;
    sg.hidden = !st.sugg.length;
    sg.style.top = inp.parentElement.offsetTop + inp.parentElement.offsetHeight + "px";
    sg.innerHTML = st.sugg.map((s, i) => `<button class="menu-item ${i === st.si ? "hl" : ""}" data-pick="${i}"><span class="mav" style="background:${colorFor(s.email)}">${esc(initials(s.name || s.email))}</span><span><b>${esc(s.name || s.email)}${s.contact ? ' <i class="tag">Kontakt</i>' : ""}</b><small>${esc(s.email)}</small></span></button>`).join("");
  };
  const pick = (i) => {
    const s = st.sugg[i]; if (!s) return;
    const parts = active.value.split(/[,;]/); parts.pop();
    active.value = [...parts.map((p) => p.trim()).filter(Boolean), s.email].join(", ") + ", ";
    sg.hidden = true; active.focus();
  };
  document.querySelectorAll("#modal-root .rcpt").forEach((inp) => {
    inp.addEventListener("input", () => showSugg(inp));
    inp.addEventListener("blur", () => setTimeout(() => (sg.hidden = true), 150));
    inp.addEventListener("keydown", (e) => {
      if (sg.hidden || active !== inp) return;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        st.si = (st.si + (e.key === "ArrowDown" ? 1 : st.sugg.length - 1)) % st.sugg.length;
        sg.querySelectorAll(".menu-item").forEach((b, i) => b.classList.toggle("hl", i === st.si));
      } else if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); pick(st.si); }
      else if (e.key === "Escape") { e.stopPropagation(); sg.hidden = true; }
    });
  });
  sg.addEventListener("mousedown", (e) => { const b = e.target.closest("[data-pick]"); if (b) { e.preventDefault(); pick(Number(b.dataset.pick)); } });

  const clean = (v) => v.trim().replace(/[,;]\s*$/, "");
  const send = async () => {
    const to = clean(toEl.value), ccv = clean($("#c-cc").value), bccv = clean($("#c-bcc").value);
    if (!to && !ccv && !bccv) return toEl.focus();
    const s = signatureOf(account(st.accId), st.sig);
    let body = $("#c-body").value;
    if (s && s.text) {
      // Bei Weiterleitung/Antwort Signatur vor das Zitat setzen
      const cut = body.search(/\n\n\n(Am .* schrieb|---------- Weitergeleitete)/);
      body = cut >= 0 ? `${body.slice(0, cut)}\n\n-- \n${s.text}${body.slice(cut)}` : `${body}\n\n-- \n${s.text}`;
    }
    const btn = $("#c-send");
    btn.disabled = true; btn.lastChild.textContent = " Sende …";
    try {
      await invoke("send_mail", {
        accountId: st.accId, to, cc: ccv, bcc: bccv, subject: $("#c-subj").value, body,
        attachments: st.files.map(({ name, mime, data }) => ({ name, mime, data })),
        forward: st.forward && st.fwdAtts.length ? st.forward : null,
      });
      closeModal();
      toast("Nachricht gesendet", "ok");
    } catch (e) {
      btn.disabled = false; btn.lastChild.textContent = " Senden";
      toast(String(e), "err");
    }
  };
  $("#c-send").onclick = send;
  root.querySelector(".modal").addEventListener("keydown", (e) => { if (e.ctrlKey && e.key === "Enter") send(); });
  (to ? $("#c-body") : toEl).focus();
  if (quote) $("#c-body").setSelectionRange(0, 0);
}

async function replyOrForward(fwd) {
  const h = curHead();
  if (!h) return;
  closeMenus();
  let b;
  try { b = await ensureBody(); } catch { b = { text: "", reply_to: h.from_addr, attachments: [] }; }
  if (fwd) {
    openCompose({
      subject: fwdSubject(h), quote: "\n\n\n" + forwardText(h, b),
      forward: { accountId: S.cur.id, folder: S.cur.folder, uid: h.uid }, fwdAtts: b.attachments || [],
    });
  } else {
    const quoted = (b.text || "").split("\n").map((l) => "> " + l).join("\n");
    const subj = /^(re|aw):/i.test(h.subject) ? h.subject : "Re: " + h.subject;
    openCompose({ to: b.reply_to || h.from_addr, subject: subj, quote: `\n\n\nAm ${fmtLong(h.ts)} schrieb ${h.from} <${h.from_addr}>:\n${quoted}` });
  }
}

// ---------------------------------------------------------------- Kontakte
let contactsState = { q: "", edit: null, prefill: null };

function openContacts(prefill = null) {
  contactsState = { q: "", edit: prefill ? "new" : null, prefill };
  renderContacts();
}

function renderContacts() {
  const st = contactsState;
  let body, foot;
  if (st.edit !== null) {
    const c = st.edit === "new" ? { name: "", email: "", company: "", phone: "", note: "", quick: false, ...(st.prefill || {}) } : S.cfg.contacts.find((x) => x.id === st.edit);
    body = `<div class="form-grid">
      <label class="inp">Name<input id="k-name" value="${esc(c.name)}" placeholder="Buchhaltung" /></label>
      <label class="inp">E-Mail-Adresse<input id="k-email" value="${esc(c.email)}" placeholder="rechnungen@steuerbuero.de" /></label>
      <label class="inp">Firma<input id="k-company" value="${esc(c.company)}" /></label>
      <label class="inp">Telefon<input id="k-phone" value="${esc(c.phone)}" /></label>
      <label class="inp full">Notiz<textarea id="k-note">${esc(c.note)}</textarea></label>
      <label class="check full"><input type="checkbox" id="k-quick" ${c.quick ? "checked" : ""}/> <span><b>Schnell-Weiterleiten</b><br><small class="muted">Erscheint oben im Menü „Weiterleiten an“ – ein Klick leitet die Mail inkl. aller Anhänge an diesen Kontakt weiter.</small></span></label>
    </div>`;
    foot = `${st.edit !== "new" ? `<button class="btn danger" data-act="del-contact">Löschen</button>` : ""}<span class="grow"></span>
      <button class="btn" data-act="contacts-back">Abbrechen</button><button class="btn primary" data-act="save-contact">Speichern</button>`;
  } else {
    const q = st.q.toLowerCase();
    const list = S.cfg.contacts
      .filter((c) => !q || [c.name, c.email, c.company].some((v) => (v || "").toLowerCase().includes(q)))
      .sort((a, b) => (b.quick - a.quick) || (a.name || a.email).localeCompare(b.name || b.email));
    body = `<div class="search" style="margin:12px 0 6px">${svg('<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>')}<input id="k-search" value="${esc(st.q)}" placeholder="Kontakte durchsuchen" autocomplete="off" /></div>
      ${list.length ? list.map((c) => `<div class="acc-row contact" data-contact="${c.id}">
          <div class="av round" style="background:${colorFor(c.email)}">${esc(initials(c.name || c.email))}</div>
          <div class="meta"><b>${esc(c.name || c.email)} ${c.quick ? '<i class="tag">⚡ Schnell</i>' : ""}</b><span>${esc(c.email)}${c.company ? " · " + esc(c.company) : ""}</span></div>
          <button class="btn" data-mailto="${c.id}" title="E-Mail schreiben">${svg('<path d="M4 20h4L19 9l-4-4L4 16z"/>')}</button>
          <button class="btn" data-edit-contact="${c.id}">Bearbeiten</button></div>`).join("")
        : `<div class="empty-hint">${S.cfg.contacts.length ? "Keine Treffer." : "Noch keine Kontakte. Lege z. B. deine Buchhaltung an und aktiviere „Schnell-Weiterleiten“ – dann gehen Rechnungen mit zwei Klicks raus."}</div>`}`;
    foot = `<span class="grow"></span><button class="btn primary" data-act="new-contact">${svg('<path d="M12 5v14M5 12h14"/>')} Kontakt hinzufügen</button>`;
  }
  $("#modal-root").innerHTML = `<div class="overlay"><div class="modal wide">
    <div class="modal-head"><h3>Kontakte</h3><button class="icon-btn" data-close>${svg('<path d="M6 6l12 12M18 6 6 18"/>')}</button></div>
    <div class="modal-body">${body}</div>
    <div class="modal-foot">${foot}</div></div></div>`;
  const ks = $("#k-search");
  if (ks) { ks.focus(); ks.setSelectionRange(ks.value.length, ks.value.length); ks.oninput = () => { contactsState.q = ks.value; renderContacts(); }; }
  else $("#k-name")?.focus();
}

async function saveContact() {
  const st = contactsState;
  const v = (id) => $(id).value.trim();
  const email = v("#k-email");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return toast("Bitte eine gültige E-Mail-Adresse eingeben", "err");
  const data = { name: v("#k-name"), email, company: v("#k-company"), phone: v("#k-phone"), note: $("#k-note").value, quick: $("#k-quick").checked };
  if (st.edit === "new") S.cfg.contacts.push({ id: Date.now(), ...data });
  else Object.assign(S.cfg.contacts.find((x) => x.id === st.edit), data);
  await saveCfg();
  toast("Kontakt gespeichert", "ok");
  contactsState.edit = null; contactsState.prefill = null;
  renderContacts();
  renderReader();
}

async function deleteContact() {
  const c = S.cfg.contacts.find((x) => x.id === contactsState.edit);
  if (!c || !confirm(`Kontakt „${c.name || c.email}“ löschen?`)) return;
  S.cfg.contacts = S.cfg.contacts.filter((x) => x.id !== c.id);
  await saveCfg();
  contactsState.edit = null;
  renderContacts();
  renderReader();
}

// ---------------------------------------------------------------- Spaltenbreiten
const COLS = { side: [180, 400, 248], list: [280, 720, 400] };
function applyCols() {
  let w = {};
  try { w = JSON.parse(localStorage.getItem("cols") || "{}"); } catch {}
  for (const [k, [min, max, def]] of Object.entries(COLS)) {
    const v = Math.min(max, Math.max(min, Number(w[k]) || def));
    document.documentElement.style.setProperty(`--w-${k}`, v + "px");
  }
}
function initResizers() {
  applyCols();
  document.querySelectorAll(".resizer").forEach((r) => {
    r.addEventListener("pointerdown", (e) => {
      const k = r.dataset.resize, [min, max] = COLS[k];
      const panel = r.parentElement, startX = e.clientX, startW = panel.getBoundingClientRect().width;
      r.setPointerCapture(e.pointerId);
      document.body.classList.add("resizing");
      const move = (ev) => {
        const v = Math.min(max, Math.max(min, startW + ev.clientX - startX));
        document.documentElement.style.setProperty(`--w-${k}`, v + "px");
      };
      const up = () => {
        r.removeEventListener("pointermove", move);
        document.body.classList.remove("resizing");
        let w = {};
        try { w = JSON.parse(localStorage.getItem("cols") || "{}"); } catch {}
        w[k] = parseInt(getComputedStyle(document.documentElement).getPropertyValue(`--w-${k}`));
        try { localStorage.setItem("cols", JSON.stringify(w)); } catch {}
      };
      r.addEventListener("pointermove", move);
      r.addEventListener("pointerup", up, { once: true });
    });
    r.addEventListener("dblclick", () => {
      const k = r.dataset.resize;
      document.documentElement.style.setProperty(`--w-${k}`, COLS[k][2] + "px");
      try { const w = JSON.parse(localStorage.getItem("cols") || "{}"); delete w[k]; localStorage.setItem("cols", JSON.stringify(w)); } catch {}
    });
  });
}

function closeModal() { $("#modal-root").innerHTML = ""; }

// ---------------------------------------------------------------- Einstellungen
const PRESETS = {
  "gmail.com": ["imap.gmail.com", "smtp.gmail.com", 465],
  "googlemail.com": ["imap.gmail.com", "smtp.gmail.com", 465],
  "outlook.com": ["outlook.office365.com", "smtp.office365.com", 587],
  "hotmail.com": ["outlook.office365.com", "smtp.office365.com", 587],
  "live.com": ["outlook.office365.com", "smtp.office365.com", 587],
  "gmx.de": ["imap.gmx.net", "mail.gmx.net", 587],
  "gmx.net": ["imap.gmx.net", "mail.gmx.net", 587],
  "web.de": ["imap.web.de", "smtp.web.de", 587],
  "t-online.de": ["secureimap.t-online.de", "securesmtp.t-online.de", 465],
  "icloud.com": ["imap.mail.me.com", "smtp.mail.me.com", 587],
  "posteo.de": ["posteo.de", "posteo.de", 587],
  "mailbox.org": ["imap.mailbox.org", "smtp.mailbox.org", 465],
  "yahoo.com": ["imap.mail.yahoo.com", "smtp.mail.yahoo.com", 465],
};

let settingsState = { tab: "accounts", edit: null, sigAcc: null };

function openSettings(tab = "accounts", editId = null) {
  settingsState = { tab, edit: editId, sigAcc: settingsState.sigAcc ?? S.accId };
  renderSettings();
}

function accountForm(a) {
  const v = (x) => esc(x ?? "");
  return `<div class="form-grid" id="acc-form">
    <label class="inp">Anzeigename<input id="f-name" value="${v(a?.name)}" placeholder="Max Mustermann" /></label>
    <label class="inp">E-Mail-Adresse<input id="f-email" value="${v(a?.email)}" placeholder="max@firma.de" /></label>
    <label class="inp">Benutzername<input id="f-user" value="${v(a?.username)}" placeholder="meist die E-Mail-Adresse" /></label>
    <label class="inp">Passwort<input id="f-pw" type="password" placeholder="${a ? "unverändert lassen" : "App-Passwort / Passwort"}" /></label>
    <label class="inp">IMAP-Server<div class="row2"><input id="f-imap" value="${v(a?.imap_host)}" placeholder="imap.firma.de" /><input id="f-imapport" value="${v(a?.imap_port ?? 993)}" /></div></label>
    <label class="inp">SMTP-Server<div class="row2"><input id="f-smtp" value="${v(a?.smtp_host)}" placeholder="smtp.firma.de" /><input id="f-smtpport" value="${v(a?.smtp_port ?? 587)}" /></div></label>
    <div class="full hint">IMAP mit SSL/TLS (Port 993). SMTP: Port 465 = SSL/TLS, sonst STARTTLS. Das Passwort wird in der Windows-Anmeldeinformationsverwaltung gespeichert.</div>
  </div>`;
}

function renderSettings() {
  const st = settingsState;
  let body = "", foot = "";
  if (st.tab === "accounts") {
    if (st.edit !== null) {
      const a = st.edit === "new" ? null : account(st.edit);
      body = accountForm(a);
      foot = `${a ? `<button class="btn danger" data-act="del-account">Konto entfernen</button>` : ""}<span class="grow"></span>
        <button class="btn" data-act="back">Abbrechen</button><button class="btn primary" data-act="save-account">${a ? "Speichern" : "Konto hinzufügen"}</button>`;
    } else {
      body = (S.cfg.accounts.length ? S.cfg.accounts.map((a) => `<div class="acc-row">
          <div class="av" style="background:${accColor(a)}">${esc(initials(a.name || a.email))}</div>
          <div class="meta"><b>${esc(a.name)}</b><span>${esc(a.email)} · ${esc(a.imap_host)}</span></div>
          <button class="btn" data-edit="${a.id}">Bearbeiten</button></div>`).join("")
        : `<div class="empty-hint">Noch keine Konten.</div>`);
      foot = `<span class="grow"></span><button class="btn primary" data-act="new-account">${svg('<path d="M12 5v14M5 12h14"/>')} Konto hinzufügen</button>`;
    }
  } else {
    if (!account(st.sigAcc)) st.sigAcc = S.cfg.accounts[0]?.id;
    const a = account(st.sigAcc);
    body = !a ? `<div class="empty-hint">Lege zuerst ein Konto an.</div>` : `
      <label class="inp" style="margin-top:14px">Konto<select id="sig-acc">${S.cfg.accounts.map((x) => `<option value="${x.id}" ${x.id === a.id ? "selected" : ""}>${esc(x.name)} – ${esc(x.email)}</option>`).join("")}</select></label>
      ${a.signatures.map((s, i) => `<div class="sig-card">
        <div class="top"><input data-sig-name="${i}" value="${esc(s.name)}" />
          <label class="radio"><input type="radio" name="defsig" data-sig-def="${i}" ${a.default_signature === i ? "checked" : ""}/> Standard</label>
          <button class="icon-btn" data-sig-del="${i}" title="Löschen">${svg(ICONS.trash)}</button></div>
        <textarea data-sig-text="${i}" placeholder="Signaturtext …">${esc(s.text)}</textarea></div>`).join("")}
      <button class="btn" style="margin-top:12px" data-act="add-sig">${svg('<path d="M12 5v14M5 12h14"/>')} Signatur hinzufügen</button>
      <div class="hint">Lege z. B. „Deutsch“ und „English“ an – beim Verfassen wechselst du mit einem Klick.</div>`;
    foot = `<span class="grow"></span><button class="btn primary" data-close>Fertig</button>`;
  }

  $("#modal-root").innerHTML = `<div class="overlay"><div class="modal wide">
    <div class="modal-head"><h3>Einstellungen</h3><button class="icon-btn" data-close>${svg('<path d="M6 6l12 12M18 6 6 18"/>')}</button></div>
    <div class="tabs"><button class="${st.tab === "accounts" ? "on" : ""}" data-tab="accounts">Konten</button><button class="${st.tab === "sigs" ? "on" : ""}" data-tab="sigs">Signaturen</button></div>
    <div class="modal-body">${body}</div>
    <div class="modal-foot">${foot}</div></div></div>`;

  const email = $("#f-email");
  if (email) email.addEventListener("change", () => {
    const d = email.value.split("@")[1]?.toLowerCase();
    const p = PRESETS[d];
    if (!$("#f-user").value) $("#f-user").value = email.value;
    if (p && !$("#f-imap").value) { $("#f-imap").value = p[0]; $("#f-smtp").value = p[1]; $("#f-smtpport").value = p[2]; }
    else if (d && !$("#f-imap").value) { $("#f-imap").value = "imap." + d; $("#f-smtp").value = "smtp." + d; }
  });
  const sa = $("#sig-acc");
  if (sa) sa.onchange = () => { settingsState.sigAcc = Number(sa.value); renderSettings(); };
}

async function saveAccount() {
  const st = settingsState;
  const isNew = st.edit === "new";
  const val = (id) => $(id).value.trim();
  const email = val("#f-email"), pw = $("#f-pw").value, imap = val("#f-imap");
  if (!email || !imap || (isNew && !pw)) return toast("E-Mail, IMAP-Server und Passwort sind erforderlich", "err");
  const name = val("#f-name") || email;
  const a = isNew
    ? { id: Date.now(), signatures: [{ name: "Deutsch", text: `Viele Grüße\n${name}` }, { name: "English", text: `Best regards\n${name}` }], default_signature: 0 }
    : account(st.edit);
  Object.assign(a, {
    name, email,
    username: val("#f-user") || email,
    imap_host: imap,
    imap_port: Number(val("#f-imapport")) || 993,
    smtp_host: val("#f-smtp") || imap.replace(/^imap\./, "smtp."),
    smtp_port: Number(val("#f-smtpport")) || 587,
  });
  try {
    if (pw) await invoke("set_password", { id: a.id, password: pw });
  } catch (e) { return toast(String(e), "err"); }
  if (isNew) S.cfg.accounts.push(a);
  await saveCfg();
  toast(isNew ? "Konto hinzugefügt" : "Gespeichert", "ok");
  settingsState.edit = null;
  delete S.folders[a.id];
  loadFolders(a.id);
  if (isNew || S.accId === a.id) { closeModal(); openFolder(a.id, "INBOX"); }
  else renderSettings();
}

async function deleteAccount() {
  const a = account(settingsState.edit);
  if (!a || !confirm(`Konto „${a.email}“ aus MailLine entfernen?`)) return;
  S.cfg.accounts = S.cfg.accounts.filter((x) => x.id !== a.id);
  S.cfg.focus_folders = S.cfg.focus_folders.filter((k) => !k.startsWith(a.id + "|"));
  await invoke("delete_password", { id: a.id });
  await saveCfg();
  settingsState.edit = null;
  if (S.accId === a.id) {
    S.cur = null; S.selUid = null; S.accId = S.cfg.accounts[0]?.id ?? null;
    if (S.accId) openFolder(S.accId, "INBOX"); else renderAll();
  } else renderAll();
  renderSettings();
}

// ---------------------------------------------------------------- Ereignisse
document.addEventListener("click", (e) => {
  const t = e.target;
  const star = t.closest("[data-star]");
  if (star) {
    e.stopPropagation();
    const k = star.dataset.star;
    const i = S.cfg.focus_folders.indexOf(k);
    i >= 0 ? S.cfg.focus_folders.splice(i, 1) : S.cfg.focus_folders.push(k);
    saveCfg(); renderSidebar();
    return;
  }
  const f = t.closest("[data-open]");
  if (f) { const k = f.dataset.open, i = k.indexOf("|"); return openFolder(Number(k.slice(0, i)), k.slice(i + 1)); }
  const acc = t.closest("[data-acc]");
  if (acc) return switchAccount(Number(acc.dataset.acc));
  const qf = t.closest("[data-quickfwd]");
  if (qf) return quickForward(Number(qf.dataset.quickfwd));
  const attSave = t.closest("[data-att-save]");
  if (attSave) { e.stopPropagation(); return attachmentAction(Number(attSave.dataset.attSave), false); }
  const attOpen = t.closest("[data-att-open]");
  if (attOpen) return attachmentAction(Number(attOpen.dataset.attOpen), true);
  const ec = t.closest("[data-edit-contact]");
  if (ec) { contactsState.edit = Number(ec.dataset.editContact); return renderContacts(); }
  const mt = t.closest("[data-mailto]");
  if (mt) { const c = S.cfg.contacts.find((x) => x.id === Number(mt.dataset.mailto)); closeModal(); return openCompose({ to: c.email + ", " }); }
  if (!t.closest(".menu-wrap")) closeMenus();
  const msg = t.closest("[data-uid]");
  if (msg) return openMessage(Number(msg.dataset.uid));
  if (t.closest("[data-close]") || t.classList.contains("overlay")) return closeModal();
  const tab = t.closest("[data-tab]");
  if (tab) { settingsState.tab = tab.dataset.tab; settingsState.edit = null; return renderSettings(); }
  const ed = t.closest("[data-edit]");
  if (ed) { settingsState.edit = Number(ed.dataset.edit); return renderSettings(); }
  const sigDel = t.closest("[data-sig-del]");
  if (sigDel) {
    const a = account(settingsState.sigAcc);
    a.signatures.splice(Number(sigDel.dataset.sigDel), 1);
    if (a.default_signature >= a.signatures.length) a.default_signature = 0;
    saveCfg(); return renderSettings();
  }
  const act = t.closest("[data-act]")?.dataset.act;
  switch (act) {
    case "compose": return openCompose();
    case "reply": return replyOrForward(false);
    case "forward": return replyOrForward(true);
    case "settings": return openSettings("accounts");
    case "add-account": return openSettings("accounts", "new");
    case "new-account": settingsState.edit = "new"; return renderSettings();
    case "back": settingsState.edit = null; return renderSettings();
    case "save-account": return saveAccount();
    case "del-account": return deleteAccount();
    case "toggle-focus": return toggleFocus();
    case "edit-focus": S.editFocus = !S.editFocus; return renderSidebar();
    case "images": S.showImages = true; return renderReader();
    case "fwd-menu": { const m = $("#fwd-menu"); const was = m.hidden; closeMenus(); m.hidden = !was; return; }
    case "contacts": closeMenus(); return openContacts();
    case "new-contact": contactsState.edit = "new"; contactsState.prefill = null; return renderContacts();
    case "contacts-back": contactsState.edit = null; return renderContacts();
    case "save-contact": return saveContact();
    case "del-contact": return deleteContact();
    case "save-sender": { const h = curHead(); return openContacts({ name: h.from !== h.from_addr ? h.from : "", email: h.from_addr }); }
    case "add-sig": {
      const a = account(settingsState.sigAcc);
      a.signatures.push({ name: `Signatur ${a.signatures.length + 1}`, text: "" });
      saveCfg(); return renderSettings();
    }
  }
});

document.addEventListener("input", (e) => {
  const t = e.target;
  const a = account(settingsState.sigAcc);
  if (t.dataset.sigName !== undefined && a) { a.signatures[Number(t.dataset.sigName)].name = t.value; saveCfgSoon(); }
  if (t.dataset.sigText !== undefined && a) { a.signatures[Number(t.dataset.sigText)].text = t.value; saveCfgSoon(); }
});
document.addEventListener("change", (e) => {
  const t = e.target;
  if (t.dataset.sigDef !== undefined) { account(settingsState.sigAcc).default_signature = Number(t.dataset.sigDef); saveCfg(); }
});
let saveTimer;
function saveCfgSoon() { clearTimeout(saveTimer); saveTimer = setTimeout(saveCfg, 400); }

function toggleFocus() {
  S.cfg.focus_active = !S.cfg.focus_active;
  S.editFocus = false;
  saveCfg();
  // Beim Einschalten direkt ins erste Fokus-Postfach springen
  if (S.cfg.focus_active && S.cur && !S.cfg.focus_folders.includes(curKey()) && S.cfg.focus_folders.length) {
    const k = S.cfg.focus_folders[0], i = k.indexOf("|");
    openFolder(Number(k.slice(0, i)), k.slice(i + 1));
  } else renderSidebar();
  toast(S.cfg.focus_active ? "Fokus-Modus an" : "Fokus-Modus aus");
}

$("#search").addEventListener("input", (e) => { S.search = e.target.value; renderList(); });
$("#refresh").addEventListener("click", () => S.cur && loadHeads(S.cur.id, S.cur.folder));

document.addEventListener("keydown", (e) => {
  const inField = /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName);
  if (e.key === "Escape") { closeMenus(); if ($("#modal-root").innerHTML) return closeModal(); if (inField) return document.activeElement.blur(); }
  if (e.ctrlKey && !e.shiftKey && /^[1-9]$/.test(e.key)) {
    const a = S.cfg.accounts[Number(e.key) - 1];
    if (a) { e.preventDefault(); switchAccount(a.id); }
    return;
  }
  if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "f") { e.preventDefault(); return toggleFocus(); }
  if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "k") { e.preventDefault(); return openContacts(); }
  if (e.ctrlKey && e.key.toLowerCase() === "k") { e.preventDefault(); return $("#search").focus(); }
  if (e.ctrlKey && e.key.toLowerCase() === "n") { e.preventDefault(); return openCompose(); }
  if (e.key === "F5") { e.preventDefault(); return S.cur && loadHeads(S.cur.id, S.cur.folder); }
  if (inField || $("#modal-root").innerHTML) return;
  if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "j" || e.key === "k") {
    const list = visibleHeads();
    if (!list.length) return;
    e.preventDefault();
    let i = list.findIndex((m) => m.uid === S.selUid);
    i = e.key === "ArrowDown" || e.key === "j" ? Math.min(list.length - 1, i + 1) : Math.max(0, i - 1);
    openMessage(list[i].uid);
    document.querySelector(`.msg[data-uid="${list[i].uid}"]`)?.scrollIntoView({ block: "nearest" });
  }
  if (e.key === "r") replyOrForward(false);
  if (e.key === "w" && curHead()) { const m = $("#fwd-menu"); if (m) m.hidden = !m.hidden; }
  if (e.key === "Delete" && curHead()) { e.preventDefault(); deleteMessages([S.selUid], e.shiftKey); }
  if (e.key === "u" && curHead()) setSeen([S.selUid], curHead().unread);
});

// ---------------------------------------------------------------- Löschen / Verschieben / Gelesen
function isTrashFolder(id, folder) { return folderInfo(folder, id).icon === "trash"; }

/// Entfernt Mails lokal aus der Liste, wählt die nächste aus; gibt eine Rückgängig-Funktion zurück.
function removeLocally(uids) {
  const k = curKey(), before = S.heads[k] || [], sel = S.selUid;
  const vis = visibleHeads();
  let next = null;
  if (uids.includes(sel)) {
    const i = vis.findIndex((m) => m.uid === sel);
    next = vis.slice(i + 1).find((m) => !uids.includes(m.uid)) || vis.slice(0, i).reverse().find((m) => !uids.includes(m.uid)) || null;
  }
  S.heads[k] = before.filter((m) => !uids.includes(m.uid));
  if (uids.includes(sel)) {
    S.selUid = null;
    if (next) openMessage(next.uid); else { renderList(); renderReader(); }
  } else renderList();
  renderListHead(); renderSidebar(); renderRail();
  return () => { S.heads[k] = before; S.selUid = sel; renderList(); renderListHead(); renderReader(); renderSidebar(); renderRail(); };
}

function forgetFolder(id, pred) {
  for (const k of Object.keys(S.heads)) {
    const i = k.indexOf("|");
    if (Number(k.slice(0, i)) === id && pred(k.slice(i + 1))) delete S.heads[k];
  }
}

async function deleteMessages(uids, permanent = false) {
  if (!S.cur || !uids.length) return;
  const { id, folder } = S.cur;
  const perm = permanent || isTrashFolder(id, folder);
  if (perm && !confirm(uids.length > 1 ? `${uids.length} Nachrichten endgültig löschen?` : "Nachricht endgültig löschen? Das kann nicht rückgängig gemacht werden.")) return;
  const undo = removeLocally(uids);
  try {
    const wasPermanent = await invoke("delete_messages", { accountId: id, folder, uids, permanent: perm });
    toast(wasPermanent ? "Endgültig gelöscht" : "In den Papierkorb verschoben", "ok");
    forgetFolder(id, (f) => isTrashFolder(id, f)); // Papierkorb beim nächsten Öffnen neu laden
  } catch (e) {
    undo();
    toast(`Löschen fehlgeschlagen: ${e}`, "err");
  }
}

async function moveMessages(uids, target) {
  if (!S.cur || !uids.length) return;
  const { id, folder } = S.cur;
  const undo = removeLocally(uids);
  try {
    await invoke("move_messages", { accountId: id, folder, uids, target });
    toast(`Verschoben nach „${folderInfo(target, id).label}“`, "ok");
    forgetFolder(id, (f) => f === target);
  } catch (e) {
    undo();
    toast(`Verschieben fehlgeschlagen: ${e}`, "err");
  }
}

async function setSeen(uids, seen) {
  if (!S.cur || !uids.length) return;
  const { id, folder } = S.cur;
  const list = (S.heads[curKey()] || []).filter((m) => uids.includes(m.uid));
  const old = list.map((m) => m.unread);
  list.forEach((m) => (m.unread = !seen));
  renderList(); renderListHead(); renderSidebar(); renderRail();
  try {
    await invoke("set_seen", { accountId: id, folder, uids, seen });
  } catch (e) {
    list.forEach((m, i) => (m.unread = old[i]));
    renderList(); renderListHead(); renderSidebar(); renderRail();
    toast(String(e), "err");
  }
}

// ---------------------------------------------------------------- Kontextmenü
const I = {
  reply: '<path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 5 5v6"/>',
  fwd: '<path d="m15 14 5-5-5-5"/><path d="M20 9H9a5 5 0 0 0-5 5v6"/>',
  read: '<path d="M3 8.5 12 14l9-5.5"/><rect x="3" y="5" width="18" height="14" rx="2"/>',
  unread: '<circle cx="12" cy="12" r="4" fill="currentColor"/>',
  move: ICONS.folder,
  trash: ICONS.trash,
  contact: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0M19 8v6M16 11h6"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/>',
  open: '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  save: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
  refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"/>',
  star: '<path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/>',
  compose: '<path d="M4 20h4L19 9l-4-4L4 16z"/>',
};

let ctxActions = [];
function ctxHtml(items) {
  return items.map((it) => {
    if (it === "-") return '<div class="menu-sep"></div>';
    if (it.label && it.sub) {
      return `<div class="ctx-item has-sub">${svg(it.icon || "")}<span class="l">${esc(it.label)}</span>${svg('<path d="m9 6 6 6-6 6"/>')}
        <div class="ctx-menu sub">${it.sub.length ? ctxHtml(it.sub) : '<div class="menu-empty">Keine Einträge</div>'}</div></div>`;
    }
    if (it.header) return `<div class="menu-label">${esc(it.header)}</div>`;
    const i = ctxActions.push(it.run) - 1;
    return `<button class="ctx-item ${it.danger ? "danger" : ""}" data-ctx="${i}" ${it.disabled ? "disabled" : ""}>${svg(it.icon || "")}<span class="l">${esc(it.label)}</span>${it.kbd ? `<span class="k">${esc(it.kbd)}</span>` : ""}</button>`;
  }).join("");
}

function showCtx(x, y, items) {
  closeCtx(); closeMenus();
  ctxActions = [];
  const el = document.createElement("div");
  el.id = "ctx";
  el.className = "ctx-menu";
  el.innerHTML = ctxHtml(items);
  document.body.appendChild(el);
  const r = el.getBoundingClientRect();
  el.style.left = Math.min(x, innerWidth - r.width - 8) + "px";
  el.style.top = Math.min(y, innerHeight - r.height - 8) + "px";
  // Untermenüs nach links öffnen, wenn rechts kein Platz ist
  if (x + r.width * 2 > innerWidth) el.classList.add("flip");
  el.addEventListener("click", (e) => {
    const b = e.target.closest("[data-ctx]");
    if (!b || b.disabled) return;
    const fn = ctxActions[Number(b.dataset.ctx)];
    closeCtx();
    fn && fn();
  });
}
function closeCtx() { document.getElementById("ctx")?.remove(); }

function messageMenu(uid) {
  const h = (S.heads[curKey()] || []).find((m) => m.uid === uid);
  if (!h) return [];
  const { id, folder } = S.cur;
  const folders = (S.folders[id] || []).filter((f) => f !== folder);
  const contacts = [...S.cfg.contacts].sort((a, b) => b.quick - a.quick);
  const trash = isTrashFolder(id, folder);
  return [
    { label: "Antworten", icon: I.reply, kbd: "R", run: async () => { await openMessage(uid); replyOrForward(false); } },
    { label: "Weiterleiten …", icon: I.fwd, run: async () => { await openMessage(uid); replyOrForward(true); } },
    { label: "Weiterleiten an", icon: I.fwd, sub: contacts.map((c) => ({ label: `${c.quick ? "⚡ " : ""}${c.name || c.email}`, icon: I.contact, run: async () => { await openMessage(uid); quickForward(c.id); } })) },
    "-",
    h.unread
      ? { label: "Als gelesen markieren", icon: I.read, kbd: "U", run: () => setSeen([uid], true) }
      : { label: "Als ungelesen markieren", icon: I.unread, kbd: "U", run: () => setSeen([uid], false) },
    { label: "Verschieben nach", icon: I.move, sub: folders.map((f) => ({ label: " ".repeat(folderInfo(f, id).depth * 3) + folderInfo(f, id).label, icon: ICONS[folderInfo(f, id).icon], run: () => moveMessages([uid], f) })) },
    "-",
    ...(h.from_addr && !isContact(h.from_addr) ? [{ label: "Absender als Kontakt speichern", icon: I.contact, run: () => openContacts({ name: h.from !== h.from_addr ? h.from : "", email: h.from_addr }) }] : []),
    { label: "Absender-Adresse kopieren", icon: I.copy, run: () => copyText(h.from_addr) },
    "-",
    { label: trash ? "Endgültig löschen" : "Löschen", icon: I.trash, kbd: "Entf", danger: true, run: () => deleteMessages([uid], trash) },
    ...(!trash ? [{ label: "Endgültig löschen", icon: I.trash, kbd: "⇧ Entf", danger: true, run: () => deleteMessages([uid], true) }] : []),
  ];
}

function folderMenu(id, folder) {
  const k = key(id, folder), focus = S.cfg.focus_folders.includes(k);
  const unread = (S.heads[k] || []).filter((m) => m.unread).map((m) => m.uid);
  return [
    { label: "Öffnen", icon: I.open, run: () => openFolder(id, folder) },
    { label: "Aktualisieren", icon: I.refresh, run: () => { if (curKey() === k) loadHeads(id, folder); else openFolder(id, folder); } },
    { label: focus ? "Aus Fokus-Postfächern entfernen" : "Als Fokus-Postfach markieren", icon: I.star, run: () => { toggleFocusFolder(k); } },
    "-",
    { label: "Alle als gelesen markieren", icon: I.read, disabled: !unread.length, run: async () => { if (curKey() !== k) openFolder(id, folder); setSeen(unread, true); } },
  ];
}

function accountMenu(id) {
  return [
    { label: "Zu diesem Konto wechseln", icon: I.open, run: () => switchAccount(id) },
    { label: "Neue Nachricht von diesem Konto", icon: I.compose, run: () => { switchAccount(id); openCompose(); } },
    "-",
    { label: "Konto bearbeiten", icon: I.edit, run: () => openSettings("accounts", id) },
    { label: "Signaturen", icon: I.edit, run: () => { settingsState.sigAcc = id; openSettings("sigs"); } },
  ];
}

function toggleFocusFolder(k) {
  const i = S.cfg.focus_folders.indexOf(k);
  i >= 0 ? S.cfg.focus_folders.splice(i, 1) : S.cfg.focus_folders.push(k);
  saveCfg(); renderSidebar();
}

async function copyText(t) {
  try { await navigator.clipboard.writeText(t); toast("Kopiert", "ok"); } catch { toast("Kopieren nicht möglich", "err"); }
}

function selectionMenu(text) {
  return [{ label: "Kopieren", icon: I.copy, kbd: "Strg+C", run: () => copyText(text) }];
}

document.addEventListener("contextmenu", (e) => {
  const t = e.target;
  // In Eingabefeldern das normale Menü (Ausschneiden/Kopieren/Einfügen) lassen
  if (t.closest("input, textarea, [contenteditable]")) return;
  e.preventDefault();
  const sel = String(getSelection() || "").trim();
  if (sel) return showCtx(e.clientX, e.clientY, selectionMenu(sel));
  const msg = t.closest(".msg[data-uid]");
  if (msg) {
    const uid = Number(msg.dataset.uid);
    if (S.selUid !== uid) openMessage(uid);
    return showCtx(e.clientX, e.clientY, messageMenu(uid));
  }
  const f = t.closest("[data-open]");
  if (f) { const k = f.dataset.open, i = k.indexOf("|"); return showCtx(e.clientX, e.clientY, folderMenu(Number(k.slice(0, i)), k.slice(i + 1))); }
  const acc = t.closest("[data-acc]");
  if (acc) return showCtx(e.clientX, e.clientY, accountMenu(Number(acc.dataset.acc)));
  const att = t.closest("[data-att-open]");
  if (att) {
    const idx = Number(att.dataset.attOpen);
    return showCtx(e.clientX, e.clientY, [
      { label: "Öffnen", icon: I.open, run: () => attachmentAction(idx, true) },
      { label: "In Downloads speichern", icon: I.save, run: () => attachmentAction(idx, false) },
    ]);
  }
  if (t.closest("#reader") && curHead()) return showCtx(e.clientX, e.clientY, messageMenu(S.selUid));
  closeCtx();
});
document.addEventListener("mousedown", (e) => { if (!e.target.closest("#ctx")) closeCtx(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeCtx(); }, true);
window.addEventListener("blur", closeCtx);
window.addEventListener("resize", closeCtx);

/// HTML-Mails laufen in einem iframe: Tastatur und Rechtsklick von dort an die App weiterreichen.
function wireIframe(frame) {
  frame.addEventListener("load", () => {
    const doc = frame.contentDocument;
    if (!doc) return;
    doc.addEventListener("keydown", (e) => {
      if (["Delete", "ArrowDown", "ArrowUp", "Escape", "F5"].includes(e.key) || e.ctrlKey || /^[rwujk]$/.test(e.key)) {
        if (e.ctrlKey && e.key.toLowerCase() === "c") return; // Kopieren im iframe normal lassen
        e.preventDefault();
        document.dispatchEvent(new KeyboardEvent("keydown", { key: e.key, ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, bubbles: true }));
      }
    });
    doc.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      const r = frame.getBoundingClientRect();
      const sel = String(doc.getSelection() || "").trim();
      const link = e.target.closest?.("a[href]");
      const items = sel ? selectionMenu(sel) : messageMenu(S.selUid);
      if (link && !sel) items.unshift({ label: "Link-Adresse kopieren", icon: I.copy, run: () => copyText(link.href) }, "-");
      showCtx(r.left + e.clientX, r.top + e.clientY, items);
    });
    doc.addEventListener("mousedown", closeCtx);
  });
}

// Automatisch alle 3 Minuten aktuellen Ordner + Posteingänge aktualisieren
setInterval(() => {
  if (S.cur) loadHeads(S.cur.id, S.cur.folder);
  for (const a of S.cfg.accounts) if (!(S.cur && S.cur.id === a.id && S.cur.folder === "INBOX")) loadHeads(a.id, "INBOX");
}, 180000);

// ---------------------------------------------------------------- Start
(async function init() {
  initResizers();
  S.cfg = await invoke("get_config");
  S.cfg.contacts ||= [];
  S.cfg.accounts.forEach((a) => { a.signatures ||= []; });
  const first = S.cfg.accounts[0];
  if (!first) { renderAll(); return openSettings("accounts", "new"); }
  S.accId = first.id;
  if (S.cfg.focus_active && S.cfg.focus_folders.length) {
    const k = S.cfg.focus_folders[0], i = k.indexOf("|");
    openFolder(Number(k.slice(0, i)), k.slice(i + 1));
  } else openFolder(first.id, "INBOX");
  for (const a of S.cfg.accounts) {
    loadFolders(a.id);
    if (a.id !== S.cur.id) loadHeads(a.id, "INBOX"); // Badges für andere Konten
  }
})();
