#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod backend;
mod cache;
mod config;
mod update;

use backend::{BodyOut, Draft, FoldersOut, HeadersOut, OutAttachment, Store};
use cache::{Cache, SearchHit};
use config::{Account, Config};
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{async_runtime::spawn_blocking, AppHandle, Emitter, Manager, State};

struct AppState {
    cfg: Mutex<Config>,
    store: Arc<Store>,
    syncing: Arc<AtomicBool>,
}

impl AppState {
    fn account(&self, id: u64) -> Result<Account, String> {
        self.cfg
            .lock()
            .unwrap()
            .accounts
            .iter()
            .find(|a| a.id == id)
            .cloned()
            .ok_or_else(|| "Unbekanntes Konto".to_string())
    }
}

fn err(e: impl std::fmt::Display) -> String {
    format!("{e:#}")
}

/// Führt blockierende IMAP/SMTP-Arbeit außerhalb des UI-Threads aus.
async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    spawn_blocking(f).await.map_err(err)?
}

// ------------------------------------------------------------------ Konfiguration

#[tauri::command]
fn get_config(state: State<AppState>) -> Config {
    state.cfg.lock().unwrap().clone()
}

#[tauri::command]
fn save_config(state: State<AppState>, cfg: Config) {
    cfg.save();
    *state.cfg.lock().unwrap() = cfg;
}

#[tauri::command]
fn set_password(id: u64, password: String) -> Result<(), String> {
    keyring::Entry::new("MailLine", &format!("account-{id}"))
        .and_then(|e| e.set_password(&password))
        .map_err(err)
}

/// Konto entfernt: Passwort und Offline-Daten löschen.
#[tauri::command]
fn delete_password(state: State<AppState>, id: u64) {
    if let Ok(e) = keyring::Entry::new("MailLine", &format!("account-{id}")) {
        let _ = e.delete_credential();
    }
    let _ = state.store.cache.purge_account(id);
}

// ------------------------------------------------------------------ Lesen

#[tauri::command]
async fn folders(state: State<'_, AppState>, account_id: u64) -> Result<FoldersOut, String> {
    let acc = state.account(account_id)?;
    let store = state.store.clone();
    blocking(move || store.folders(&acc).map_err(err)).await
}

#[tauri::command]
async fn headers(state: State<'_, AppState>, account_id: u64, folder: String) -> Result<HeadersOut, String> {
    let acc = state.account(account_id)?;
    let store = state.store.clone();
    blocking(move || store.headers(&acc, &folder).map_err(err)).await
}

#[tauri::command]
async fn body(state: State<'_, AppState>, account_id: u64, folder: String, uid: u32) -> Result<BodyOut, String> {
    let acc = state.account(account_id)?;
    let store = state.store.clone();
    blocking(move || store.body(&acc, &folder, uid).map_err(err)).await
}

/// Alle Anhänge einer Nachricht (zum erneuten Bearbeiten eines Entwurfs).
#[tauri::command]
async fn get_attachments(state: State<'_, AppState>, account_id: u64, folder: String, uid: u32) -> Result<Vec<OutAttachment>, String> {
    let acc = state.account(account_id)?;
    let store = state.store.clone();
    blocking(move || Ok(backend::attachments_of(&store.raw(&acc, &folder, uid).map_err(err)?))).await
}

#[tauri::command]
async fn search(state: State<'_, AppState>, query: String) -> Result<Vec<SearchHit>, String> {
    let store = state.store.clone();
    blocking(move || store.cache.search(&query, 150).map_err(err)).await
}

// ------------------------------------------------------------------ Ändern

#[tauri::command]
async fn set_seen(state: State<'_, AppState>, account_id: u64, folder: String, uids: Vec<u32>, seen: bool) -> Result<(), String> {
    let acc = state.account(account_id)?;
    let store = state.store.clone();
    blocking(move || store.set_seen(&acc, &folder, &uids, seen).map_err(err)).await
}

#[tauri::command]
async fn move_messages(state: State<'_, AppState>, account_id: u64, folder: String, uids: Vec<u32>, target: String) -> Result<(), String> {
    let acc = state.account(account_id)?;
    let store = state.store.clone();
    blocking(move || store.move_to(&acc, &folder, &uids, &target).map_err(err)).await
}

/// Rückgabe: true = endgültig gelöscht, false = in den Papierkorb verschoben
#[tauri::command]
async fn delete_messages(state: State<'_, AppState>, account_id: u64, folder: String, uids: Vec<u32>, permanent: bool) -> Result<bool, String> {
    let acc = state.account(account_id)?;
    let store = state.store.clone();
    blocking(move || store.delete(&acc, &folder, &uids, permanent).map_err(err)).await
}

#[tauri::command]
async fn save_attachment(state: State<'_, AppState>, account_id: u64, folder: String, uid: u32, index: usize, open: bool) -> Result<String, String> {
    let acc = state.account(account_id)?;
    let store = state.store.clone();
    blocking(move || {
        let raw = store.raw(&acc, &folder, uid).map_err(err)?;
        backend::save_attachment(&raw, index, open).map_err(err)
    })
    .await
}

// ------------------------------------------------------------------ Verfassen

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ForwardRef {
    account_id: u64,
    folder: String,
    uid: u32,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct Compose {
    account_id: u64,
    #[serde(default)]
    to: String,
    #[serde(default)]
    cc: String,
    #[serde(default)]
    bcc: String,
    #[serde(default)]
    subject: String,
    #[serde(default)]
    body: String,
    #[serde(default)]
    attachments: Vec<OutAttachment>,
    /// Weiterleitung: Anhänge dieser Original-Nachricht mitschicken
    forward: Option<ForwardRef>,
    /// Message-ID des Entwurfs, aus dem diese Nachricht stammt
    draft_id: Option<String>,
}

impl Compose {
    /// Konto und vollständige Anhangsliste (inkl. Original-Anhänge bei Weiterleitungen).
    fn resolve(self, state: &AppState) -> Result<(Account, Option<Account>, Self), String> {
        let acc = state.account(self.account_id)?;
        let src = match &self.forward {
            Some(f) => Some(state.account(f.account_id)?),
            None => None,
        };
        Ok((acc, src, self))
    }
}

fn into_draft(c: &mut Compose, store: &Store, src: Option<Account>) -> Result<Draft, String> {
    let mut attachments = std::mem::take(&mut c.attachments);
    if let (Some(f), Some(src)) = (c.forward.take(), src) {
        let raw = store.raw(&src, &f.folder, f.uid).map_err(err)?;
        attachments.extend(backend::attachments_of(&raw));
    }
    let take = std::mem::take::<String>;
    Ok(Draft {
        to: take(&mut c.to),
        cc: take(&mut c.cc),
        bcc: take(&mut c.bcc),
        subject: take(&mut c.subject),
        body: std::mem::take(&mut c.body),
        attachments,
    })
}

#[derive(Serialize)]
struct SendOut {
    /// Hinweis, falls zwar gesendet, aber z. B. die Gesendet-Kopie fehlgeschlagen ist
    warning: Option<String>,
    sent_folder: Option<String>,
}

#[tauri::command]
async fn send_mail(state: State<'_, AppState>, mail: Compose) -> Result<SendOut, String> {
    let (acc, src, mut c) = mail.resolve(&state)?;
    let store = state.store.clone();
    blocking(move || {
        let draft_id = c.draft_id.take();
        let d = into_draft(&mut c, &store, src)?;
        let bytes = backend::send(&acc, d).map_err(err)?;
        let mut out = SendOut { warning: None, sent_folder: None };
        if acc.save_sent {
            match store.save_sent_copy(&acc, &bytes) {
                Ok(f) => out.sent_folder = Some(f),
                Err(e) => out.warning = Some(format!("Gesendet, aber Kopie im Gesendet-Ordner fehlgeschlagen: {e:#}")),
            }
        }
        if let Some(id) = draft_id {
            let _ = store.discard_draft(&acc, &id);
        }
        Ok(out)
    })
    .await
}

#[derive(Serialize)]
struct DraftOut {
    draft_id: String,
    folder: String,
}

#[tauri::command]
async fn save_draft(state: State<'_, AppState>, mail: Compose) -> Result<DraftOut, String> {
    let (acc, src, mut c) = mail.resolve(&state)?;
    let store = state.store.clone();
    blocking(move || {
        let id = c.draft_id.take().unwrap_or_else(|| backend::new_message_id(&acc));
        let d = into_draft(&mut c, &store, src)?;
        let bytes = backend::draft_bytes(&acc, d, &id).map_err(err)?;
        let folder = store.save_draft(&acc, &bytes, &id).map_err(err)?;
        Ok(DraftOut { draft_id: id, folder })
    })
    .await
}

#[tauri::command]
async fn discard_draft(state: State<'_, AppState>, account_id: u64, draft_id: String) -> Result<(), String> {
    let acc = state.account(account_id)?;
    let store = state.store.clone();
    blocking(move || store.discard_draft(&acc, &draft_id).map_err(err)).await
}

// ------------------------------------------------------------------ Offline-Sync

#[derive(Serialize, Clone)]
struct SyncDone {
    messages: u64,
    offline: u64,
}

/// Startet die Hintergrund-Synchronisierung aller Konten (läuft höchstens einmal gleichzeitig).
#[tauri::command]
fn start_sync(app: AppHandle, state: State<AppState>) -> bool {
    if state.syncing.swap(true, Ordering::SeqCst) {
        return false;
    }
    let accounts = state.cfg.lock().unwrap().accounts.clone();
    let store = state.store.clone();
    let flag = state.syncing.clone();
    std::thread::spawn(move || {
        for acc in &accounts {
            let app2 = app.clone();
            let r = store.sync_account(acc, &move |p| {
                let _ = app2.emit("sync-progress", p);
            });
            if let Err(e) = r {
                let _ = app.emit("sync-error", format!("{}: {e:#}", acc.email));
            }
        }
        let (messages, offline) = store.cache.stats();
        let _ = app.emit("sync-done", SyncDone { messages, offline });
        flag.store(false, Ordering::SeqCst);
    });
    true
}

// ------------------------------------------------------------------ Updates

#[tauri::command]
fn app_version() -> &'static str {
    update::VERSION
}

/// Release-Seite im Standardbrowser öffnen (nur GitHub-Links dieses Projekts).
#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    if !url.starts_with("https://github.com/bluecraank/MailLine/") {
        return Err("Link nicht erlaubt".into());
    }
    std::process::Command::new("explorer").arg(&url).spawn().map_err(err)?;
    Ok(())
}

#[tauri::command]
async fn check_update() -> Result<update::UpdateInfo, String> {
    blocking(|| update::check().map_err(err)).await
}

/// Lädt das Update, ersetzt die .exe und startet MailLine neu.
#[tauri::command]
async fn install_update(app: AppHandle) -> Result<(), String> {
    let app2 = app.clone();
    blocking(move || {
        let info = update::check().map_err(err)?;
        if !info.available {
            return Err("Kein Update verfügbar".into());
        }
        update::install(&info, &|done, total| {
            let _ = app2.emit("update-progress", (done, total));
        })
        .map_err(err)?;
        update::restart().map_err(err)
    })
    .await?;
    app.exit(0);
    Ok(())
}

#[tauri::command]
fn cache_stats(state: State<AppState>) -> SyncDone {
    let (messages, offline) = state.store.cache.stats();
    SyncDone { messages, offline }
}

fn main() {
    update::wait_for_previous();
    update::cleanup();
    let cache = Cache::open().unwrap_or_else(|e| {
        eprintln!("Offline-Cache nicht verfügbar ({e:#}), nutze Speicher-Cache");
        Cache::in_memory()
    });
    tauri::Builder::default()
        // Zweiter Start: vorhandenes Fenster nach vorn holen statt abzustürzen
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.webview_windows().values().next() {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        .manage(AppState {
            cfg: Mutex::new(Config::load()),
            store: Arc::new(Store::new(cache)),
            syncing: Arc::new(AtomicBool::new(false)),
        })
        .invoke_handler(tauri::generate_handler![
            get_config, save_config, set_password, delete_password,
            folders, headers, body, get_attachments, search,
            set_seen, move_messages, delete_messages, save_attachment,
            send_mail, save_draft, discard_draft,
            start_sync, cache_stats,
            app_version, check_update, install_update, open_url
        ])
        .run(tauri::generate_context!())
        .expect("MailLine konnte nicht gestartet werden");
}
