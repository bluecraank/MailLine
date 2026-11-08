use crate::config::Account;
use anyhow::{anyhow, Context as _, Result};
use imap::Session;
use native_tls::{TlsConnector, TlsStream};
use serde::Serialize;
use std::collections::HashMap;
use std::net::TcpStream;
use std::sync::{Arc, Mutex};

type Sess = Session<TlsStream<TcpStream>>;

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
pub struct BodyOut {
    pub text: String,
    pub html: Option<String>,
    pub reply_to: String,
    pub attachments: Vec<AttachmentInfo>,
}

#[derive(Serialize)]
pub struct AttachmentInfo {
    pub index: usize,
    pub name: String,
    pub mime: String,
    pub size: usize,
}

#[derive(Default)]
pub struct Store {
    slots: Mutex<HashMap<u64, Arc<Mutex<Option<Sess>>>>>,
}

fn connect(acc: &Account) -> Result<Sess> {
    let pw = acc.password().ok_or_else(|| anyhow!("Kein Passwort gespeichert"))?;
    let tls = TlsConnector::builder().build()?;
    let client = imap::connect((acc.imap_host.as_str(), acc.imap_port), &acc.imap_host, &tls)
        .context("IMAP-Verbindung fehlgeschlagen")?;
    client.login(&acc.username, &pw).map_err(|e| anyhow!("Login fehlgeschlagen: {}", e.0))
}

impl Store {
    /// Gecachte Session pro Konto; bei Fehler einmal mit neuer Verbindung wiederholen.
    fn with_session<T>(&self, acc: &Account, mut f: impl FnMut(&mut Sess) -> Result<T>) -> Result<T> {
        let slot = self.slots.lock().unwrap().entry(acc.id).or_default().clone();
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

    pub fn folders(&self, acc: &Account) -> Result<Vec<Folder>> {
        self.with_session(acc, |s| {
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
        })
    }

    pub fn headers(&self, acc: &Account, folder: &str) -> Result<Vec<MsgHead>> {
        self.with_session(acc, |s| fetch_headers(s, folder))
    }

    pub fn body(&self, acc: &Account, folder: &str, uid: u32) -> Result<BodyOut> {
        self.with_session(acc, |s| fetch_body(s, folder, uid))
    }

    pub fn raw(&self, acc: &Account, folder: &str, uid: u32) -> Result<Vec<u8>> {
        self.with_session(acc, |s| fetch_raw(s, folder, uid))
    }

    pub fn set_seen(&self, acc: &Account, folder: &str, uids: &[u32], seen: bool) -> Result<()> {
        let set = uid_set(uids);
        self.with_session(acc, |s| {
            s.select(folder)?;
            let op = if seen { r"+FLAGS.SILENT (\Seen)" } else { r"-FLAGS.SILENT (\Seen)" };
            s.uid_store(&set, op)?;
            Ok(())
        })
    }

    /// Verschiebt Nachrichten in einen anderen Ordner.
    pub fn move_to(&self, acc: &Account, folder: &str, uids: &[u32], target: &str) -> Result<()> {
        let set = uid_set(uids);
        self.with_session(acc, |s| {
            s.select(folder)?;
            move_uids(s, &set, target)
        })
    }

    /// Löschen: in den Papierkorb verschieben. Liegt die Mail schon im Papierkorb
    /// (oder es gibt keinen), wird sie endgültig gelöscht. Rückgabe: true = endgültig.
    pub fn delete(&self, acc: &Account, folder: &str, uids: &[u32], permanent: bool) -> Result<bool> {
        let set = uid_set(uids);
        self.with_session(acc, |s| {
            let trash = if permanent { None } else { find_trash(s)? };
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
        })
    }
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

/// Papierkorb finden: zuerst per SPECIAL-USE-Attribut (\Trash), sonst über gängige Namen.
fn find_trash(s: &mut Sess) -> Result<Option<String>> {
    let names = s.list(Some(""), Some("*"))?;
    let by_attr = names.iter().find(|n| {
        n.attributes().iter().any(|a| matches!(a, imap::types::NameAttribute::Custom(c) if c.eq_ignore_ascii_case(r"\Trash")))
    });
    if let Some(n) = by_attr {
        return Ok(Some(n.name().to_string()));
    }
    const CANDIDATES: [&str; 8] = ["trash", "papierkorb", "deleted items", "deleted messages", "gelöschte elemente", "gelöscht", "bin", "deleted"];
    for c in CANDIDATES {
        if let Some(n) = names.iter().find(|n| {
            let delim = n.delimiter().unwrap_or("/");
            let leaf = decode_mutf7(n.name().rsplit(delim).next().unwrap_or(""));
            leaf.eq_ignore_ascii_case(c)
        }) {
            return Ok(Some(n.name().to_string()));
        }
    }
    Ok(None)
}

#[derive(Serialize)]
pub struct Folder {
    pub name: String,
    pub label: String,
    pub depth: u32,
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

fn fetch_headers(s: &mut Sess, folder: &str) -> Result<Vec<MsgHead>> {
    let mb = s.select(folder)?;
    if mb.exists == 0 {
        return Ok(vec![]);
    }
    let start = mb.exists.saturating_sub(99).max(1);
    let fetches = s.fetch(
        format!("{start}:{}", mb.exists),
        "(UID FLAGS BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE)])",
    )?;
    let parser = mail_parser::MessageParser::default();
    let mut out = Vec::new();
    for f in fetches.iter() {
        let Some(uid) = f.uid else { continue };
        let unread = !f.flags().iter().any(|fl| matches!(fl, imap::types::Flag::Seen));
        let (mut from, mut from_addr, mut subject, mut ts) = (String::new(), String::new(), String::new(), 0i64);
        if let Some(h) = f.header().or_else(|| f.body()) {
            if let Some(m) = parser.parse(h) {
                subject = m.subject().unwrap_or("(kein Betreff)").to_string();
                if let Some(a) = m.from().and_then(|a| a.first()) {
                    from_addr = a.address().unwrap_or("").to_string();
                    from = a.name().filter(|n| !n.is_empty()).unwrap_or(&from_addr).to_string();
                }
                if let Some(d) = m.date() {
                    ts = d.to_timestamp();
                }
            }
        }
        out.push(MsgHead { uid, from, from_addr, subject, ts, unread });
    }
    out.sort_by(|a, b| b.uid.cmp(&a.uid));
    Ok(out)
}

fn fetch_raw(s: &mut Sess, folder: &str, uid: u32) -> Result<Vec<u8>> {
    s.select(folder)?;
    let fetches = s.uid_fetch(uid.to_string(), "BODY.PEEK[]")?;
    fetches
        .iter()
        .find_map(|f| f.body().map(|b| b.to_vec()))
        .ok_or_else(|| anyhow!("Nachricht nicht gefunden"))
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

fn fetch_body(s: &mut Sess, folder: &str, uid: u32) -> Result<BodyOut> {
    use base64::Engine as _;
    let raw = fetch_raw(s, folder, uid)?;
    let msg = mail_parser::MessageParser::default().parse(&raw[..]);
    let mut out = BodyOut { text: String::new(), html: None, reply_to: String::new(), attachments: vec![] };
    if let Some(m) = msg {
        let has_html = m.html_body().any(|p| p.is_content_type("text", "html"));
        let mut html = if has_html { m.body_html(0).map(|h| h.to_string()) } else { None };
        out.text = m.body_text(0).map(|t| t.to_string()).unwrap_or_default();
        if let Some(list) = m.reply_to().or_else(|| m.from()) {
            if let Some(a) = list.first() {
                out.reply_to = a.address().unwrap_or("").to_string();
            }
        }
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
            let name = p
                .attachment_name()
                .map(|n| n.to_string())
                .unwrap_or_else(|| format!("Anhang {}", index + 1));
            out.attachments.push(AttachmentInfo { index, name, mime, size: p.decoded_len() });
        }
        out.html = html;
    }
    let _ = s.uid_store(uid.to_string(), r"+FLAGS (\Seen)");
    Ok(out)
}

/// Anhang speichern. `open = true`: in Temp-Ordner speichern und mit Standard-Programm oeffnen,
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

#[derive(serde::Deserialize)]
pub struct OutAttachment {
    pub name: String,
    pub mime: String,
    pub data: String, // Base64
}

/// Alle Anhänge einer Original-Nachricht (für Weiterleitungen) als OutAttachment liefern.
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

fn parse_list(s: &str) -> Result<Vec<lettre::message::Mailbox>> {
    s.split([',', ';'])
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|r| r.parse().with_context(|| format!("Ungültige Empfängeradresse: {r}")))
        .collect()
}

pub struct Recipients<'a> {
    pub to: &'a str,
    pub cc: &'a str,
    pub bcc: &'a str,
}

pub fn send(acc: &Account, rcpt: Recipients, subject: &str, body: String, attachments: Vec<OutAttachment>) -> Result<()> {
    use base64::Engine as _;
    use lettre::message::{header::ContentType, Attachment, Mailbox, MultiPart, SinglePart};
    use lettre::transport::smtp::authentication::Credentials;
    use lettre::{Message, SmtpTransport, Transport};
    let pw = acc.password().ok_or_else(|| anyhow!("Kein Passwort gespeichert"))?;
    let from = Mailbox::new(
        (!acc.name.is_empty()).then(|| acc.name.clone()),
        acc.email.parse().context("Ungueltige Absenderadresse")?,
    );
    let mut builder = Message::builder().from(from).subject(subject);
    let (to, cc, bcc) = (parse_list(rcpt.to)?, parse_list(rcpt.cc)?, parse_list(rcpt.bcc)?);
    if to.is_empty() && cc.is_empty() && bcc.is_empty() {
        return Err(anyhow!("Kein Empfänger angegeben"));
    }
    for mb in to {
        builder = builder.to(mb);
    }
    for mb in cc {
        builder = builder.cc(mb);
    }
    // BCC landet nur im SMTP-Umschlag, lettre entfernt den Header vor dem Versand
    for mb in bcc {
        builder = builder.bcc(mb);
    }
    // Wichtig: explizit UTF-8, sonst kommen Umlaute beim Empfaenger kaputt an.
    let text = SinglePart::builder().header(ContentType::TEXT_PLAIN).body(body);
    let msg = if attachments.is_empty() {
        builder.singlepart(text)?
    } else {
        let mut mp = MultiPart::mixed().singlepart(text);
        for a in attachments {
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(a.data.as_bytes())
                .context("Anhang beschädigt")?;
            let ct = ContentType::parse(&a.mime)
                .unwrap_or_else(|_| ContentType::parse("application/octet-stream").unwrap());
            mp = mp.singlepart(Attachment::new(a.name).body(bytes, ct));
        }
        builder.multipart(mp)?
    };
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
    Ok(())
}
