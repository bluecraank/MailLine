<p align="center">
  <img src="icons/icon.png" width="96" alt="MailLine icon" />
</p>

# MailLine

**Yet another mail client.** Yes, really. Another one.

But this one is modern, fast, written in Rust and fully *vibe coded*: the requirements went into a Markdown file, someone said "build it", then went to grab a coffee. ☕

No Electron, no cloud, no account with anybody. Just you, your IMAP server and a UI that doesn't look like 2003.

---

## Features

- **Multiple accounts**: all your IMAP mailboxes in one window. Switch with a click or `Ctrl+1…9`.
- **Focus mode**: star the folders that matter right now, across accounts, and hide everything else. No more newsletter noise.
- **Multiple signatures per account**: e.g. German and English, switchable with one click while writing.
- **Contacts with quick forward**: an invoice comes in → "Forward to" → Accounting → done. The mail goes out with all its attachments, no typing.
- **Offline mode**: the newest 1,000 mails of every folder are synced in the background, including their content. No connection? MailLine keeps working from the local cache.
- **Full-text search**: searches subject, sender, body and attachment names across all accounts and folders, with highlighted snippets. Umlauts and accents are ignored, so `uber` finds `über`.
- **Drafts**: saved on the server, so they show up on your phone too. Saved with `Ctrl+S` or automatically when you close the editor. Double-click a draft to keep editing it.
- **Sent folder copy**: optional per account. Turn it off for Gmail and Microsoft 365, they do it themselves.
- **Attachments**: preview, open with one click, save to Downloads, attach your own files.
- **CC & BCC**, with autocomplete from contacts and known senders.
- **Context menus**: right-click mails, folders, accounts or attachments to reply, forward, mark as read or unread, move or delete.
- **Delete with `Del`**: the mail goes to the trash. `Shift+Del` deletes it permanently.
- **HTML mails** render properly. Remote images are blocked by default (tracking pixels, no thanks).
- **Light & dark**: follows your Windows theme.
- **Resizable columns**: drag to adjust, double-click to reset.
- **Server presets** for Gmail, Outlook, GMX, web.de, T-Online, iCloud, Posteo, mailbox.org and Yahoo.
- **Passwords** are stored in the Windows Credential Manager, not in plain text on disk.

> The UI is currently in German.

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl+1` … `Ctrl+9` | Switch account |
| `Ctrl+N` | New message |
| `Ctrl+K` | Search (all accounts & folders) |
| `Ctrl+Shift+F` | Toggle focus mode |
| `Ctrl+Shift+K` | Contacts |
| `↑` / `↓` (or `j` / `k`) | Browse mails |
| `R` | Reply |
| `W` | Forward menu |
| `U` | Toggle read / unread |
| `Del` | Move to trash |
| `Shift+Del` | Delete permanently |
| `Enter` | Edit draft (in the Drafts folder) |
| `Ctrl+Enter` | Send |
| `Ctrl+S` | Save draft |
| `F5` | Refresh |

## Tech stack

| Part | Built with |
|---|---|
| Backend | **Rust**: [`imap`](https://crates.io/crates/imap), [`lettre`](https://crates.io/crates/lettre) (SMTP), [`mail-parser`](https://crates.io/crates/mail-parser), [`keyring`](https://crates.io/crates/keyring), [`rusqlite`](https://crates.io/crates/rusqlite) (SQLite + FTS5) |
| App shell | [Tauri 2](https://tauri.app) (uses the WebView2 that ships with Windows) |
| UI | Plain HTML, CSS and JavaScript, with no framework and no build step |

The release `.exe` is about 11 MB.

## Download

Get the latest `mailline.exe` from [Releases](../../releases). No installation needed.

The binary isn't code-signed, so Windows SmartScreen may complain on first launch ("More info" → "Run anyway").

## Build & run

Requirements: [Rust](https://rustup.rs) (stable) and Windows 10/11 (WebView2 is already installed there). Node.js is **not** needed.

```sh
cargo run --release
```

> Use `--release` for everyday use. The debug build is noticeably slower.

The binary ends up in `target/release/mailline.exe`.

## Where is my data?

| What | Where |
|---|---|
| Accounts, signatures, contacts, focus folders | `%APPDATA%\MailLine\config.json` |
| Passwords | Windows Credential Manager (`MailLine`) |
| Offline cache & search index | `%LOCALAPPDATA%\MailLine\cache.db` |
| Opened attachments (temporary) | `%TEMP%\MailLine\` |

Deleting `cache.db` is safe: MailLine rebuilds it on the next sync.

```
src/
  main.rs      Tauri commands (the bridge between UI and Rust)
  backend.rs   IMAP, SMTP, MIME parsing, sync, drafts
  cache.rs     Offline cache & full-text index (SQLite/FTS5)
  config.rs    Settings & passwords
ui/
  index.html   Skeleton
  style.css    Design (light/dark)
  app.js       The entire UI
```

## Honest limitations

It's vibe coded, so:

- Offline sync covers the **newest 1,000 mails per folder**. Spam and trash are skipped, and mails over 25 MB stay online-only.
- **Sending requires a connection**. There's no outbox queue yet.
- No "Reply all", no multi-select, no rich-text editor (plain text only).
- Built and tested primarily on **Windows**.
- No OAuth: Gmail and Outlook need an **app password**.

Pull requests welcome. Or just keep vibing on it yourself. 🤙

## License

None chosen yet.
