use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Serialize, Deserialize, Clone, Default)]
pub struct Signature {
    pub name: String,
    pub text: String,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct Account {
    pub id: u64,
    pub name: String,
    pub email: String,
    pub username: String,
    pub imap_host: String,
    pub imap_port: u16,
    pub smtp_host: String,
    pub smtp_port: u16,
    pub signatures: Vec<Signature>,
    pub default_signature: usize,
    /// Nach dem Senden eine Kopie per IMAP im Gesendet-Ordner ablegen
    #[serde(default)]
    pub save_sent: bool,
    /// Leer = automatisch erkennen
    #[serde(default)]
    pub sent_folder: String,
    #[serde(default)]
    pub drafts_folder: String,
}

impl Account {
    pub fn password(&self) -> Option<String> {
        keyring::Entry::new("MailLine", &format!("account-{}", self.id))
            .ok()?
            .get_password()
            .ok()
    }
}

#[derive(Serialize, Deserialize, Default, Clone)]
pub struct Contact {
    pub id: u64,
    pub name: String,
    pub email: String,
    #[serde(default)]
    pub company: String,
    #[serde(default)]
    pub phone: String,
    #[serde(default)]
    pub note: String,
    /// Erscheint im Menü "Weiterleiten an" für Ein-Klick-Weiterleitung
    #[serde(default)]
    pub quick: bool,
}

#[derive(Serialize, Deserialize, Default, Clone)]
#[serde(default)]
pub struct Config {
    pub accounts: Vec<Account>,
    /// Fokus-Postfächer als "kontoId|Ordner"
    pub focus_folders: Vec<String>,
    pub focus_active: bool,
    pub contacts: Vec<Contact>,
}

impl Config {
    fn path() -> PathBuf {
        let mut p = dirs::config_dir().unwrap_or_else(|| PathBuf::from("."));
        p.push("MailLine");
        let _ = std::fs::create_dir_all(&p);
        p.push("config.json");
        p
    }

    pub fn load() -> Self {
        std::fs::read_to_string(Self::path())
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    }

    pub fn save(&self) {
        if let Ok(s) = serde_json::to_string_pretty(self) {
            let _ = std::fs::write(Self::path(), s);
        }
    }
}
