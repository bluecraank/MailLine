"use strict";
// Übersetzungen. Schlüssel = deutscher Originaltext, {name} = Platzhalter.
// Neue Sprache: weiteren Block in I18N anlegen und in LANGUAGES eintragen.

const LANGUAGES = { de: "Deutsch", en: "English" };

const I18N = {
  en: {
    // Ordner & Zeit
    "Posteingang": "Inbox", "Gesendet": "Sent", "Entwürfe": "Drafts", "Archiv": "Archive", "Spam": "Spam", "Papierkorb": "Trash",
    "Heute": "Today", "Gestern": "Yesterday", "Diese Woche": "This week", "Diesen Monat": "This month", "Älter": "Older",
    "(kein Betreff)": "(no subject)", "(unbekannt)": "(unknown)",
    "Strg": "Ctrl", "Strg+C": "Ctrl+C", "Strg+N": "Ctrl+N", "Strg+Umschalt+F": "Ctrl+Shift+F", "Entf": "Del", "⇧ Entf": "⇧ Del",

    // Leiste & Seitenleiste
    "Konto hinzufügen": "Add account", "Kontakte": "Contacts", "Einstellungen": "Settings",
    "Noch kein Konto eingerichtet.": "No account set up yet.",
    "Neue Nachricht": "New message", "Fokus-Modus": "Focus mode",
    "Nur ausgewählte Postfächer": "Selected folders only", "Alle Postfächer sichtbar": "All folders visible",
    "Fokus-Postfächer": "Focus folders", "Bearbeiten": "Edit", "Fertig": "Done", "Ordner": "Folders",
    "★ Fokus wählen": "★ Pick focus", "Fokus-Postfächer auswählen": "Choose focus folders",
    "Als Fokus-Postfach markieren": "Mark as focus folder", "Aus Fokus-Postfächern entfernen": "Remove from focus folders",
    "Noch keine Fokus-Postfächer.": "No focus folders yet.",
    "Tippe auf <b>Bearbeiten</b> und markiere Ordner mit ★ – egal aus welchem Konto.": "Click <b>Edit</b> and star folders with ★ – from any account.",
    "Fokus-Modus an": "Focus mode on", "Fokus-Modus aus": "Focus mode off",
    "Update {v} verfügbar": "Update {v} available",

    // Liste
    "Suchen  (Strg+K)": "Search  (Ctrl+K)", "Aktualisieren (F5)": "Refresh (F5)", "Suche": "Search",
    "{n} Treffer in allen Postfächern": "{n} results in all folders", "{n} ungelesen": "{n} unread", "{n} Nachrichten": "{n} messages",
    "Keine Treffer.": "No results.", "Dieser Ordner ist leer.": "This folder is empty.",
    "Gesucht wird in allen offline gespeicherten Mails.": "Searching all mails stored offline.",
    "Ziehen zum Ändern · Doppelklick = Standard": "Drag to resize · double-click = default",

    // Lesen
    "Keine Nachricht ausgewählt": "No message selected", "Willkommen bei MailLine": "Welcome to MailLine",
    "zum Blättern": "to browse", "neue Nachricht": "new message", "Erstes Konto hinzufügen": "Add your first account",
    "Das ist ein Entwurf.": "This is a draft.", "Weiter bearbeiten": "Continue editing",
    "Externe Bilder wurden zum Schutz deiner Privatsphäre blockiert.": "Remote images were blocked to protect your privacy.",
    "Bilder laden": "Load images", "Öffnen": "Open", "In Downloads speichern": "Save to Downloads",
    "Schnell-Weiterleiten": "Quick forward", "inkl. {n} Anhang": "incl. {n} attachment", "inkl. {n} Anhänge": "incl. {n} attachments",
    "Weitere Kontakte": "Other contacts",
    "Noch keine Kontakte. Lege unter <b>Kontakte</b> z. B. deine Buchhaltung an und aktiviere „Schnell-Weiterleiten“.":
      "No contacts yet. Add e.g. your accountant under <b>Contacts</b> and enable “Quick forward”.",
    "Bearbeiten & weiterleiten …": "Edit & forward …", "Kontakte verwalten …": "Manage contacts …",
    "Absender als Kontakt speichern": "Save sender as contact", "Antworten (R)": "Reply (R)", "Antworten": "Reply",
    "Weiterleiten (W)": "Forward (W)", "Weiterleiten an": "Forward to", "Weiterleiten": "Forward", "Weiterleiten …": "Forward …",
    "Weitergeleitete Nachricht": "Forwarded message", "Von": "From", "Datum": "Date", "Betreff": "Subject", "An": "To",
    "WG: ": "Fwd: ", "Am {date} schrieb {name}:": "On {date}, {name} wrote:",
    "Leite weiter an {name} …": "Forwarding to {name} …", "Weitergeleitet an {name}": "Forwarded to {name}",
    " (inkl. {n} Anhang)": " (incl. {n} attachment)", " (inkl. {n} Anhänge)": " (incl. {n} attachments)",
    "Weiterleiten fehlgeschlagen: {e}": "Forwarding failed: {e}", "Gespeichert: {p}": "Saved: {p}",

    // Verfassen
    "Entwurf": "Draft", "Schließen (wird als Entwurf gespeichert)": "Close (saved as draft)",
    "Name oder Adresse – mehrere mit Komma": "Name or address – separate several with commas",
    "CC / BCC hinzufügen": "Add CC / BCC", "Kopie an": "Copy to", "Blindkopie an (für andere unsichtbar)": "Blind copy to (hidden from others)",
    "Nachricht schreiben …": "Write your message …", "Signatur": "Signature", "Keine": "None", "Entwurf verwerfen": "Discard draft",
    "Als Entwurf speichern (Strg+S)": "Save as draft (Ctrl+S)", "Datei anhängen": "Attach file", "Anhang": "Attach",
    "Senden": "Send", "Sende …": "Sending …", "Entfernen": "Remove", "Kontakt": "Contact",
    "Speichere Entwurf …": "Saving draft …", "Entwurf gespeichert {time}": "Draft saved {time}", "Als Entwurf gespeichert": "Saved as draft",
    "Entwurf konnte nicht gespeichert werden: {e}": "Could not save draft: {e}",
    "Der Entwurf konnte nicht gespeichert werden. Trotzdem schließen? Der Text geht verloren.": "The draft could not be saved. Close anyway? Your text will be lost.",
    "Nachricht gesendet": "Message sent", "Entwurf verwerfen?": "Discard draft?", "Entwurf verworfen": "Draft discarded",
    "Entwurf konnte nicht geöffnet werden: {e}": "Could not open draft: {e}", "Entwurf bearbeiten": "Edit draft",

    // Sync
    "Offline-Sync": "Offline sync", "Zeige gespeicherte Mails": "Showing stored mails", "{n} Mails offline verfügbar": "{n} mails available offline",

    // Kontakte
    "Name": "Name", "E-Mail-Adresse": "Email address", "Firma": "Company", "Telefon": "Phone", "Notiz": "Note", "Buchhaltung": "Accounting",
    "Erscheint oben im Menü „Weiterleiten an“ – ein Klick leitet die Mail inkl. aller Anhänge an diesen Kontakt weiter.":
      "Shown at the top of the “Forward to” menu – one click forwards the mail including all attachments to this contact.",
    "Löschen": "Delete", "Abbrechen": "Cancel", "Speichern": "Save", "Kontakte durchsuchen": "Search contacts", "⚡ Schnell": "⚡ Quick",
    "E-Mail schreiben": "Write email", "Kontakt hinzufügen": "Add contact",
    "Noch keine Kontakte. Lege z. B. deine Buchhaltung an und aktiviere „Schnell-Weiterleiten“ – dann gehen Rechnungen mit zwei Klicks raus.":
      "No contacts yet. Add e.g. your accountant and enable “Quick forward” – then invoices go out in two clicks.",
    "Bitte eine gültige E-Mail-Adresse eingeben": "Please enter a valid email address", "Kontakt gespeichert": "Contact saved",
    "Kontakt „{name}“ löschen?": "Delete contact “{name}”?",

    // Einstellungen
    "Konten": "Accounts", "Signaturen": "Signatures", "Allgemein": "General",
    "Anzeigename": "Display name", "Benutzername": "Username", "Passwort": "Password",
    "Max Mustermann": "Jane Doe", "max@firma.de": "jane@company.com", "meist die E-Mail-Adresse": "usually the email address",
    "unverändert lassen": "leave unchanged", "App-Passwort / Passwort": "App password / password",
    "imap.firma.de": "imap.company.com", "smtp.firma.de": "smtp.company.com",
    "IMAP mit SSL/TLS (Port 993). SMTP: Port 465 = SSL/TLS, sonst STARTTLS. Das Passwort wird in der Windows-Anmeldeinformationsverwaltung gespeichert.":
      "IMAP with SSL/TLS (port 993). SMTP: port 465 = SSL/TLS, otherwise STARTTLS. The password is stored in the Windows Credential Manager.",
    "Gesendete Mails im Gesendet-Ordner speichern": "Save sent mails to the Sent folder",
    "Legt nach dem Senden eine Kopie per IMAP ab. Bei Gmail und Outlook/Microsoft 365 ausschalten – die speichern selbst, sonst landet jede Mail doppelt.":
      "Stores a copy via IMAP after sending. Turn this off for Gmail and Outlook/Microsoft 365 – they do it themselves, otherwise every mail ends up twice.",
    "Gesendet-Ordner": "Sent folder", "Entwürfe-Ordner": "Drafts folder", "Automatisch erkennen": "Detect automatically",
    "Konto entfernen": "Remove account", "Noch keine Konten.": "No accounts yet.", "Lege zuerst ein Konto an.": "Add an account first.",
    "Konto": "Account", "Standard": "Default", "Signaturtext …": "Signature text …", "Signatur hinzufügen": "Add signature", "Signatur {n}": "Signature {n}",
    "Lege z. B. „Deutsch“ und „English“ an – beim Verfassen wechselst du mit einem Klick.": "Create e.g. “German” and “English” – switch with one click while writing.",
    "E-Mail, IMAP-Server und Passwort sind erforderlich": "Email, IMAP server and password are required",
    "Konto hinzugefügt": "Account added", "Gespeichert": "Saved", "Konto „{name}“ aus MailLine entfernen?": "Remove account “{name}” from MailLine?",
    "Sprache": "Language", "Automatisch (Systemsprache)": "Automatic (system language)",
    "Updates": "Updates", "Installierte Version": "Installed version",
    "Beim Start automatisch nach Updates suchen": "Check for updates on startup", "Jetzt nach Updates suchen": "Check for updates now",
    "Suche nach Updates …": "Checking for updates …", "Du nutzt die neueste Version.": "You're on the latest version.",
    "Update-Prüfung fehlgeschlagen: {e}": "Update check failed: {e}",

    // Update-Dialog
    "Update verfügbar": "Update available", "Version {v} ist verfügbar (installiert: {c}).": "Version {v} is available (installed: {c}).",
    "Später": "Later", "Jetzt installieren": "Install now", "Auf GitHub ansehen": "View on GitHub",
    "Lade herunter … {p} %": "Downloading … {p} %", "Installiere …": "Installing …",
    "MailLine startet nach dem Update automatisch neu.": "MailLine restarts automatically after the update.",
    "Update fehlgeschlagen: {e}": "Update failed: {e}",

    // Löschen / Verschieben / Menüs
    "{n} Nachrichten endgültig löschen?": "Permanently delete {n} messages?",
    "Nachricht endgültig löschen? Das kann nicht rückgängig gemacht werden.": "Permanently delete this message? This cannot be undone.",
    "Endgültig gelöscht": "Permanently deleted", "In den Papierkorb verschoben": "Moved to trash",
    "Löschen fehlgeschlagen: {e}": "Delete failed: {e}", "Verschoben nach „{f}“": "Moved to “{f}”", "Verschieben fehlgeschlagen: {e}": "Move failed: {e}",
    "Keine Einträge": "No entries", "Als gelesen markieren": "Mark as read", "Als ungelesen markieren": "Mark as unread",
    "Verschieben nach": "Move to", "Absender-Adresse kopieren": "Copy sender address", "Endgültig löschen": "Delete permanently",
    "Aktualisieren": "Refresh", "Alle als gelesen markieren": "Mark all as read",
    "Zu diesem Konto wechseln": "Switch to this account", "Neue Nachricht von diesem Konto": "New message from this account",
    "Konto bearbeiten": "Edit account", "Kopiert": "Copied", "Kopieren nicht möglich": "Copy not possible", "Kopieren": "Copy",
    "Link-Adresse kopieren": "Copy link address",
  },
};

// Fehlermeldungen aus dem Rust-Backend (Textbausteine, auch mitten im Satz)
const I18N_ERRORS = {
  en: [
    ["Offline – diese Nachricht ist noch nicht im Offline-Speicher", "Offline – this message is not in the offline cache yet"],
    ["Gesendet, aber Kopie im Gesendet-Ordner fehlgeschlagen", "Sent, but saving a copy to the Sent folder failed"],
    ["– bitte in den Konto-Einstellungen auswählen", "– please choose it in the account settings"],
    ["Kein Gesendet-Ordner gefunden", "No Sent folder found"], ["Kein Entwürfe-Ordner gefunden", "No Drafts folder found"],
    ["Kein Papierkorb-Ordner gefunden", "No Trash folder found"],
    ["Kein Passwort gespeichert", "No password stored"], ["IMAP-Verbindung fehlgeschlagen", "IMAP connection failed"],
    ["Login fehlgeschlagen", "Login failed"], ["Nachricht nicht gefunden", "Message not found"], ["Nachricht nicht lesbar", "Message not readable"],
    ["Anhang nicht gefunden", "Attachment not found"], ["Anhang beschädigt", "Attachment corrupted"],
    ["Ungültige Empfängeradresse", "Invalid recipient address"], ["Ungültige Absenderadresse", "Invalid sender address"],
    ["Kein Empfänger angegeben", "No recipient given"], ["Unbekanntes Konto", "Unknown account"],
    [/Verschieben nach „(.*?)“ fehlgeschlagen/g, "Moving to “$1” failed"],
    ["Kein Update verfügbar", "No update available"], ["GitHub nicht erreichbar", "GitHub not reachable"],
    ["Antwort von GitHub nicht lesbar", "Could not read GitHub's response"],
    ["Kein Download für Windows im Release gefunden", "No Windows download found in the release"],
    ["Unerwartete Download-Adresse", "Unexpected download address"], ["Programmordner unbekannt", "Program folder unknown"],
    ["Kein Schreibzugriff auf", "No write access to"], ["Download fehlgeschlagen", "Download failed"], ["Download abgebrochen", "Download interrupted"],
    [/Download unvollständig \((\d+) von (\d+) Bytes\)/g, "Download incomplete ($1 of $2 bytes)"],
    ["Prüfsumme stimmt nicht – Update verworfen", "Checksum mismatch – update discarded"],
    ["Download ist keine Windows-Programmdatei", "Download is not a Windows executable"],
    ["Programmdatei konnte nicht ersetzt werden", "Could not replace the program file"],
  ],
};

let LANG = "de";

function detectLang(pref) {
  if (pref && LANGUAGES[pref]) return pref;
  const sys = (navigator.languages?.[0] || navigator.language || "de").slice(0, 2).toLowerCase();
  return LANGUAGES[sys] ? sys : "en";
}

/// Übersetzen. Unbekannte Texte (z. B. Namen) bleiben unverändert.
function t(s, vars) {
  let r = (LANG !== "de" && I18N[LANG]?.[s]) || s;
  if (vars) r = r.replace(/\{(\w+)\}/g, (_, k) => (vars[k] ?? ""));
  return r;
}

/// Fehlermeldungen aus dem Backend übersetzen (Bausteine ersetzen).
function tErr(msg) {
  let r = String(msg);
  for (const [from, to] of I18N_ERRORS[LANG] || []) r = typeof from === "string" ? r.split(from).join(to) : r.replace(from, to);
  return r;
}

const LOCALE = () => (LANG === "de" ? "de-DE" : LANG === "en" ? "en-GB" : LANG);
