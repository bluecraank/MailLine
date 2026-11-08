# MailLine

**Yet another Mail-Client.** Ja, wirklich. Noch einer.

Aber dieser hier ist modern, schnell, in Rust geschrieben und komplett *vibe coded*: Anforderungen in eine Markdown-Datei geschrieben, „umsetzen“ gesagt, Kaffee geholt. ☕

Kein Electron, keine Cloud, kein Konto bei irgendwem. Nur du, dein IMAP-Server und eine Oberfläche, die nicht aussieht wie 2003.

---

## Was kann das Ding?

- **Mehrere Konten**: alle IMAP-Postfächer in einem Fenster, Wechsel per Klick oder `Strg+1…9`
- **Fokus-Modus**: Markiere die Postfächer, die gerade zählen (auch über mehrere Konten hinweg), und blende den Rest aus. Kein Newsletter-Rauschen mehr.
- **Mehrere Signaturen pro Konto**: z. B. Deutsch und Englisch, beim Schreiben per Klick umschalten
- **Kontakte mit Schnell-Weiterleiten**: Rechnung kommt rein → „Weiterleiten an“ → Buchhaltung → fertig. Die Mail geht samt allen Anhängen raus, ohne Adresse tippen.
- **Anhänge**: ansehen, mit einem Klick öffnen, in „Downloads“ speichern, eigene Dateien anhängen
- **CC & BCC**, mit Autovervollständigung aus Kontakten und bekannten Absendern
- **Rechtsklick-Menüs**: auf Mails, Ordnern, Konten und Anhängen. Mails lassen sich so beantworten, weiterleiten, als gelesen oder ungelesen markieren, verschieben und löschen.
- **Löschen mit `Entf`**: Die Mail wandert in den Papierkorb. `Umschalt+Entf` löscht sie endgültig.
- **HTML-Mails** werden richtig dargestellt. Externe Bilder sind standardmäßig blockiert (Tracking-Pixel, nein danke).
- **Hell & dunkel**: folgt automatisch der Windows-Einstellung
- **Verschiebbare Spalten**: Breite per Drag anpassen, Doppelklick setzt sie zurück
- **Server-Voreinstellungen** für Gmail, Outlook, GMX, web.de, T-Online, iCloud, Posteo, mailbox.org und Yahoo
- **Passwörter** liegen in der Windows-Anmeldeinformationsverwaltung, nicht im Klartext auf der Platte

## Tastenkürzel

| Kürzel | Aktion |
|---|---|
| `Strg+1` … `Strg+9` | Konto wechseln |
| `Strg+N` | Neue Nachricht |
| `Strg+K` | Suchen |
| `Strg+Umschalt+F` | Fokus-Modus an/aus |
| `Strg+Umschalt+K` | Kontakte |
| `↑` / `↓` (oder `j` / `k`) | Durch Mails blättern |
| `R` | Antworten |
| `W` | Weiterleiten-Menü |
| `U` | Gelesen / ungelesen umschalten |
| `Entf` | In den Papierkorb |
| `Umschalt+Entf` | Endgültig löschen |
| `Strg+Enter` | Senden |
| `F5` | Aktualisieren |

## Tech-Stack

| Teil | Womit |
|---|---|
| Backend | **Rust**: [`imap`](https://crates.io/crates/imap), [`lettre`](https://crates.io/crates/lettre) (SMTP), [`mail-parser`](https://crates.io/crates/mail-parser), [`keyring`](https://crates.io/crates/keyring) |
| App-Hülle | [Tauri 2](https://tauri.app) (nutzt das in Windows eingebaute WebView2) |
| Oberfläche | Plain HTML, CSS und JavaScript, ohne Framework und ohne Build-Schritt |

Die Release-`.exe` ist rund 9 MB groß.

## Download

Die fertige `mailline.exe` gibt es unter [Releases](../../releases). Die Datei ist nicht signiert, deshalb kann Windows SmartScreen beim ersten Start warnen („Weitere Informationen“ → „Trotzdem ausführen“).

## Bauen & starten

Voraussetzungen: [Rust](https://rustup.rs) (stable) und Windows 10/11 (WebView2 ist dort schon installiert). Node.js wird **nicht** gebraucht.

```sh
cargo run --release
```

> Für den Alltag immer `--release` verwenden. Der Debug-Build ist spürbar träger.

Die fertige Datei liegt danach unter `target/release/mailline.exe`.

## Wo liegt was?

| Was | Wo |
|---|---|
| Konten, Signaturen, Kontakte, Fokus-Postfächer | `%APPDATA%\MailLine\config.json` |
| Passwörter | Windows-Anmeldeinformationsverwaltung (`MailLine`) |
| Geöffnete Anhänge (temporär) | `%TEMP%\MailLine\` |

```
src/
  main.rs      Tauri-Befehle (Brücke zwischen Oberfläche und Rust)
  backend.rs   IMAP, SMTP, MIME-Parsing, Anhänge
  config.rs    Konfiguration & Passwörter
ui/
  index.html   Grundgerüst
  style.css    Design (Hell/Dunkel)
  app.js       Die komplette Oberfläche
```

## Ehrliche Einschränkungen

Es ist vibe coded, also:

- Pro Ordner werden die **neuesten 100 Mails** geladen
- **Kein Offline-Modus**, keine lokale Volltextsuche (gesucht wird in den geladenen Mails)
- Gesendete Mails landen **nicht automatisch im „Gesendet“-Ordner** (viele Anbieter wie Gmail machen das selbst)
- Keine Entwürfe, kein „Allen antworten“, keine Mehrfachauswahl
- Primär für **Windows** gebaut und getestet
- Kein OAuth: Für Gmail/Outlook braucht es ein **App-Passwort**

Pull Requests willkommen. Oder einfach selbst weiter-viben. 🤙

## Lizenz

Noch keine festgelegt.
