//! Update-Check und -Installation über GitHub Releases.

use anyhow::{anyhow, bail, Context as _, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::path::PathBuf;

const REPO: &str = "bluecraank/MailLine";
const USER_AGENT: &str = "MailLine-Updater";

pub const VERSION: &str = env!("CARGO_PKG_VERSION");

#[derive(Deserialize)]
struct Release {
    tag_name: String,
    html_url: String,
    #[serde(default)]
    body: String,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    prerelease: bool,
    #[serde(default)]
    assets: Vec<Asset>,
}

#[derive(Deserialize)]
struct Asset {
    name: String,
    browser_download_url: String,
    size: u64,
    /// "sha256:<hex>" – liefert GitHub für neuere Uploads mit
    #[serde(default)]
    digest: Option<String>,
}

#[derive(Serialize, Clone)]
pub struct UpdateInfo {
    pub current: String,
    pub latest: String,
    pub available: bool,
    pub notes: String,
    pub page: String,
    pub url: Option<String>,
    pub size: u64,
    pub sha256: Option<String>,
}

fn parse_version(v: &str) -> (u64, u64, u64) {
    let mut it = v.trim().trim_start_matches(['v', 'V']).split(['.', '-', '+']).map(|p| p.parse::<u64>().unwrap_or(0));
    (it.next().unwrap_or(0), it.next().unwrap_or(0), it.next().unwrap_or(0))
}

pub fn check() -> Result<UpdateInfo> {
    let url = format!("https://api.github.com/repos/{REPO}/releases/latest");
    let mut resp = ureq::get(&url)
        .header("User-Agent", USER_AGENT)
        .header("Accept", "application/vnd.github+json")
        .call()
        .context("GitHub nicht erreichbar")?;
    let rel: Release = resp.body_mut().read_json().context("Antwort von GitHub nicht lesbar")?;
    let asset = rel.assets.iter().find(|a| a.name.to_lowercase().ends_with(".exe"));
    let available = !rel.draft && !rel.prerelease && parse_version(&rel.tag_name) > parse_version(VERSION) && asset.is_some();
    Ok(UpdateInfo {
        current: VERSION.into(),
        latest: rel.tag_name.trim_start_matches(['v', 'V']).into(),
        available,
        notes: rel.body,
        page: rel.html_url,
        url: asset.map(|a| a.browser_download_url.clone()),
        size: asset.map(|a| a.size).unwrap_or(0),
        sha256: asset.and_then(|a| a.digest.as_deref()).and_then(|d| d.strip_prefix("sha256:")).map(str::to_lowercase),
    })
}

/// Lädt die neue Version, prüft sie und ersetzt die laufende .exe.
/// Danach muss die App neu gestartet werden (siehe `restart`).
pub fn install(info: &UpdateInfo, progress: &dyn Fn(u64, u64)) -> Result<()> {
    let url = info.url.as_deref().ok_or_else(|| anyhow!("Kein Download für Windows im Release gefunden"))?;
    if !url.starts_with("https://github.com/") && !url.starts_with("https://objects.githubusercontent.com/") {
        bail!("Unerwartete Download-Adresse");
    }
    let exe = std::env::current_exe()?;
    let dir = exe.parent().ok_or_else(|| anyhow!("Programmordner unbekannt"))?;
    let tmp = dir.join("mailline.update.tmp");

    // Herunterladen
    let mut resp = ureq::get(url).header("User-Agent", USER_AGENT).call().context("Download fehlgeschlagen")?;
    let mut reader = resp.body_mut().with_config().limit(500 * 1024 * 1024).reader();
    let mut file = std::fs::File::create(&tmp).with_context(|| format!("Kein Schreibzugriff auf {}", dir.display()))?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 64 * 1024];
    let mut done = 0u64;
    loop {
        let n = reader.read(&mut buf).context("Download abgebrochen")?;
        if n == 0 {
            break;
        }
        file.write_all(&buf[..n])?;
        hasher.update(&buf[..n]);
        done += n as u64;
        progress(done, info.size);
    }
    file.flush()?;
    drop(file);

    // Prüfen
    let check = || -> Result<()> {
        if info.size > 0 && done != info.size {
            bail!("Download unvollständig ({done} von {} Bytes)", info.size);
        }
        if let Some(expected) = &info.sha256 {
            let got = hex::encode(hasher.finalize());
            if &got != expected {
                bail!("Prüfsumme stimmt nicht – Update verworfen");
            }
        }
        let mut head = [0u8; 2];
        std::fs::File::open(&tmp)?.read_exact(&mut head)?;
        if &head != b"MZ" {
            bail!("Download ist keine Windows-Programmdatei");
        }
        Ok(())
    };
    if let Err(e) = check() {
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }

    // Austauschen: laufende .exe darf unter Windows umbenannt, aber nicht überschrieben werden
    let old = old_path(&exe);
    let _ = std::fs::remove_file(&old);
    std::fs::rename(&exe, &old).context("Programmdatei konnte nicht ersetzt werden")?;
    if let Err(e) = std::fs::rename(&tmp, &exe) {
        let _ = std::fs::rename(&old, &exe); // zurückrollen
        return Err(anyhow!("Programmdatei konnte nicht ersetzt werden: {e}"));
    }
    Ok(())
}

fn old_path(exe: &std::path::Path) -> PathBuf {
    exe.with_extension("old")
}

/// Neue Version starten (die aktuelle beendet sich danach).
/// Die neue Instanz wartet, bis diese hier wirklich beendet ist (siehe `wait_for_previous`).
pub fn restart() -> Result<()> {
    std::process::Command::new(std::env::current_exe()?)
        .arg("--after-update")
        .arg(std::process::id().to_string())
        .spawn()?;
    Ok(())
}

/// Nach einem Update: warten, bis die alte Instanz beendet ist, sonst ist WebView2 noch belegt.
pub fn wait_for_previous() {
    let args: Vec<String> = std::env::args().collect();
    let Some(i) = args.iter().position(|a| a == "--after-update") else { return };
    let Some(pid) = args.get(i + 1).cloned() else { return };
    for _ in 0..60 {
        if !process_alive(&pid) {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(250));
    }
    // WebView2-Hilfsprozesse brauchen einen Moment, um das Datenverzeichnis freizugeben
    std::thread::sleep(std::time::Duration::from_millis(800));
}

fn process_alive(pid: &str) -> bool {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    std::process::Command::new("tasklist")
        .args(["/FI", &format!("PID eq {pid}"), "/NH", "/FO", "CSV"])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).contains(&format!("\"{pid}\"")))
        .unwrap_or(false)
}

/// Reste eines früheren Updates aufräumen.
pub fn cleanup() {
    if let Ok(exe) = std::env::current_exe() {
        let _ = std::fs::remove_file(old_path(&exe));
        if let Some(dir) = exe.parent() {
            let _ = std::fs::remove_file(dir.join("mailline.update.tmp"));
        }
    }
}
