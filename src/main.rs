#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod backend;
mod config;

use backend::{BodyOut, Folder, MsgHead, Store};
use config::{Account, Config};
use std::sync::{Arc, Mutex};
use tauri::{async_runtime::spawn_blocking, State};

struct AppState {
    cfg: Mutex<Config>,
    store: Arc<Store>,
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

#[tauri::command]
fn delete_password(id: u64) {
    if let Ok(e) = keyring::Entry::new("MailLine", &format!("account-{id}")) {
        let _ = e.delete_credential();
    }
}

#[tauri::command]
async fn folders(state: State<'_, AppState>, account_id: u64) -> Result<Vec<Folder>, String> {
    let acc = state.account(account_id)?;
    let store = state.store.clone();
    spawn_blocking(move || store.folders(&acc).map_err(err)).await.map_err(err)?
}

#[tauri::command]
async fn headers(state: State<'_, AppState>, account_id: u64, folder: String) -> Result<Vec<MsgHead>, String> {
    let acc = state.account(account_id)?;
    let store = state.store.clone();
    spawn_blocking(move || store.headers(&acc, &folder).map_err(err)).await.map_err(err)?
}

#[tauri::command]
async fn body(state: State<'_, AppState>, account_id: u64, folder: String, uid: u32) -> Result<BodyOut, String> {
    let acc = state.account(account_id)?;
    let store = state.store.clone();
    spawn_blocking(move || store.body(&acc, &folder, uid).map_err(err)).await.map_err(err)?
}

#[tauri::command]
async fn set_seen(state: State<'_, AppState>, account_id: u64, folder: String, uids: Vec<u32>, seen: bool) -> Result<(), String> {
    let acc = state.account(account_id)?;
    let store = state.store.clone();
    spawn_blocking(move || store.set_seen(&acc, &folder, &uids, seen).map_err(err)).await.map_err(err)?
}

#[tauri::command]
async fn move_messages(state: State<'_, AppState>, account_id: u64, folder: String, uids: Vec<u32>, target: String) -> Result<(), String> {
    let acc = state.account(account_id)?;
    let store = state.store.clone();
    spawn_blocking(move || store.move_to(&acc, &folder, &uids, &target).map_err(err)).await.map_err(err)?
}

/// Rückgabe: true = endgültig gelöscht, false = in den Papierkorb verschoben
#[tauri::command]
async fn delete_messages(state: State<'_, AppState>, account_id: u64, folder: String, uids: Vec<u32>, permanent: bool) -> Result<bool, String> {
    let acc = state.account(account_id)?;
    let store = state.store.clone();
    spawn_blocking(move || store.delete(&acc, &folder, &uids, permanent).map_err(err)).await.map_err(err)?
}

#[tauri::command]
async fn send_mail(
    state: State<'_, AppState>,
    account_id: u64,
    to: String,
    cc: Option<String>,
    bcc: Option<String>,
    subject: String,
    body: String,
    mut attachments: Vec<backend::OutAttachment>,
    forward: Option<ForwardRef>,
) -> Result<(), String> {
    let acc = state.account(account_id)?;
    let src = match &forward {
        Some(f) => Some(state.account(f.account_id)?),
        None => None,
    };
    let store = state.store.clone();
    spawn_blocking(move || {
        // Bei Weiterleitungen die Original-Anhänge mitschicken
        if let (Some(f), Some(src)) = (forward, src) {
            let raw = store.raw(&src, &f.folder, f.uid).map_err(err)?;
            attachments.extend(backend::attachments_of(&raw));
        }
        let (cc, bcc) = (cc.unwrap_or_default(), bcc.unwrap_or_default());
        let rcpt = backend::Recipients { to: &to, cc: &cc, bcc: &bcc };
        backend::send(&acc, rcpt, &subject, body, attachments).map_err(err)
    })
    .await
    .map_err(err)?
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ForwardRef {
    account_id: u64,
    folder: String,
    uid: u32,
}

#[tauri::command]
async fn save_attachment(
    state: State<'_, AppState>,
    account_id: u64,
    folder: String,
    uid: u32,
    index: usize,
    open: bool,
) -> Result<String, String> {
    let acc = state.account(account_id)?;
    let store = state.store.clone();
    spawn_blocking(move || {
        let raw = store.raw(&acc, &folder, uid).map_err(err)?;
        backend::save_attachment(&raw, index, open).map_err(err)
    })
    .await
    .map_err(err)?
}

fn main() {
    tauri::Builder::default()
        .manage(AppState { cfg: Mutex::new(Config::load()), store: Arc::new(Store::default()) })
        .invoke_handler(tauri::generate_handler![
            get_config, save_config, set_password, delete_password, folders, headers, body, send_mail, save_attachment, set_seen, move_messages, delete_messages
        ])
        .run(tauri::generate_context!())
        .expect("MailLine konnte nicht gestartet werden");
}
