//! Lokaler Offline-Cache (SQLite) mit Volltextindex (FTS5).
//! Liegt unter %LOCALAPPDATA%\MailLine\cache.db.

use crate::backend::{Folder, MsgHead};
use anyhow::Result;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use std::collections::HashSet;
use std::sync::Mutex;

pub struct Cache {
    db: Mutex<Connection>,
}

#[derive(Serialize)]
pub struct SearchHit {
    pub account: u64,
    pub folder: String,
    pub uid: u32,
    pub from: String,
    pub from_addr: String,
    pub subject: String,
    pub ts: i64,
    pub unread: bool,
    pub snippet: String,
}

/// has_body: 0 = noch nicht geladen, 1 = vollständig im Cache, 2 = zu groß (nur online)
const SCHEMA: &str = r#"
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
CREATE TABLE IF NOT EXISTS folders (
    account INTEGER NOT NULL, name TEXT NOT NULL, label TEXT NOT NULL, depth INTEGER NOT NULL,
    PRIMARY KEY (account, name)
);
CREATE TABLE IF NOT EXISTS folder_state (
    account INTEGER NOT NULL, name TEXT NOT NULL, uidvalidity INTEGER NOT NULL,
    PRIMARY KEY (account, name)
);
CREATE TABLE IF NOT EXISTS msgs (
    id INTEGER PRIMARY KEY,
    account INTEGER NOT NULL, folder TEXT NOT NULL, uid INTEGER NOT NULL,
    from_name TEXT NOT NULL, from_addr TEXT NOT NULL, subject TEXT NOT NULL,
    ts INTEGER NOT NULL, unread INTEGER NOT NULL,
    has_body INTEGER NOT NULL DEFAULT 0, raw BLOB,
    UNIQUE (account, folder, uid)
);
CREATE INDEX IF NOT EXISTS msgs_list ON msgs (account, folder, ts DESC);
CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(
    subject, from_name, from_addr, body,
    tokenize = 'unicode61 remove_diacritics 2'
);
"#;

impl Cache {
    pub fn open() -> Result<Self> {
        let mut dir = dirs::data_local_dir().unwrap_or_else(std::env::temp_dir);
        dir.push("MailLine");
        std::fs::create_dir_all(&dir)?;
        let conn = Connection::open(dir.join("cache.db"))?;
        conn.execute_batch(SCHEMA)?;
        Ok(Self { db: Mutex::new(conn) })
    }

    /// Fallback, falls die Datei nicht geöffnet werden kann: Cache nur im Speicher.
    pub fn in_memory() -> Self {
        let conn = Connection::open_in_memory().expect("SQLite");
        conn.execute_batch(SCHEMA).expect("Schema");
        Self { db: Mutex::new(conn) }
    }

    // ---------------------------------------------------------------- Ordner

    pub fn save_folders(&self, acc: u64, folders: &[Folder]) -> Result<()> {
        let mut db = self.db.lock().unwrap();
        let tx = db.transaction()?;
        tx.execute("DELETE FROM folders WHERE account = ?1", params![acc as i64])?;
        for f in folders {
            tx.execute(
                "INSERT INTO folders (account, name, label, depth) VALUES (?1, ?2, ?3, ?4)",
                params![acc as i64, f.name, f.label, f.depth],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn folders(&self, acc: u64) -> Result<Vec<Folder>> {
        let db = self.db.lock().unwrap();
        let mut st = db.prepare("SELECT name, label, depth FROM folders WHERE account = ?1")?;
        let v = st
            .query_map(params![acc as i64], |r| Ok(Folder { name: r.get(0)?, label: r.get(1)?, depth: r.get(2)? }))?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(v)
    }

    /// Prüft UIDVALIDITY; hat sie sich geändert, sind alle gecachten UIDs ungültig.
    pub fn check_validity(&self, acc: u64, folder: &str, validity: u32) -> Result<()> {
        let db = self.db.lock().unwrap();
        let old: Option<i64> = db
            .query_row(
                "SELECT uidvalidity FROM folder_state WHERE account = ?1 AND name = ?2",
                params![acc as i64, folder],
                |r| r.get(0),
            )
            .optional()?;
        if old.is_some_and(|o| o != validity as i64) {
            db.execute(
                "DELETE FROM fts WHERE rowid IN (SELECT id FROM msgs WHERE account = ?1 AND folder = ?2)",
                params![acc as i64, folder],
            )?;
            db.execute("DELETE FROM msgs WHERE account = ?1 AND folder = ?2", params![acc as i64, folder])?;
        }
        db.execute(
            "INSERT INTO folder_state (account, name, uidvalidity) VALUES (?1, ?2, ?3)
             ON CONFLICT (account, name) DO UPDATE SET uidvalidity = excluded.uidvalidity",
            params![acc as i64, folder, validity as i64],
        )?;
        Ok(())
    }

    // ---------------------------------------------------------------- Nachrichten

    pub fn upsert_heads(&self, acc: u64, folder: &str, heads: &[MsgHead]) -> Result<()> {
        let mut db = self.db.lock().unwrap();
        let tx = db.transaction()?;
        for h in heads {
            let inserted = tx.execute(
                "INSERT OR IGNORE INTO msgs (account, folder, uid, from_name, from_addr, subject, ts, unread)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![acc as i64, folder, h.uid, h.from, h.from_addr, h.subject, h.ts, h.unread],
            )?;
            if inserted == 1 {
                let id = tx.last_insert_rowid();
                tx.execute(
                    "INSERT INTO fts (rowid, subject, from_name, from_addr, body) VALUES (?1, ?2, ?3, ?4, '')",
                    params![id, h.subject, h.from, h.from_addr],
                )?;
            } else {
                tx.execute(
                    "UPDATE msgs SET unread = ?4 WHERE account = ?1 AND folder = ?2 AND uid = ?3",
                    params![acc as i64, folder, h.uid, h.unread],
                )?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    /// Entfernt alle gecachten Nachrichten des Ordners, die es auf dem Server nicht mehr gibt.
    pub fn prune(&self, acc: u64, folder: &str, keep: &HashSet<u32>) -> Result<()> {
        let gone: Vec<u32> = {
            let db = self.db.lock().unwrap();
            let mut st = db.prepare("SELECT uid FROM msgs WHERE account = ?1 AND folder = ?2")?;
            let all = st.query_map(params![acc as i64, folder], |r| r.get::<_, u32>(0))?;
            all.filter_map(|u| u.ok()).filter(|u| !keep.contains(u)).collect()
        };
        self.remove(acc, folder, &gone)
    }

    pub fn remove(&self, acc: u64, folder: &str, uids: &[u32]) -> Result<()> {
        let mut db = self.db.lock().unwrap();
        let tx = db.transaction()?;
        for uid in uids {
            tx.execute(
                "DELETE FROM fts WHERE rowid = (SELECT id FROM msgs WHERE account = ?1 AND folder = ?2 AND uid = ?3)",
                params![acc as i64, folder, uid],
            )?;
            tx.execute(
                "DELETE FROM msgs WHERE account = ?1 AND folder = ?2 AND uid = ?3",
                params![acc as i64, folder, uid],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn purge_account(&self, acc: u64) -> Result<()> {
        let db = self.db.lock().unwrap();
        db.execute("DELETE FROM fts WHERE rowid IN (SELECT id FROM msgs WHERE account = ?1)", params![acc as i64])?;
        for t in ["msgs", "folders", "folder_state"] {
            db.execute(&format!("DELETE FROM {t} WHERE account = ?1"), params![acc as i64])?;
        }
        Ok(())
    }

    pub fn heads(&self, acc: u64, folder: &str, limit: u32) -> Result<Vec<MsgHead>> {
        let db = self.db.lock().unwrap();
        let mut st = db.prepare(
            "SELECT uid, from_name, from_addr, subject, ts, unread FROM msgs
             WHERE account = ?1 AND folder = ?2 ORDER BY ts DESC, uid DESC LIMIT ?3",
        )?;
        let v = st
            .query_map(params![acc as i64, folder, limit], |r| {
                Ok(MsgHead {
                    uid: r.get(0)?,
                    from: r.get(1)?,
                    from_addr: r.get(2)?,
                    subject: r.get(3)?,
                    ts: r.get(4)?,
                    unread: r.get(5)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(v)
    }

    pub fn set_unread(&self, acc: u64, folder: &str, uids: &[u32], unread: bool) -> Result<()> {
        let db = self.db.lock().unwrap();
        for uid in uids {
            db.execute(
                "UPDATE msgs SET unread = ?4 WHERE account = ?1 AND folder = ?2 AND uid = ?3",
                params![acc as i64, folder, uid, unread],
            )?;
        }
        Ok(())
    }

    pub fn raw(&self, acc: u64, folder: &str, uid: u32) -> Option<Vec<u8>> {
        let db = self.db.lock().unwrap();
        db.query_row(
            "SELECT raw FROM msgs WHERE account = ?1 AND folder = ?2 AND uid = ?3 AND has_body = 1",
            params![acc as i64, folder, uid],
            |r| r.get::<_, Option<Vec<u8>>>(0),
        )
        .optional()
        .ok()
        .flatten()
        .flatten()
    }

    /// Vollständige Nachricht speichern und den Text in den Suchindex aufnehmen.
    pub fn store_raw(&self, acc: u64, folder: &str, uid: u32, raw: &[u8], text: &str) -> Result<()> {
        let db = self.db.lock().unwrap();
        let row: Option<(i64, String, String, String)> = db
            .query_row(
                "SELECT id, subject, from_name, from_addr FROM msgs WHERE account = ?1 AND folder = ?2 AND uid = ?3",
                params![acc as i64, folder, uid],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .optional()?;
        let Some((id, subject, from, addr)) = row else { return Ok(()) };
        db.execute("UPDATE msgs SET raw = ?2, has_body = 1 WHERE id = ?1", params![id, raw])?;
        db.execute("DELETE FROM fts WHERE rowid = ?1", params![id])?;
        db.execute(
            "INSERT INTO fts (rowid, subject, from_name, from_addr, body) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![id, subject, from, addr, text],
        )?;
        Ok(())
    }

    pub fn mark_too_large(&self, acc: u64, folder: &str, uid: u32) -> Result<()> {
        let db = self.db.lock().unwrap();
        db.execute(
            "UPDATE msgs SET has_body = 2 WHERE account = ?1 AND folder = ?2 AND uid = ?3",
            params![acc as i64, folder, uid],
        )?;
        Ok(())
    }

    pub fn missing_bodies(&self, acc: u64, folder: &str, limit: u32) -> Result<Vec<u32>> {
        let db = self.db.lock().unwrap();
        let mut st = db.prepare(
            "SELECT uid FROM msgs WHERE account = ?1 AND folder = ?2 AND has_body = 0 ORDER BY uid DESC LIMIT ?3",
        )?;
        let v = st.query_map(params![acc as i64, folder, limit], |r| r.get(0))?.collect::<Result<Vec<_>, _>>()?;
        Ok(v)
    }

    pub fn stats(&self) -> (u64, u64) {
        let db = self.db.lock().unwrap();
        db.query_row("SELECT COUNT(*), COALESCE(SUM(has_body = 1), 0) FROM msgs", [], |r| {
            Ok((r.get::<_, i64>(0)? as u64, r.get::<_, i64>(1)? as u64))
        })
        .unwrap_or((0, 0))
    }

    // ---------------------------------------------------------------- Suche

    pub fn search(&self, query: &str, limit: u32) -> Result<Vec<SearchHit>> {
        // Jedes Wort als Präfix-Suche, alle Wörter müssen vorkommen
        let q = query
            .split_whitespace()
            .map(|w| w.replace('"', ""))
            .filter(|w| !w.is_empty())
            .map(|w| format!("\"{w}\"*"))
            .collect::<Vec<_>>()
            .join(" ");
        if q.is_empty() {
            return Ok(vec![]);
        }
        let db = self.db.lock().unwrap();
        let mut st = db.prepare(
            "SELECT m.account, m.folder, m.uid, m.from_name, m.from_addr, m.subject, m.ts, m.unread,
                    snippet(fts, 3, char(1), char(2), '…', 16)
             FROM fts JOIN msgs m ON m.id = fts.rowid
             WHERE fts MATCH ?1 ORDER BY m.ts DESC LIMIT ?2",
        )?;
        let v = st
            .query_map(params![q, limit], |r| {
                Ok(SearchHit {
                    account: r.get::<_, i64>(0)? as u64,
                    folder: r.get(1)?,
                    uid: r.get(2)?,
                    from: r.get(3)?,
                    from_addr: r.get(4)?,
                    subject: r.get(5)?,
                    ts: r.get(6)?,
                    unread: r.get(7)?,
                    snippet: r.get::<_, Option<String>>(8)?.unwrap_or_default(),
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(v)
    }
}
