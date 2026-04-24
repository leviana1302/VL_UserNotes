// ==UserScript==
// @name         VL_UserNotes
// @namespace    http://tampermonkey.net/
// @version      7.7
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
        startupDelay:         2000,   // Pipeline-Start nach load-Event (erhöht, um Save-Fehler zu vermeiden)
        checkerBtnDelay:       500,   // Nach CheckerButton-Klick
        viewportZoomDelay:     100    // Mobile-Zoom Delay
    };

    /** Regex zur Erkennung gültiger CC-Koordinaten (N/E Minuten-Format). */
    const CC_COORD_REGEX_N = /N\s*\d+°\s*\d+\.\d+/;
    const CC_COORD_REGEX_E = /E\s*\d+°\s*\d+\.\d+/;

    /** Erkennt Zeilen, die mit einem Emoji (Unicode Extended_Pictographic) beginnen. */
    const EMOJI_START_RE = /^\p{Extended_Pictographic}/u;

    /** Emojis, die kleiner dargestellt werden und Scale-Fix brauchen. */
    const SMALL_EMOJIS = new Set(["✳️", "✉️", "⚠️"]);

    // ════════════════════════════════════════════════════════════════════════════
    // ⭐ 2. LOGGER
    // ════════════════════════════════════════════════════════════════════════════

    const log   = (...args) => console.log("[VL]",   ...args);
    const debug = (...args) => console.debug("[VL]", ...args);
    const warn  = (...args) => console.warn("[VL]",  ...args);

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

    /** Cache-Typ der aktuellen Seite (einmal beim Start ermittelt, ändert sich nicht). */
    const cacheType = document.querySelector('a[href="/about/cache_types.aspx"][title]')?.getAttribute("title") ?? null;

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

    /** Setzt den Cursor ans Ende der Textarea. */
    function focusAndPositionCursor() {
        const ta = DOM.note;
        if (!ta) return;
        ta.focus();
        const len = ta.value.length;
        ta.setSelectionRange(len, len);
    }

    /** Passt die Höhe der Textarea an. */
    function resizeNoteTextarea(extraLines = 2) {
        const ta = DOM.note;
        if (!ta) return;

        // Aktuelle scrollHeight + 50px Zugabe
        ta.style.height = "auto";  // Reset auf auto um scrollHeight zu berechnen
        const scrollHeight = ta.scrollHeight;
        const newHeight = scrollHeight + 50;

        log("resizeNoteTextarea:");
        log("  scrollHeight:", scrollHeight, "px");
        log("  newHeight (+ 50px):", newHeight, "px");

        ta.style.height = newHeight + "px";
    }

    /** Scrollt sanft zur Textarea. */
    const scrollToNote = () => DOM.note?.scrollIntoView({ behavior: "smooth", block: "center" });

    /** Öffnet die Notiz, falls sie geschlossen ist. Returns `true`, wenn geöffnet wurde. */
    function activateNote() {
        const viewBtn = DOM.viewBtn;
        if (!viewBtn || isNoteOpen()) return false;
        viewBtn.click();
        setTimeout(() => resizeNoteTextarea(2), 300);   // Erster Resize nach React-Render
        setTimeout(() => {
            resizeNoteTextarea(2);                       // Zweiter Resize für Stabilität
            focusAndPositionCursor();                    // Cursor ans Ende beim Öffnen
        }, 600);
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
        if (!ta)              return warn("writeLines: Textarea nicht gefunden");
        if (noteWriteLocked)  return warn("writeLines: noteWriteLocked=true");

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
    /** Regex zum Erkennen von Koordinatenpaaren (N/S + E/W, verschiedene Schreibweisen). */
    const COORD_NORMALIZE_RE = /([NS])\s*(\d{1,3})\s*°?\s*(\d{1,2})\.(\d{1,6})[′']?\s*([EW])\s*(\d{1,3})\s*°?\s*(\d{1,2})\.(\d{1,6})[′']?/gi;

    /**
     * Normalisiert Koordinaten in einer Zeile auf das Standardformat:
     *   N DD° MM.MMM E DDD° MM.MMM
     *
     * Korrigiert: fehlende Leerzeichen, fehlendes °, fehlende führende Nullen.
     * Beispiele:
     *   "N52°17.721E7°9.566"        → "N 52° 17.721 E 007° 09.566"
     *   "N 52 17.721 E 007 09.566"  → "N 52° 17.721 E 007° 09.566"
     *   "N 52° 7.72 E 7° 9.5"      → "N 52° 07.720 E 007° 09.500"
     */
    function normalizeCoords(line) {
        COORD_NORMALIZE_RE.lastIndex = 0;
        return line.replace(
            COORD_NORMALIZE_RE,
            (_, ns, latDeg, latMin, latDec, ew, lonDeg, lonMin, lonDec) => {
                const latD = String(parseInt(latDeg, 10)).padStart(2, '0');
                const lonD = String(parseInt(lonDeg, 10)).padStart(3, '0');
                const latM = String(parseInt(latMin, 10)).padStart(2, '0');
                const lonM = String(parseInt(lonMin, 10)).padStart(2, '0');
                const latF = latDec.slice(0, 3).padEnd(3, '0');
                const lonF = lonDec.slice(0, 3).padEnd(3, '0');
                return `${ns.toUpperCase()} ${latD}° ${latM}.${latF} ${ew.toUpperCase()} ${lonD}° ${lonM}.${lonF}`;
            }
        );
    }

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

            result.push(normalizeCoords(t).replace(/=>/g, "→"));
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

        // Neues Format: 📌 Koords
        if (t.startsWith("📌") && CC_COORD_REGEX_N.test(t) && CC_COORD_REGEX_E.test(t)) {
            return true;
        }

        // Altes Format: ~* CC: Koords *~
        if (t.startsWith("~* CC:") && t.endsWith("*~") && (CC_COORD_REGEX_N.test(t) || CC_COORD_REGEX_E.test(t))) {
            return true;
        }

        return false;
    }

    /** Formatiert "~* CC:"-Zeilen in das neue 📌-Format. */
    function formatOldCC(line) {
        const t = line.replace(/^~\* CC:\s*/, "").replace(/\s*~\*$/, "").trim();
        const match = t.match(/(N\s*\d+°\s*\d+\.\d+)\s+(E)\s*(\d+)°\s*(\d+\.\d+)/i);
        if (!match) return `📌 (alt) ${t}`;
        const [, north, eastPrefix, eastDegRaw, eastRest] = match;
        return `📌 ${north} ${eastPrefix} ${eastDegRaw.padStart(3, "0")}° ${eastRest}`;
    }

    /**
     * Extrahiert die Koordinaten-Zeichenkette aus einer CC-Zeile (beide Formate).
     * @returns {string|null} Die Koordinaten (z.B. "N 50° 42.968 E 010° 47.456") oder null
     */
    function extractCoordsFromCCLine(line) {
        if (!line) return null;
        const t = line.trim();

        // Neues Format: "📌 N 50° 42.968 E 010° 47.456"
        if (t.startsWith("📌")) {
            return t.substring(2).trim();
        }

        // Altes Format: "~* CC: N 50° 42.968 E 10° 47.456 *~"
        if (t.startsWith("~* CC:") && t.endsWith("*~")) {
            return t.replace(/^~\*\s*CC:\s*/, "").replace(/\s*\*~$/, "").trim();
        }

        return null;
    }

    /**
     * Normalisiert Koordinaten für sicheren Vergleich.
     * Entfernt Leerzeichen und vereinheitlicht führende Nullen.
     * @returns {string} Normalisierte Koordinaten für Vergleich
     */
    function normalizeCoordsForComparison(coords) {
        if (!coords) return "";
        return coords
            .replace(/\s+/g, "")              // Alle Leerzeichen weg
            .replace(/0+(?=\d+°)/g, "")      // Entferne Nullen vor Ziffern+°: 010° → 1°, 008° → 8°, 80° bleibt 80°
            .toUpperCase();
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

        // Beautify anwenden und nur speichern wenn sich etwas geändert hat
        const beautified = beautifyLines(lines).join("\n");
        if (beautified !== saved) {
            debug("autoBeautifyOldNote: Änderungen erkannt → setWorkingNote");
            setWorkingNote(beautified);
        } else {
            debug("autoBeautifyOldNote: Keine Änderungen → kein Speichern nötig");
        }
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
     * Beobachtet #uxLatLon auf Änderungen und aktualisiert nur den Cache und das Dropdown-Label.
     * KEINE automatische Änderung der Note (verursacht Save-Fehler).
     * Die Message-Logik läuft über die Startup-Pipeline nach Hard-Reload.
     */
    function initCoordsObserver() {
        cachedCoords = getCorrectedCoords();
        debug("Initiale Koordinaten:", cachedCoords);

        const coordsEl = DOM.corrected;
        if (!coordsEl) return;

        const observer = new MutationObserver(() => {
            const newCoords = getCorrectedCoords();
            if (newCoords === cachedCoords) return;

            debug("Koordinaten-Observer: Änderung erkannt:", { alt: cachedCoords, neu: newCoords });
            cachedCoords = newCoords;

            // Dropdown-Label aktualisieren (falls UI schon vorhanden)
            const falschOpt = document.querySelector('#cc-snippets [data-vl-key="falsch"]');
            if (falschOpt) {
                const hint = falschOpt.dataset.shortcutKey ? `  [Alt+${falschOpt.dataset.shortcutKey}]` : "";
                falschOpt.textContent = `❌ GEOCHECKER FALSCH (${newCoords ?? "?"})${hint}`;
            }
        });

        observer.observe(coordsEl, {
            childList:     true,
            characterData: true,
            subtree:       true,
            attributes:    true,
            attributeFilter: ['class']
        });
    }

    // ════════════════════════════════════════════════════════════════════════════
    // ⭐ 12. SNIPPET-DEFINITIONEN & BEAUTIFY-REGELN
    // ════════════════════════════════════════════════════════════════════════════

    /** Exakte Ersetzungen für Beautify (getrimmte komplette Zeile → Ersatz). */
    const BEAUTIFY_EXACT = {
        "---":              "",
        "MESSAGE:":         "✉️ MESSAGE:",
        "SOLUTION:":        "💡 SOLUTION:",
        "KEIN GEOCHECKER":  "❓ KEIN GEOCHECKER"
    };

    /** Präfix-Ersetzungen für Beautify (Zeile fängt mit Key an → Emoji davor). */
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
     *   inOverflow       – true = Button im "..."-Overflow-Dropdown statt in der Hauptleiste
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
        { label: '🚗 Parken: ', emoji: '🚗', value: '🚗 PARKEN: ' },
        { label: '→',          emoji: '→', value: '→', noBlankBefore: true, inOverflow: true },
        { label: '➡️',         emoji: '➡️', value: '➡️ ', noBlankBefore: true, inOverflow: true },
        { label: '⭐',        emoji: '⭐', value: '⭐ ',                       inOverflow: true },
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
    /** Öffnet einen externen Link (isLink-Snippet). */
    function applyLinkSnippet(sn) {
        if (!gcCode) { showNotification("GC-Code nicht gefunden."); return; }
        const url = sn.linkUrl.replace("__GCCODE__", gcCode);
        log(`Link geöffnet: ${sn.label}`);
        window.open(url, "_blank");
    }

    /** Öffnet Facebook-Suche und kopiert GC-Code in Zwischenablage (isFbSearch-Snippet). */
    function applyFbSnippet() {
        if (!gcCode) { showNotification("GC-Code nicht gefunden."); return; }
        const url = FB_SEARCH_URL.replace("__GCCODE__", gcCode);
        copyToClipboard(gcCode);
        log(`Facebook-Suche: ${url}`);
        const a = document.createElement("a");
        a.href = url;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
    }

    /** Löst __COORDS__-Platzhalter auf und aktualisiert ggf. das Dropdown-Label. */
    async function resolveSnippetText(sn) {
        let text = sn.value;
        if (!text.includes("__COORDS__")) return text;

        const liveCoords = await waitForCoords();
        text = text.replace("__COORDS__", liveCoords ?? "?");

        if (liveCoords) {
            const opt = document.querySelector('#cc-snippets [data-vl-key="falsch"]');
            if (opt) {
                const hint = opt.dataset.shortcutKey ? `  [Alt+${opt.dataset.shortcutKey}]` : "";
                opt.textContent = `❌ GEOCHECKER FALSCH (${liveCoords})${hint}`;
            }
        }
        return text;
    }

    /** Hauptfunktion: Snippet anwenden (Text einfügen, ggf. speichern). */
    async function applySnippet(sn) {
        log("applySnippet:", sn.label);

        if (sn.isLink)     { applyLinkSnippet(sn); return; }
        if (sn.isFbSearch) { applyFbSnippet();     return; }

        const noteWasClosed = activateNote();
        if (!DOM.note) return;

        if (noteWasClosed) {
            await waitFor(
                () => DOM.note?.value.trim(),
                { interval: 80, timeoutMs: TIMINGS.waitForElementMed }
            );
        }

        const text = await resolveSnippetText(sn);
        insertSnippet(text, noteWasClosed, sn);

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

        if (sn.autoSave) {
            debug("Snippet: autoSave=true → speichern");
            writeLines(DOM.note.value.split("\n"), true);
            return;
        }

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

            // CC-Zeile aus Note entfernen, falls vorhanden
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

                // MERKE: Aktuelle (falsche) Koords für Warnung nach Reload speichern
                if (cachedCoords) {
                    try {
                        localStorage.setItem(
                            `vl-reset-coords-warning-${gcCode}`,
                            JSON.stringify({
                                oldCoords: cachedCoords, // Die falschen Koords vor Reset
                                timestamp: Date.now()
                            })
                        );
                        log("Reset-Warnung in localStorage gespeichert:", cachedCoords);
                    } catch (e) {
                        warn("Reset-Warnung speichern fehlgeschlagen:", e);
                    }
                }

                restoreBtn.click();
                // Nach geocaching.com Reload: checkResetCoordsWarning() zeigt die Warnung
            } else {
                warn("Reset-Coords: Wiederherstellen-Button nicht gefunden");
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
        { key: "GEOCHECKER", msg: "ℹ️ geochecker.com gefunden",      match: h => h.includes("geochecker.com"),                       copyCoords: true,  color: "#1565c0" },
        { key: "GEOCHECKER", msg: "ℹ️ geocheck.org gefunden",        match: h => h.includes("geocheck.org"),                         copyCoords: true,  color: "#1565c0" },
        { key: "GEOCHECKER", msg: "ℹ️ geotjek.dk gefunden",          match: h => h.includes("geotjek.dk"),                           copyCoords: true,  color: "#1565c0" },
        { key: "GC-APPS",    msg: "ℹ️ GC-Apps Checker gefunden",     match: h => h.includes("gc-apps.com") && h.includes("checker"), copyCoords: true,  color: "#1565c0" },
        { key: "CERTITUDE",  msg: "ℹ️ Certitude Checker gefunden",   match: h => h.includes("certitudes.org"),                       copyCoords: true,  color: "#1565c0" },
        { key: "CHALLENGE",  msg: "ℹ️ Challenge-Link gefunden",      match: h => h.includes("project-gc.com/challenges/"),           copyCoords: false, color: "#f9a825" },
        { key: "JIGIDI",     msg: "🧩 Jigidi-Link gefunden",         match: h => h.includes("jigidi.com/"),                          copyCoords: false, color: "#b6d48a",
          // Notification nur unterdrücken wenn JIGIDI gelöst ist (kein UNSOLVED mehr)
          suppressCheck: saved => saved.includes("JIGIDI:") && !saved.includes("JIGIDI: UNSOLVED") }
    ];

    /**
     * Mapping: Note-Keyword → Checker-Key.
     * Doppelte Verwendung:
     *  1. updateCheckerWarnings: Notification entfernen wenn Note-Keyword nach Speichern vorhanden
     *  2. scanCheckers: Notification beim Laden unterdrücken (Reverse-Lookup auf Checker-Key),
     *     sofern kein suppressCheck in CHECKER_DEFS definiert ist.
     *
     * CHALLENGE ERFÜLLT → CHALLENGE (nicht "CHALLENGE" direkt!):
     * Damit bleibt die Notification bei "CHALLENGE NICHT ERFÜLLT" bestehen.
     *
     * JIGIDI: suppressCheck in CHECKER_DEFS übernimmt die Unterdrückung beim Laden,
     * updateCheckerWarnings behandelt JIGIDI separat (nur entfernen wenn gelöst).
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
     * Alle Checker-relevanten Links aus den Cache-Beschreibungsbereichen.
     * Nur .UserSuppliedContent-Divs werden durchsucht (statt der gesamten Seite),
     * da externe Checker-Links ausschließlich dort vorkommen.
     * Einmalig gecacht — ändert sich nach Seitenload nicht.
     */
    const checkerAnchors = [...document.querySelectorAll(".UserSuppliedContent a[href]")]
        .map(a => ({ original: a.href, lower: a.href.toLowerCase() }));

    function scanCheckers() {
        log("scanCheckers");
        const saved = getWorkingNote().toUpperCase();

        let foundAnyChecker = false;

        // Integrierter Solution-Checker
        if (DOM.solutionCheckerLabel) {
            foundAnyChecker = true;
            if (!saved.includes("GEOCHECKER") && !notified.has("INTERNAL")) {
                notified.add("INTERNAL");
                showNotification(
                    "ℹ️ Integrierter Koordinatenchecker gefunden",
                    "warn-INTERNAL",
                    "#ctl00_ContentBody_lblSolutionChecker",
                    { key: "INTERNAL", color: "#1565c0", copyCoords: false }
                );
            }
        }

        // Externe Checker + Jigidi-Behandlung
        for (const def of CHECKER_DEFS) {
            const anchor = checkerAnchors.find(a => def.match(a.lower));
            if (!anchor) continue;

            if (def.key !== "JIGIDI") foundAnyChecker = true;

            // Notification unterdrücken wenn die Note bereits das passende Ergebnis enthält.
            // suppressCheck (wenn definiert) hat Vorrang vor dem Reverse-Lookup in CHECKER_KEYWORDS.
            const alreadyHandled = def.suppressCheck
                ? def.suppressCheck(saved)
                : Object.entries(CHECKER_KEYWORDS)
                    .filter(([, v]) => v === def.key)
                    .map(([k]) => k)
                    .some(kw => saved.includes(kw));

            if (!alreadyHandled && !notified.has(def.key)) {
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
        if (!cacheType || !GEOCACHER_REQUIRED_TYPES.has(cacheType)) {
            debug(`scanCheckers: Cache-Typ "${cacheType}" erfordert keinen Geochecker`);
            return;
        }

        // Nur einfügen, wenn korrigierte Koordinaten vorhanden sind
        if (!cachedCoords) {
            debug("scanCheckers: keine korrigierten Koordinaten → KEIN GEOCHECKER nicht eingefügt");
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
            // INTERNAL: separat behandeln (wenn GEOCHECKER OK/FALSCH vorhanden → Notification löschen)
            if (key === "INTERNAL") {
                if (note.includes("GEOCHECKER")) {
                    notified.delete(key);
                    document.getElementById("warn-" + key)?.remove();
                }
                continue;
            }

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

            // Reverse-Lookup: alle Note-Keywords finden die diesen Checker-Key als "erledigt" markieren
            // Beispiel: "CHALLENGE" → ["CHALLENGE ERFÜLLT"] (nicht "CHALLENGE NICHT ERFÜLLT")
            const doneKeywords = Object.entries(CHECKER_KEYWORDS)
                .filter(([, v]) => v === key)
                .map(([k]) => k);

            if (doneKeywords.some(kw => note.includes(kw))) {
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

        // ALTE erste CC-Zeile MERKEN (für Koords-Change-Warnung)
        const oldFirstLine = lines[0];
        const oldCoordsFromFirstLine = isCCLine(oldFirstLine)
            ? extractCoordsFromCCLine(oldFirstLine)
            : null;

        // Bei "FALSCH": alte CC-Zeile am Anfang entfernen
        if (snippet.includes("GEOCHECKER FALSCH") && isCCLine(lines[0])) {
            debug("SolutionChecker: entferne alte CC-Zeile");
            lines.shift();
        }

        lines = beautifyLines(lines);

        // Stelle sicher dass eine CC-Zeile am Anfang ist (bei GEOCHECKER OK mit neuen Koords)
        if (snippet.includes("GEOCHECKER OK") && cachedCoords && !isCCLine(lines[0])) {
            debug("SolutionChecker OK: füge CC-Zeile mit neuen Koords am Anfang ein");
            lines.unshift(`📌 ${cachedCoords}`);
        }

        // Nach erstem Block (= erste Leerzeile) einfügen
        let i = 0;
        while (i < lines.length && lines[i].trim() !== "") i++;
        const insertAt = i + 1;
        lines.splice(insertAt, 0, "");
        lines.splice(insertAt + 1, 0, snippet.trimStart());

        scrollToNote();
        writeLines(lines, true);

        // Nach updateFirstCCLine ggf. Koords-Change-Warnung anzeigen (nur bei OK)
        // Bei FALSCH kommt ja showResetCoordsPrompt
        if (snippet.includes("GEOCHECKER OK") && cachedCoords) {
            // Es gibt NEUE Koords nach dem Checker
            // Zeige Warnung unabhängig davon ob es vorher alte Koords gab

            const oldCoords = oldCoordsFromFirstLine ?? "(keine)";

            // Zeige Warnung wenn:
            // - Es gab keine alten Koords (neue wurden gerade gefunden) → immer zeigen
            // - ODER alte und neue sind unterschiedlich
            const shouldShowWarning = !oldCoordsFromFirstLine ||
                normalizeCoordsForComparison(oldCoordsFromFirstLine) !== normalizeCoordsForComparison(cachedCoords);

            if (shouldShowWarning) {
                log("SolutionChecker OK: zeige Warnung für neue Koordinaten");
                log("  Alt:", oldCoords);
                log("  Neu:", cachedCoords);
                showCoordsChangedWarning(oldCoords, cachedCoords);
            }
        }

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

    /**
     * Beobachtet Öffnen/Schließen der Note-Textarea (Klick auf viewCacheNote-Button)
     * und resized dann.
     */
    function initNoteOpenObserver() {
        const viewBtn = DOM.viewBtn;
        if (!viewBtn) return;

        // Beim Klick: resize nach 300ms und 600ms
        viewBtn.addEventListener("click", () => {
            setTimeout(() => resizeNoteTextarea(2), 300);
            setTimeout(() => {
                resizeNoteTextarea(2);
                focusAndPositionCursor();  // Cursor ans Ende beim Öffnen
            }, 600);
        });

        debug("Note-Open-Observer gestartet");
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
                border: 1px solid #ccc;
                border-radius: 4px;
                background: #f5f5f5;
                color: #333;
                font-weight: bold;
                cursor: pointer;
                transition: background 0.2s;
            }
            #cc-btn:disabled {
                background: #e8e8e8;
                cursor: not-allowed;
            }
            #cc-btn:hover:not(:disabled) {
                background: #e0e0e0;
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
            #cc-snippet-btns button:not(#cc-overflow-btn) {
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
            /* Overflow-Dropdown ("➕"-Button) */
            #cc-overflow-wrap {
                position: relative;
                flex: 0 1 calc(10% - 6px);
                display: inline-flex;
            }
            #cc-overflow-btn {
                width: 100%;
                position: relative;
                padding: 8px 12px;
                border: 1px solid #ccc;
                border-radius: 4px;
                background: #f5f5f5;
                cursor: pointer;
                font-size: 20px;
                line-height: 1;
                text-align: center;
                display: flex;
                align-items: center;
                justify-content: center;
                min-height: 36px;
            }
            #cc-overflow-btn:hover { background: #e0e0e0; }
            @media (max-width: 768px) {
                #cc-overflow-wrap { flex: 0 1 calc(10% - 5px); }
                #cc-overflow-btn { padding: 14px 16px; font-size: 22px; }
            }
            #cc-overflow-menu {
                display: none;
                position: absolute;
                top: calc(100% + 4px);
                left: 0;
                z-index: 999;
                background: #fff;
                border: 1px solid #ccc;
                border-radius: 4px;
                box-shadow: 0 4px 12px rgba(0,0,0,0.15);
                padding: 4px;
                display: none;
                flex-direction: column;
                gap: 4px;
                min-width: 60px;
            }
            #cc-overflow-menu.open { display: flex; }
            #cc-overflow-menu button {
                padding: 8px 12px;
                border: 1px solid #ccc;
                border-radius: 4px;
                background: #f5f5f5;
                cursor: pointer;
                font-size: 20px;
                text-align: center;
                white-space: nowrap;
            }
            #cc-overflow-menu button:hover { background: #e0e0e0; }
            @media (max-width: 768px) {
                #cc-snippet-btns button:not(#cc-overflow-btn) {
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

        // Button deaktivieren wenn Note unverändert, aktivieren wenn geändert
        btn.disabled = !changed;
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
            // Link-Snippets, FB-Suche und Overflow-Snippets nicht im Dropdown anzeigen
            if (sn.isLink || sn.isFbSearch || sn.inOverflow) return;

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
        btn.disabled        = true;    // Grau am Anfang (disabled state)

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

        // Normale Buttons (emoji, kein Link, kein FB, kein Overflow)
        const normalSnippets = SNIPPETS.filter(sn => (sn.emoji || sn.image) && !sn.isLink && !sn.isFbSearch && !sn.inOverflow);
        normalSnippets.forEach(sn => btnBar.appendChild(buildSnippetButton(sn)));

        // "..."-Overflow-Button mit Dropdown
        const overflowSnippets = SNIPPETS.filter(sn => sn.inOverflow);
        if (overflowSnippets.length > 0) {
            const wrap = document.createElement("div");
            wrap.id = "cc-overflow-wrap";

            const overflowBtn = document.createElement("button");
            overflowBtn.id   = "cc-overflow-btn";
            overflowBtn.type = "button";
            overflowBtn.textContent = "➕";
            overflowBtn.title = "Weitere Buttons";

            const menu = document.createElement("div");
            menu.id = "cc-overflow-menu";
            overflowSnippets.forEach(sn => menu.appendChild(buildSnippetButton(sn)));

            // Desktop: Mouseover öffnen/schließen (mit Delay bei Leave)
            let closeTimeout;
            wrap.addEventListener("mouseenter", () => {
                clearTimeout(closeTimeout);
                menu.classList.add("open");
            });
            wrap.addEventListener("mouseleave", () => {
                closeTimeout = setTimeout(() => menu.classList.remove("open"), 200);
            });
            // Menü selbst: closeTimeout clearen wenn Cursor über Menü schwebt
            menu.addEventListener("mouseenter", () => clearTimeout(closeTimeout));
            menu.addEventListener("mouseleave", () => {
                closeTimeout = setTimeout(() => menu.classList.remove("open"), 100);
            });

            // Mobile: Klick auf Button togglet Menü
            overflowBtn.addEventListener("click", (e) => {
                e.stopPropagation();
                menu.classList.toggle("open");
            });
            // Klick außerhalb schließt Menü
            document.addEventListener("click", () => menu.classList.remove("open"));

            wrap.appendChild(overflowBtn);
            wrap.appendChild(menu);
            btnBar.appendChild(wrap);
        }

        // FB-Button + Link-Buttons (zweite Zeile, sichtbar wie normale Buttons)
        const extraSnippets = SNIPPETS.filter(sn => sn.isFbSearch || sn.isLink);
        extraSnippets.forEach(sn => btnBar.appendChild(buildSnippetButton(sn)));

        noteWrapper.insertBefore(btnBar, container.nextSibling);

        updateCCBtn();

        // updateCCBtn bei Änderungen in der Textarea (statt Polling)
        DOM.note?.addEventListener('input', updateCCBtn);

        debug("UI hinzugefügt");
    }

    /**
     * Startet den DOM-Monitor für Checker-Warnungen.
     * MutationObserver auf DOM.savedNote: feuert nur wenn sich der gespeicherte
     * Notiz-Text tatsächlich ändert (nach dem Speichern), statt alle 500ms zu pollen.
     */
    function startDomMonitor() {
        const target = DOM.savedNote;
        if (!target) {
            warn("startDomMonitor: DOM.savedNote nicht gefunden");
            return;
        }

        const observer = new MutationObserver(() => {
            if (notified.size > 0) updateCheckerWarnings();
        });

        observer.observe(target, { characterData: true, childList: true, subtree: true });
        debug("DOM-Monitor gestartet (MutationObserver)");
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
            const cleaned = cleanLines(ta.value.split("\n").map(normalizeCoords));
            const cleanedText = cleaned.join("\n");
            if (cleanedText !== ta.value) {
                debug("SaveButton-Interceptor: Leerzeilen reduziert / Koordinaten normalisiert");
                setTextareaValue(ta, cleanedText);
            }
        };

        // Desktop: capture=true stellt sicher, dass wir BEVOR React ausgeführt werden
        saveBtn.addEventListener('click', cleanBeforeSave, { capture: true });

        // iPad/iOS Safari: touchstart feuert noch VOR click
        saveBtn.addEventListener('touchstart', cleanBeforeSave, { passive: true });

        debug("Save-Button-Interceptor gestartet");
    }

    /**
     * Beobachtet den Wiederherstellen-Button ("Restore Coordinates").
     * Wenn der User diesen Button klickt, speichern wir die aktuellen Koords
     * damit nach dem Reload eine Warnung angezeigt wird.
     */
    function initRestoreButtonObserver() {
        const restoreBtn = DOM.restoreBtn;
        if (!restoreBtn) return;

        restoreBtn.addEventListener("click", () => {
            log("Restore-Button geklickt");

            // Speichere aktuelle Koords BEVOR sie zurückgesetzt werden
            if (cachedCoords) {
                try {
                    localStorage.setItem(
                        `vl-reset-coords-warning-${gcCode}`,
                        JSON.stringify({
                            oldCoords: cachedCoords,
                            timestamp: Date.now()
                        })
                    );
                    log("Reset-Warnung in localStorage gespeichert (manueller Restore):", cachedCoords);
                } catch (e) {
                    warn("Reset-Warnung speichern fehlgeschlagen:", e);
                }
            }
        });

        debug("Restore-Button-Observer gestartet");
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

    /**
     * Zeigt die "Koordinaten geändert" Warnung mit alter/neuer Koordinate.
     *
     * Enthält drei Elemente:
     *  - Text mit Alt/Neu Koordinaten (links)
     *  - "Listen"-Button für die Bookmarkliste (mitte)
     *  - "X"-Button zum Schließen (rechts) → markiert die aktuellen Koords als "gesehen"
     *
     * @param {string} oldCoords Alte Koordinaten (oder "(keine)")
     * @param {string} newCoords Neue Koordinaten (oder "(zurückgesetzt)")
     */

    /**
     * Zeigt eine rote Warnung wenn alte Koords in der Note sind, aber keine aktuellen im DOM.
     * Beispiel: Nach Reset der Koords wurde die alte CC-Zeile nicht aus der Note entfernt.
     */
    function showStaleCoordsBanner(staleCoords) {
        debug("showStaleCoordsBanner:", staleCoords);
        document.getElementById("vl-stale-coords-banner")?.remove();

        const container = ensureNotificationsContainer();
        if (!container) return warn("Stale-Coords: Container nicht gefunden");

        const div = document.createElement("div");
        div.id = "vl-stale-coords-banner";
        div.classList.add("checker-warning");
        div.style.background = "#c62828";
        div.style.display = "flex";
        div.style.alignItems = "center";
        div.style.justifyContent = "space-between";
        div.style.gap = "12px";

        // Linke Seite: Text
        const textDiv = document.createElement("div");
        textDiv.style.flex = "1";
        textDiv.style.fontSize = "13px";
        textDiv.style.lineHeight = "1.6";
        textDiv.innerHTML = `<div>⚠️ Bitte korrigierte Koordinaten in der Notiz prüfen!</div>
<div style="margin-top: 6px; font-size: 12px; opacity: 0.9;">${staleCoords}</div>`;

        div.appendChild(textDiv);

        // Rechts: X-Button
        const btnGroup = document.createElement("div");
        btnGroup.style.display = "flex";
        btnGroup.style.gap = "6px";
        btnGroup.style.flexShrink = "0";
        btnGroup.style.alignItems = "center";

        const closeBtn = document.createElement("button");
        closeBtn.type = "button";
        closeBtn.textContent = "✕";
        closeBtn.title = "Warnung schließen";
        closeBtn.style.cssText = "background:transparent;border:1px solid rgba(255,255,255,0.6);color:white;border-radius:3px;padding:2px 8px;cursor:pointer;font-weight:bold;";
        closeBtn.addEventListener("click", () => {
            div.remove();
            log("Stale-Coords-Warnung geschlossen");
        });

        btnGroup.appendChild(closeBtn);
        div.appendChild(btnGroup);

        container.appendChild(div);
        log("Stale-Coords-Warnung angezeigt:", staleCoords);
    }

    function showCoordsChangedWarning(oldCoords, newCoords) {
        log("showCoordsChangedWarning:", { oldCoords, newCoords });

        const container = ensureNotificationsContainer();
        if (!container) return warn("showCoordsChangedWarning: Container nicht gefunden");

        // Alte Warnung entfernen wenn sie schon da ist
        document.getElementById("warn-coords-changed")?.remove();

        const div = document.createElement("div");
        div.id = "warn-coords-changed";
        div.classList.add("checker-warning");
        div.style.background = "#c62828";
        div.style.display = "flex";
        div.style.alignItems = "center";
        div.style.justifyContent = "space-between";
        div.style.gap = "12px";

        // Linke Seite: Text und Koordinaten (mit Grid für Ausrichtung)
        const textDiv = document.createElement("div");
        textDiv.style.flex = "1";
        textDiv.style.fontSize = "13px";
        textDiv.style.lineHeight = "1.6";

        textDiv.innerHTML = `<div style="margin-bottom: 8px;">⚠️ Koordinaten geändert! Ggf. Cache zur Bookmarkliste hinzufügen!</div>
<div style="display: grid; grid-template-columns: 32px 1fr; gap: 8px; align-items: center;">
  <div>Alt:</div>
  <div>${oldCoords}</div>
  <div>Neu:</div>
  <div>${newCoords}</div>
</div>`;

        div.appendChild(textDiv);

        // Button-Gruppe rechts
        const btnGroup = document.createElement("div");
        btnGroup.style.display = "flex";
        btnGroup.style.gap = "6px";
        btnGroup.style.flexShrink = "0";
        btnGroup.style.alignItems = "center";

        // "Listen"-Button
        const listBtn = document.createElement("button");
        listBtn.type = "button";
        listBtn.className = "btn-add-to-list";
        listBtn.setAttribute("aria-describedby", "PremiumFeatureLists");
        listBtn.setAttribute("data-gcrefcode", gcCode || "");
        listBtn.setAttribute("data-href", "/bookmarks/mark.aspx?view=legacy");
        listBtn.textContent = "Listen";
        listBtn.style.whiteSpace = "nowrap";
        listBtn.style.color = "#333";
        btnGroup.appendChild(listBtn);

        // "X"-Button (Schließen + als gesehen markieren)
        const closeBtn = document.createElement("button");
        closeBtn.type = "button";
        closeBtn.textContent = "✕";
        closeBtn.title = "Als gelesen markieren";
        closeBtn.style.cssText = "background:transparent;border:1px solid rgba(255,255,255,0.6);color:white;border-radius:3px;padding:2px 8px;cursor:pointer;font-weight:bold;";
        closeBtn.addEventListener("click", () => {
            // Aktuelle korrigierte Koords als "gesehen" markieren
            markCoordsAsSeen();
            div.remove();
            log("Koords-Warnung geschlossen und als gesehen markiert");
        });
        btnGroup.appendChild(closeBtn);

        div.appendChild(btnGroup);
        container.appendChild(div);
    }

    /** Markiert die aktuellen korrigierten Koordinaten als "vom User gesehen". */
    function markCoordsAsSeen() {
        if (!gcCode) return;
        const coords = getCorrectedCoords();
        try {
            localStorage.setItem(
                `vl-corrected-coords-${gcCode}`,
                JSON.stringify({ coords, timestamp: Date.now() })
            );
            debug("Koords als gesehen markiert:", coords);
        } catch (e) {
            warn("markCoordsAsSeen: localStorage Fehler:", e);
        }
    }

    /** Flag um Doppel-Warnungen zu vermeiden wenn Reset-Warnung angezeigt wurde. */
    let resetWarningWasShown = false;

    /**
     * Prüft localStorage auf gespeicherte Reset-Warnung.
     * Nach "Koordinaten zurücksetzen?" oder manueller Restore-Klick werden die alten Koords gespeichert,
     * und diese Funktion zeigt die Warnung nach dem Reload mit Alt/Neu-Koords.
     */
    function checkResetCoordsWarning() {
        if (!gcCode) return;

        try {
            const key = `vl-reset-coords-warning-${gcCode}`;
            const stored = localStorage.getItem(key);

            if (!stored) return;

            // Sofort löschen um Doppelwarnung zu vermeiden
            localStorage.removeItem(key);

            const data = JSON.parse(stored);

            // Zeige Warnung: Alt = alte falsche Koords, Neu = aktuelle (resezte) Koords
            const currentCoords = getCorrectedCoords();
            log("Reset-Warnung aus localStorage angezeigt", {
                oldCoords: data.oldCoords,
                currentCoords
            });
            showCoordsChangedWarning(data.oldCoords, currentCoords ?? "(zurückgesetzt)");
            resetWarningWasShown = true;  // Flag setzen um Doppel-Warnungen zu vermeiden
        } catch (e) {
            warn("checkResetCoordsWarning Error:", e);
        }
    }

    /**
     * ZENTRALE Funktion zur Erkennung von Koordinaten-Änderungen.
     *
     * Logik:
     *  1. Koordinaten aus #uxLatLon (DOM) auslesen
     *  2. Falls keine Koords vorhanden → nichts zu tun
     *  3. Erste Zeile der Note auslesen
     *  4. Wenn erste Zeile eine CC-Zeile ist UND Koords identisch → alles OK
     *  5. Wenn erste Zeile passt nicht zu DOM-Koords:
     *     → localStorage prüfen: wurden diese Koords bereits vom User gesehen?
     *       - Ja (localStorage === DOM-Koords) → keine Warnung
     *       - Nein → Warnung anzeigen mit Alt/Neu
     *
     * @param {string} [expectedOldCoords] Optional: explizite alte Koords (z.B. vom Solution-Checker)
     */
    function checkAndShowCoordsChanged(expectedOldCoords = null) {
        if (!gcCode) {
            warn("checkAndShowCoordsChanged: gcCode nicht vorhanden");
            return;
        }

        // 1. Aktuelle korrigierte Koords aus DOM
        const currentCoords = getCorrectedCoords();
        log("checkAndShowCoordsChanged: currentCoords =", currentCoords);

        // Spezialfall: Keine aktuellen Koords, aber alte in der Note vorhanden
        if (!currentCoords) {
            const saved = getSavedNote();
            const firstLine = saved.split("\n")[0];
            const firstLineCoords = isCCLine(firstLine) ? extractCoordsFromCCLine(firstLine) : null;

            // Nur Stale-Coords-Warnung zeigen wenn NICHT bereits eine Reset-Warnung angezeigt wurde
            if (firstLineCoords && !resetWarningWasShown) {
                log("  ⚠️ SPEZIALFALL: Keine aktuellen Koords, aber alte Koords in der Note!");
                showStaleCoordsBanner(firstLineCoords);
            }
            return;
        }

        // 2. Erste Zeile der gespeicherten Note
        const saved = getSavedNote();
        const firstLine = saved.split("\n")[0];
        log("  erste Note-Zeile:", JSON.stringify(firstLine));

        // 3. Koords aus erster Zeile extrahieren (beide Formate unterstützen!)
        let firstLineCoords = null;
        if (isCCLine(firstLine)) {
            firstLineCoords = extractCoordsFromCCLine(firstLine);
            log("  Koords aus erster Zeile:", firstLineCoords);
        } else {
            log("  erste Zeile ist keine CC-Zeile");
        }

        // 4. Vergleich mit Normalisierung: Wenn erste Zeile passt → alles OK
        if (firstLineCoords && normalizeCoordsForComparison(firstLineCoords) === normalizeCoordsForComparison(currentCoords)) {
            log("  ✅ Koords passen zur ersten Zeile → keine Warnung");
            return;
        }

        // 5. Mismatch: prüfe localStorage ("schon gesehen?")
        let lastSeenCoords = null;
        try {
            const stored = localStorage.getItem(`vl-corrected-coords-${gcCode}`);
            if (stored) {
                lastSeenCoords = JSON.parse(stored).coords;
            }
        } catch (e) {
            warn("  localStorage Lesen fehlgeschlagen:", e);
        }
        log("  lastSeenCoords (aus localStorage):", lastSeenCoords);

        // Wenn User diese Koords schon gesehen hat (normalisiert) → keine Warnung
        if (lastSeenCoords && normalizeCoordsForComparison(lastSeenCoords) === normalizeCoordsForComparison(currentCoords)) {
            log("  ℹ️ Koords bereits vom User gesehen (X-Button geklickt) → keine Warnung");
            return;
        }

        // 6. Warnung zeigen
        const oldCoords = expectedOldCoords ?? firstLineCoords ?? lastSeenCoords ?? "(keine)";
        log("  🚨 KOORDINATEN-ÄNDERUNG ERKANNT");
        log("    Alt:", oldCoords);
        log("    Neu:", currentCoords);
        showCoordsChangedWarning(oldCoords, currentCoords);
    }

    /**
     * Einmalige Start-Sequenz nach Page-Load.
     *
     * Reihenfolge:
     *  1. Warten bis Note geladen (bereits via startupDelay + waitForSavedNoteLoaded)
     *  2. autoBeautifyOldNote - Note aufräumen
     *  3. updateFirstCCLine - erste Zeile ggf. aktualisieren
     *  4. scanCheckers - Info-Messages für Geochecker/Jigidi/Challenges
     *  5. flushNoteChanges - Änderungen speichern
     *  6. addUI - Buttons, Snippets etc.
     *  7. checkAndShowCoordsChanged - Warnung bei Koordinaten-Mismatch
     *  8. Observer und Interceptoren starten
     */
    async function runStartupPipeline() {
        await waitForSavedNoteLoaded();

        // Original-Text für Undo sichern
        originalNoteText = getSavedNote();
        log("originalNoteText gesichert, Länge:", originalNoteText.length);

        // 2. Note aufräumen
        autoBeautifyOldNote();

        // 3. erste CC-Zeile ggf. aktualisieren
        updateFirstCCLine(true);

        // 4. Checker-Messages (Info-Icons)
        scanCheckers();

        // 5. Änderungen speichern
        flushNoteChanges();

        // 6. UI bauen
        addUI();

        // 7a. Prüfe ob eine Reset-Warnung gespeichert ist (nach Koordinaten-Reset mit "Ja" oder manueller Restore-Klick)
        checkResetCoordsWarning();

        // 7b. Koordinaten-Warnung prüfen (Mismatch zwischen erster Note-Zeile und korrigierten Koords)
        checkAndShowCoordsChanged();

        // 8. Observer & Interceptoren
        initSaveErrorObserver();
        initNoteOpenObserver();
        initSaveButtonInterceptor();
        initRestoreButtonObserver();

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
        // Disclaimer sofort ausblenden (noch VOR initMobileViewport)
        const disclaimer = document.querySelector('.Disclaimer');
        if (disclaimer) disclaimer.style.display = 'none';

        // Mobile-Viewport sofort anpassen (verhindert Ruckeln)
        initMobileViewport();
        initCoordsObserver();
        setTimeout(runStartupPipeline, TIMINGS.startupDelay);
    });

    document.addEventListener("keydown", handleKeydown);

})();