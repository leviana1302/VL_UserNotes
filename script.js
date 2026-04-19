// ==UserScript==
// @name         VL_UserNotes
// @namespace    http://tampermonkey.net/
// @version      6.1
// @description  Beautify User Notes
// @author       Verena
// @match        https://www.geocaching.com/geocache/GC*
// @match        https://www.geocaching.com/seek/cache_details.aspx*
// @grant        none
// @updateURL    https://github.com/leviana1302/VL_UserNotes/raw/main/script.js
// @downloadURL  https://github.com/leviana1302/VL_UserNotes/raw/main/script.js
// ==/UserScript==

(function () {
    'use strict';

    // ════════════════════════════════════════════════════════════════════════════
    // ⭐ 1. KONSTANTEN
    // ════════════════════════════════════════════════════════════════════════════

    const SCRIPT_VERSION = GM_info?.script?.version ?? "unbekannt";
    const SCRIPT_NAME    = GM_info?.script?.name    ?? "unbekannt";

    /** GC-Code aus Seitenkopf auslesen (ändert sich nicht). */
    const gcCode = (() => {
        const el = document.getElementById("ctl00_ContentBody_CoordInfoLinkControl1_uxCoordInfoCode");
        const code = el?.textContent?.trim() ?? null;
        return code;
    })();

    /** Facebook-Suche URL (Top-Suche, Desktop + Mobile). */
    const FB_SEARCH_URL = "https://www.facebook.com/search/top/?q=__GCCODE__";

    /** Facebook-Logo als SVG-Daten-URI (blaues "f" auf Kreis). */
    const FB_LOGO = "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCI+PGNpcmNsZSBjeD0iMTIiIGN5PSIxMiIgcj0iMTIiIGZpbGw9IiMxODc3RjIiLz48cGF0aCBkPSJNMTYuNSA3LjVoLTJjLS44IDAtMSAuMy0xIDFWMTBoM2wtLjQgM0gxMy41djhIMTB2LThIOC41di0zSDEwVjguM0MxMCA2IDExLjUgNC41IDE0IDQuNWMxLjEgMCAyLjUuMiAyLjUuMlY3LjV6IiBmaWxsPSJ3aGl0ZSIvPjwvc3ZnPg==";

    /** Zentrale Timing-Werte (ms). */
    const TIMINGS = {
        writeLockRelease:      300,   // Dauer bis noteWriteLocked wieder frei
        saveSettleDelay:       400,   // Wartezeit nach writeLines vor Folgeaktion
        resizeAfterOpen:       150,   // Wartezeit nach activateNote für resize
        waitForElementShort:  1000,   // Default-Timeout waitFor
        waitForElementMed:    1500,   // Medium Timeout
        waitForElementLong:   5000,   // Langer Timeout (z.B. Koord-Dialog)
        waitForSolution:     30000,   // Solution-Checker Response
        startupDelay:          500,   // Pipeline-Start nach load-Event
        checkerBtnDelay:       500,   // Nach CheckerButton-Klick
        domMonitorInterval:    500,   // DOM-Monitor Interval
        viewportZoomDelay:     100    // Mobile-Zoom Delay
    };

    /** Regex zur Erkennung gültiger CC-Koordinaten (N/E Minuten-Format). */
    const CC_COORD_REGEX_N = /N\s*\d+°\s*\d+\.\d+/;
    const CC_COORD_REGEX_E = /E\s*\d+°\s*\d+\.\d+/;

    /** Erkennt Zeilen, die mit einem Emoji (Unicode Extended_Pictographic) beginnen. */
    const EMOJI_START_RE = /^\p{Extended_Pictographic}/u;

    /** Exakte Ersetzungen für Beautify (komplette Zeile). */
    const BEAUTIFY_EXACT = {
        "---":              "",
        "MESSAGE:":         "✉️ MESSAGE:",
        "SOLUTION:":        "💡 SOLUTION:",
        "KEIN GEOCHECKER":  "❓ KEIN GEOCHECKER"
    };

    /** Präfix-Ersetzungen (Zeile fängt mit Key an → Emoji davor). */
    const BEAUTIFY_PREFIX = [
        ["MESSAGE:",                "✉️ "],
        ["GC-APPS:",                "🔴 "],
        ["GEOCHECKER OK",           "✅ "],
        ["GEOCHECKER FALSCH",       "❌ "],
        ["CERTITUDE:",              "🟢 "],
        ["CHALLENGE ERFÜLLT",       "🏆 "],
        ["CHALLENGE NICHT ERFÜLLT", "⛔ "],
        ["HINT:",                   "👉 "],
        ["WP",                      "🚩 "],
        ["STAGE",                   "🚩 "],
        ["JIGIDI",                  "🧩 "]
    ];

    /** Emojis, die kleiner dargestellt werden und Scale-Fix brauchen. */
    const SMALL_EMOJIS = new Set(["✳️", "✉️", "⚠️"]);

    // ════════════════════════════════════════════════════════════════════════════
    // ⭐ 2. LOGGER
    // ════════════════════════════════════════════════════════════════════════════

    const log   = (...args) => console.log("[VL]",   ...args);
    const debug = (...args) => console.debug("[VL]", ...args);
    const warn  = (...args) => console.warn("[VL]",  ...args);
    const err   = (...args) => console.error("[VL]", ...args);

    log(`=== ${SCRIPT_NAME} ${SCRIPT_VERSION} gestartet ===`);

    // ════════════════════════════════════════════════════════════════════════════
    // ⭐ 3. DEVICE DETECTION (einmalig beim Script-Start)
    // ════════════════════════════════════════════════════════════════════════════

    const DEVICE = (() => {
        const ua        = navigator.userAgent;
        const isAndroid = /Android/.test(ua);
        const isSafari  = ua.includes('Safari') && !ua.includes('Chrome');
        const isIPad    = ua.includes('iPad') ||
                          (ua.includes('Mac OS X') && navigator.maxTouchPoints >= 5);
        const isIPadSafari = isSafari && isIPad;
        // iPad-Safari rendert die problematischen Emojis fast korrekt (1.1), andere zu klein (1.25)
        const smallEmojiScale = isIPadSafari ? 1.1 : 1.25;

        debug("Device:", { isAndroid, isSafari, isIPad, isIPadSafari, smallEmojiScale });
        return { isAndroid, isSafari, isIPad, isIPadSafari, smallEmojiScale };
    })();

    // ════════════════════════════════════════════════════════════════════════════
    // ⭐ 4. DOM-ZUGRIFFE (zentral)
    // ════════════════════════════════════════════════════════════════════════════

    /** Zentraler Zugriffspunkt auf wichtige DOM-Elemente (immer live abgefragt). */
    const DOM = {
        get note()                 { return document.getElementById("cacheNoteText"); },
        get saveBtn()              { return document.querySelector(".js-pcn-submit"); },
        get cancelBtn()            { return document.querySelector(".js-pcn-cancel"); },
        get corrected()            { return document.getElementById("uxLatLon"); },
        get savedNote()            { return document.getElementById("srOnlyCacheNote"); },
        get viewBtn()              { return document.getElementById("viewCacheNote"); },
        get solutionCheckerLabel() { return document.getElementById("ctl00_ContentBody_lblSolutionChecker"); },
        get solutionResponse()     { return document.getElementById("lblSolutionResponse"); },
        get latLonLink()           { return document.getElementById("uxLatLonLink"); },
        get restoreBtn()           { return document.querySelector(".btn-cc-restore"); },
        get noteSection()          { return document.querySelector(".Note.PersonalCacheNote"); }
    };

    // ════════════════════════════════════════════════════════════════════════════
    // ⭐ 5. STATE (Arbeits-Puffer, Locks, Ursprungs-Text)
    // ════════════════════════════════════════════════════════════════════════════

    /** Arbeits-Puffer für die Note (null = noch nicht geladen). */
    let pendingNoteText = null;

    /** Flag: Wurde der Puffer verändert und muss geschrieben werden? */
    let noteDirty = false;

    /** Lock gegen Ping-Pong zwischen writeLines() und React. */
    let noteWriteLocked = false;

    /** Sicherungskopie der Note VOR allen Script-Änderungen (für Undo). */
    let originalNoteText = null;

    /** Cache für korrigierte Koordinaten (wird per MutationObserver aktualisiert). */
    let cachedCoords = null;

    // ════════════════════════════════════════════════════════════════════════════
    // ⭐ 6. HELPER UTILITIES
    // ════════════════════════════════════════════════════════════════════════════

    /** Pollt `predicate()`, bis er truthy ist oder das Timeout erreicht ist. */
    function waitFor(predicate, { interval = 50, timeoutMs = TIMINGS.waitForElementShort } = {}) {
        return new Promise(resolve => {
            const start = Date.now();
            const tick = () => {
                let res = null;
                try { res = predicate(); } catch (_) {}
                if (res) return resolve(res);
                if (Date.now() - start >= timeoutMs) return resolve(null);
                setTimeout(tick, interval);
            };
            tick();
        });
    }

    /** Schläft `ms` Millisekunden. */
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));

    /**
     * Setzt den Wert einer Textarea React-kompatibel.
     * Verwendet den nativen HTMLTextAreaElement.value-Setter, damit React
     * den neuen Wert in seinen internen State übernimmt.
     * WICHTIG für Mobilgeräte, wo `ta.value = ...` direkt oft ignoriert wird.
     */
    function setTextareaValue(ta, text) {
        if (!ta) return;
        const nativeSetter = Object.getOwnPropertyDescriptor(
            window.HTMLTextAreaElement.prototype, 'value'
        ).set;
        nativeSetter.call(ta, text);
        ta.dispatchEvent(new Event('input', { bubbles: true }));
    }

    /** Kopiert Text in die Zwischenablage (mit Mobile-Fallback). */
    function copyToClipboard(text) {
        if (!text) return;
        navigator.clipboard.writeText(text).catch(() => {
            const ta = document.createElement('textarea');
            ta.value = text;
            ta.style.cssText = "position:fixed;opacity:0";
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy');
            document.body.removeChild(ta);
        });
    }

    /** Stellt sicher, dass der Notifications-Container über der Note existiert. */
    function ensureNotificationsContainer() {
        let container = document.getElementById("vl-notifications-container");
        if (container) return container;

        const noteSection = DOM.noteSection;
        if (!noteSection?.parentElement) return null;

        container = document.createElement("div");
        container.id = "vl-notifications-container";
        noteSection.parentElement.insertBefore(container, noteSection);
        return container;
    }

    /** Heutiges Datum im Format dd.mm.yyyy. */
    const getTodayStr = () => {
        const t = new Date();
        return `${String(t.getDate()).padStart(2, "0")}.${String(t.getMonth() + 1).padStart(2, "0")}.${t.getFullYear()}`;
    };

    /** Cache-Typen, bei denen "KEIN GEOCHECKER" eingefügt werden soll. */
    const GEOCACHER_REQUIRED_TYPES = new Set([
        "Multi-Cache",
        "Mystery-Cache",
        "Letterbox-Hybrid",
        "Wherigo-Geocache"
    ]);

    /** Liest den Cache-Typ aus dem title-Attribut des Cache-Type-Links. */
    function getCacheType() {
        const el = document.querySelector('a[href="/about/cache_types.aspx"][title]');
        return el?.getAttribute("title") ?? null;
    }

    /** Liest korrigierte Koordinaten aus #uxLatLon (nur wenn .italic-Klasse vorhanden). */
    function getCorrectedCoords() {
        const el = DOM.corrected;
        if (!el?.classList.contains("italic")) return null;
        return el.textContent.trim().replace(/'/g, "");
    }

    /** Liefert die gespeicherte Note (schreibgeschützter Textinhalt). */
    const getSavedNote = () => DOM.savedNote?.textContent ?? "";

    /** Prüft, ob die Notiz aktuell geöffnet ist. */
    const isNoteOpen = () => DOM.viewBtn?.style.display === "none";

    /** Wartet, bis #srOnlyCacheNote im DOM verfügbar ist. */
    const waitForSavedNoteLoaded = () =>
        waitFor(() => DOM.savedNote, { interval: 50, timeoutMs: TIMINGS.waitForElementShort });

    /** Wartet auf korrigierte Koordinaten und aktualisiert cachedCoords. */
    async function waitForCoords(timeoutMs = 2000) {
        if (cachedCoords) return cachedCoords;
        const result = await waitFor(() => {
            const c = getCorrectedCoords();
            if (c) cachedCoords = c;
            return c;
        }, { interval: 100, timeoutMs });
        debug("waitForCoords →", result);
        return result;
    }

    /** Passt die Höhe der Textarea dynamisch an den Inhalt an. */
    function resizeNoteTextarea(extra = 20) {
        const ta = DOM.note;
        if (!ta) return;
        ta.style.height = "auto";
        ta.style.height = (ta.scrollHeight + extra) + "px";
    }

    /** Scrollt sanft zur Textarea. */
    const scrollToNote = () => DOM.note?.scrollIntoView({ behavior: "smooth", block: "center" });

    /** Öffnet die Notiz, falls sie geschlossen ist. Returns `true`, wenn geöffnet wurde. */
    function activateNote() {
        const viewBtn = DOM.viewBtn;
        if (!viewBtn || isNoteOpen()) return false;
        viewBtn.click();
        setTimeout(() => resizeNoteTextarea(50), TIMINGS.resizeAfterOpen);
        return true;
    }

    /** Schließt die Notiz ohne zu speichern. */
    function cancelNote() {
        if (!isNoteOpen())    return warn("ESC ignoriert: Note ist nicht offen");
        if (!DOM.cancelBtn)   return warn("ESC ignoriert: Abbrechen-Button nicht gefunden");
        log("Shortcut ESC → Note schließen ohne Speichern");
        DOM.cancelBtn.click();
    }

    /**
     * Bereinigt Zeilen-Array in EINEM Durchgang:
     * - Mehrere aufeinanderfolgende Leerzeilen → genau 1 Leerzeile
     * - Vor jeder Emoji-Zeile (außer am Anfang) → genau 1 Leerzeile
     * - Entfernt führende Leerzeilen am Anfang
     *
     * Funktioniert deterministisch auf Desktop UND Mobile.
     */
    function cleanLines(lines) {
        const result = [];
        let blankCount = 0;

        for (const line of lines) {
            const trimmed = line.trim();
            const isBlank = trimmed === "";
            const isEmojiLine = !isBlank && EMOJI_START_RE.test(trimmed);

            if (isBlank) {
                blankCount++;
                continue;
            }

            // Nicht-leere Zeile: entscheiden, ob eine Leerzeile davor kommen muss
            if (result.length > 0 && (isEmojiLine || blankCount > 0)) {
                result.push("");  // genau EINE Leerzeile
            }

            result.push(line);
            blankCount = 0;
        }

        return result;
    }

    /**
     * Schreibt Zeilen in die Textarea und speichert optional.
     * Bereinigt Leerzeilen (max. 1 zusammenhängend) und stellt sicher,
     * dass vor Emoji-Zeilen genau 1 Leerzeile steht.
     *
     * Verwendet den nativen HTMLTextAreaElement-Setter, damit React
     * den neuen Wert auch auf Mobilgeräten übernimmt.
     */
    function writeLines(lines, save = false) {
        const ta = DOM.note;
        if (!ta)              return err("writeLines: Textarea nicht gefunden");
        if (noteWriteLocked)  return err("writeLines: noteWriteLocked=true");

        // Einheitliche Bereinigung in einem Durchgang
        const cleaned = cleanLines(lines);
        const cleanedText = cleaned.join("\n");

        // Puffer synchronisieren
        setWorkingNote(cleanedText);

        noteWriteLocked = true;

        // React-kompatibel setzen (funktioniert auf Desktop + Mobile)
        setTextareaValue(ta, cleanedText);

        if (save) {
            setTimeout(() => {
                debug("writeLines → speichern");
                DOM.saveBtn?.click();
            }, 200);
        }

        setTimeout(() => {
            noteWriteLocked = false;
            debug("Write-Lock aufgehoben");
        }, TIMINGS.writeLockRelease);
    }

    /** Schreibt den Puffer `pendingNoteText` in die Textarea und speichert. */
    function flushNoteChanges() {
        if (!noteDirty || pendingNoteText === null) return;
        debug("Flush: Puffer wird gespeichert");
        activateNote();
        writeLines(pendingNoteText.split("\n"), true);
        noteDirty = false;
        pendingNoteText = null;
    }

    // ════════════════════════════════════════════════════════════════════════════
    // ⭐ 8. WORKING-NOTE (Pufferverwaltung)
    // ════════════════════════════════════════════════════════════════════════════

    /** Liefert den Arbeits-Puffer (lädt ihn bei Bedarf aus der gespeicherten Note). */
    function getWorkingNote() {
        if (pendingNoteText !== null) return pendingNoteText;
        pendingNoteText = getSavedNote();
        return pendingNoteText;
    }

    /** Setzt den Arbeits-Puffer und markiert ihn als geändert. */
    function setWorkingNote(newText) {
        pendingNoteText = newText;
        noteDirty = true;
    }

    // ════════════════════════════════════════════════════════════════════════════
    // ⭐ 9. BEAUTIFY ENGINE
    // ════════════════════════════════════════════════════════════════════════════

    /**
     * Wendet exakte und Präfix-Ersetzungen auf jede Zeile an, dann cleanLines.
     */
    function beautifyLines(lines) {
        const result = [];

        for (const line of lines) {
            let t = line;

            if (t.trim() === "---") {
                result.push("");
                continue;
            }

            // Prüfe BEAUTIFY_EXACT auf getrimmtem String
            if (BEAUTIFY_EXACT[t.trim()]) {
                t = BEAUTIFY_EXACT[t.trim()];
            }

            // Danach immer BEAUTIFY_PREFIX prüfen
            for (const [prefix, emoji] of BEAUTIFY_PREFIX) {
                if (t.startsWith(prefix)) {
                    if (!t.startsWith(emoji)) t = emoji + t;
                    break;
                }
            }

            result.push(t);
        }

        return cleanLines(result);
    }

    // ════════════════════════════════════════════════════════════════════════════
    // ⭐ 10. CC ENGINE (Koordinaten-Logik)
    // ════════════════════════════════════════════════════════════════════════════

    /** Prüft, ob eine Zeile eine gültige CC-Zeile (📌 + N/E-Koords) ist. */
    function isCCLine(line) {
        if (!line) return false;
        const t = line.trim();
        return t.startsWith("📌")
            && CC_COORD_REGEX_N.test(t)
            && CC_COORD_REGEX_E.test(t);
    }

    /** Formatiert "~* CC:"-Zeilen in das neue 📌-Format. */
    function formatOldCC(line) {
        const t = line.replace(/^~\* CC:\s*/, "").replace(/\s*~\*$/, "").trim();
        const match = t.match(/(N\s*\d+°\s*\d+\.\d+)\s+(E)\s*(\d+)°\s*(\d+\.\d+)/i);
        if (!match) return `📌 (alt) ${t}`;
        const [, north, eastPrefix, eastDegRaw, eastRest] = match;
        return `📌 ${north} ${eastPrefix} ${eastDegRaw.padStart(3, "0")}° ${eastRest}`;
    }

    /** Ersetzt die erste CC-Zeile oder fügt eine am Anfang ein. Mutiert `lines`. */
    function replaceCC(lines, coords) {
        const idx = lines.findIndex(isCCLine);
        if (idx !== -1) lines[idx] = `📌 ${coords}`;
        else lines.unshift(`📌 ${coords}`);
        return lines;
    }

    /** CC-Aktion: entfernt alle 📌-Zeilen, schreibt eine neue an den Anfang. */
    function applyCC(coords) {
        debug("applyCC", coords);
        let lines = getSavedNote().split("\n").filter(l => !l.startsWith("📌"));

        // Alte "~* CC:"-Zeilen: erste wird zur neuen CC-Zeile, weitere werden formatiert
        let firstRemoved = false;
        lines = lines.map(l => {
            if (!l.startsWith("~* CC:")) return l;
            if (!firstRemoved) { firstRemoved = true; return null; }
            return formatOldCC(l);
        }).filter(Boolean);

        lines.unshift(`📌 ${coords}`);
        setWorkingNote(beautifyLines(lines).join("\n"));
    }

    /** Formatiert alte "~* CC:"-Notizen beim Laden der Seite in das neue Format. */
    function autoBeautifyOldNote() {
        const saved = getWorkingNote();
        log("Ursprüngliche Note:\n" + saved);

        let lines = saved.split("\n");
        const coords = getCorrectedCoords();
        log("Korrigierte Koordinaten:", coords ?? "(keine)");
        if (!coords) return;

        // Pfad A: Alte "~* CC:"-Zeilen vorhanden → komplett konvertieren
        if (lines.some(l => l.startsWith("~* CC:"))) {
            let firstConverted = false;
            const newLines = [];
            for (const line of lines) {
                if (line.startsWith("~* CC:")) {
                    if (!firstConverted) {
                        firstConverted = true;
                        newLines.push(`📌 ${coords}`);
                    } else {
                        newLines.push(formatOldCC(line));
                    }
                } else {
                    newLines.push(line);
                }
            }
            setWorkingNote(beautifyLines(newLines).join("\n"));
            return;
        }

        // Pfad B: Keine CC-Zeile vorhanden → neu am Anfang einfügen
        const ccIdx = lines.findIndex(isCCLine);
        if (ccIdx === -1) {
            lines.unshift(`📌 ${coords}`);
            setWorkingNote(beautifyLines(lines).join("\n"));
            return;
        }

        // Pfad C: Vorhandene CC-Zeile ggf. auf aktuelle Koordinaten aktualisieren
        const expected = `📌 ${coords}`;
        if (lines[ccIdx].trim() !== expected) {
            debug("autoBeautifyOldNote: CC-Zeile aktualisiert →", expected);
            lines[ccIdx] = expected;
        }

        // WICHTIG: Am Ende IMMER beautifyLines auf die gesamte Note anwenden
        // (damit auch alte Zeilen wie "KEIN GEOCHECKER" → "❓ KEIN GEOCHECKER" konvertiert werden)
        setWorkingNote(beautifyLines(lines).join("\n"));
    }

    /**
     * Aktualisiert die erste CC-Zeile in der Textarea auf `cachedCoords`.
     * @param {boolean} onlyIfChanged  true = nur schreiben bei Unterschied
     */
    function updateFirstCCLine(onlyIfChanged = false) {
        if (!cachedCoords) return;
        const ta = DOM.note;
        if (!ta) return;

        const lines = ta.value.split("\n");
        if (!isCCLine(lines[0])) return;

        const expected = `📌 ${cachedCoords}`;
        if (onlyIfChanged && lines[0].trim() === expected) return;

        lines[0] = expected;
        writeLines(lines, true);
    }

    // ════════════════════════════════════════════════════════════════════════════
    // ⭐ 11. KOORDINATEN-OBSERVER (live-Update bei Änderung)
    // ════════════════════════════════════════════════════════════════════════════

    /**
     * Beobachtet #uxLatLon auf Änderungen und aktualisiert Note + Dropdown.
     * Wird einmalig beim Script-Start gestartet.
     */
    function initCoordsObserver() {
        cachedCoords = getCorrectedCoords();
        debug("Initiale Koordinaten:", cachedCoords);

        const coordsEl = DOM.corrected;
        if (!coordsEl) return;

        const observer = new MutationObserver(async () => {
            const newCoords = getCorrectedCoords();
            if (!newCoords || newCoords === cachedCoords) return;

            debug("Koordinaten geändert:", newCoords);
            cachedCoords = newCoords;

            // Dropdown-Label aktualisieren (falls UI schon vorhanden)
            const falschOpt = document.querySelector('#cc-snippets [data-vl-key="falsch"]');
            if (falschOpt) {
                const hint = falschOpt.dataset.shortcutKey ? `  [Alt+${falschOpt.dataset.shortcutKey}]` : "";
                falschOpt.textContent = `❌ GEOCHECKER FALSCH (${newCoords})${hint}`;
            }

            // Warten, bis srOnlyCacheNote wirklich geladen ist (auf Mobile wichtig)
            await waitForSavedNoteLoaded();
            autoBeautifyOldNote();
            flushNoteChanges();
        });

        observer.observe(coordsEl, {
            childList:     true,
            characterData: true,
            subtree:       true,
            attributes:    true,            // iOS/Android: italic-Klasse wird per Attribut gesetzt
            attributeFilter: ['class']
        });
    }

    // ════════════════════════════════════════════════════════════════════════════
    // ⭐ 12. SNIPPET-DEFINITIONEN
    // ════════════════════════════════════════════════════════════════════════════

    /**
     * Ein Snippet beschreibt einen einfügbaren Textbaustein oder Link.
     *
     * Felder:
     *   label            – Anzeigename in Dropdown und Tooltip
     *   value            – einzufügender Text (Platzhalter: __COORDS__)
     *   emoji            – Emoji für Schnellzugriff-Button (nur wenn gesetzt)
     *   shortcutKey      – Alt+<Taste> (nur '0'–'9')
     *   autoSave         – sofort speichern nach Einfügen?
     *   removeCC         – CC-Zeile (📌) am Anfang entfernen?
     *   confirmResetCoords – nach Einfügen Reset-Coords-Dialog zeigen?
     *   noBlankBefore    – true = keine Leerzeile davor einfügen (inline-Snippet)
     *   isLink           – true wenn Snippet ein externer Link ist
     *   linkUrl          – URL für isLink=true (Platzhalter: __GCCODE__)
     */
    const SNIPPETS = [
        { label: '➕ Snippet', value: '' },
        {
            label: `✅ GEOCHECKER OK (${getTodayStr()})`,
            emoji: '✅', shortcutKey: '1',
            value: `✅ GEOCHECKER OK (${getTodayStr()})`,
            autoSave: true
        },
        {
            label: `✅ GEOCHECKER OK (${getTodayStr()}) & MESSAGE`,
            emoji: '✳️', shortcutKey: '2',
            value: `✅ GEOCHECKER OK (${getTodayStr()})\n\n✉️ MESSAGE:\n`,
            autoSave: false
        },
        {
            label: `❌ GEOCHECKER FALSCH (Koordinaten)`,
            emoji: '❌', shortcutKey: '3',
            value: '❌ GEOCHECKER FALSCH (__COORDS__)',
            removeCC: true, autoSave: true, confirmResetCoords: true
        },
        { label: '❓ KEIN GEOCHECKER',              emoji: '❓', shortcutKey: '4', value: '❓ KEIN GEOCHECKER' },
        { label: '✉️ MESSAGE:',                     emoji: '✉️', shortcutKey: '5', value: '✉️ MESSAGE:' },
        { label: '⚠️ OBS: Field puzzle from here!', emoji: '⚠️', shortcutKey: '6', value: '⚠️ OBS: Field puzzle from here!' },
        { label: '💡 SOLUTION:',                    emoji: '💡', shortcutKey: '7', value: '💡 SOLUTION:\n' },
        { label: '🧩 JIGIDI:',                      emoji: '🧩', shortcutKey: '8', value: '🧩 JIGIDI:\n' },
        { label: '🟢 CERTITUDE: & ✉️ MESSAGE:',     emoji: '🟢', shortcutKey: '9', value: '🟢 CERTITUDE: \n\n✉️ MESSAGE:\n' },
        { label: '🔴 GC-APPS: & ✉️ MESSAGE:',       emoji: '🔴', shortcutKey: '0', value: '🔴 GC-APPS: \n\n✉️ MESSAGE:\n' },
        {
            label: `🏆 CHALLENGE ERFÜLLT (${getTodayStr()})`,
            emoji: '🏆',
            value: `🏆 CHALLENGE ERFÜLLT (${getTodayStr()})`,
            autoSave: true
        },
        {
            label: `⛔ CHALLENGE NICHT ERFÜLLT (${getTodayStr()})`,
            emoji: '⛔',
            value: `⛔ CHALLENGE NICHT ERFÜLLT (${getTodayStr()})`,
            autoSave: true
        },
        { label: '🔒 CODE:',    emoji: '🔒', value: '🔒 CODE: ' },
        { label: '👉 HINT:',    emoji: '👉', value: '👉 HINT: ' },
        { label: '🚩 WP',       emoji: '🚩', value: '🚩 WP' },
        { label: '🚗 Parken: ', emoji: '🚗', value: '🚗 Parken: ' },
        { label: '➡️ ',               emoji: '➡️', value: '➡️', noBlankBefore: true },
        {
            label: 'Facebook-Suche',
            image: FB_LOGO,
            isFbSearch: true,
            value: ''
        },
        {
            label: '🔍 PUZZLE-COORDS (Desktop)',
            emoji: '🔍',
            value: ``,  // Link wird in applySnippet verarbeitet
            isLink: true,
            linkUrl: 'https://puzzle-coords.info/__GCCODE__'
        },
        {
            label: '📱 PUZZLE-COORDS (Mobile)',
            emoji: '📱',
            value: ``,  // Link wird in applySnippet verarbeitet
            isLink: true,
            linkUrl: 'https://puzzle-coords.info/mobile/mobile_search.php?gc_code=__GCCODE__'
        }
    ];

    // ════════════════════════════════════════════════════════════════════════════
    // ⭐ 13. SNIPPET ENGINE
    // ════════════════════════════════════════════════════════════════════════════

    /**
     * Fügt Text in die Textarea ein. Strategie:
     *  - noBlankBefore: Text direkt am Cursor einfügen (keine Leerzeilen-Logik)
     *  - GeoChecker-Snippets: an definierter Position (nach erstem Block) einfügen
     *  - Note war geschlossen: am Ende anhängen
     *  - Note war offen + Cursor aktiv: an Cursor-Position einfügen
     *
     * Verwendet setTextareaValue (React-kompatibel für Mobile).
     */
    function insertSnippet(text, wasNoteClosed = true, snippet = null) {
        const ta = DOM.note;
        if (!ta) return;

        // INLINE-Snippets (noBlankBefore): direkt am Cursor einfügen, GAR NICHTS SONST
        if (snippet?.noBlankBefore) {
            activateNote();
            const pos = ta.selectionEnd || ta.value.length;

            // Leerzeichen davor einfügen, wenn keins da ist
            let prefix = '';
            if (pos > 0 && ta.value[pos - 1] !== ' ') {
                prefix = ' ';
            }

            // Leerzeichen danach einfügen, wenn keins da ist
            let suffix = '';
            if (pos < ta.value.length && ta.value[pos] !== ' ') {
                suffix = ' ';
            }

            const fullText = prefix + text + suffix;
            ta.setRangeText(fullText, pos, pos, 'end');
            ta.dispatchEvent(new Event('input', { bubbles: true }));
            ta.focus();
            return;
        }

        const isGeoChecker = text.includes("GEOCHECKER OK") || text.includes("GEOCHECKER FALSCH");

        // Fall A: GeoChecker-Snippet → nach erstem Block (= erste Leerzeile)
        if (isGeoChecker) {
            const lines = ta.value.split("\n");
            let i = 0;
            while (i < lines.length && lines[i].trim() !== "") i++;

            if (i === lines.length) {
                lines.push("", text);
            } else {
                lines.splice(i + 1, 0, text);
            }

            const cleaned = cleanLines(lines);
            setTextareaValue(ta, cleaned.join("\n"));
            ta.setSelectionRange(ta.value.length, ta.value.length);
            setTimeout(() => ta.focus(), 10);
            return;
        }

        // Sicherstellen dass Textarea fokussiert ist
        if (ta !== document.activeElement) ta.focus();

        const cursorActive = ta === document.activeElement && typeof ta.selectionStart === "number";

        // Fall B: Note war offen + Cursor aktiv → an Cursor-Position
        if (cursorActive && !wasNoteClosed) {
            debug("insertSnippet → an Cursor-Position");
            const start  = ta.selectionStart;
            const before = ta.value.slice(0, start);
            const after  = ta.value.slice(start);

            const separator = before.length === 0 || before.endsWith("\n") ? "" : "\n";
            const newValue = before + separator + text + after;

            const lines = newValue.split("\n");
            const cleaned = cleanLines(lines);
            setTextareaValue(ta, cleaned.join("\n"));
            const newPos = before.length + separator.length + text.length;
            ta.setSelectionRange(newPos, newPos);
            setTimeout(() => ta.focus(), 10);
            return;
        }

        // Fall C: Default → am Ende anhängen
        debug("insertSnippet → am Ende");
        const lines = ta.value.split("\n");
        const lastLine = lines.length > 0 ? lines[lines.length - 1] : "";
        if (lastLine.trim() !== "") {
            lines.push("");
        }
        lines.push(text);

        const cleaned = cleanLines(lines);
        setTextareaValue(ta, cleaned.join("\n"));
        ta.setSelectionRange(ta.value.length, ta.value.length);
        setTimeout(() => ta.focus(), 10);
    }

    /** Führt ein Snippet vollständig aus: Text auflösen, einfügen, ggf. speichern. */
    async function applySnippet(sn) {
        log("applySnippet:", sn.label);

        // Link-Snippets: sofort öffnen (kein Text in Note)
        if (sn.isLink) {
            if (!gcCode) {
                showNotification("GC-Code nicht gefunden.");
                return;
            }
            const url = sn.linkUrl.replace("__GCCODE__", gcCode);
            log(`Link geöffnet: ${sn.label}`);
            window.open(url, "_blank");
            return;
        }

        // Facebook-Suche: GC-Code in Zwischenablage + neuen Browser-Tab öffnen
        if (sn.isFbSearch) {
            if (!gcCode) {
                showNotification("GC-Code nicht gefunden.");
                return;
            }
            const url = FB_SEARCH_URL.replace("__GCCODE__", gcCode);
            copyToClipboard(gcCode);
            log(`Facebook-Suche: ${url}`);
            // rel="noopener noreferrer" + target verhindert Öffnen in FB-App
            const a = document.createElement("a");
            a.href = url;
            a.target = "_blank";
            a.rel = "noopener noreferrer";
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            return;
        }

        const noteWasClosed = activateNote();
        if (!DOM.note) return;

        // Bei frisch geöffneter Note: auf Textarea-Content warten
        if (noteWasClosed) {
            await waitFor(
                () => DOM.note?.value.trim(),
                { interval: 80, timeoutMs: TIMINGS.waitForElementMed }
            );
        }

        // __COORDS__-Platzhalter auflösen
        let text = sn.value;
        if (text.includes("__COORDS__")) {
            const liveCoords = await waitForCoords();
            text = text.replace("__COORDS__", liveCoords ?? "?");

            if (liveCoords) {
                const opt = document.querySelector('#cc-snippets [data-vl-key="falsch"]');
                if (opt) {
                    const hint = opt.dataset.shortcutKey ? `  [Alt+${opt.dataset.shortcutKey}]` : "";
                    opt.textContent = `❌ GEOCHECKER FALSCH (${liveCoords})${hint}`;
                }
            }
        }

        insertSnippet(text, noteWasClosed, sn);

        // Pfad 1: CC-Zeile entfernen (nur wenn vorhanden)
        if (sn.removeCC) {
            debug("Snippet: removeCC=true → CC-Zeile entfernen");
            const lines = DOM.note.value.split("\n");
            if (isCCLine(lines[0])) lines.shift();
            writeLines(lines, true);
            if (sn.confirmResetCoords) {
                debug("Snippet: Reset-Coords-Prompt anzeigen");
                showResetCoordsPrompt();
            }
            return;
        }

        // Pfad 2: AutoSave
        if (sn.autoSave) {
            debug("Snippet: autoSave=true → speichern");
            writeLines(DOM.note.value.split("\n"), true);
            return;
        }

        // Pfad 3: Kein Save → nur Cursor setzen
        debug("Snippet: kein autoSave, nur Cursor-Focus");
        DOM.note.focus();
        resizeNoteTextarea();
        scrollToNote();
    }

    // ════════════════════════════════════════════════════════════════════════════
    // ⭐ 14. RESET-COORDS PROMPT
    // ════════════════════════════════════════════════════════════════════════════

    /**
     * Zeigt eine Ja/Nein-Abfrage zum Zurücksetzen der korrigierten Koordinaten.
     * Wird nach "GEOCHECKER FALSCH" und bei Seitenstart (falls nötig) angezeigt.
     */
    function showResetCoordsPrompt() {
        debug("showResetCoordsPrompt");
        document.getElementById("vl-reset-coords-prompt")?.remove();

        const container = ensureNotificationsContainer();
        if (!container) return warn("Reset-Coords: Container nicht gefunden");

        const overlay = document.createElement("div");
        overlay.id = "vl-reset-coords-prompt";
        overlay.innerHTML = `
            <span>Korrigierte Koordinaten zurücksetzen?</span>
            <button type="button" class="vl-btn-ja">Ja</button>
            <button type="button" class="vl-btn-nein">Nein</button>`;
        container.appendChild(overlay);

        overlay.querySelector(".vl-btn-nein").addEventListener("click", () => {
            overlay.remove();
            log("Reset-Coords: abgelehnt");
        });

        overlay.querySelector(".vl-btn-ja").addEventListener("click", async () => {
            overlay.remove();
            log("Reset-Coords: bestätigt");

            // CC-Zeile entfernen, falls noch vorhanden
            activateNote();
            const ta = DOM.note;
            if (ta) {
                const lines = ta.value.split("\n");
                if (isCCLine(lines[0])) {
                    debug("Reset-Coords: CC-Zeile entfernen");
                    lines.shift();
                    writeLines(lines, true);
                    await sleep(TIMINGS.saveSettleDelay);
                }
            }

            // Wiederherstellen-Button klicken (evtl. erst Dialog öffnen)
            let restoreBtn = DOM.restoreBtn;
            if (!restoreBtn) {
                debug("Reset-Coords: öffne Koordinaten-Dialog");
                DOM.latLonLink?.click();
                restoreBtn = await waitFor(
                    () => DOM.restoreBtn,
                    { interval: 100, timeoutMs: TIMINGS.waitForElementLong }
                );
            }

            if (restoreBtn) {
                log("Reset-Coords: Wiederherstellen geklickt");
                restoreBtn.click();
            } else {
                err("Reset-Coords: Wiederherstellen-Button nicht gefunden");
            }
        });
    }

    // ════════════════════════════════════════════════════════════════════════════
    // ⭐ 15. NOTIFICATION ENGINE
    // ════════════════════════════════════════════════════════════════════════════

    /** Set der bereits angezeigten Notification-Keys (Deduplizierung). */
    const notified = new Set();

    /**
     * Erzeugt eine Notification oberhalb der Note.
     * Mit checkerLink: Button "Öffnen" springt/öffnet Link; copyCoords: Coords in Clipboard.
     */
    function showNotification(msg, id, checkerLink = null, def = null) {
        if (id && document.getElementById(id)) return;
        const container = ensureNotificationsContainer();
        if (!container) return;

        const bgColor = def?.color ?? "#c62828";
        const div = document.createElement("div");
        div.classList.add("checker-warning");
        div.style.background = bgColor;
        div.textContent = msg;
        if (id) div.id = id;

        if (checkerLink) {
            const btn = document.createElement("button");
            btn.textContent    = "Öffnen";
            btn.style.color    = bgColor;

            btn.addEventListener("click", e => {
                e.preventDefault();
                e.stopPropagation();
                e.stopImmediatePropagation();

                if (def?.copyCoords) {
                    const coords = getCorrectedCoords();
                    if (coords) copyToClipboard(coords);
                }

                if (checkerLink.startsWith("#")) {
                    const element = document.querySelector(checkerLink);
                    if (element) {
                        element.focus({ preventScroll: true });
                        element.scrollIntoView({ behavior: "smooth", block: "center" });
                    }
                } else {
                    window.open(checkerLink, "_blank");
                }
            });

            div.appendChild(btn);
        }

        container.appendChild(div);
    }

    // ════════════════════════════════════════════════════════════════════════════
    // ⭐ 16. CHECKER ENGINE
    // ════════════════════════════════════════════════════════════════════════════

    /** Definitionen für Checker-Erkennung (Links + Notification-Konfiguration). */
    const CHECKER_DEFS = [
        { key: "GEOCHECKER", msg: "⚠️ geochecker.com gefunden",      match: h => h.includes("geochecker.com"),                          copyCoords: true,  color: "#1565c0" },
        { key: "GEOCHECKER", msg: "⚠️ geocheck.org gefunden",        match: h => h.includes("geocheck.org"),                            copyCoords: true,  color: "#1565c0" },
        { key: "GEOCHECKER", msg: "⚠️ geotjek.dk gefunden",          match: h => h.includes("geotjek.dk"),                              copyCoords: true,  color: "#1565c0" },
        { key: "GC-APPS",    msg: "⚠️ GC-Apps Checker gefunden",     match: h => h.includes("gc-apps.com") && h.includes("checker"),    copyCoords: true,  color: "#1565c0" },
        { key: "CERTITUDE",  msg: "⚠️ Certitude Checker gefunden",   match: h => h.includes("certitudes.org"),                          copyCoords: true,  color: "#1565c0" },
        { key: "CHALLENGE",  msg: "⚠️ Challenge-Link gefunden",      match: h => h.startsWith("https://project-gc.com/challenges/"),    copyCoords: false, color: "#f9a825" },
        { key: "JIGIDI",     msg: "🧩 Jigidi-Link gefunden",         match: h => h.includes("jigidi.com/"),                             copyCoords: false, color: "#f9a825" }
    ];

    /**
     * Mapping: notified-Key → Note-Keyword, bei dem die Notification entfernt wird.
     *
     * HINWEIS: "CHALLENGE" ist hier absichtlich NICHT enthalten, damit die
     * Challenge-Notification beim Einfügen von "CHALLENGE NICHT ERFÜLLT"
     * NICHT verschwindet. (Key in scanCheckers ist "CHALLENGE", Lookup
     * ergibt undefined → die Warnung bleibt stehen.)
     */
    const CHECKER_KEYWORDS = {
        "GEOCHECKER":         "GEOCHECKER",
        "GC-APPS":            "GC-APPS",
        "CERTITUDE":          "CERTITUDE",
        "INTERNAL":           "GEOCHECKER",
        "CHALLENGE ERFÜLLT":  "CHALLENGE",  // absichtlich nicht unter "CHALLENGE"!
        "JIGIDI":             "JIGIDI"
    };

    /**
     * Scannt die Seite nach Checker-Links und zeigt Warnungen an.
     * Fügt bei JIGIDI automatisch eine "UNSOLVED"-Zeile in die Note ein.
     * Bei keinen Checkern: fügt "KEIN GEOCHECKER" ein.
     */
    function scanCheckers() {
        log("scanCheckers");
        const saved = getWorkingNote().toUpperCase();
        const anchors = [...document.querySelectorAll("a[href]")]
            .map(a => ({ original: a.href, lower: a.href.toLowerCase() }));

        let foundAnyChecker = false;

        // Integrierter Solution-Checker
        if (DOM.solutionCheckerLabel) {
            foundAnyChecker = true;
            if (!saved.includes("GEOCHECKER") && !notified.has("INTERNAL")) {
                notified.add("INTERNAL");
                showNotification(
                    "⚠️ Integrierter Koordinatenchecker gefunden",
                    "warn-INTERNAL",
                    "#ctl00_ContentBody_lblSolutionChecker",
                    { key: "INTERNAL", color: "#1565c0", copyCoords: false }
                );
            }
        }

        // Externe Checker + Jigidi-Behandlung
        for (const def of CHECKER_DEFS) {
            const anchor = anchors.find(a => def.match(a.lower));
            if (!anchor) continue;

            if (def.key !== "JIGIDI") foundAnyChecker = true;

            if (!saved.includes(def.key) && !notified.has(def.key)) {
                notified.add(def.key);
                showNotification(def.msg, "warn-" + def.key, anchor.original, def);
            }

            if (def.key === "JIGIDI") {
                const working = getWorkingNote().toUpperCase();
                if (working.includes("JIGIDI:") || working.includes("🧩 JIGIDI:")) continue;

                const coords = getCorrectedCoords();
                if (!coords) continue;

                let lines = getWorkingNote().split("\n");
                lines = replaceCC(lines, coords);
                lines = beautifyLines(lines);
                if (lines.length && lines[lines.length - 1].trim() !== "") lines.push("");
                lines.push("🧩 JIGIDI: UNSOLVED");
                setWorkingNote(lines.join("\n"));
            }
        }

        if (foundAnyChecker) return;
        if (saved.includes("KEIN GEOCHECKER")) return;

        // Nur einfügen, wenn Cache-Typ einen Geochecker erfordert
        const cacheType = getCacheType();
        if (!cacheType || !GEOCACHER_REQUIRED_TYPES.has(cacheType)) {
            debug(`scanCheckers: Cache-Typ "${cacheType}" erfordert keinen Geochecker`);
            return;
        }

        // Keine Checker gefunden → "KEIN GEOCHECKER" einfügen
        let lines = getWorkingNote().split("\n");
        const coords = getCorrectedCoords();
        if (coords) lines = replaceCC(lines, coords);
        lines = beautifyLines(lines);

        const ccIdx = lines.findIndex(isCCLine);
        let insertAt = ccIdx !== -1 ? ccIdx + 1 : 0;

        if (insertAt > 0 && lines[insertAt - 1].trim() !== "") {
            lines.splice(insertAt, 0, "");
            insertAt++;
        }
        lines.splice(insertAt, 0, "❓ KEIN GEOCHECKER");

        const hasAfter = lines.slice(insertAt + 1).some(l => l.trim() !== "");
        if (hasAfter && lines[insertAt + 1]?.trim() !== "") {
            lines.splice(insertAt + 1, 0, "");
        }

        setWorkingNote(lines.join("\n"));
    }

    /**
     * Entfernt Notifications, wenn deren Keyword in der gespeicherten Note steht.
     * Wird regelmäßig vom DOM-Monitor aufgerufen.
     */
    function updateCheckerWarnings() {
        const note  = getSavedNote().toUpperCase();
        const lines = note.split("\n").map(l => l.trim());

        for (const key of [...notified]) {
            const keyword = CHECKER_KEYWORDS[key];
            if (!keyword) continue;

            // JIGIDI: separat behandeln (nur entfernen wenn gelöst)
            if (key === "JIGIDI") {
                const hasJigidi   = lines.some(l => l.startsWith("🧩 JIGIDI:") || l.startsWith("JIGIDI:"));
                const hasUnsolved = lines.includes("🧩 JIGIDI: UNSOLVED") || lines.includes("JIGIDI: UNSOLVED");
                if (hasJigidi && !hasUnsolved) {
                    notified.delete(key);
                    document.getElementById("warn-" + key)?.remove();
                }
                continue;
            }

            if (note.includes(keyword)) {
                notified.delete(key);
                document.getElementById("warn-" + key)?.remove();
            }
        }
    }

    /**
     * Behandelt das Ergebnis des integrierten Solution-Checkers.
     * Schreibt automatisch "GEOCHECKER OK" oder "GEOCHECKER FALSCH" mit Datum in die Note.
     */
    async function handleSolutionCheckerResult() {
        const el = await waitFor(() => {
            const e = DOM.solutionResponse;
            return e?.textContent.trim() ? e : null;
        }, { interval: 1000, timeoutMs: TIMINGS.waitForSolution });

        if (!el) return;

        const text = el.textContent.trim();
        let snippet = null;

        if (text.includes("Richtig! Die Koordinaten dieses Caches wurden aktualisiert")) {
            snippet = `✅ GEOCHECKER OK (${getTodayStr()})`;
        } else if (text.includes("Diese Koordinaten sind falsch")) {
            const coords = getCorrectedCoords();
            if (!coords) return;
            snippet = `❌ GEOCHECKER FALSCH (${coords}) (${getTodayStr()})`;
        }
        if (!snippet) return;

        activateNote();
        const ta = await waitFor(() => DOM.note, { interval: 80, timeoutMs: TIMINGS.waitForElementLong });
        if (!ta) return;

        let lines = ta.value.split("\n");

        // Bei "FALSCH": alte CC-Zeile am Anfang entfernen
        if (snippet.includes("GEOCHECKER FALSCH") && isCCLine(lines[0])) {
            debug("SolutionChecker: entferne alte CC-Zeile");
            lines.shift();
        }

        lines = beautifyLines(lines);

        // Nach erstem Block (= erste Leerzeile) einfügen
        let i = 0;
        while (i < lines.length && lines[i].trim() !== "") i++;
        const insertAt = i + 1;
        lines.splice(insertAt, 0, "");
        lines.splice(insertAt + 1, 0, snippet.trimStart());

        scrollToNote();
        writeLines(lines, true);
        await sleep(TIMINGS.saveSettleDelay);
        updateFirstCCLine(false);

        // Reset-Coords-Prompt bei FALSCH + vorhandenen korrigierten Coords
        if (snippet.includes("GEOCHECKER FALSCH") && cachedCoords) {
            log("SolutionChecker: zeige Reset-Coords-Prompt");
            showResetCoordsPrompt();
        }
    }

    // ════════════════════════════════════════════════════════════════════════════
    // ⭐ 17. SAVE-ERROR HANDLER
    // ════════════════════════════════════════════════════════════════════════════

    /**
     * Wenn geocaching.com das Speichern einer Note ablehnt, erscheint unter der Note:
     *   <span class="js-pcn-status validation-error">Es ist ein Fehler aufgetreten…</span>
     * Der einzige zuverlässige Fix ist ein Hard-Reload (Strg+F5). Diese Sektion
     * erkennt den Fehler automatisch und lädt die Seite neu.
     */

    /** Selector für das Fehler-Element. */
    const SAVE_ERROR_SELECTOR = ".js-pcn-status.validation-error";

    /** Teil-String, der im Element-Text stehen muss. */
    const SAVE_ERROR_TEXT = "Es ist ein Fehler aufgetreten";

    /** Verzögerung vor automatischem Reload (Nutzer soll Notification sehen). */
    const SAVE_ERROR_RELOAD_DELAY = 2000;

    /** Flag gegen Mehrfach-Trigger des Reload. */
    let saveErrorReloadTriggered = false;

    /** Prüft, ob das Fehler-Element im DOM sichtbar ist und den Fehlertext enthält. */
    function isSaveErrorVisible() {
        const el = document.querySelector(SAVE_ERROR_SELECTOR);
        if (!el) return false;
        if (!el.textContent.includes(SAVE_ERROR_TEXT)) return false;
        // offsetParent === null bedeutet "nicht sichtbar" (display:none oder detached)
        if (el.offsetParent === null) return false;
        return true;
    }

    /** Löst den Reload-Flow aus: Text in Zwischenablage, Notification, dann Seite neu laden. */
    function triggerSaveErrorReload() {
        if (saveErrorReloadTriggered) return;
        saveErrorReloadTriggered = true;

        // Aktuellen Text der Textarea in Zwischenablage sichern (falls nicht gespeicherte Änderungen)
        const currentText = DOM.note?.value ?? "";
        if (currentText) {
            copyToClipboard(currentText);
            log(`Note-Text in Zwischenablage kopiert (${currentText.length} Zeichen)`);
        }

        warn("Save-Fehler erkannt – Seite wird in " + SAVE_ERROR_RELOAD_DELAY + "ms neu geladen");
        showNotification(
            "⚠️ Speichern fehlgeschlagen – Text in Zwischenablage, lade Seite neu…",
            "warn-SAVE-ERROR",
            null,
            { color: "#c62828" }
        );
        setTimeout(() => window.location.reload(), SAVE_ERROR_RELOAD_DELAY);
    }

    /**
     * Startet einen MutationObserver, der die Note-Section auf das Fehler-Element
     * beobachtet. Läuft die gesamte Script-Laufzeit (wird erst bei Trigger disconnected).
     */
    function initSaveErrorObserver() {
        // Bereits beim Start sichtbar? (z.B. wenn Seite im Fehler-Zustand geladen wurde)
        // Dann KEIN Reload – sonst würde ein Loop entstehen.
        if (isSaveErrorVisible()) {
            warn("Save-Fehler bereits beim Start sichtbar – Auto-Reload wird unterdrückt");
            saveErrorReloadTriggered = true;   // blockiert spätere Trigger
            return;
        }

        const noteSection = DOM.noteSection;
        if (!noteSection) return warn("initSaveErrorObserver: noteSection nicht gefunden");

        const observer = new MutationObserver(() => {
            if (saveErrorReloadTriggered) return;
            if (!isSaveErrorVisible()) return;
            observer.disconnect();
            triggerSaveErrorReload();
        });

        observer.observe(noteSection, {
            childList:      true,
            subtree:        true,
            characterData:  true,
            attributes:     true,
            attributeFilter: ['style', 'class']
        });

        debug("Save-Error-Observer gestartet");
    }

    // ════════════════════════════════════════════════════════════════════════════
    // ⭐ 18. UI ENGINE (Styles + Elements)
    // ════════════════════════════════════════════════════════════════════════════

    /** Injiziert die CSS-Styles einmalig in den <head>. */
    function injectStyles() {
        if (document.getElementById("vl-usernotes-styles")) return;
        const style = document.createElement("style");
        style.id = "vl-usernotes-styles";
        style.textContent = `
            .checker-warning {
                position: relative;
                color: white;
                padding: 8px 12px;
                border-radius: 4px;
                font-size: 13px;
                box-shadow: 0 1px 3px rgba(0,0,0,0.2);
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: 8px;
                margin-bottom: 4px;
            }
            .checker-warning button {
                padding: 4px 8px;
                background: #fff;
                border: none;
                border-radius: 3px;
                cursor: pointer;
                font-weight: bold;
                font-size: 12px;
                flex-shrink: 0;
            }
            #vl-notifications-container {
                margin-bottom: 8px;
                display: flex;
                flex-direction: column;
                gap: 0;
            }
            #vl-notifications-container:empty { display: none; }
            #cc-ui-container {
                display: flex;
                align-items: center;
                gap: 10px;
                margin-bottom: 10px;
            }
            #cc-ui-version {
                font-size: 10px;
                line-height: 1;
                opacity: 0.7;
                margin-bottom: 4px;
            }
            #cc-btn {
                padding: 8px 12px;
                border: none;
                border-radius: 4px;
                background: #1b5e20;
                color: white;
                font-weight: bold;
                cursor: pointer;
                transition: opacity 0.2s;
            }
            #cc-btn:disabled {
                cursor: not-allowed;
            }
            #cc-snippets {
                padding: 6px;
                border-radius: 4px;
                border: 1px solid #ccc;
                cursor: pointer;
            }
            #cc-snippet-btns {
                display: flex;
                flex-wrap: wrap;
                gap: 6px;
                margin-top: 8px;
                margin-bottom: 10px;
                justify-content: flex-start;
            }
            #cc-snippet-btns button {
                position: relative;
                flex: 0 1 calc(10% - 6px);
                padding: 8px 12px;
                border: 1px solid #ccc;
                border-radius: 4px;
                background: #f5f5f5;
                cursor: pointer;
                font-size: 15px;
                line-height: 1;
                font-weight: 500;
                text-align: center;
                display: flex;
                align-items: center;
                justify-content: center;
                min-height: 36px;
            }
            #cc-snippet-btns button:hover { background: #e0e0e0; }
            #cc-snippet-btns a {
                flex: 0 1 calc(10% - 6px);
                min-height: 36px;
                padding: 8px 12px;
            }
            #cc-snippet-btns a:hover { background: #e0e0e0; }
            @media (max-width: 768px) {
                #cc-snippet-btns button {
                    padding: 14px 16px;
                    font-size: 19px;
                    flex: 0 1 calc(10% - 5px);
                }
            }
            .vl-shortcut-badge {
                position: absolute;
                bottom: 1px;
                right: 2px;
                font-size: 8px;
                line-height: 1;
                color: #555;
                pointer-events: none;
            }
            #vl-reset-coords-prompt {
                position: relative;
                color: white;
                padding: 8px 12px;
                border-radius: 4px;
                font-size: 13px;
                box-shadow: 0 1px 3px rgba(0,0,0,0.2);
                display: flex;
                align-items: center;
                justify-content: flex-start;
                gap: 8px;
                margin-bottom: 4px;
                background: #c62828;
            }
            #vl-reset-coords-prompt span { flex: 1; }
            #vl-reset-coords-prompt .vl-btn-ja,
            #vl-reset-coords-prompt .vl-btn-nein {
                padding: 4px 8px;
                border-radius: 3px;
                cursor: pointer;
                font-weight: bold;
                font-size: 12px;
                flex-shrink: 0;
            }
            #vl-reset-coords-prompt .vl-btn-ja {
                border: none;
                background: white;
                color: #c62828;
            }
            #vl-reset-coords-prompt .vl-btn-nein {
                border: 1px solid rgba(255,255,255,0.6);
                background: transparent;
                color: white;
            }
        `;
        document.head.appendChild(style);
    }

    /** Aktiviert Mobile-Zoom auf Android (nur dort nötig). */
    function initMobileViewport() {
        log("initMobileViewport: isAndroid =", DEVICE.isAndroid);
        if (!DEVICE.isAndroid) return;

        const viewport = document.querySelector('meta[name="viewport"]');
        if (viewport) viewport.setAttribute("content", "width=device-width, initial-scale=1.0, user-scalable=yes");

        setTimeout(() => {
            const noteSection = DOM.noteSection;
            if (!noteSection) return warn("initMobileViewport: Note-Section nicht gefunden");

            const zoomFactor = (window.innerWidth / noteSection.offsetWidth) * 0.97;
            log(`Android Zoom: ${zoomFactor.toFixed(3)} (noteSection=${noteSection.offsetWidth}px, viewport=${window.innerWidth}px)`);

            document.body.style.zoom = zoomFactor;
            document.documentElement.style.zoom = zoomFactor;
            window.scrollTo(0, 0);
        }, TIMINGS.viewportZoomDelay);
    }

    /**
     * Aktualisiert den CC/Undo-Button je nach Noten-Zustand.
     * - Grün "📝"  → Note entspricht dem ursprünglichen Ladestand
     * - Blau "↩"   → Note wurde seither verändert
     */
    function updateCCBtn() {
        const btn = document.getElementById("cc-btn");
        if (!btn || originalNoteText === null) return;

        const currentText = DOM.note?.value ?? getSavedNote();
        const changed = currentText.trim() !== originalNoteText.trim();

        // Nur Opacity ändern: grau (0.4) wenn unverändert, normal (1) wenn geändert
        btn.style.opacity = changed ? "1" : "0.4";
        btn.disabled = !changed;  // Button deaktivieren wenn unverändert
    }

    /** Erzeugt einen Emoji-Container mit passendem Scale-Fix (Emoji oder Buchstaben). */
    function buildEmojiContainer(emoji) {
        const el = document.createElement("span");
        el.style.cssText = "display:inline-flex;align-items:center;justify-content:center;height:20px;width:20px;line-height:1";
        el.textContent = emoji;

        const isTextLabel = /^[A-Za-z]+$/.test(emoji);
        if (isTextLabel) {
            el.style.fontSize = "13px";
        } else if (SMALL_EMOJIS.has(emoji)) {
            el.style.fontSize = "16px";
            el.style.transform = `scale(${DEVICE.smallEmojiScale})`;
        } else {
            el.style.fontSize = "20px";
        }
        return el;
    }

    /** Baut einen einzelnen Schnellzugriff-Button für ein Snippet. */
    function buildSnippetButton(sn) {
        // FB-Suche: echter <a>-Link damit Safari "In neuem Tab öffnen" anbietet
        if (sn.isFbSearch) {
            const url = gcCode
                ? FB_SEARCH_URL.replace("__GCCODE__", gcCode)
                : "https://www.facebook.com/";
            const a = document.createElement("a");
            a.href = url;
            a.target = "_blank";
            a.rel = "noopener noreferrer";
            a.title = sn.label;
            // Gleiche CSS-Klasse wie Buttons (per inline-Style da kein className)
            a.style.cssText = "position:relative;display:inline-flex;align-items:center;justify-content:center;border:1px solid #ccc;border-radius:4px;background:#f5f5f5;cursor:pointer;text-decoration:none;box-sizing:border-box;";

            const img = document.createElement("img");
            img.src = sn.image;
            img.style.cssText = "width:20px;height:20px;object-fit:contain;display:block;";
            img.alt = sn.label;
            a.appendChild(img);

            // Klick: GC-Code in Zwischenablage kopieren
            a.addEventListener("click", (e) => {
                if (gcCode) copyToClipboard(gcCode);
            });
            return a;
        }

        const b = document.createElement("button");
        b.type = "button";

        if (sn.image) {
            const img = document.createElement("img");
            img.src = sn.image;
            img.style.cssText = "width:20px;height:20px;object-fit:contain;display:block;";
            img.alt = sn.label;
            b.appendChild(img);
        } else {
            b.appendChild(buildEmojiContainer(sn.emoji));
        }

        if (sn.shortcutKey) {
            const badge = document.createElement("span");
            badge.className   = "vl-shortcut-badge";
            badge.textContent = sn.shortcutKey;
            b.appendChild(badge);
        }

        const hint = sn.shortcutKey ? ` [Alt+${sn.shortcutKey}]` : "";
        b.title = sn.label + hint;

        b.addEventListener("click", () => applySnippet(sn));
        return b;
    }

    /** Baut das Snippet-Dropdown. */
    function buildSnippetSelect() {
        const select = document.createElement("select");
        select.id = "cc-snippets";

        SNIPPETS.forEach(sn => {
            // Link-Snippets nicht im Dropdown anzeigen
            if (sn.isLink) return;

            const opt = document.createElement("option");
            opt.textContent = sn.shortcutKey
                ? `${sn.label}  [Alt+${sn.shortcutKey}]`
                : sn.label;
            opt.value = sn.value;

            if (sn.label === "➕ Snippet") {
                opt.disabled = true;
                opt.selected = true;
            }
            if (sn.value.includes("__COORDS__")) opt.dataset.vlKey = "falsch";
            if (sn.shortcutKey)                  opt.dataset.shortcutKey = sn.shortcutKey;

            select.appendChild(opt);
        });

        select.addEventListener("change", async e => {
            const val = e.target.value;
            if (!val) return;
            const sn = SNIPPETS.find(s => s.value === val);
            if (sn) await applySnippet(sn);
            select.selectedIndex = 0;
        });

        return select;
    }

    /** Baut den CC/Undo-Button mit Toggle-Logik. */
    function buildCCButton() {
        const btn = document.createElement("button");
        btn.id             = "cc-btn";
        btn.type           = "button";
        btn.dataset.vlMode = "undo";  // Immer Undo-Modus
        btn.textContent    = "↩";     // Immer Undo-Emoji
        btn.title          = "Ursprüngliche Note am Ende einfügen (ohne Speichern)";
        btn.style.opacity  = "0.4";   // Grau (disabled) am Anfang

        btn.addEventListener("click", async e => {
            e.preventDefault();
            e.stopPropagation();

            activateNote();
            const ta = DOM.note;
            if (!ta || originalNoteText === null) return;

            const lines = ta.value.split("\n");
            if (lines[lines.length - 1].trim() !== "") lines.push("");
            lines.push("🗑️ OLD NOTE:");
            originalNoteText.split("\n").forEach(l => lines.push(l));

            setTextareaValue(ta, lines.join("\n"));
            ta.setSelectionRange(ta.value.length, ta.value.length);

            resizeNoteTextarea();
            scrollToNote();
            log("Undo: ursprüngliche Note angehängt");
        });

        return btn;
    }

    /** Baut die komplette UI: Version, CC-Button, Dropdown, Schnellzugriff. */
    function addUI() {
        if (document.getElementById("cc-ui-container")) return;
        const noteWrapper = document.querySelector(".PersonalCacheNote");
        if (!noteWrapper) return;

        injectStyles();

        const versionDiv = document.createElement("div");
        versionDiv.id = "cc-ui-version";
        versionDiv.textContent = `v${SCRIPT_VERSION}`;

        const container = document.createElement("div");
        container.id = "cc-ui-container";
        container.appendChild(buildCCButton());
        container.appendChild(buildSnippetSelect());

        noteWrapper.prepend(container);
        noteWrapper.prepend(versionDiv);

        const btnBar = document.createElement("div");
        btnBar.id = "cc-snippet-btns";

        // Normale Buttons (emoji, kein Link, kein FB)
        const normalSnippets = SNIPPETS.filter(sn => (sn.emoji || sn.image) && !sn.isLink && !sn.isFbSearch);
        normalSnippets.forEach(sn => btnBar.appendChild(buildSnippetButton(sn)));

        // FB-Button + Link-Buttons (neue Zeile)
        const extraSnippets = SNIPPETS.filter(sn => sn.isFbSearch || sn.isLink);
        extraSnippets.forEach(sn => btnBar.appendChild(buildSnippetButton(sn)));

        noteWrapper.insertBefore(btnBar, container.nextSibling);

        updateCCBtn();
        debug("UI hinzugefügt");
    }

    /** Startet den regelmäßigen DOM-Monitor (Checker-Warnungen + CC-Button). */
    function startDomMonitor() {
        setInterval(() => {
            updateCheckerWarnings();
            updateCCBtn();
        }, TIMINGS.domMonitorInterval);
        debug("DOM-Monitor gestartet");
    }

    /**
     * Interceptor für Save-Button: Reduziert Leerzeilen BEVOR React speichert.
     * - click mit capture=true: für Desktop-Browser
     * - touchstart: für iPad/iOS (Safari verarbeitet click anders)
     */
    function initSaveButtonInterceptor() {
        const saveBtn = DOM.saveBtn;
        if (!saveBtn) return;

        const cleanBeforeSave = () => {
            const ta = DOM.note;
            if (!ta) return;
            const cleaned = cleanLines(ta.value.split("\n"));
            const cleanedText = cleaned.join("\n");
            if (cleanedText !== ta.value) {
                debug("SaveButton-Interceptor: Leerzeilen reduziert");
                setTextareaValue(ta, cleanedText);
            }
        };

        // Desktop: capture=true stellt sicher, dass wir BEVOR React ausgeführt werden
        saveBtn.addEventListener('click', cleanBeforeSave, { capture: true });

        // iPad/iOS Safari: touchstart feuert noch VOR click
        saveBtn.addEventListener('touchstart', cleanBeforeSave, { passive: true });

        debug("Save-Button-Interceptor gestartet");
    }

    // ════════════════════════════════════════════════════════════════════════════
    // ⭐ 19. KEYBOARD SHORTCUTS
    // ════════════════════════════════════════════════════════════════════════════

    /** Tastatur-Event-Handler für alle Shortcuts. */
    async function handleKeydown(e) {
        // ESC → Note schließen (kein Modifier)
        if (e.key === "Escape" && !e.ctrlKey && !e.shiftKey && !e.altKey) {
            if (isNoteOpen()) {
                e.preventDefault();
                cancelNote();
            }
            return;
        }

        // Alt+Zahl → Snippet per Tastenkürzel
        if (e.altKey && !e.ctrlKey && !e.shiftKey) {
            const digitMatch = e.code?.match(/^(?:Digit|Numpad)(\d)$/);
            if (digitMatch) {
                const sn = SNIPPETS.find(s => s.shortcutKey === digitMatch[1]);
                if (sn) {
                    e.preventDefault();
                    log(`Shortcut Alt+${digitMatch[1]} → ${sn.label}`);
                    await applySnippet(sn);
                }
            }
            return;
        }

        // Ab hier: nur reine Ctrl-Kombinationen
        if (!e.ctrlKey || e.shiftKey || e.altKey) return;
        const key = e.key.toLowerCase();

        // Ctrl+S → speichern
        if (key === "s") {
            e.preventDefault();
            if (!isNoteOpen()) return warn("Ctrl+S ignoriert: Note nicht offen");
            if (!DOM.note)     return warn("Ctrl+S ignoriert: Textarea nicht vorhanden");
            log("Shortcut Ctrl+S → speichern");
            writeLines(DOM.note.value.split("\n"), true);
            return;
        }

        // Ctrl+O → Note öffnen
        if (key === "o") {
            e.preventDefault();
            log("Shortcut Ctrl+O → Note öffnen");
            activateNote();
            scrollToNote();
            return;
        }
    }

    // ════════════════════════════════════════════════════════════════════════════
    // ⭐ 20. START PIPELINE
    // ════════════════════════════════════════════════════════════════════════════

    /** Einmalige Start-Sequenz nach Page-Load. */
    async function runStartupPipeline() {
        await waitForSavedNoteLoaded();

        // Original-Text für Undo sichern
        originalNoteText = getSavedNote();
        log("originalNoteText gesichert, Länge:", originalNoteText.length);

        autoBeautifyOldNote();
        updateFirstCCLine(true);      // syncCCLineWithCorrectedCoords
        scanCheckers();
        flushNoteChanges();

        addUI();

        // Observer für Save-Fehler starten (nachdem UI + Note-Section da sind)
        initSaveErrorObserver();

        // Interceptor für Save-Button starten (reduziert Leerzeilen vor Speichern)
        initSaveButtonInterceptor();

        // Reset-Coords-Prompt anzeigen, wenn Koordinaten korrigiert sind
        // UND die Note bereits "GEOCHECKER FALSCH" enthält
        if (cachedCoords && originalNoteText?.toUpperCase().includes("GEOCHECKER FALSCH")) {
            log("Startup: Reset-Coords-Prompt anzeigen");
            showResetCoordsPrompt();
        }

        startDomMonitor();

        // Listener für den integrierten Solution-Checker
        const checkerBtn = document.getElementById("CheckerButton");
        if (checkerBtn) {
            checkerBtn.addEventListener("click", () => {
                debug("SolutionChecker: CheckerButton geklickt");
                setTimeout(handleSolutionCheckerResult, TIMINGS.checkerBtnDelay);
            });
        }
    }

    window.addEventListener("load", () => {
        // Mobile-Viewport sofort anpassen (verhindert Ruckeln)
        initMobileViewport();
        initCoordsObserver();
        setTimeout(runStartupPipeline, TIMINGS.startupDelay);
    });

    document.addEventListener("keydown", handleKeydown);

})();