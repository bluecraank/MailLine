use crate::cache::Cache;
use crate::config::Account;
use anyhow::{anyhow, Context as _, Result};
use imap::types::Flag;
use imap::Session;
use native_tls::{TlsConnector, TlsStream};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::net::TcpStream;
use std::sync::{Arc, Mutex};

type Sess = Session<TlsStream<TcpStream>>;

/// Wie viele der neuesten Mails pro Ordner offline vorgehalten werden
const SYNC_DEPTH: u32 = 1000;
/// Mails größer als das werden nicht in den Offline-Cache geladen
const MAX_CACHE_SIZE: u32 = 25 * 1024 * 1024;
/// So viele Mails zeigt die Liste pro Ordner
const LIST_LIMIT: u32 = 500;

#[derive(Clone, Debug, Serialize)]
pub struct MsgHead {
    pub uid: u32,
    pub from: String,
    pub from_addr: String,
    pub subject: String,
    pub ts: i64,
    pub unread: bool,
}

#[derive(Serialize)]
pub struct HeadersOut {
    pub msgs: Vec<MsgHead>,
    /// true = Server nicht erreichbar, Liste stammt aus dem Offline-Cache
    pub offline: bool,
}

#[derive(Serialize)]
pub struct FoldersOut {
    pub folders: Vec<Folder>,
    pub offline: bool,
}

#[derive(Serialize, Default)]
pub struct BodyOut {
    pub text: String,
    pub html: Option<String>,
    pub reply_to: String,
    pub to: String,
    pub cc: String,
    pub bcc: String,
    pub message_id: String,
    pub attachments: Vec<AttachmentInfo>,
    pub offline: bool,
}

#[derive(Serialize)]
pub struct AttachmentInfo {
    pub index: usize,
    pub name: String,
    pub mime: String,
    pub size: usize,
}

#[derive(Serialize, Clone)]
pub struct Folder {
    pub name: String,
    pub label: String,
    pub depth: u32,
}

#[derive(Serialize, Clone)]
pub struct SyncProgress {
    pub account: u64,
    pub folder: String,
    pub done: usize,
    pub total: usize,
}

#[derive(Clone, Copy, PartialEq, Eq, Hash)]
enum Lane {
    /// Verbindung für Klicks in der Oberfläche
    Ui,
    /// Eigene Verbindung für die Hintergrund-Synchronisierung, damit die Oberfläche nicht wartet
    Sync,
}

#[derive(Clone, Copy)]
pub enum Special {
    Sent,
    Drafts,
    Trash,
}

impl Special {
    fn attr(self) -> &'static str {
        match self {
            Special::Sent => r"\Sent",
            Special::Drafts => r"\Drafts",
            Special::Trash => r"\Trash",
        }
    }
    fn names(self) -> &'static [&'static str] {
        match self {
            Special::Sent => &["sent", "gesendet", "sent items", "sent messages", "gesendete elemente", "gesendete objekte", "gesendete nachrichten"],
            Special::Drafts => &["drafts", "entwürfe", "draft", "entwurf"],
            Special::Trash => &["trash", "papierkorb", "deleted items", "deleted messages", "gelöschte elemente", "gelöschte objekte", "gelöscht", "bin", "deleted"],
        }
    }
    fn label(self) -> &'static str {
        match self {
            Special::Sent => "Gesendet",
            Special::Drafts => "Entwürfe",
            Special::Trash => "Papierkorb",
        }
    }
}

pub struct Store {
    slots: Mutex<HashMap<(u64, Lane), Arc<Mutex<Option<Sess>>>>>,
    pub cache: Cache,
}

fn connect(acc: &Account) -> Result<Sess> {
    let pw = acc.password().ok_or_else(|| anyhow!("Kein Passwort gespeichert"))?;
    let tls = TlsConnector::builder().build()?;
    let client = imap::connect((acc.imap_host.as_str(), acc.imap_port), &acc.imap_host, &tls)
        .context("IMAP-Verbindung fehlgeschlagen")?;
    client.login(&acc.username, &pw).map_err(|e| anyhow!("Login fehlgeschlagen: {}", e.0))
}

impl Store {
    pub fn new(cache: Cache) -> Self {
        Self { slots: Mutex::new(HashMap::new()), cache }
    }

    /// Gecachte Session pro Konto und Spur; bei Fehler einmal mit neuer Verbindung wiederholen.
    fn with_lane<T>(&self, acc: &Account, lane: Lane, mut f: impl FnMut(&mut Sess) -> Result<T>) -> Result<T> {
        let slot = self.slots.lock().unwrap().entry((acc.id, lane)).or_default().clone();
        let mut g = slot.lock().unwrap();
        if let Some(s) = g.as_mut() {
            if let Ok(v) = f(s) {
                return Ok(v);
            }
            *g = None;
        }
        let mut s = connect(acc)?;
        let r = f(&mut s);
        if r.is_ok() {
            *g = Some(s);
        }
        r
    }

    fn with_session<T>(&self, acc: &Account, f: impl FnMut(&mut Sess) -> Result<T>) -> Result<T> {
        self.with_lane(acc, Lane::Ui, f)
    }

    // ---------------------------------------------------------------- Lesen

    pub fn folders(&self, acc: &Account) -> Result<FoldersOut> {
        match self.with_session(acc, list_folders) {
            Ok(folders) => {
                let _ = self.cache.save_folders(acc.id, &folders);
                Ok(FoldersOut { folders, offline: false })
            }
            Err(e) => {
                let folders = self.cache.folders(acc.id)?;
                if folders.is_empty() {
                    return Err(e);
                }
                Ok(FoldersOut { folders, offline: true })
            }
        }
    }

    pub fn headers(&self, acc: &Account, folder: &str) -> Result<HeadersOut> {
        let online = self.with_session(acc, |s| self.refresh_folder(s, acc.id, folder, 300));
        match online {
            Ok(()) => Ok(HeadersOut { msgs: self.cache.heads(acc.id, folder, LIST_LIMIT)?, offline: false }),
            Err(e) => {
                let msgs = self.cache.heads(acc.id, folder, LIST_LIMIT)?;
                if msgs.is_empty() {
                    return Err(e);
                }
                Ok(HeadersOut { msgs, offline: true })
            }
        }
    }

    /// Holt die neuesten `depth` Kopfzeilen + Flags und gleicht den Cache mit dem Server ab.
    fn refresh_folder(&self, s: &mut Sess, acc: u64, folder: &str, depth: u32) -> Result<()> {
        let mb = s.select(folder)?;
        if let Some(v) = mb.uid_validity {
            self.cache.check_validity(acc, folder, v)?;
        }
        if mb.exists == 0 {
            self.cache.prune(acc, folder, &HashSet::new())?;
            return Ok(());
        }
        let start = mb.exists.saturating_sub(depth - 1).max(1);
        let fetches = s.fetch(
            format!("{start}:{}", mb.exists),
            "(UID FLAGS BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE)])",
        )?;
        let parser = mail_parser::MessageParser::default();
        let heads: Vec<MsgHead> = fetches
            .iter()
            .filter_map(|f| {
                let uid = f.uid?;
                let unread = !f.flags().iter().any(|fl| matches!(fl, Flag::Seen));
                Some(parse_head(&parser, uid, unread, f.header().or_else(|| f.body())))
            })
            .collect();
        self.cache.upsert_heads(acc, folder, &heads)?;
        // Auf dem Server gelöschte/verschobene Mails aus dem Cache entfernen
        let all = s.uid_search("ALL")?;
        self.cache.prune(acc, folder, &all)?;
        Ok(())
    }

    /// Nachricht anzeigen: zuerst aus dem Offline-Cache, sonst vom Server (und dann cachen).
    pub fn body(&self, acc: &Account, folder: &str, uid: u32) -> Result<BodyOut> {
        if let Some(raw) = self.cache.raw(acc.id, folder, uid) {
            return Ok(parse_body(&raw));
        }
        let raw = self
            .with_session(acc, |s| fetch_raw(s, folder, uid))
            .map_err(|e| anyhow!("Offline – diese Nachricht ist noch nicht im Offline-Speicher ({e:#})"))?;
        if raw.len() <= MAX_CACHE_SIZE as usize {
            let _ = self.cache.store_raw(acc.id, folder, uid, &raw, &index_text(&raw));
        }
        Ok(parse_body(&raw))
    }

    pub fn raw(&self, acc: &Account, folder: &str, uid: u32) -> Result<Vec<u8>> {
        if let Some(raw) = self.cache.raw(acc.id, folder, uid) {
            return Ok(raw);
        }
        self.with_session(acc, |s| fetch_raw(s, folder, uid))
    }

    // ---------------------------------------------------------------- Ändern

    pub fn set_seen(&self, acc: &Account, folder: &str, uids: &[u32], seen: bool) -> Result<()> {
        let set = uid_set(uids);
        self.with_session(acc, |s| {
            s.select(folder)?;
            let op = if seen { r"+FLAGS.SILENT (\Seen)" } else { r"-FLAGS.SILENT (\Seen)" };
            s.uid_store(&set, op)?;
            Ok(())
        })?;
        self.cache.set_unread(acc.id, folder, uids, !seen)
    }

    pub fn move_to(&self, acc: &Account, folder: &str, uids: &[u32], target: &str) -> Result<()> {
        let set = uid_set(uids);
        self.with_session(acc, |s| {
            s.select(folder)?;
            move_uids(s, &set, target)
        })?;
        self.cache.remove(acc.id, folder, uids)
    }

    /// Löschen: in den Papierkorb verschieben. Liegt die Mail schon im Papierkorb
    /// (oder es gibt keinen), wird sie endgültig gelöscht. Rückgabe: true = endgültig.
    pub fn delete(&self, acc: &Account, folder: &str, uids: &[u32], permanent: bool) -> Result<bool> {
        let set = uid_set(uids);
        let r = self.with_session(acc, |s| {
            let trash = if permanent { None } else { find_special(s, Special::Trash, "")? };
            s.select(folder)?;
            match trash {
                Some(t) if t != folder => {
                    move_uids(s, &set, &t)?;
                    Ok(false)
                }
                _ => {
                    s.uid_store(&set, r"+FLAGS.SILENT (\Deleted)")?;
                    expunge_uids(s, &set)?;
                    Ok(true)
                }
            }
        })?;
        self.cache.remove(acc.id, folder, uids)?;
        Ok(r)
    }

    /// Nachricht in einem Sonderordner ablegen (Gesendet/Entwürfe). Gibt den Ordnernamen zurück.
    fn append(&self, acc: &Account, kind: Special, over: &str, bytes: &[u8], flags: &[Flag<'static>]) -> Result<String> {
        self.with_session(acc, |s| {
            let folder = find_special(s, kind, over)?
                .ok_or_else(|| anyhow!("Kein {}-Ordner gefunden – bitte in den Konto-Einstellungen auswählen", kind.label()))?;
            s.append_with_flags(&folder, bytes, flags)?;
            Ok(folder)
        })
    }

    pub fn save_sent_copy(&self, acc: &Account, bytes: &[u8]) -> Result<String> {
        self.append(acc, Special::Sent, &acc.sent_folder, bytes, &[Flag::Seen])
    }

    /// Entwurf speichern; ältere Fassungen desselben Entwurfs (gleiche Message-ID) werden ersetzt.
    pub fn save_draft(&self, acc: &Account, bytes: &[u8], message_id: &str) -> Result<String> {
        let folder = self.append(acc, Special::Drafts, &acc.drafts_folder, bytes, &[Flag::Seen, Flag::Draft])?;
        self.remove_drafts(acc, &folder, message_id, true)?;
        Ok(folder)
    }

    /// Entwurf nach dem Senden (oder Verwerfen) entfernen.
    pub fn discard_draft(&self, acc: &Account, message_id: &str) -> Result<()> {
        let folder = self
            .with_session(acc, |s| find_special(s, Special::Drafts, &acc.drafts_folder))?
            .ok_or_else(|| anyhow!("Kein Entwürfe-Ordner gefunden"))?;
        self.remove_drafts(acc, &folder, message_id, false)
    }

    fn remove_drafts(&self, acc: &Account, folder: &str, message_id: &str, keep_newest: bool) -> Result<()> {
        let removed = self.with_session(acc, |s| {
            s.select(folder)?;
            let id = message_id.replace('"', "");
            let mut uids: Vec<u32> = s.uid_search(format!("HEADER Message-ID \"{id}\""))?.into_iter().collect();
            uids.sort_unstable();
            if keep_newest {
                uids.pop();
            }
            if !uids.is_empty() {
                let set = uid_set(&uids);
                s.uid_store(&set, r"+FLAGS.SILENT (\Deleted)")?;
                expunge_uids(s, &set)?;
            }
            Ok(uids)
        })?;
        self.cache.remove(acc.id, folder, &removed)
    }

    // ---------------------------------------------------------------- Offline-Sync

    /// Hält die neuesten Mails aller Ordner offline vor (Kopfzeilen + Inhalt + Suchindex).
    pub fn sync_account(&self, acc: &Account, progress: &dyn Fn(SyncProgress)) -> Result<()> {
        let folders = self.with_lane(acc, Lane::Sync, list_folders)?;
        let _ = self.cache.save_folders(acc.id, &folders);
        let skip = |f: &Folder| {
            let l = f.label.to_lowercase();
            ["spam", "junk", "bulk"].iter().any(|x| l.starts_with(x)) || Special::Trash.names().contains(&l.as_str())
        };
        let mut order: Vec<&Folder> = folders.iter().filter(|f| !skip(f)).collect();
        // Posteingang zuerst, dann Gesendet, dann der Rest
        order.sort_by_key(|f| {
            let l = f.label.to_lowercase();
            if f.name.eq_ignore_ascii_case("INBOX") { 0 } else if Special::Sent.names().contains(&l.as_str()) { 1 } else { 2 }
        });
        for f in order {
            let folder = f.name.as_str();
            if let Err(e) = self.with_lane(acc, Lane::Sync, |s| self.refresh_folder(s, acc.id, folder, SYNC_DEPTH)) {
                eprintln!("Sync {folder}: {e:#}");
                continue;
            }
            let missing = self.cache.missing_bodies(acc.id, folder, SYNC_DEPTH)?;
            let total = missing.len();
            if total == 0 {
                continue;
            }
            let mut done = 0;
            for chunk in missing.chunks(20) {
                let r = self.with_lane(acc, Lane::Sync, |s| {
                    s.select(folder)?;
                    let set = uid_set(chunk);
                    // Erst Größen holen, damit riesige Mails nicht den Speicher füllen
                    let sizes = s.uid_fetch(&set, "(UID RFC822.SIZE)")?;
                    let mut small = vec![];
                    for f in sizes.iter() {
                        let Some(uid) = f.uid else { continue };
                        if f.size.unwrap_or(0) > MAX_CACHE_SIZE {
                            self.cache.mark_too_large(acc.id, folder, uid)?;
                        } else {
                            small.push(uid);
                        }
                    }
                    if small.is_empty() {
                        return Ok(());
                    }
                    let bodies = s.uid_fetch(uid_set(&small), "(UID BODY.PEEK[])")?;
                    for f in bodies.iter() {
                        if let (Some(uid), Some(raw)) = (f.uid, f.body()) {
                            self.cache.store_raw(acc.id, folder, uid, raw, &index_text(raw))?;
                        }
                    }
                    Ok(())
                });
                if let Err(e) = r {
                    eprintln!("Sync {folder}: {e:#}");
                    break;
                }
                done += chunk.len();
                progress(SyncProgress { account: acc.id, folder: f.label.clone(), done, total });
            }
        }
        Ok(())
    }
}

// -------------------------------------------------------------------- IMAP-Helfer

fn list_folders(s: &mut Sess) -> Result<Vec<Folder>> {
    let names = s.list(Some(""), Some("*"))?;
    let mut v: Vec<Folder> = names
        .iter()
        .filter(|n| !n.attributes().iter().any(|a| matches!(a, imap::types::NameAttribute::NoSelect)))
        .map(|n| {
            let name = n.name().to_string();
            let delim = n.delimiter().unwrap_or("/").to_string();
            let parts: Vec<&str> = name.split(delim.as_str()).filter(|p| !p.is_empty()).collect();
            let leaf = parts.last().copied().unwrap_or(name.as_str());
            let mut depth = parts.len().saturating_sub(1) as u32;
            if parts.first().is_some_and(|p| p.eq_ignore_ascii_case("INBOX")) && depth > 0 {
                depth -= 1;
            }
            Folder { label: decode_mutf7(leaf), name, depth }
        })
        .collect();
    v.sort_by_key(|f| (!f.name.eq_ignore_ascii_case("INBOX"), f.name.to_lowercase()));
    Ok(v)
}

fn uid_set(uids: &[u32]) -> String {
    uids.iter().map(|u| u.to_string()).collect::<Vec<_>>().join(",")
}

fn expunge_uids(s: &mut Sess, set: &str) -> Result<()> {
    // UID EXPUNGE (UIDPLUS) löscht nur genau diese Mails; sonst klassisches EXPUNGE
    if s.uid_expunge(set).is_err() {
        s.expunge()?;
    }
    Ok(())
}

fn move_uids(s: &mut Sess, set: &str, target: &str) -> Result<()> {
    if s.uid_mv(set, target).is_ok() {
        return Ok(());
    }
    // Server ohne MOVE-Erweiterung: kopieren + als gelöscht markieren
    s.uid_copy(set, target).with_context(|| format!("Verschieben nach „{target}“ fehlgeschlagen"))?;
    s.uid_store(set, r"+FLAGS.SILENT (\Deleted)")?;
    expunge_uids(s, set)
}

/// Sonderordner finden: manuelle Einstellung > SPECIAL-USE-Attribut > gängige Namen.
fn find_special(s: &mut Sess, kind: Special, over: &str) -> Result<Option<String>> {
    if !over.is_empty() {
        return Ok(Some(over.to_string()));
    }
    let names = s.list(Some(""), Some("*"))?;
    let by_attr = names.iter().find(|n| {
        n.attributes().iter().any(|a| matches!(a, imap::types::NameAttribute::Custom(c) if c.eq_ignore_ascii_case(kind.attr())))
    });
    if let Some(n) = by_attr {
        return Ok(Some(n.name().to_string()));
    }
    for c in kind.names() {
        if let Some(n) = names.iter().find(|n| {
            let delim = n.delimiter().unwrap_or("/");
            decode_mutf7(n.name().rsplit(delim).next().unwrap_or("")).to_lowercase() == *c
        }) {
            return Ok(Some(n.name().to_string()));
        }
    }
    Ok(None)
}

fn fetch_raw(s: &mut Sess, folder: &str, uid: u32) -> Result<Vec<u8>> {
    s.select(folder)?;
    let fetches = s.uid_fetch(uid.to_string(), "BODY.PEEK[]")?;
    fetches
        .iter()
        .find_map(|f| f.body().map(|b| b.to_vec()))
        .ok_or_else(|| anyhow!("Nachricht nicht gefunden"))
}

/// IMAP "modified UTF-7" (RFC 3501) in normalen Text umwandeln, z. B. "Entw&APw-rfe" -> "Entwürfe".
fn decode_mutf7(s: &str) -> String {
    let mut out = String::new();
    let mut rest = s;
    while let Some(i) = rest.find('&') {
        out.push_str(&rest[..i]);
        rest = &rest[i + 1..];
        let Some(end) = rest.find('-') else {
            out.push('&');
            out.push_str(rest);
            return out;
        };
        let chunk = &rest[..end];
        rest = &rest[end + 1..];
        if chunk.is_empty() {
            out.push('&');
            continue;
        }
        let (mut bits, mut nbits, mut units) = (0u32, 0u32, Vec::<u16>::new());
        for c in chunk.bytes() {
            let v = match c {
                b'A'..=b'Z' => c - b'A',
                b'a'..=b'z' => c - b'a' + 26,
                b'0'..=b'9' => c - b'0' + 52,
                b'+' => 62,
                b',' => 63,
                _ => continue,
            } as u32;
            bits = (bits << 6) | v;
            nbits += 6;
            if nbits >= 16 {
                nbits -= 16;
                units.push((bits >> nbits) as u16);
                bits &= (1 << nbits) - 1;
            }
        }
        out.push_str(&String::from_utf16_lossy(&units));
    }
    out.push_str(rest);
    out
}

// -------------------------------------------------------------------- MIME-Helfer

fn parse_head(parser: &mail_parser::MessageParser, uid: u32, unread: bool, header: Option<&[u8]>) -> MsgHead {
    let mut h = MsgHead { uid, from: String::new(), from_addr: String::new(), subject: String::new(), ts: 0, unread };
    if let Some(m) = header.and_then(|b| parser.parse(b)) {
        h.subject = m.subject().unwrap_or("(kein Betreff)").to_string();
        if let Some(a) = m.from().and_then(|a| a.first()) {
            h.from_addr = a.address().unwrap_or("").to_string();
            h.from = a.name().filter(|n| !n.is_empty()).unwrap_or(&h.from_addr).to_string();
        }
        if let Some(d) = m.date() {
            h.ts = d.to_timestamp();
        }
    } else {
        h.subject = "(kein Betreff)".into();
    }
    h
}

fn mime_of(p: &mail_parser::MessagePart) -> String {
    p.content_type()
        .map(|c| match c.subtype() {
            Some(sub) => format!("{}/{}", c.ctype(), sub),
            None => c.ctype().to_string(),
        })
        .unwrap_or_else(|| "application/octet-stream".into())
        .to_lowercase()
}

fn addr_list(l: Option<mail_parser::AddressList>) -> String {
    l.map(|l| l.mailboxes().filter_map(|m| m.address().map(str::to_string)).collect::<Vec<_>>().join(", "))
        .unwrap_or_default()
}

/// Text für den Suchindex: Inhalt + Anhangnamen (begrenzt).
fn index_text(raw: &[u8]) -> String {
    let Some(m) = mail_parser::MessageParser::default().parse(raw) else { return String::new() };
    let mut t = m.body_text(0).map(|t| t.to_string()).unwrap_or_default();
    for p in m.attachments() {
        if let Some(n) = p.attachment_name() {
            t.push('\n');
            t.push_str(n);
        }
    }
    if t.len() > 200_000 {
        let mut cut = 200_000;
        while !t.is_char_boundary(cut) {
            cut -= 1;
        }
        t.truncate(cut);
    }
    t
}

fn parse_body(raw: &[u8]) -> BodyOut {
    use base64::Engine as _;
    let mut out = BodyOut::default();
    let Some(m) = mail_parser::MessageParser::default().parse(raw) else { return out };
    let has_html = m.html_body().any(|p| p.is_content_type("text", "html"));
    let mut html = if has_html { m.body_html(0).map(|h| h.to_string()) } else { None };
    out.text = m.body_text(0).map(|t| t.to_string()).unwrap_or_default();
    if let Some(a) = m.reply_to().or_else(|| m.from()).and_then(|l| l.first()) {
        out.reply_to = a.address().unwrap_or("").to_string();
    }
    out.to = addr_list(m.to());
    out.cc = addr_list(m.cc());
    out.bcc = addr_list(m.bcc());
    out.message_id = m.message_id().unwrap_or("").to_string();
    for (index, p) in m.attachments().enumerate() {
        let mime = mime_of(&p);
        // Eingebettete Bilder (cid:) direkt ins HTML einsetzen
        if let (Some(h), Some(cid)) = (html.as_mut(), p.content_id()) {
            let cid = cid.trim_matches(|c| c == '<' || c == '>');
            let needle = format!("cid:{cid}");
            if h.contains(&needle) {
                let data = base64::engine::general_purpose::STANDARD.encode(p.decoded());
                *h = h.replace(&needle, &format!("data:{mime};base64,{data}"));
                if p.attachment_name().is_none() {
                    continue;
                }
            }
        }
        let name = p.attachment_name().map(|n| n.to_string()).unwrap_or_else(|| format!("Anhang {}", index + 1));
        out.attachments.push(AttachmentInfo { index, name, mime, size: p.decoded_len() });
    }
    out.html = html;
    out
}

/// Anhang speichern. `open = true`: in Temp-Ordner speichern und mit Standard-Programm öffnen,
/// sonst in "Downloads" speichern und im Explorer markieren.
pub fn save_attachment(raw: &[u8], index: usize, open: bool) -> Result<String> {
    let m = mail_parser::MessageParser::default().parse(raw).ok_or_else(|| anyhow!("Nachricht nicht lesbar"))?;
    let p = m.attachments().nth(index).ok_or_else(|| anyhow!("Anhang nicht gefunden"))?;
    let name: String = p
        .attachment_name()
        .unwrap_or("Anhang")
        .chars()
        .map(|c| if "<>:\"/\\|?*".contains(c) || c.is_control() { '_' } else { c })
        .collect();
    let dir = if open {
        let d = std::env::temp_dir().join("MailLine");
        std::fs::create_dir_all(&d)?;
        d
    } else {
        dirs::download_dir().unwrap_or_else(std::env::temp_dir)
    };
    let path = std::path::Path::new(&name);
    let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("Anhang").to_string();
    let ext = path.extension().and_then(|s| s.to_str()).map(|e| format!(".{e}")).unwrap_or_default();
    let mut target = dir.join(&name);
    let mut n = 1;
    while target.exists() && !open {
        target = dir.join(format!("{stem} ({n}){ext}"));
        n += 1;
    }
    std::fs::write(&target, p.decoded())?;
    if open {
        std::process::Command::new("cmd").args(["/C", "start", ""]).arg(&target).spawn()?;
    } else {
        std::process::Command::new("explorer").arg(format!("/select,{}", target.display())).spawn()?;
    }
    Ok(target.display().to_string())
}

#[derive(serde::Deserialize, Serialize)]
pub struct OutAttachment {
    pub name: String,
    pub mime: String,
    pub data: String, // Base64
}

/// Alle Anhänge einer Nachricht (für Weiterleitungen und Entwürfe) als OutAttachment liefern.
pub fn attachments_of(raw: &[u8]) -> Vec<OutAttachment> {
    use base64::Engine as _;
    let Some(m) = mail_parser::MessageParser::default().parse(raw) else { return vec![] };
    m.attachments()
        .filter_map(|p| {
            let name = p.attachment_name()?.to_string();
            Some(OutAttachment {
                name,
                mime: mime_of(&p),
                data: base64::engine::general_purpose::STANDARD.encode(p.decoded()),
            })
        })
        .collect()
}

// -------------------------------------------------------------------- Senden & Entwürfe

fn parse_list(s: &str) -> Result<Vec<lettre::message::Mailbox>> {
    s.split([',', ';'])
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|r| r.parse().with_context(|| format!("Ungültige Empfängeradresse: {r}")))
        .collect()
}

pub struct Draft {
    pub to: String,
    pub cc: String,
    pub bcc: String,
    pub subject: String,
    pub body: String,
    pub attachments: Vec<OutAttachment>,
}

pub fn new_message_id(acc: &Account) -> String {
    let t = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default();
    let domain = acc.email.split('@').nth(1).unwrap_or("mailline.local");
    format!("<{}.{}.{}@{}>", t.as_secs(), t.subsec_nanos(), std::process::id(), domain)
}

/// Baut die Nachricht. `draft = true`: BCC bleibt erhalten, Empfänger sind optional.
fn build_message(acc: &Account, d: Draft, draft: bool, message_id: Option<String>) -> Result<lettre::Message> {
    use base64::Engine as _;
    use lettre::address::Envelope;
    use lettre::message::{header::ContentType, Attachment, Mailbox, MultiPart, SinglePart};
    let from = Mailbox::new(
        (!acc.name.is_empty()).then(|| acc.name.clone()),
        acc.email.parse().context("Ungültige Absenderadresse")?,
    );
    let mut builder = lettre::Message::builder().from(from.clone()).subject(d.subject.as_str()).message_id(message_id);
    let (to, cc, bcc) = (parse_list(&d.to)?, parse_list(&d.cc)?, parse_list(&d.bcc)?);
    if to.is_empty() && cc.is_empty() && bcc.is_empty() {
        if !draft {
            return Err(anyhow!("Kein Empfänger angegeben"));
        }
        // Entwurf ohne Empfänger: Umschlag nur pro forma (wird nie versendet)
        builder = builder.envelope(Envelope::new(Some(from.email.clone()), vec![from.email.clone()])?);
    }
    for mb in to {
        builder = builder.to(mb);
    }
    for mb in cc {
        builder = builder.cc(mb);
    }
    // BCC: beim Versand entfernt lettre den Header, im Entwurf bleibt er erhalten
    for mb in bcc {
        builder = builder.bcc(mb);
    }
    if draft {
        builder = builder.keep_bcc();
    }
    // Wichtig: explizit UTF-8, sonst kommen Umlaute beim Empfänger kaputt an.
    let text = SinglePart::builder().header(ContentType::TEXT_PLAIN).body(d.body);
    let msg = if d.attachments.is_empty() {
        builder.singlepart(text)?
    } else {
        let mut mp = MultiPart::mixed().singlepart(text);
        for a in d.attachments {
            let bytes = base64::engine::general_purpose::STANDARD.decode(a.data.as_bytes()).context("Anhang beschädigt")?;
            let ct = ContentType::parse(&a.mime).unwrap_or_else(|_| ContentType::parse("application/octet-stream").unwrap());
            mp = mp.singlepart(Attachment::new(a.name).body(bytes, ct));
        }
        builder.multipart(mp)?
    };
    Ok(msg)
}

/// Sendet per SMTP und gibt die versendete Nachricht (für die Gesendet-Kopie) zurück.
pub fn send(acc: &Account, d: Draft) -> Result<Vec<u8>> {
    use lettre::transport::smtp::authentication::Credentials;
    use lettre::{SmtpTransport, Transport};
    let pw = acc.password().ok_or_else(|| anyhow!("Kein Passwort gespeichert"))?;
    let msg = build_message(acc, d, false, Some(new_message_id(acc)))?;
    let transport = if acc.smtp_port == 465 {
        SmtpTransport::relay(&acc.smtp_host)?
    } else {
        SmtpTransport::starttls_relay(&acc.smtp_host)?
    };
    transport
        .port(acc.smtp_port)
        .credentials(Credentials::new(acc.username.clone(), pw))
        .build()
        .send(&msg)?;
    Ok(msg.formatted())
}

pub fn draft_bytes(acc: &Account, d: Draft, message_id: &str) -> Result<Vec<u8>> {
    Ok(build_message(acc, d, true, Some(message_id.to_string()))?.formatted())
}
