// The copy every client renders, keyed by an identifier that does not change when the locale does.
//
// English is the source catalog: it declares the key set, and the other two are typed against it, so a
// key nobody translated is a compile error in this file rather than an identifier on a screen during a
// service. There is deliberately no per-key fallback to English at run time — that is the silent gap
// the missing-key rule exists to prevent, and a German screen with one English line reads as a bug
// nobody reported rather than one the build refused.

import { formatNumber, type PluralCategory, pluralCategory } from './format.js';
import type { Locale } from './locales.js';

const en = {
  'shell.preparing': 'Preparing the service view.',
  'service.slideCount.one': '{count} slide',
  'service.slideCount.other': '{count} slides',
  'output.channel.audience': 'Audience',
  'output.channel.stage': 'Stage',
  'output.channel.singer': 'Singer',
  'output.launch.screen': '{view} opened on its assigned screen.',
  'output.launch.manual':
    "{view} opened. Drag this window onto its screen, then use the display's own fullscreen control.",
  'output.launch.blocked': "{view} was blocked by the browser's popup policy. Click to open it.",
  'arrangement.preview.screen': '{view} will open on its saved screen.',
  'arrangement.preview.manual': '{view} will open without its saved screen; drag it into place once it opens.',
  'placement.screen.primary': 'Screen {number} (main), {width} × {height}',
  'placement.screen.secondary': 'Screen {number}, {width} × {height}',
  'placement.applied': '{view} opened on {screen}.',
  'placement.unapplied.notAuthorized': '{view} was not opened: this session may not control the presentation.',
  'placement.unapplied.notIssued':
    "{view} was not opened: the server's answer carried no capability this client could read.",
  'placement.unapplied.detection':
    '{view} opened without its assigned screen, because this browser did not list the screens. Drag it into place.',
  'placement.unapplied.screenAbsent':
    '{view} opened without its assigned screen, because that screen is no longer there. Drag it into place.',
  'placement.unapplied.unassigned': '{view} opened without a screen, because none is assigned to it. Drag it into place.',
  'placement.unapplied.blocked':
    "{view} was blocked by the browser's popup policy, so it was not placed. Click to open it.",
  'localOutput.fullscreen.entered': 'Presenting fullscreen.',
  'localOutput.fullscreen.exited': 'No longer presenting fullscreen.',
  'localOutput.fullscreen.absent':
    "This browser cannot enter fullscreen from the page. Press F11, or your browser's own fullscreen key, instead.",
  'localOutput.fullscreen.denied':
    "Fullscreen was not granted. Press F11, or your browser's own fullscreen key, instead.",
  'localOutput.wakeLock.active': 'Keeping this screen awake.',
  'localOutput.wakeLock.released': 'Not keeping this screen awake.',
  'localOutput.wakeLock.lost':
    'The screen wake lock was lost. It will be requested again once this tab is active.',
  'localOutput.wakeLock.absent':
    "This browser cannot keep the screen awake automatically. Adjust this device's own sleep settings for the service.",
  'localOutput.wakeLock.denied':
    "Permission to keep the screen awake was not granted. Adjust this device's own sleep settings for the service.",
  'liveMedia.playing': 'The media is playing.',
  'liveMedia.autoplayBlocked': 'This browser would not start the media on its own. Press Play to start it.',
  'liveMedia.loadError':
    'The media could not be loaded. The last frame is still showing; press Retry to load it again.',
  'liveMedia.follower.silent': 'This view is not playing the media. Opt in to play it in step with {view}.',
  'liveMedia.follower.synchronized': 'Playing in step with {view}.',
  'liveMedia.follower.resynchronized': 'Caught back up with {view}.',
  // The words the two assertive connection announcements are said in (`apps/web/src/announcements.ts`),
  // and the polite confirmation that takes them back. `lost` and `restored` are the UI contract's own
  // Offline and Reconnect copy, word for word — AX-F3 was raised over announcements that had an
  // expected wording and nowhere to say it, so saying them in different words would only half answer
  // it. `reconnecting` has no counterpart in the contract at all and is new copy: a recoverable drop,
  // where the room keeps the last public frame and nobody has to do anything, is a state the contract
  // never wrote a line for.
  'announce.connection.reconnecting': 'Reconnecting; last public frame remains visible',
  'announce.connection.lost': 'Connection lost. Your last typed text is safe. Editing is paused while we reconnect.',
  'announce.connection.restored': 'Back online. Checking for newer changes…',
  'audienceOffline.live': 'Following the live service.',
  'audienceOffline.offline':
    'The live connection was lost. Showing the last verified copy; other screens may no longer match this one.',
  'audienceOffline.unavailable':
    'The live connection was lost, and no verified copy is available to show.',
  'control.skipLinks.label': 'Skip links',
  'control.skip.order': 'Skip to Order',
  'control.skip.editorPreview': 'Skip to Editor and Preview',
  'control.skip.properties': 'Skip to Properties',
  'control.skip.liveControls': 'Skip to Live Controls',
  'control.region.order': 'Order',
  'control.region.editorPreview': 'Editor and Preview',
  'control.region.properties': 'Properties',
  'control.region.liveControls': 'Live Controls',
  'control.order.empty': 'No slides in this order yet.',
  'control.order.select': 'Show {label}',
  'control.editor.heading': 'Editor',
  'control.editor.empty': 'Nothing selected to edit yet.',
  'control.preview.heading': 'Preview',
  'control.preview.current': 'Current',
  'control.preview.next': 'Next',
  'control.preview.noNext': 'No next slide.',
  'control.preview.empty': 'Nothing to preview yet.',
  'control.properties.label': 'Label',
  'control.properties.empty': 'Select a slide to see its properties.',
  'control.live.previous': 'Previous slide',
  'control.live.next': 'Next slide',
  'control.status.showing': 'Now showing {label}.',
  'control.connection.authorizing': 'Checking live access…',
  'control.connection.connecting': 'Connecting to the live service…',
  'control.connection.synchronised': 'Connected to the live service.',
  'control.connection.resuming': 'Restoring the live connection…',
  'control.connection.degraded': 'Live connection interrupted.',
  'control.connection.closed': 'Live connection closed.',
  'app.skipToMain': 'Skip to main content',
  'app.nav.label': 'Main',
  'app.nav.services': 'Services',
  'app.nav.library': 'Library',
  'app.nav.administration': 'Administration',
  'app.nav.users': 'Users',
  'app.account.signedInAs': 'Signed in as {name}',
  'app.role.admin': 'Administrator',
  'app.role.editor': 'Editor',
  'app.role.member': 'Member',
  'app.signOut': 'Sign out',
  'app.signOut.failed': 'Signing out failed. Try again.',
  'app.loading': 'Loading…',
  'app.notFound.title': 'Page not found',
  'app.notFound.body': 'Nothing lives at this address.',
  'app.notFound.link': 'Go to services',
  'app.services.title': 'Services',
  'app.services.empty': 'Service planning arrives in a later update. Open a service from its link to present it.',
  'app.service.title': 'Service {id}',
  'form.error.summary': 'Check the highlighted fields.',
  'form.error.required': 'This field is required.',
  'form.error.length': 'Use {minimum} to {maximum} characters.',
  'form.error.network': 'The server could not be reached. Check the connection and try again.',
  'form.error.unexpected': 'Something went wrong ({code}). Try again.',
  'welcome.title': 'Welcome to HolyDeck',
  'welcome.intro': 'Create the first account. It administers this installation.',
  'welcome.name': 'Handle',
  'welcome.name.hint': '{minimum} to {maximum} characters, used to sign in.',
  'welcome.displayName': 'Display name',
  'welcome.password': 'Password',
  'welcome.password.hint': '{minimum} to {maximum} characters.',
  'welcome.confirm': 'Confirm password',
  'welcome.submit': 'Create account',
  'welcome.error.mismatch': 'The passwords do not match.',
  'welcome.error.claimed': 'This installation already has an administrator. Sign in instead.',
  'signIn.title': 'Sign in',
  'signIn.name': 'Handle',
  'signIn.password': 'Password',
  'signIn.code': 'Authenticator code (if enabled)',
  'signIn.submit': 'Sign in',
  'signIn.refused': 'Signing in failed. Check the handle and the password, and try again in a few minutes.',
  'signIn.expired': 'Your session ended. Sign in again to continue.',
  'session.expiring': 'You will be signed out in {minutes} minutes because of inactivity.',
  'session.stay': 'Stay signed in',
  'session.extended': 'You are still signed in.',
  'session.expired': 'You were signed out after a period of inactivity.',
  'update.title': 'Update required',
  'update.body': 'A newer version of HolyDeck is running on the server. Reload to continue; unsaved form entries are kept.',
  'update.reload': 'Reload',
  'users.title': 'Users',
  'users.caption': 'Accounts on this installation',
  'users.column.name': 'Handle',
  'users.column.displayName': 'Display name',
  'users.column.role': 'Role',
  'users.column.status': 'Status',
  'users.column.control': 'Control presentation',
  'users.column.actions': 'Actions',
  'users.status.active': 'Active',
  'users.status.disabled': 'Disabled',
  'users.control.granted': 'Allowed',
  'users.control.none': 'Not allowed',
  'users.you': '(you)',
  'users.action.disable': 'Disable {name}',
  'users.action.restore': 'Restore {name}',
  'users.action.grantControl': 'Allow {name} to control presentation',
  'users.action.revokeControl': 'Stop {name} controlling presentation',
  'users.action.role': 'Role for {name}',
  'users.create.title': 'Create an account',
  'users.create.submit': 'Create account',
  'users.announce.created': 'Account {name} created.',
  'users.announce.updated': 'Account {name} updated.',
  'users.refused': 'The change was refused: {message}',
  'users.loadFailed': 'The accounts could not be loaded.',
} as const;

export type MessageKey = keyof typeof en;

type Catalog = Readonly<Record<MessageKey, string>>;

const de: Catalog = {
  'shell.preparing': 'Die Gottesdienstansicht wird vorbereitet.',
  'service.slideCount.one': '{count} Folie',
  'service.slideCount.other': '{count} Folien',
  'output.channel.audience': 'Publikum',
  'output.channel.stage': 'Bühne',
  'output.channel.singer': 'Sänger',
  'output.launch.screen': '{view} wurde auf dem zugewiesenen Bildschirm geöffnet.',
  'output.launch.manual':
    '{view} wurde geöffnet. Ziehen Sie dieses Fenster auf seinen Bildschirm und nutzen Sie dann die Vollbildfunktion des Displays.',
  'output.launch.blocked': '{view} wurde von der Popup-Blockierung des Browsers verhindert. Zum Öffnen klicken.',
  'arrangement.preview.screen': '{view} wird auf dem gespeicherten Bildschirm geöffnet.',
  'arrangement.preview.manual':
    '{view} wird ohne den gespeicherten Bildschirm geöffnet; ziehen Sie es nach dem Öffnen an seinen Platz.',
  'placement.screen.primary': 'Bildschirm {number} (Haupt), {width} × {height}',
  'placement.screen.secondary': 'Bildschirm {number}, {width} × {height}',
  'placement.applied': '{view} wurde auf {screen} geöffnet.',
  'placement.unapplied.notAuthorized':
    '{view} wurde nicht geöffnet: Diese Sitzung darf die Präsentation nicht steuern.',
  'placement.unapplied.notIssued':
    '{view} wurde nicht geöffnet: Die Antwort des Servers enthielt keine Berechtigung, die dieser Client lesen konnte.',
  'placement.unapplied.detection':
    '{view} wurde ohne den zugewiesenen Bildschirm geöffnet, da dieser Browser die Bildschirme nicht aufgelistet hat. Ziehen Sie es an seinen Platz.',
  'placement.unapplied.screenAbsent':
    '{view} wurde ohne den zugewiesenen Bildschirm geöffnet, da dieser Bildschirm nicht mehr vorhanden ist. Ziehen Sie es an seinen Platz.',
  'placement.unapplied.unassigned':
    '{view} wurde ohne Bildschirm geöffnet, da ihm keiner zugewiesen ist. Ziehen Sie es an seinen Platz.',
  'placement.unapplied.blocked':
    '{view} wurde von der Popup-Blockierung des Browsers verhindert und daher nicht platziert. Zum Öffnen klicken.',
  'localOutput.fullscreen.entered': 'Vollbildpräsentation aktiv.',
  'localOutput.fullscreen.exited': 'Vollbildmodus beendet.',
  'localOutput.fullscreen.absent':
    'Dieser Browser kann von der Seite aus nicht in den Vollbildmodus wechseln. Drücken Sie stattdessen F11 oder die Vollbildtaste Ihres Browsers.',
  'localOutput.fullscreen.denied':
    'Der Vollbildmodus wurde nicht gewährt. Drücken Sie stattdessen F11 oder die Vollbildtaste Ihres Browsers.',
  'localOutput.wakeLock.active': 'Dieser Bildschirm wird wachgehalten.',
  'localOutput.wakeLock.released': 'Dieser Bildschirm wird nicht wachgehalten.',
  'localOutput.wakeLock.lost':
    'Die Bildschirmsperre wurde verloren. Sie wird erneut angefordert, sobald dieser Tab aktiv ist.',
  'localOutput.wakeLock.absent':
    'Dieser Browser kann den Bildschirm nicht automatisch wachhalten. Passen Sie die Energieeinstellungen dieses Geräts für den Gottesdienst an.',
  'localOutput.wakeLock.denied':
    'Die Berechtigung, den Bildschirm wachzuhalten, wurde nicht erteilt. Passen Sie die Energieeinstellungen dieses Geräts für den Gottesdienst an.',
  'liveMedia.playing': 'Das Medium wird abgespielt.',
  'liveMedia.autoplayBlocked':
    'Dieser Browser hat das Medium nicht von selbst gestartet. Drücken Sie Wiedergabe, um es zu starten.',
  'liveMedia.loadError':
    'Das Medium konnte nicht geladen werden. Das letzte Bild wird weiterhin angezeigt; drücken Sie Erneut versuchen, um es noch einmal zu laden.',
  'liveMedia.follower.silent':
    'Diese Ansicht spielt das Medium nicht ab. Aktivieren Sie die Wiedergabe, um es synchron zu {view} abzuspielen.',
  'liveMedia.follower.synchronized': 'Wiedergabe synchron zu {view}.',
  'liveMedia.follower.resynchronized': 'Wieder synchron zu {view}.',
  'announce.connection.reconnecting': 'Verbindung wird wiederhergestellt; das letzte öffentliche Bild bleibt sichtbar',
  'announce.connection.lost':
    'Verbindung unterbrochen. Ihr zuletzt eingegebener Text ist gesichert. Die Bearbeitung pausiert, bis die Verbindung wiederhergestellt ist.',
  'announce.connection.restored': 'Wieder online. Es wird nach neueren Änderungen gesucht…',
  'audienceOffline.live': 'Folgt dem Live-Gottesdienst.',
  'audienceOffline.offline':
    'Die Live-Verbindung wurde unterbrochen. Es wird die zuletzt geprüfte Kopie gezeigt; andere Bildschirme stimmen möglicherweise nicht mehr damit überein.',
  'audienceOffline.unavailable':
    'Die Live-Verbindung wurde unterbrochen, und es ist keine geprüfte Kopie zum Anzeigen vorhanden.',
  'control.skipLinks.label': 'Sprungmarken',
  'control.skip.order': 'Zum Ablauf springen',
  'control.skip.editorPreview': 'Zu Editor und Vorschau springen',
  'control.skip.properties': 'Zu Eigenschaften springen',
  'control.skip.liveControls': 'Zur Live-Steuerung springen',
  'control.region.order': 'Ablauf',
  'control.region.editorPreview': 'Editor und Vorschau',
  'control.region.properties': 'Eigenschaften',
  'control.region.liveControls': 'Live-Steuerung',
  'control.order.empty': 'Noch keine Folien in diesem Ablauf.',
  'control.order.select': '{label} anzeigen',
  'control.editor.heading': 'Bearbeitung',
  'control.editor.empty': 'Noch nichts zum Bearbeiten ausgewählt.',
  'control.preview.heading': 'Vorschau',
  'control.preview.current': 'Aktuell',
  'control.preview.next': 'Nächste',
  'control.preview.noNext': 'Keine nächste Folie.',
  'control.preview.empty': 'Noch nichts zum Anzeigen.',
  'control.properties.label': 'Bezeichnung',
  'control.properties.empty': 'Wählen Sie eine Folie, um ihre Eigenschaften zu sehen.',
  'control.live.previous': 'Vorherige Folie',
  'control.live.next': 'Nächste Folie',
  'control.status.showing': 'Zeigt jetzt {label}.',
  'control.connection.authorizing': 'Live-Zugriff wird geprüft…',
  'control.connection.connecting': 'Verbindung zum laufenden Gottesdienst wird hergestellt…',
  'control.connection.synchronised': 'Mit dem laufenden Gottesdienst verbunden.',
  'control.connection.resuming': 'Live-Verbindung wird wiederhergestellt…',
  'control.connection.degraded': 'Live-Verbindung unterbrochen.',
  'control.connection.closed': 'Live-Verbindung geschlossen.',
  'app.skipToMain': 'Zum Hauptinhalt springen',
  'app.nav.label': 'Hauptnavigation',
  'app.nav.services': 'Gottesdienste',
  'app.nav.library': 'Bibliothek',
  'app.nav.administration': 'Verwaltung',
  'app.nav.users': 'Benutzer',
  'app.account.signedInAs': 'Angemeldet als {name}',
  'app.role.admin': 'Administration',
  'app.role.editor': 'Bearbeitung',
  'app.role.member': 'Mitglied',
  'app.signOut': 'Abmelden',
  'app.signOut.failed': 'Abmelden fehlgeschlagen. Bitte erneut versuchen.',
  'app.loading': 'Wird geladen…',
  'app.notFound.title': 'Seite nicht gefunden',
  'app.notFound.body': 'Unter dieser Adresse gibt es nichts.',
  'app.notFound.link': 'Zu den Gottesdiensten',
  'app.services.title': 'Gottesdienste',
  'app.services.empty': 'Die Gottesdienstplanung folgt in einem späteren Update. Öffnen Sie einen Gottesdienst über seinen Link, um ihn zu präsentieren.',
  'app.service.title': 'Gottesdienst {id}',
  'form.error.summary': 'Bitte prüfen Sie die markierten Felder.',
  'form.error.required': 'Dieses Feld ist erforderlich.',
  'form.error.length': 'Verwenden Sie {minimum} bis {maximum} Zeichen.',
  'form.error.network': 'Der Server ist nicht erreichbar. Prüfen Sie die Verbindung und versuchen Sie es erneut.',
  'form.error.unexpected': 'Etwas ist schiefgelaufen ({code}). Bitte erneut versuchen.',
  'welcome.title': 'Willkommen bei HolyDeck',
  'welcome.intro': 'Legen Sie das erste Konto an. Es verwaltet diese Installation.',
  'welcome.name': 'Anmeldename',
  'welcome.name.hint': '{minimum} bis {maximum} Zeichen, zum Anmelden.',
  'welcome.displayName': 'Anzeigename',
  'welcome.password': 'Passwort',
  'welcome.password.hint': '{minimum} bis {maximum} Zeichen.',
  'welcome.confirm': 'Passwort bestätigen',
  'welcome.submit': 'Konto anlegen',
  'welcome.error.mismatch': 'Die Passwörter stimmen nicht überein.',
  'welcome.error.claimed': 'Diese Installation hat bereits eine Administration. Bitte melden Sie sich an.',
  'signIn.title': 'Anmelden',
  'signIn.name': 'Anmeldename',
  'signIn.password': 'Passwort',
  'signIn.code': 'Code aus der Authentifizierungs-App (falls aktiviert)',
  'signIn.submit': 'Anmelden',
  'signIn.refused': 'Anmeldung fehlgeschlagen. Prüfen Sie Anmeldename und Passwort und versuchen Sie es in einigen Minuten erneut.',
  'signIn.expired': 'Ihre Sitzung ist abgelaufen. Melden Sie sich erneut an, um fortzufahren.',
  'session.expiring': 'Sie werden wegen Inaktivität in {minutes} Minuten abgemeldet.',
  'session.stay': 'Angemeldet bleiben',
  'session.extended': 'Sie sind weiterhin angemeldet.',
  'session.expired': 'Sie wurden nach einer Zeit der Inaktivität abgemeldet.',
  'update.title': 'Aktualisierung erforderlich',
  'update.body': 'Auf dem Server läuft eine neuere Version von HolyDeck. Laden Sie neu, um fortzufahren; ungespeicherte Formulareingaben bleiben erhalten.',
  'update.reload': 'Neu laden',
  'users.title': 'Benutzer',
  'users.caption': 'Konten dieser Installation',
  'users.column.name': 'Anmeldename',
  'users.column.displayName': 'Anzeigename',
  'users.column.role': 'Rolle',
  'users.column.status': 'Zustand',
  'users.column.control': 'Präsentation steuern',
  'users.column.actions': 'Aktionen',
  'users.status.active': 'Aktiv',
  'users.status.disabled': 'Deaktiviert',
  'users.control.granted': 'Erlaubt',
  'users.control.none': 'Nicht erlaubt',
  'users.you': '(Sie)',
  'users.action.disable': '{name} deaktivieren',
  'users.action.restore': '{name} wiederherstellen',
  'users.action.grantControl': '{name} das Steuern der Präsentation erlauben',
  'users.action.revokeControl': '{name} das Steuern der Präsentation entziehen',
  'users.action.role': 'Rolle für {name}',
  'users.create.title': 'Konto anlegen',
  'users.create.submit': 'Konto erstellen',
  'users.announce.created': 'Konto {name} angelegt.',
  'users.announce.updated': 'Konto {name} aktualisiert.',
  'users.refused': 'Die Änderung wurde abgelehnt: {message}',
  'users.loadFailed': 'Die Konten konnten nicht geladen werden.',
};

const ta: Catalog = {
  'shell.preparing': 'வழிபாட்டுக் காட்சி தயாராகிறது.',
  'service.slideCount.one': '{count} ஸ்லைடு',
  'service.slideCount.other': '{count} ஸ்லைடுகள்',
  'output.channel.audience': 'பார்வையாளர்',
  'output.channel.stage': 'மேடை',
  'output.channel.singer': 'பாடகர்',
  'output.launch.screen': '{view} அதற்கான திரையில் திறக்கப்பட்டது.',
  'output.launch.manual':
    '{view} திறக்கப்பட்டது. இந்த சாளரத்தை அதற்கான திரைக்கு இழுத்துச் சென்று, பின்னர் காட்சியின் முழுத்திரைக் கட்டுப்பாட்டைப் பயன்படுத்தவும்.',
  'output.launch.blocked': '{view} உலாவியின் பாப்-அப் கொள்கையால் தடுக்கப்பட்டது. திறக்க கிளிக் செய்யவும்.',
  'arrangement.preview.screen': '{view} அதற்கான சேமிக்கப்பட்ட திரையில் திறக்கப்படும்.',
  'arrangement.preview.manual':
    '{view} சேமிக்கப்பட்ட திரை இல்லாமல் திறக்கப்படும்; திறந்தவுடன் அதை இழுத்து வைக்கவும்.',
  'placement.screen.primary': 'திரை {number} (முதன்மை), {width} × {height}',
  'placement.screen.secondary': 'திரை {number}, {width} × {height}',
  'placement.applied': '{view} {screen} இல் திறக்கப்பட்டது.',
  'placement.unapplied.notAuthorized':
    '{view} திறக்கப்படவில்லை: இந்த அமர்வு வழிபாட்டுக் காட்சியைக் கட்டுப்படுத்த அனுமதிக்கப்படவில்லை.',
  'placement.unapplied.notIssued':
    '{view} திறக்கப்படவில்லை: சேவையகத்தின் பதிலில் இந்த கிளையன்ட் படிக்கக்கூடிய அனுமதி எதுவும் இல்லை.',
  'placement.unapplied.detection':
    '{view} அதற்கான திரை இல்லாமல் திறக்கப்பட்டது, ஏனெனில் இந்த உலாவி திரைகளைப் பட்டியலிடவில்லை. அதை இழுத்து வைக்கவும்.',
  'placement.unapplied.screenAbsent':
    '{view} அதற்கான திரை இல்லாமல் திறக்கப்பட்டது, ஏனெனில் அந்தத் திரை இனி இல்லை. அதை இழுத்து வைக்கவும்.',
  'placement.unapplied.unassigned':
    '{view} திரை இல்லாமல் திறக்கப்பட்டது, ஏனெனில் அதற்கு எதுவும் ஒதுக்கப்படவில்லை. அதை இழுத்து வைக்கவும்.',
  'placement.unapplied.blocked':
    '{view} உலாவியின் பாப்-அப் கொள்கையால் தடுக்கப்பட்டது, எனவே அது வைக்கப்படவில்லை. திறக்க கிளிக் செய்யவும்.',
  'localOutput.fullscreen.entered': 'முழுத்திரையில் காட்டப்படுகிறது.',
  'localOutput.fullscreen.exited': 'முழுத்திரை பயன்முறை நிறுத்தப்பட்டது.',
  'localOutput.fullscreen.absent':
    'இந்த உலாவியால் பக்கத்திலிருந்து முழுத்திரைக்குச் செல்ல முடியாது. அதற்குப் பதிலாக F11 ஐ அழுத்தவும், அல்லது உங்கள் உலாவியின் முழுத்திரைப் பட்டனைப் பயன்படுத்தவும்.',
  'localOutput.fullscreen.denied':
    'முழுத்திரைக்கான அனுமதி வழங்கப்படவில்லை. அதற்குப் பதிலாக F11 ஐ அழுத்தவும், அல்லது உங்கள் உலாவியின் முழுத்திரைப் பட்டனைப் பயன்படுத்தவும்.',
  'localOutput.wakeLock.active': 'இந்தத் திரை விழிப்புடன் வைக்கப்பட்டுள்ளது.',
  'localOutput.wakeLock.released': 'இந்தத் திரை விழிப்புடன் வைக்கப்படவில்லை.',
  'localOutput.wakeLock.lost':
    'திரை விழிப்புப் பூட்டு இழக்கப்பட்டது. இந்தத் தாவல் மீண்டும் செயலில் வரும்போது மீண்டும் கோரப்படும்.',
  'localOutput.wakeLock.absent':
    'இந்த உலாவியால் திரையைத் தானாக விழிப்புடன் வைக்க முடியாது. இந்தச் சேவைக்காக இந்தச் சாதனத்தின் உறக்க அமைப்புகளை மாற்றவும்.',
  'localOutput.wakeLock.denied':
    'திரையை விழிப்புடன் வைக்க அனுமதி வழங்கப்படவில்லை. இந்தச் சேவைக்காக இந்தச் சாதனத்தின் உறக்க அமைப்புகளை மாற்றவும்.',
  'liveMedia.playing': 'ஊடகம் இயக்கப்படுகிறது.',
  'liveMedia.autoplayBlocked': 'இந்த உலாவி ஊடகத்தைத் தானாகத் தொடங்கவில்லை. தொடங்க இயக்கு பட்டனை அழுத்தவும்.',
  'liveMedia.loadError':
    'ஊடகத்தை ஏற்ற முடியவில்லை. கடைசி சட்டகம் இன்னும் காட்டப்படுகிறது; மீண்டும் ஏற்ற, மீண்டும் முயற்சி பட்டனை அழுத்தவும்.',
  'liveMedia.follower.silent': 'இந்தக் காட்சி ஊடகத்தை இயக்கவில்லை. {view} உடன் ஒத்திசைவாக இயக்க இதைத் தேர்ந்தெடுக்கவும்.',
  'liveMedia.follower.synchronized': '{view} உடன் ஒத்திசைவாக இயக்கப்படுகிறது.',
  'liveMedia.follower.resynchronized': '{view} உடன் மீண்டும் ஒத்திசைக்கப்பட்டது.',
  'announce.connection.reconnecting': 'மீண்டும் இணைக்கப்படுகிறது; கடைசியாகக் காட்டப்பட்ட பொதுச் சட்டகம் தொடர்ந்து தெரியும்',
  'announce.connection.lost':
    'இணைப்பு துண்டிக்கப்பட்டது. நீங்கள் கடைசியாகத் தட்டச்சு செய்த உரை பாதுகாப்பாக உள்ளது. மீண்டும் இணைக்கப்படும் வரை திருத்தம் இடைநிறுத்தப்பட்டுள்ளது.',
  'announce.connection.restored': 'மீண்டும் இணைப்பில். புதிய மாற்றங்கள் சரிபார்க்கப்படுகின்றன…',
  'audienceOffline.live': 'நேரடி வழிபாட்டைப் பின்தொடர்கிறது.',
  'audienceOffline.offline':
    'நேரடி இணைப்பு துண்டிக்கப்பட்டது. கடைசியாக சரிபார்க்கப்பட்ட நகல் காட்டப்படுகிறது; மற்ற திரைகள் இனி இதற்குப் பொருந்தாமல் இருக்கலாம்.',
  'audienceOffline.unavailable':
    'நேரடி இணைப்பு துண்டிக்கப்பட்டது, மேலும் காட்ட சரிபார்க்கப்பட்ட நகல் எதுவும் இல்லை.',
  'control.skipLinks.label': 'தாவல் இணைப்புகள்',
  'control.skip.order': 'வரிசைக்குச் செல்க',
  'control.skip.editorPreview': 'எடிட்டர் மற்றும் முன்னோட்டத்திற்குச் செல்க',
  'control.skip.properties': 'பண்புகளுக்குச் செல்க',
  'control.skip.liveControls': 'நேரடி கட்டுப்பாடுகளுக்குச் செல்க',
  'control.region.order': 'வரிசை',
  'control.region.editorPreview': 'எடிட்டர் மற்றும் முன்னோட்டம்',
  'control.region.properties': 'பண்புகள்',
  'control.region.liveControls': 'நேரடி கட்டுப்பாடுகள்',
  'control.order.empty': 'இந்த வரிசையில் இன்னும் ஸ்லைடுகள் இல்லை.',
  'control.order.select': '{label} காட்டு',
  'control.editor.heading': 'எடிட்டர்',
  'control.editor.empty': 'திருத்த எதுவும் தேர்ந்தெடுக்கப்படவில்லை.',
  'control.preview.heading': 'முன்னோட்டம்',
  'control.preview.current': 'தற்போதைய',
  'control.preview.next': 'அடுத்தது',
  'control.preview.noNext': 'அடுத்த ஸ்லைடு இல்லை.',
  'control.preview.empty': 'முன்னோட்டத்திற்கு எதுவும் இல்லை.',
  'control.properties.label': 'லேபிள்',
  'control.properties.empty': 'பண்புகளைக் காண ஒரு ஸ்லைடைத் தேர்ந்தெடுக்கவும்.',
  'control.live.previous': 'முந்தைய ஸ்லைடு',
  'control.live.next': 'அடுத்த ஸ்லைடு',
  'control.status.showing': 'இப்போது {label} காட்டப்படுகிறது.',
  'control.connection.authorizing': 'நேரலை அணுகல் சரிபார்க்கப்படுகிறது…',
  'control.connection.connecting': 'நேரலை வழிபாட்டுடன் இணைக்கப்படுகிறது…',
  'control.connection.synchronised': 'நேரலை வழிபாட்டுடன் இணைக்கப்பட்டுள்ளது.',
  'control.connection.resuming': 'நேரலை இணைப்பு மீட்டமைக்கப்படுகிறது…',
  'control.connection.degraded': 'நேரலை இணைப்பு தடைப்பட்டது.',
  'control.connection.closed': 'நேரலை இணைப்பு மூடப்பட்டது.',
  'app.skipToMain': 'முதன்மை உள்ளடக்கத்திற்குச் செல்லவும்',
  'app.nav.label': 'முதன்மை வழிசெலுத்தல்',
  'app.nav.services': 'வழிபாடுகள்',
  'app.nav.library': 'நூலகம்',
  'app.nav.administration': 'நிர்வாகம்',
  'app.nav.users': 'பயனர்கள்',
  'app.account.signedInAs': '{name} ஆக உள்நுழைந்துள்ளீர்கள்',
  'app.role.admin': 'நிர்வாகி',
  'app.role.editor': 'தொகுப்பாளர்',
  'app.role.member': 'உறுப்பினர்',
  'app.signOut': 'வெளியேறு',
  'app.signOut.failed': 'வெளியேற முடியவில்லை. மீண்டும் முயற்சிக்கவும்.',
  'app.loading': 'ஏற்றப்படுகிறது…',
  'app.notFound.title': 'பக்கம் கிடைக்கவில்லை',
  'app.notFound.body': 'இந்த முகவரியில் எதுவும் இல்லை.',
  'app.notFound.link': 'வழிபாடுகளுக்குச் செல்லவும்',
  'app.services.title': 'வழிபாடுகள்',
  'app.services.empty': 'வழிபாட்டுத் திட்டமிடல் பின்னர் வரும் புதுப்பிப்பில் வரும். வழங்க ஒரு வழிபாட்டை அதன் இணைப்பிலிருந்து திறக்கவும்.',
  'app.service.title': 'வழிபாடு {id}',
  'form.error.summary': 'குறிக்கப்பட்ட புலங்களைச் சரிபார்க்கவும்.',
  'form.error.required': 'இந்தப் புலம் கட்டாயம்.',
  'form.error.length': '{minimum} முதல் {maximum} எழுத்துகளைப் பயன்படுத்தவும்.',
  'form.error.network': 'சேவையகத்தை அணுக முடியவில்லை. இணைப்பைச் சரிபார்த்து மீண்டும் முயற்சிக்கவும்.',
  'form.error.unexpected': 'ஏதோ தவறு நடந்தது ({code}). மீண்டும் முயற்சிக்கவும்.',
  'welcome.title': 'HolyDeck-க்கு வரவேற்கிறோம்',
  'welcome.intro': 'முதல் கணக்கை உருவாக்கவும். அது இந்த நிறுவலை நிர்வகிக்கும்.',
  'welcome.name': 'பயனர் பெயர்',
  'welcome.name.hint': 'உள்நுழையப் பயன்படும், {minimum} முதல் {maximum} எழுத்துகள்.',
  'welcome.displayName': 'காட்சிப் பெயர்',
  'welcome.password': 'கடவுச்சொல்',
  'welcome.password.hint': '{minimum} முதல் {maximum} எழுத்துகள்.',
  'welcome.confirm': 'கடவுச்சொல்லை உறுதிப்படுத்தவும்',
  'welcome.submit': 'கணக்கை உருவாக்கு',
  'welcome.error.mismatch': 'கடவுச்சொற்கள் பொருந்தவில்லை.',
  'welcome.error.claimed': 'இந்த நிறுவலுக்கு ஏற்கனவே ஒரு நிர்வாகி உள்ளார். அதற்குப் பதிலாக உள்நுழையவும்.',
  'signIn.title': 'உள்நுழை',
  'signIn.name': 'பயனர் பெயர்',
  'signIn.password': 'கடவுச்சொல்',
  'signIn.code': 'அங்கீகாரக் குறியீடு (இயக்கப்பட்டிருந்தால்)',
  'signIn.submit': 'உள்நுழை',
  'signIn.refused': 'உள்நுழைவு தோல்வியடைந்தது. பயனர் பெயரையும் கடவுச்சொல்லையும் சரிபார்த்து, சில நிமிடங்களில் மீண்டும் முயற்சிக்கவும்.',
  'signIn.expired': 'உங்கள் அமர்வு முடிந்தது. தொடர மீண்டும் உள்நுழையவும்.',
  'session.expiring': 'செயலற்ற நிலையால் {minutes} நிமிடங்களில் நீங்கள் வெளியேற்றப்படுவீர்கள்.',
  'session.stay': 'உள்நுழைந்தே இருக்கவும்',
  'session.extended': 'நீங்கள் இன்னும் உள்நுழைந்துள்ளீர்கள்.',
  'session.expired': 'சிறிது நேரம் செயலற்றிருந்ததால் நீங்கள் வெளியேற்றப்பட்டீர்கள்.',
  'update.title': 'புதுப்பிப்பு தேவை',
  'update.body': 'சேவையகத்தில் HolyDeck-இன் புதிய பதிப்பு இயங்குகிறது. தொடர மீண்டும் ஏற்றவும்; சேமிக்கப்படாத படிவ உள்ளீடுகள் வைக்கப்படும்.',
  'update.reload': 'மீண்டும் ஏற்று',
  'users.title': 'பயனர்கள்',
  'users.caption': 'இந்த நிறுவலில் உள்ள கணக்குகள்',
  'users.column.name': 'பயனர் பெயர்',
  'users.column.displayName': 'காட்சிப் பெயர்',
  'users.column.role': 'பங்கு',
  'users.column.status': 'நிலை',
  'users.column.control': 'விளக்கக்காட்சிக் கட்டுப்பாடு',
  'users.column.actions': 'செயல்கள்',
  'users.status.active': 'செயலில்',
  'users.status.disabled': 'முடக்கப்பட்டது',
  'users.control.granted': 'அனுமதிக்கப்பட்டது',
  'users.control.none': 'அனுமதிக்கப்படவில்லை',
  'users.you': '(நீங்கள்)',
  'users.action.disable': '{name} ஐ முடக்கு',
  'users.action.restore': '{name} ஐ மீட்டமை',
  'users.action.grantControl': '{name} விளக்கக்காட்சியைக் கட்டுப்படுத்த அனுமதி',
  'users.action.revokeControl': '{name} விளக்கக்காட்சியைக் கட்டுப்படுத்துவதை நிறுத்து',
  'users.action.role': '{name} க்கான பங்கு',
  'users.create.title': 'கணக்கை உருவாக்கவும்',
  'users.create.submit': 'கணக்கை உருவாக்கு',
  'users.announce.created': '{name} கணக்கு உருவாக்கப்பட்டது.',
  'users.announce.updated': '{name} கணக்கு புதுப்பிக்கப்பட்டது.',
  'users.refused': 'மாற்றம் மறுக்கப்பட்டது: {message}',
  'users.loadFailed': 'கணக்குகளை ஏற்ற முடியவில்லை.',
};

/** One catalog per shipped locale: adding a locale is a compile error until its copy exists. */
export const MESSAGES: Readonly<Record<Locale, Catalog>> = { en, de, ta };

// Object.keys is typed as string[] whatever it reads, and the sort is what makes the census below
// readable rather than dependent on the order somebody happened to type the catalog in.
export const MESSAGE_KEYS: readonly MessageKey[] = Object.freeze(
  (Object.keys(en) as MessageKey[]).sort(),
);

export type MessageValues = Readonly<Record<string, string | number>>;

/** Raised rather than returned: a message that cannot be rendered is a defect, not a value. */
export class MessageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MessageError';
  }
}

// Widened views of the catalogs, so the two guards below can be written at all: indexing the narrow
// types can only ever produce a string, which is exactly the assumption a caller in JavaScript or a
// key that arrived as data breaks.
const CATALOGS: Readonly<Record<string, Catalog | undefined>> = MESSAGES;
const entriesOf = (catalog: Catalog): Readonly<Record<string, string | undefined>> => catalog;

const PLACEHOLDER = /\{([a-z][A-Za-z0-9]*)\}/gu;

/**
 * Renders one message. Every placeholder the copy names must have a value and every value passed must
 * have a placeholder, because a renamed placeholder is otherwise invisible: the old name silently
 * renders nothing and the new one silently goes unused.
 */
export function translate(locale: Locale, key: MessageKey, values: MessageValues = {}): string {
  const catalog = CATALOGS[locale];
  if (catalog === undefined) throw new MessageError(`there is no catalog for the locale ${locale}`);
  const template = entriesOf(catalog)[key];
  if (template === undefined) throw new MessageError(`there is no message named ${key}`);

  const used = new Set<string>();
  const rendered = template.replace(PLACEHOLDER, (_whole, name: string) => {
    const value = values[name];
    if (value === undefined) throw new MessageError(`the message ${key} needs a value for {${name}}`);
    used.add(name);
    return typeof value === 'number' ? formatNumber(locale, value) : value;
  });
  for (const name of Object.keys(values)) {
    if (!used.has(name)) throw new MessageError(`the message ${key} has no place for {${name}}`);
  }
  return rendered;
}

type PrefixOf<Key, Suffix extends string> = Key extends `${infer Prefix}.${Suffix}` ? Prefix : never;

/** A message that ships one variant per plural category, named without the category. */
export type CountKey = PrefixOf<MessageKey, 'one'>;

// The compile-time half of the counted-message rule: this line stops typechecking if any counted
// message is missing a variant, because the template type it builds would then name a key nothing has.
const variantKey = (key: CountKey, category: PluralCategory): MessageKey => `${key}.${category}`;

/** Renders a counted message: the locale picks the variant, and the count is formatted in it. */
export function translateCount(
  locale: Locale,
  key: CountKey,
  count: number,
  values: MessageValues = {},
): string {
  return translate(locale, variantKey(key, pluralCategory(locale, count)), { ...values, count });
}
