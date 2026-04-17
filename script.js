// ==UserScript==
// @name         VL_UserNotes
// @namespace    http://tampermonkey.net/
// @version      2.4
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

    // ============================================================================
    // ⭐ GLOBAL / SETUP & DOM‑ENGINE
    // - Versionsinfo, globale Flags, Script-Initialisierung
    // - Zugriff auf DOM-Elemente
    // - Zentrale Selektoren
    // ============================================================================

    /** Name und Versionsnummer des Userscripts (aus dem Header). */
    const SCRIPT_VERSION = GM_info?.script?.version ?? "unbekannt";
    const SCRIPT_NAME    = GM_info?.script?.name    ?? "unbekannt";
    console.log(`=== ${SCRIPT_NAME} ${SCRIPT_VERSION} gestartet ===`);

    /** DOM‑Cache: zentrale Zugriffspunkte auf wichtige Elemente. */
    const DOM = {
        /** Textarea für die Personal Cache Note. */
        get note()                  { return document.getElementById("cacheNoteText"); },
        /** Speichern‑Button der Note. */
        get saveBtn()               { return document.querySelector(".js-pcn-submit"); },
        /** Abbrechen‑Button der Note (schließt ohne Speichern). */
        get cancelBtn()             { return document.querySelector(".js-pcn-cancel"); },
        /** Element mit korrigierten Koordinaten (#uxLatLon). */
        get corrected()             { return document.getElementById("uxLatLon"); },
        /** Unsichtbare gespeicherte Note (#srOnlyCacheNote). */
        get savedNote()             { return document.getElementById("srOnlyCacheNote"); },
        /** "Note anzeigen"-Button. */
        get viewBtn()               { return document.getElementById("viewCacheNote"); },
        /** Label des integrierten GC‑Solution‑Checkers. */
        get solutionCheckerLabel()  { return document.getElementById("ctl00_ContentBody_lblSolutionChecker"); },
        /** Ergebnistext des integrierten GC‑Solution‑Checkers. */
        get solutionResponse()      { return document.getElementById("lblSolutionResponse"); },
        /** Button zum Öffnen des Koordinaten-Dialogs. */
        get latLonLink()            { return document.getElementById("uxLatLonLink"); },
        /** "Wiederherstellen"-Button (erscheint erst nach Klick auf latLonLink). */
        get restoreBtn()            { return document.querySelector(".btn-cc-restore"); }
    };

    /** Arbeits‑Puffer für die Note. */
    let pendingNoteText = null;

    /** Flag: Wurde der Puffer verändert? */
    let noteDirty = false;

    /** Lock: verhindert Ping‑Pong zwischen writeLines() und React. */
    let noteWriteLocked = false;

    /**
     * Ursprünglicher Notetext beim Seitenladen (vor allen Script-Änderungen).
     * Wird in der Start-Pipeline einmalig befüllt.
     */
    /** Sicherungskopie der Note VOR allen Script-Änderungen (für Undo). */
    let originalNoteText = null;

    // ============================================================================
    // ⭐ HELPER UTILITIES (generisch)
    // ============================================================================

    /** Regex zur Erkennung gültiger CC-Koordinaten (N/E Minuten-Format). */
    const CC_COORD_REGEX_N = /N\s*\d+°\s*\d+\.\d+/;
    const CC_COORD_REGEX_E = /E\s*\d+°\s*\d+\.\d+/;

    /** Generischer Poll-Helper: wartet, bis `predicate()` truthy ist. */
    function waitFor(predicate, { interval = 50, timeoutMs = 1000 } = {}) {
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

    /** Kopiert Text in die Zwischenablage – mit Mobile-Fallback. */
    function copyToClipboard(text) {
        if (!text) return;
        navigator.clipboard.writeText(text).catch(() => {
            const ta = document.createElement('textarea');
            ta.value = text;
            ta.style.position = 'fixed';
            ta.style.opacity = '0';
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy');
            document.body.removeChild(ta);
        });
    }

    /** Prüft, ob die Note aktuell geöffnet ist. */
    const isNoteOpen = () => DOM.viewBtn?.style.display === "none";

    // ============================================================================
    // ⭐ CORE UTILITIES
    // - Basisfunktionen für Datum, Koordinaten, Note-Handling, Schreiben/Speichern
    // ============================================================================

    /** Gibt das heutige Datum im Format dd.mm.yyyy zurück. */
    const getTodayStr = () => {
        const today = new Date();
        const dd   = String(today.getDate()).padStart(2, "0");
        const mm   = String(today.getMonth() + 1).padStart(2, "0");
        const yyyy = today.getFullYear();
        return `${dd}.${mm}.${yyyy}`;
    };

    /** Liest die korrigierten Koordinaten aus #uxLatLon aus. */
    const getCorrectedCoords = () => {
        const el = DOM.corrected;
        const res = el && el.classList.contains("italic")
            ? el.textContent.trim().replace(/'/g, "")
            : null;
        console.debug("[VL] getCorrectedCoords:", res);
        return res;
    };

    /** Koordinaten-Cache + Observer */
    let cachedCoords = getCorrectedCoords();
    console.debug("[VL] Initiale Koordinaten:", cachedCoords);

    {
        const coordsEl = DOM.corrected;
        if (coordsEl) {
            const observer = new MutationObserver(async () => {
                const newCoords = getCorrectedCoords();
                if (newCoords && newCoords !== cachedCoords) {
                    console.debug("[VL] Koordinaten geändert:", newCoords);
                    cachedCoords = newCoords;

                    // Dropdown-Label aktualisieren, falls UI schon vorhanden
                    const falschOpt = document.querySelector('#cc-snippets [data-vl-key="falsch"]');
                    if (falschOpt) {
                        const hint = falschOpt.dataset.shortcutKey ? `  [Alt+${falschOpt.dataset.shortcutKey}]` : "";
                        falschOpt.textContent = `❌ GEOCHECKER FALSCH (${newCoords})${hint}`;
                    }

                    // warten, bis srOnlyCacheNote wirklich geladen ist (mobil wichtig!)
                    await waitForSavedNoteLoaded();
                    await autoBeautifyOldNote();

                    // Änderungen in die Textarea schreiben und speichern
                    await flushNoteChanges();
                }
            });
            observer.observe(coordsEl, {
                childList: true,
                characterData: true,
                subtree: true,
                attributes: true,           // iOS/Android: italic-Klasse wird per Attribut gesetzt
                attributeFilter: ['class']
            });
        }
    }

    /** Liefert den gespeicherten Notiztext aus srOnlyCacheNote. */
    const getSavedNote = () => DOM.savedNote?.textContent ?? "";

    /** Schreibt Zeilen in die Textarea und speichert optional. */
    function writeLines(lines, save = false) {
        const ta = DOM.note;
        if (!ta) {
            console.error("[VL] writeLines abgebrochen: Textarea nicht gefunden");
            return;
        }
        if (noteWriteLocked) {
            console.error("[VL] writeLines abgebrochen: noteWriteLocked=true");
            return;
        }

        // genau eine Leerzeile vor Emoji-Zeilen sicherstellen (ZUERST!)
        lines = normalizeEmojiSpacing(lines);

        // mehrere Leerzeilen reduzieren (danach)
        lines = lines.filter((line, idx, arr) =>
            line.trim() !== "" || idx === 0 || arr[idx - 1].trim() !== ""
        );

        noteWriteLocked = true;

        ta.value = lines.join("\n");
        ta.dispatchEvent(new Event("input", { bubbles: true }));

        if (save) {
            console.debug("[VL] speichern");
            DOM.saveBtn?.click();
        }

        setTimeout(() => {
            noteWriteLocked = false;
            console.debug("[VL] Lock aufgehoben");
        }, 300);
    }

    /** Passt die Höhe der Textarea dynamisch an. */
    function resizeNoteTextarea(extra = 20) {
        const ta = DOM.note;
        if (!ta) return;
        ta.style.height = "auto";
        ta.style.height = (ta.scrollHeight + extra) + "px";
    }

    /** Scrollt sanft zur Textarea. */
    function scrollToNote() {
        DOM.note?.scrollIntoView({ behavior: "smooth", block: "center" });
    }

    /** Öffnet die Notiz, falls sie geschlossen ist. */
    function activateNote() {
        const viewBtn = DOM.viewBtn;
        if (!viewBtn) return false;
        if (isNoteOpen()) return false;

        viewBtn.click();
        setTimeout(() => resizeNoteTextarea(50), 150);
        return true;
    }

    /** Schließt die Notiz ohne zu speichern. */
    function cancelNote() {
        if (!isNoteOpen()) {
            console.warn("[VL] ESC ignoriert: Note ist nicht offen");
            return;
        }
        const cancelBtn = DOM.cancelBtn;
        if (!cancelBtn) {
            console.warn("[VL] ESC ignoriert: Abbrechen-Button nicht gefunden");
            return;
        }
        console.log("[VL] Shortcut: ESC → Note schließen ohne Speichern");
        cancelBtn.click();
    }

    /** Wartet, bis srOnlyCacheNote im DOM verfügbar ist. */
    function waitForSavedNoteLoaded() {
        return waitFor(() => DOM.savedNote, { interval: 50, timeoutMs: 1000 });
    }

    /**
     * Wartet auf korrigierte Koordinaten und aktualisiert cachedCoords.
     * Nötig auf Mobile, wo #uxLatLon erst nach dem Script-Start bereit ist.
     */
    async function waitForCoords(timeoutMs = 2000) {
        if (cachedCoords) return cachedCoords;
        const result = await waitFor(() => {
            const c = getCorrectedCoords();
            if (c) cachedCoords = c;
            return c;
        }, { interval: 100, timeoutMs });
        console.debug("[VL] waitForCoords →", result);
        return result;
    }

    /** Speichert den Puffer pendingNoteText in die Textarea. */
    async function flushNoteChanges() {
        if (!noteDirty || pendingNoteText === null) return;

        console.debug("[VL] Flush: Änderungen vorhanden → speichern");

        activateNote();

        const lines = pendingNoteText.split("\n");
        writeLines(lines, true);

        noteDirty = false;
        pendingNoteText = null;
    }

    // ============================================================================
    // ⭐ WORKING‑NOTE ENGINE (Pufferverwaltung)
    // ============================================================================

    /** Liefert den aktuellen Arbeits-Puffer oder lädt ihn aus der gespeicherten Note. */
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

    // ============================================================================
    // ⭐ BEAUTIFY-ENGINE
    // ============================================================================

    /** Exakte Ersetzungen für Beautify. */
    const BEAUTIFY_EXACT = {
        "---": "",
        "MESSAGE:": "✉️ MESSAGE:",
        "SOLUTION:": "💡 SOLUTION:",
        "KEIN GEOCHECKER": "❓ KEIN GEOCHECKER"
    };

    /** Präfix‑Ersetzungen → Emoji. */
    const BEAUTIFY_PREFIX = [
        ["MESSAGE:",              "✉️ "],
        ["GC-APPS:",              "🔴 "],
        ["GEOCHECKER OK",         "✅ "],
        ["GEOCHECKER FALSCH",     "❌ "],
        ["CERTITUDE:",            "🟢 "],
        ["CHALLENGE ERFÜLLT",     "🏆 "],
        ["CHALLENGE NICHT ERFÜLLT", "⛔ "],
        ["HINT:",                 "👉 "],
        ["WP",                    "🚩 "],
        ["STAGE",                 "🚩 "],
        ["JIGIDI",                "🧩 "]
    ];

    /** Wendet Emoji-Präfixe und exakte Ersetzungen auf jede Zeile an. */
    /**
     * Stellt sicher, dass vor jeder Zeile, die mit einem Emoji beginnt,
     * genau eine Leerzeile steht – außer ganz am Anfang der Note.
     * Überzählige Leerzeilen werden auf genau eine reduziert.
     */
    const EMOJI_START_RE = /^\p{Extended_Pictographic}/u;

    function normalizeEmojiSpacing(lines) {
        const result = [];
        for (const line of lines) {
            if (line.trim() !== "" && EMOJI_START_RE.test(line.trim()) && result.length > 0) {
                // Überschüssige Leerzeilen am Ende entfernen
                while (result.length > 0 && result[result.length - 1].trim() === "") {
                    result.pop();
                }
                // Genau eine Leerzeile vor der Emoji-Zeile
                result.push("");
            }
            result.push(line);
        }
        return result;
    }

    function beautifyLines(lines) {
        const result = [];

        for (const line of lines) {
            let t = line;

            if (t.trim() === "---") {
                result.push("");
                continue;
            }

            if (BEAUTIFY_EXACT[t]) {
                t = BEAUTIFY_EXACT[t];
            }

            for (const [prefix, emoji] of BEAUTIFY_PREFIX) {
                if (t.startsWith(prefix)) {
                    if (!t.startsWith(emoji)) t = emoji + t;
                    break;
                }
            }

            result.push(t);
        }

        return normalizeEmojiSpacing(result);
    }

    // ============================================================================
    // ⭐ CC ENGINE (Koordinaten-Logik)
    // ============================================================================

    /** Prüft, ob eine Zeile eine gültige CC-Zeile mit Koordinaten ist. */
    function isCCLine(line) {
        if (!line) return false;
        const t = line.trim();
        return t.startsWith("📌")
            && CC_COORD_REGEX_N.test(t)
            && CC_COORD_REGEX_E.test(t);
    }

    /** Formatiert alte "~* CC:"-Zeilen in das neue 📌-Format. */
    function formatOldCC(line) {
        const t = line.replace(/^~\* CC:\s*/, "").replace(/\s*~\*$/, "").trim();

        const match = t.match(/(N\s*\d+°\s*\d+\.\d+)\s+(E)\s*(\d+)°\s*(\d+\.\d+)/i);
        if (!match) return `📌 (alt) ${t}`;

        const [, north, eastPrefix, eastDegRaw, eastRest] = match;
        const eastDeg = eastDegRaw.padStart(3, "0");

        return `📌 ${north} ${eastPrefix} ${eastDeg}° ${eastRest}`;
    }

    /** Entfernt alte CC-Zeilen und fügt eine neue CC-Zeile ein. */
    const applyCC = coords => {
        console.debug("[VL] applyCC mit coords:", coords);

        let lines = getSavedNote().split("\n");

        lines = lines.filter(l => !l.startsWith("📌"));

        let firstRemoved = false;
        lines = lines.map(l => {
            if (l.startsWith("~* CC:")) {
                if (!firstRemoved) {
                    firstRemoved = true;
                    return null;
                }
                return formatOldCC(l);
            }
            return l;
        }).filter(Boolean);

        lines.unshift(`📌 ${coords}`);

        lines = beautifyLines(lines);
        setWorkingNote(lines.join("\n"));
    };

    /** Ersetzt die erste CC-Zeile oder fügt eine neue ein. */
    const replaceCC = (lines, coords) => {
        console.debug("[VL] replaceCC mit coords:", coords);
        const idx = lines.findIndex(isCCLine);
        if (idx !== -1) lines[idx] = `📌 ${coords}`;
        else lines.unshift(`📌 ${coords}`);
        return lines;
    };

    /** Formatiert alte "~* CC:"-Notizen beim Laden der Seite. */
    async function autoBeautifyOldNote() {
        const saved = getWorkingNote();
        // Ausgabe der ursprünglichen Note
        console.log("[VL] Ursprüngliche Note:\n" + saved);
        let lines = saved.split("\n");

        const coords = getCorrectedCoords();
        console.log("[VL] Korrigierte Koordinaten:", coords ?? "(keine)");
        if (!coords) return;

        const hasOldCC = lines.some(l => l.startsWith("~* CC:"));

        if (hasOldCC) {
            let firstRemoved = false;
            let newLines = [];

            for (const line of lines) {
                if (line.startsWith("~* CC:")) {
                    if (!firstRemoved) {
                        firstRemoved = true;
                        newLines.push(`📌 ${coords}`);
                    } else {
                        newLines.push(formatOldCC(line));
                    }
                } else {
                    newLines.push(line);
                }
            }

            newLines = beautifyLines(newLines);
            setWorkingNote(newLines.join("\n"));
            return;
        }

        const hasNewCC = lines.some(isCCLine);
        if (!hasNewCC) {
            // Keine CC-Zeile vorhanden → neu einfügen
            lines.unshift(`📌 ${coords}`);
            lines = beautifyLines(lines);
            setWorkingNote(lines.join("\n"));
        } else {
            // Vorhandene CC-Zeile auf aktuelle Koordinaten aktualisieren
            const idx = lines.findIndex(isCCLine);
            const expected = `📌 ${coords}`;
            if (lines[idx].trim() !== expected) {
                console.debug("[VL] autoBeautifyOldNote: CC-Zeile aktualisiert →", expected);
                lines[idx] = expected;
                lines = beautifyLines(lines);
                setWorkingNote(lines.join("\n"));
            }
        }
    }

    /**
     * Aktualisiert die erste CC-Zeile in der Textarea auf `cachedCoords`.
     * @param {boolean} onlyIfChanged - wenn true, nur schreiben, wenn sich etwas ändert
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

    /** Vergleicht korrigierte Koordinaten mit der CC-Zeile und aktualisiert sie. */
    const syncCCLineWithCorrectedCoords = () => updateFirstCCLine(true);

    /** Aktualisiert die CC-Zeile in der Textarea und speichert. */
    const updateCCLine = () => updateFirstCCLine(false);

    // ============================================================================
    // ⭐ SNIPPET ENGINE
    // ============================================================================

    /**
     * emoji       → Beschriftung des Schnellzugriff-Buttons
     * shortcutKey → Alt+<Taste> (nur '1'–'9' und '0')
     */
    const SNIPPETS = [
        { label: '➕ Snippet', value: '' },
        {
            label: `✅ GEOCHECKER OK (${getTodayStr()})`,
            emoji: '✅', shortcutKey: '1',
            value: `\n✅ GEOCHECKER OK (${getTodayStr()})`,
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
            value: '\n❌ GEOCHECKER FALSCH (__COORDS__)', // Platzhalter → live ersetzt beim Auswählen
            removeCC: true,
            autoSave: true,
            confirmResetCoords: true
        },
        { label: '❓ KEIN GEOCHECKER',              emoji: '❓', shortcutKey: '4', value: '\n❓ KEIN GEOCHECKER' },
        { label: '✉️ MESSAGE:',                     emoji: '✉️', shortcutKey: '5', value: '\n✉️ MESSAGE:' },
        { label: '⚠️ OBS: Field puzzle from here!', emoji: '⚠️', shortcutKey: '6', value: '\n⚠️ OBS: Field puzzle from here!' },
        { label: '💡 SOLUTION:',                    emoji: '💡', shortcutKey: '7', value: '\n💡 SOLUTION:' },
        { label: '🧩 JIGIDI:',                      emoji: '🧩', shortcutKey: '8', value: '\n🧩 JIGIDI:\n' },
        { label: '🟢 CERTITUDE: & ✉️ MESSAGE:',     emoji: '🟢', shortcutKey: '9', value: '\n🟢 CERTITUDE: \n\n✉️ MESSAGE:\n' },
        { label: '🔴 GC-APPS: & ✉️ MESSAGE:',       emoji: '🔴', shortcutKey: '0', value: '\n🔴 GC-APPS: \n\n✉️ MESSAGE:\n' },
        {
            label: `🏆 CHALLENGE ERFÜLLT (${getTodayStr()})`,
            emoji: '🏆',
            value: `\n🏆 CHALLENGE ERFÜLLT (${getTodayStr()})`
        },
        {
            label: `⛔ CHALLENGE NICHT ERFÜLLT (${getTodayStr()})`,
            emoji: '⛔',
            value: `\n⛔ CHALLENGE NICHT ERFÜLLT (${getTodayStr()})`
        },
        { label: '🔒 CODE:',    emoji: '🔒', value: '\n🔒 CODE:' },
        { label: '👉 HINT:',    emoji: '👉', value: '\n👉 HINT:' },
        { label: '🚩 WP',       emoji: 'WP', value: '\n🚩 WP' },
        { label: '🚩 STAGE',    emoji: 'ST', value: '\n🚩 STAGE' },
        { label: '🚗 Parken: ', emoji: '🚗', value: '\n🚗 Parken: ' }
    ];

    /**
     * Führt ein Snippet vollständig aus: Text auflösen, einfügen, ggf. speichern.
     * Gemeinsame Logik für Dropdown, Schnellzugriff-Buttons und Tastenkürzel.
     */
    async function applySnippet(sn) {
        const noteWasClosed = activateNote();
        console.log("[VL] applySnippet: noteWasClosed =", noteWasClosed);
        if (!DOM.note) return;

        // War die Note gerade geschlossen, warten bis die Textarea befüllt ist.
        // Verhindert: doppeltes activateNote()-Toggle + leere-Textarea-Timing.
        if (noteWasClosed) {
            await waitFor(
                () => DOM.note?.value.trim(),
                { interval: 80, timeoutMs: 1500 }
            );
        }

        let text = sn.value;

        // Datum anhängen
        if (sn.autoDate) {
            text = `${text} (${getTodayStr()})`;
        }

        // __COORDS__-Platzhalter live auflösen (mit Warte-Fallback für Mobile)
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

        insertSnippet(text, noteWasClosed);

        // CC-Zeile löschen (nur wenn wirklich eine CC-Zeile!)
        if (sn.removeCC) {
            const lines = DOM.note.value.split("\n");
            if (isCCLine(lines[0])) lines.shift();
            writeLines(lines, true);
            if (sn.confirmResetCoords) {
                console.log("[VL] Snippet eingefügt, zeige Reset-Coords-Prompt");
                showResetCoordsPrompt();
            }
            return;
        }

        // Speichern?
        if (sn.autoSave) {
            writeLines(DOM.note.value.split("\n"), true);
            return;
        }

        // Kein Speichern → Cursor sichtbar machen
        DOM.note.focus();
        resizeNoteTextarea();
        scrollToNote();
    }

    /** Fügt ein Snippet ein. */
    const insertSnippet = (text, wasNoteClosed = true) => {
        const ta = DOM.note;
        if (!ta) return;

        const isGeoCheckerSnippet =
              text.includes("GEOCHECKER OK") ||
              text.includes("GEOCHECKER FALSCH");

        if (isGeoCheckerSnippet) {
            const lines = ta.value.split("\n");

            let i = 0;
            while (i < lines.length && lines[i].trim() !== "") i++;

            const insertAt = i + 1;

            lines.splice(insertAt, 0, "");
            lines.splice(insertAt + 1, 0, text);

            ta.value = lines.join("\n");
            ta.dispatchEvent(new Event("input", { bubbles: true }));

            ta.setSelectionRange(ta.value.length, ta.value.length);
            return;
        }

        // Stelle sicher, dass die Textarea fokussiert ist
        if (ta !== document.activeElement) {
            ta.focus();
        }

        const cursorActive =
              ta === document.activeElement &&
              typeof ta.selectionStart === "number";

        console.log("[VL] insertSnippet Debug:", {
            wasNoteClosed,
            cursorActive,
            activeElement: document.activeElement?.id,
            selectionStart: ta.selectionStart,
            shouldUseCursor: cursorActive && !wasNoteClosed
        });

        // Note war bereits offen: an Cursor-Position einfügen
        if (cursorActive && !wasNoteClosed) {
            console.log("[VL] Einfügung an Cursor-Position");
            const start  = ta.selectionStart;
            const before = ta.value.slice(0, start);
            const after  = ta.value.slice(start);

            ta.value = before + "\n" + text + after;
            ta.dispatchEvent(new Event("input", { bubbles: true }));

            const newPos = before.length + 1 + text.length;
            ta.setSelectionRange(newPos, newPos);
            return;
        }

        // Note war geschlossen oder Cursor nicht aktiv: am Ende anhängen
        console.log("[VL] Einfügung am Ende");
        const lines = ta.value.split("\n");
        lines.push("", text);

        ta.value = lines.join("\n");
        ta.dispatchEvent(new Event("input", { bubbles: true }));

        ta.setSelectionRange(ta.value.length, ta.value.length);
    };

    // ============================================================================
    // ⭐ RESET-COORDS PROMPT
    // - Abfrage nach GEOCHECKER FALSCH: korrigierte Koordinaten zurücksetzen?
    // ============================================================================

    /**
     * Zeigt eine Ja/Nein-Abfrage an, ob die korrigierten Koordinaten
     * zurückgesetzt werden sollen (nach Einfügen von GEOCHECKER FALSCH).
     */
    async function showResetCoordsPrompt() {
        console.log("[VL] showResetCoordsPrompt aufgerufen");
        document.getElementById("vl-reset-coords-prompt")?.remove();

        // Notifications-Container über der Note verwenden
        let container = document.getElementById("vl-notifications-container");
        if (!container) {
            const noteSection = document.querySelector(".Note.PersonalCacheNote");
            if (!noteSection || !noteSection.parentElement) {
                console.warn("[VL] Notifications-Container nicht gefunden");
                return;
            }
            container = document.createElement("div");
            container.id = "vl-notifications-container";
            noteSection.parentElement.insertBefore(container, noteSection);
        }

        const overlay = document.createElement("div");
        overlay.id = "vl-reset-coords-prompt";
        console.debug("[VL] Reset-Coords-Dialog erstellt und ins DOM eingefügt");

        const msg = document.createElement("span");
        msg.textContent = "Korrigierte Koordinaten zurücksetzen?";
        overlay.appendChild(msg);

        const btnJa = document.createElement("button");
        btnJa.type = "button";
        btnJa.className = "vl-btn-ja";
        btnJa.textContent = "Ja";

        const btnNein = document.createElement("button");
        btnNein.type = "button";
        btnNein.className = "vl-btn-nein";
        btnNein.textContent = "Nein";

        overlay.appendChild(btnJa);
        overlay.appendChild(btnNein);
        container.appendChild(overlay);

        // ── Nein ──────────────────────────────────────────────────────────────
        btnNein.addEventListener("click", () => {
            overlay.remove();
            console.log("[VL] Reset-Coords: abgelehnt");
        });

        // ── Ja ────────────────────────────────────────────────────────────────
        btnJa.addEventListener("click", async () => {
            overlay.remove();
            console.log("[VL] Reset-Coords: bestätigt");

            // Erste Zeile entfernen, falls sie noch korrigierte Koordinaten enthält
            activateNote();
            const ta = DOM.note;
            if (ta) {
                const lines = ta.value.split("\n");
                if (isCCLine(lines[0])) {
                    console.debug("[VL] Reset-Coords: CC-Zeile wird entfernt");
                    lines.shift();
                    writeLines(lines, true);
                    await new Promise(r => setTimeout(r, 400));
                }
            }

            // Wiederherstellen-Button klicken (ggf. erst Koordinaten-Dialog öffnen)
            let restoreBtn = DOM.restoreBtn;
            if (!restoreBtn) {
                console.debug("[VL] Reset-Coords: öffne Koordinaten-Dialog");
                DOM.latLonLink?.click();
                restoreBtn = await waitFor(
                    () => DOM.restoreBtn,
                    { interval: 100, timeoutMs: 5000 }
                );
            }

            if (restoreBtn) {
                console.log("[VL] Reset-Coords: klicke Wiederherstellen");
                restoreBtn.click();
            } else {
                console.error("[VL] Reset-Coords: Wiederherstellen-Button nicht gefunden");
            }
        });
    }

    // ============================================================================
    // ⭐ NOTIFICATION ENGINE
    // ============================================================================

    const notified = new Set();

    const showNotification = (msg, id, checkerLink = null, def = null) => {
        if (id && document.getElementById(id)) return;

        // Notifications-Container VOR der ganzen Note-Sektion
        let container = document.getElementById("vl-notifications-container");
        if (!container) {
            // Finde die .Note.PersonalCacheNote div
            const noteSection = document.querySelector(".Note.PersonalCacheNote");
            if (!noteSection || !noteSection.parentElement) return;

            container = document.createElement("div");
            container.id = "vl-notifications-container";
            noteSection.parentElement.insertBefore(container, noteSection);
        }

        const div = document.createElement("div");
        div.textContent = msg;
        if (id) div.id = id;

        const bgColor = def?.color ?? "#c62828";

        div.classList.add("checker-warning");
        div.style.background = bgColor;

        if (checkerLink) {
            const btn = document.createElement("button");
            btn.textContent = "Öffnen";
            btn.style.color = bgColor;

            btn.addEventListener("click", (e) => {
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
                        // Nur fokussieren und auf Position scrollen, aber kein Click-Event
                        element.focus({ preventScroll: true });
                        element.scrollIntoView({
                            behavior: "smooth",
                            block: "center"
                        });
                    }
                } else {
                    window.open(checkerLink, "_blank");
                }
            });

            div.appendChild(btn);
        }

        container.appendChild(div);
    };

    // ============================================================================
    // ⭐ CHECKER ENGINE
    // ============================================================================

    const CHECKER_DEFS = [
        { key: "GEOCHECKER", msg: "⚠️ geochecker.com gefunden", match: h => h.includes("geochecker.com"), copyCoords: true,  color: "#1565c0" },
        { key: "GEOCHECKER", msg: "⚠️ geocheck.org gefunden",   match: h => h.includes("geocheck.org"),   copyCoords: true,  color: "#1565c0" },
        { key: "GEOCHECKER", msg: "⚠️ geotjek.dk gefunden",     match: h => h.includes("geotjek.dk"),     copyCoords: true,  color: "#1565c0" },
        { key: "GC-APPS",    msg: "⚠️ GC-Apps Checker gefunden",match: h => h.includes("gc-apps.com") && h.includes("checker"), copyCoords: true, color: "#1565c0" },
        { key: "CERTITUDE",  msg: "⚠️ Certitude Checker gefunden", match: h => h.includes("certitudes.org"), copyCoords: true, color: "#1565c0" },
        { key: "CHALLENGE",  msg: "⚠️ Challenge-Link gefunden",    match: h => h.startsWith("https://project-gc.com/challenges/"), copyCoords: false, color: "#f9a825" },
        { key: "JIGIDI",     msg: "🧩 Jigidi-Link gefunden",       match: h => h.includes("jigidi.com/"), copyCoords: false, color: "#f9a825" }
    ];

    const CHECKER_KEYWORDS = {
        "GEOCHECKER": "GEOCHECKER",
        "GC-APPS":    "GC-APPS",
        "CERTITUDE":  "CERTITUDE",
        "INTERNAL":   "GEOCHECKER",
        "CHALLENGE":  "CHALLENGE",
        "JIGIDI":     "JIGIDI"
    };

    async function scanCheckers() {
        console.log('scanCheckers');
        console.time('scanCheckers');

        const saved = getWorkingNote().toUpperCase();

        const anchors = [...document.querySelectorAll("a[href]")]
            .map(a => ({ original: a.href, lower: a.href.toLowerCase() }));

        let foundAnyChecker = false;

        if (DOM.solutionCheckerLabel) {
            foundAnyChecker = true;

            if (!saved.includes("GEOCHECKER") && !notified.has("INTERNAL")) {
                notified.add("INTERNAL");
                showNotification(
                    "⚠️ Integrierter Koordinatenchecker gefunden",
                    "warn-INTERNAL",
                    "#ctl00_ContentBody_lblSolutionChecker",
                    { key: "INTERNAL", color: "#c62828", copyCoords: false }
                );
            }
        }

        for (const def of CHECKER_DEFS) {
            const anchor = anchors.find(a => def.match(a.lower));
            if (!anchor) continue;
            const href = anchor.original;

            if (def.key !== "JIGIDI") foundAnyChecker = true;

            if (!saved.includes(def.key) && !notified.has(def.key)) {
                notified.add(def.key);
                showNotification(def.msg, "warn-" + def.key, href, def);
            }

            if (def.key === "JIGIDI") {
                const working = getWorkingNote().toUpperCase();
                const hasAnyJigidi =
                      working.includes("JIGIDI:") ||
                      working.includes("🧩 JIGIDI:");

                if (hasAnyJigidi) continue;

                const coords = getCorrectedCoords();
                if (!coords) continue;

                let lines = getWorkingNote().split("\n");
                lines = replaceCC(lines, coords);
                lines = beautifyLines(lines);

                if (lines.length > 0 && lines[lines.length - 1].trim() !== "") {
                    lines.push("");
                }
                lines.push("🧩 JIGIDI: UNSOLVED");

                setWorkingNote(lines.join("\n"));
            }
        }

        if (foundAnyChecker) return;

        if (saved.includes("KEIN GEOCHECKER")) return;

        let lines = getWorkingNote().split("\n");

        const coords = getCorrectedCoords();
        if (coords) lines = replaceCC(lines, coords);

        lines = beautifyLines(lines);

        let insertAt = 0;
        const ccIdx = lines.findIndex(isCCLine);
        if (ccIdx !== -1) insertAt = ccIdx + 1;

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

        console.timeEnd('scanCheckers');
    }

    const updateCheckerWarnings = () => {
        const note  = getSavedNote().toUpperCase();
        const lines = note.split("\n").map(l => l.trim());

        for (const key of [...notified]) {
            const keyword = CHECKER_KEYWORDS[key];
            if (!keyword) continue;

            if (key === "JIGIDI") {
                const hasAnyJigidi =
                      lines.some(l => l.startsWith("🧩 JIGIDI:")) ||
                      lines.some(l => l.startsWith("JIGIDI:"));

                const hasUnsolved =
                      lines.includes("🧩 JIGIDI: UNSOLVED") ||
                      lines.includes("JIGIDI: UNSOLVED");

                if (hasAnyJigidi && !hasUnsolved) {
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
    };

    async function handleSolutionCheckerResult() {
        const el = await waitFor(() => {
            const e = DOM.solutionResponse;
            return (e && e.textContent.trim()) ? e : null;
        }, { interval: 1000, timeoutMs: 30000 });

        if (!el) return;

        const text   = el.textContent.trim();
        const coords = getCorrectedCoords();

        let snippet = null;
        if (text.includes("Richtig! Die Koordinaten dieses Caches wurden aktualisiert")) {
            snippet = `✅ GEOCHECKER OK (${getTodayStr()})`;
        } else if (text.includes("Diese Koordinaten sind falsch")) {
            if (!coords) return;
            snippet = `❌ GEOCHECKER FALSCH (${coords}) (${getTodayStr()})`;
        }
        if (!snippet) return;

        activateNote();

        const ta = await waitFor(() => DOM.note, { interval: 80, timeoutMs: 5000 });
        if (!ta) return;

        let lines = ta.value.split("\n");
        
        // Wenn "GEOCHECKER FALSCH", alte CC-Zeile am Anfang entfernen
        if (snippet.includes("GEOCHECKER FALSCH") && isCCLine(lines[0])) {
            console.debug("[VL] handleSolutionCheckerResult: entferne alte CC-Zeile");
            lines.shift();
        }
        
        lines = beautifyLines(lines);

        let i = 0;
        while (i < lines.length && lines[i].trim() !== "") i++;

        const insertAt = i + 1;

        lines.splice(insertAt, 0, "");
        lines.splice(insertAt + 1, 0, snippet.trimStart());

        scrollToNote();
        writeLines(lines, true);
        
        // Warten bis writeLines fertig ist (noteWriteLocked wird auf false gesetzt)
        await new Promise(r => setTimeout(r, 400));
        
        updateCCLine();
        
        // Zeige Reset-Coords-Prompt wenn "GEOCHECKER FALSCH" und korrigierte Coords vorhanden
        console.log("[VL] handleSolutionCheckerResult Debug:", {
            snippetContent: snippet.substring(0, 50),
            hasFalsch: snippet.includes("GEOCHECKER FALSCH"),
            cachedCoords,
            shouldShow: snippet.includes("GEOCHECKER FALSCH") && cachedCoords
        });
        
        if (snippet.includes("GEOCHECKER FALSCH") && cachedCoords) {
            console.log("[VL] handleSolutionCheckerResult: zeige Reset-Coords-Prompt");
            showResetCoordsPrompt();
        }
    }

    // ============================================================================
    // ⭐ UI ENGINE
    // - Styles, CC/Undo-Button, Snippet-Dropdown, DOM-Monitor
    // ============================================================================

    /** Injiziert die gemeinsamen Styles einmalig. */
    function injectStyles() {
        if (document.getElementById("vl-usernotes-styles")) return;
        const style = document.createElement("style");
        style.id = "vl-usernotes-styles";
        style.textContent = `
            .checker-warning {
                position: relative;
                color: white;
                padding: 6px 10px;
                border-radius: 4px;
                font-size: 12px;
                box-shadow: 0 1px 3px rgba(0,0,0,0.2);
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: 8px;
                margin-bottom: 4px;
            }
            .checker-warning button {
                padding: 2px 6px;
                background: #fff;
                border: none;
                border-radius: 3px;
                cursor: pointer;
                font-weight: bold;
                font-size: 11px;
                flex-shrink: 0;
            }
            #vl-notifications-container {
                margin-bottom: 8px;
                display: flex;
                flex-direction: column;
                gap: 0;
            }
            #vl-notifications-container:empty {
                display: none;
            }
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
                transition: background 0.2s;
            }
            #cc-btn[data-vl-mode="undo"] {
                background: #01579b;
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
                flex: 0 1 calc(11% - 6px);
                padding: 8px 12px;
                border: 1px solid #ccc;
                border-radius: 4px;
                background: #f5f5f5;
                cursor: pointer;
                font-size: 16px;
                line-height: 1;
                font-weight: 500;
                text-align: center;
                display: flex;
                align-items: center;
                justify-content: center;
                min-height: 36px;
            }
            #cc-snippet-btns button:hover {
                background: #e0e0e0;
            }
            @media (max-width: 768px) {
                #cc-snippet-btns button {
                    padding: 12px 14px;
                    font-size: 18px;
                    flex: 0 1 calc(12.5% - 5px);
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
                padding: 6px 10px;
                border-radius: 4px;
                font-size: 12px;
                box-shadow: 0 1px 3px rgba(0,0,0,0.2);
                display: flex;
                align-items: center;
                justify-content: flex-start;
                gap: 8px;
                margin-bottom: 4px;
                background: #c62828;
            }
            #vl-reset-coords-prompt span {
                flex: 1;
            }
            #vl-reset-coords-prompt .vl-btn-ja {
                padding: 2px 6px;
                border: none;
                border-radius: 3px;
                cursor: pointer;
                font-weight: bold;
                background: white;
                color: #c62828;
                font-size: 11px;
                flex-shrink: 0;
            }
            #vl-reset-coords-prompt .vl-btn-nein {
                padding: 2px 6px;
                border: 1px solid rgba(255,255,255,0.6);
                border-radius: 3px;
                cursor: pointer;
                font-weight: bold;
                background: transparent;
                color: white;
                font-size: 11px;
                flex-shrink: 0;
            }
        `;
        document.head.appendChild(style);
    }

    /** Mobile: Verschiebt den Viewport sodass initial nur der Hauptbereich sichtbar ist. */
    function initMobileViewport() {
        // Nur auf Android aktivieren
        const ua = navigator.userAgent;
        const isAndroid = /Android/.test(ua);
        
        console.log("[VL] initMobileViewport: isAndroid =", isAndroid);
        
        if (!isAndroid) {
            return;
        }

        console.log("[VL] Mobile-Zoom für Android aktiviert");

        // Viewport Meta-Tag anpassen
        const viewport = document.querySelector('meta[name="viewport"]');
        if (viewport) {
            viewport.setAttribute("content", "width=device-width, initial-scale=1.0, user-scalable=yes");
        }

        // Nach Verzögerung Zoom anwenden
        setTimeout(() => {
            // Finde die Note-Sektion (mit den Buttons und Textarea)
            const noteSection = document.querySelector(".Note.PersonalCacheNote");
            if (!noteSection) {
                console.warn("[VL] Note-Section nicht gefunden");
                return;
            }

            // Berechne Zoom-Faktor basierend auf Note-Sektion-Breite
            // (nicht auf Hauptbereich - das ist zu aggressiv)
            const noteSectionWidth = noteSection.offsetWidth;
            const viewportWidth = window.innerWidth;
            let zoomFactor = viewportWidth / noteSectionWidth;
            
            // 3% weniger Zoom für perfektes Gleichgewicht
            zoomFactor = zoomFactor * 0.97;

            console.log(`[VL] Android Zoom: ${zoomFactor.toFixed(3)} (noteSection=${noteSectionWidth}px, viewport=${viewportWidth}px)`);

            // Wende Zoom an (wie Finger-Zoom)
            document.body.style.zoom = zoomFactor;
            document.documentElement.style.zoom = zoomFactor;
            
            // Scrolle nach oben-links
            window.scrollTo(0, 0);

        }, 100);
    }

    /**
     * Aktualisiert den CC/Undo-Button je nach aktuellem Noten-Zustand.
     * - Grün "📝"  → Note entspricht dem ursprünglichen Ladestand
     * - Blau "↩"   → Note wurde seither verändert (Snippet, manuelle Eingabe)
     */
    function updateCCBtn() {
        const btn = document.getElementById("cc-btn");
        if (!btn || originalNoteText === null) return;

        const currentText = DOM.note?.value ?? getSavedNote();
        const noteChanged = currentText.trim() !== originalNoteText.trim();

        if (noteChanged && btn.dataset.vlMode !== "undo") {
            btn.dataset.vlMode = "undo";
            btn.textContent    = "↩";
            btn.title          = "Ursprüngliche Note am Ende einfügen (ohne Speichern)";
        } else if (!noteChanged && btn.dataset.vlMode !== "cc") {
            btn.dataset.vlMode = "cc";
            btn.title          = "";
            btn.textContent    = "📝";
        }
    }

    /** Baut CC/Undo-Button, Snippet-Dropdown und Versionsanzeige ein. */
    const addUI = () => {
        if (document.getElementById("cc-ui-container")) return;

        const noteWrapper = document.querySelector(".PersonalCacheNote");
        if (!noteWrapper) return;

        injectStyles();

        const versionDiv = document.createElement("div");
        versionDiv.id = "cc-ui-version";
        versionDiv.textContent = `v${SCRIPT_VERSION}`;

        const container = document.createElement("div");
        container.id = "cc-ui-container";

        // CC / Undo-Button
        const btn = document.createElement("button");
        btn.id             = "cc-btn";
        btn.type           = "button";
        btn.dataset.vlMode = "cc";
        btn.textContent    = "📝";

        btn.addEventListener("click", async e => {
            e.preventDefault();
            e.stopPropagation();

            // ── Undo-Modus ──────────────────────────────────────────────────────
            if (btn.dataset.vlMode === "undo") {
                activateNote();
                const ta = DOM.note;
                if (!ta || originalNoteText === null) return;

                const lines = ta.value.split("\n");

                // Leerzeile + Trennzeile + ursprüngliche Note anhängen
                if (lines[lines.length - 1].trim() !== "") lines.push("");
                lines.push("🗑️ OLD NOTE:");
                originalNoteText.split("\n").forEach(l => lines.push(l));

                ta.value = lines.join("\n");
                ta.dispatchEvent(new Event("input", { bubbles: true }));
                ta.setSelectionRange(ta.value.length, ta.value.length);

                resizeNoteTextarea();
                scrollToNote();
                console.log("[VL] Undo: ursprüngliche Note angehängt");
                return;
            }

            // ── CC-Modus ─────────────────────────────────────────────────────────
            if (!cachedCoords) {
                showNotification("Keine korrigierten Koordinaten gefunden.");
                return;
            }

            activateNote();
            btn.textContent = "✓"; // kurze Bestätigung

            await waitFor(
                () => { const t = DOM.note; return t && t.value.trim() ? t : null; },
                { interval: 80, timeoutMs: 1680 }
            );

            applyCC(cachedCoords);
            setTimeout(() => {
                updateCCBtn(); // korrekten Modus nach CC-Operation setzen
            }, 1200);
        });

        // Snippet-Dropdown
        const select = document.createElement("select");
        select.id = "cc-snippets";

        SNIPPETS.forEach(sn => {
            const opt = document.createElement("option");

            // Shortcut-Hinweis am Ende des Labels (Option-Elemente unterstützen
            // kein CSS-Styling, daher keine echte Rechtsausrichtung möglich)
            opt.textContent = sn.shortcutKey
                ? `${sn.label}  [Alt+${sn.shortcutKey}]`
                : sn.label;
            opt.value = sn.value;

            if (sn.label === "➕ Snippet") {
                opt.disabled = true;
                opt.selected = true;
            }

            if (sn.value.includes("__COORDS__")) {
                opt.dataset.vlKey = "falsch";
            }

            // Shortcut-Ziffer auf der Option speichern → für dynamische Updates
            if (sn.shortcutKey) opt.dataset.shortcutKey = sn.shortcutKey;

            select.appendChild(opt);
        });

        select.addEventListener("change", async e => {
            const val = e.target.value;
            if (!val) return;
            const sn = SNIPPETS.find(s => s.value === val);
            if (!sn) return;
            await applySnippet(sn);
            select.selectedIndex = 0;
        });

        noteWrapper.prepend(container);
        noteWrapper.prepend(versionDiv);

        container.appendChild(btn);
        container.appendChild(select);

        // Schnellzugriff-Button-Leiste (eine Zeile pro Snippet mit emoji)
        const btnBar = document.createElement("div");
        btnBar.id = "cc-snippet-btns";

        SNIPPETS.filter(sn => sn.emoji).forEach(sn => {
            const b = document.createElement("button");
            b.type = "button";

            // Native Emojis als Text mit fester Höhe
            const emojiContainer = document.createElement("span");
            emojiContainer.style.display = "inline-flex";
            emojiContainer.style.alignItems = "center";
            emojiContainer.style.justifyContent = "center";
            emojiContainer.style.height = "20px";
            emojiContainer.style.width = "20px";
            emojiContainer.style.lineHeight = "1";
            emojiContainer.textContent = sn.emoji;

            // Text-Labels (nur reine Buchstaben wie WP, ST)
            const isTextLabel = /^[A-Za-z]+$/.test(sn.emoji);
            
            if (isTextLabel) {
                emojiContainer.style.fontSize = "11px";
            } else {
                // Manche Emojis (text-style) werden vom Browser kleiner gerendert.
                // Vergrößere sie per transform: scale()
                const smallEmojis = ["✳️", "✉️", "⚠️"];
                if (smallEmojis.includes(sn.emoji)) {
                    emojiContainer.style.fontSize = "16px";
                    emojiContainer.style.transform = "scale(1.3)";
                } else {
                    emojiContainer.style.fontSize = "20px";
                }
            }
            
            b.appendChild(emojiContainer);

            // Badge mit Shortcut-Ziffer (unten rechts)
            if (sn.shortcutKey) {
                const badge = document.createElement("span");
                badge.className   = "vl-shortcut-badge";
                badge.textContent = sn.shortcutKey;
                b.appendChild(badge);
            }

            // Tooltip: voller Label + Shortcut-Hinweis
            const hint = sn.shortcutKey ? ` [Alt+${sn.shortcutKey}]` : "";
            b.title = sn.label + hint;

            b.addEventListener("click", async () => {
                await applySnippet(sn);
            });

            btnBar.appendChild(b);
        });

        noteWrapper.insertBefore(btnBar, container.nextSibling);

        // initialen Button-Zustand setzen
        updateCCBtn();

        console.debug("[VL] UI hinzugefügt");
    };

    /** Startet den DOM-Monitor (Checker-Warnungen + Button-Zustand). */
    const startDomMonitor = () => {
        setInterval(() => {
            updateCheckerWarnings();
            updateCCBtn();
        }, 500);
        console.debug("[VL] DOM-Monitor gestartet");
    };

    // ============================================================================
    // ⭐ START PIPELINE
    // ============================================================================

    window.addEventListener("load", () => {
        // Mobile-Viewport sofort anpassen, BEVOR andere Operationen starten
        // (verhindert Ruckeln beim initialen Rendering)
        initMobileViewport();

        setTimeout(async () => {
            await waitForSavedNoteLoaded();

            // Sicherungskopie VOR allen Script-Änderungen (für Undo)
            originalNoteText = getSavedNote();
            console.log("[VL] originalNoteText gesichert, Länge:", originalNoteText.length);

            await autoBeautifyOldNote();
            syncCCLineWithCorrectedCoords();
            await scanCheckers();
            await flushNoteChanges();

            addUI();

            // Beim Laden: Abfrage zeigen, wenn korrigierte Koordinaten vorhanden,
            // aber die Note bereits "GEOCHECKER FALSCH" enthält
            if (cachedCoords && originalNoteText?.toUpperCase().includes("GEOCHECKER FALSCH")) {
                console.log("[VL] Startup: Zeige Reset-Coords-Prompt (korrigierte Coords + GEOCHECKER FALSCH in Note)");
                showResetCoordsPrompt();
            } else {
                console.debug("[VL] Startup: Reset-Coords-Prompt nicht nötig", {
                    hasCachedCoords: !!cachedCoords,
                    hasGeoCheckerFalsch: originalNoteText?.toUpperCase().includes("GEOCHECKER FALSCH")
                });
            }

            startDomMonitor();

            const checkerBtn = document.getElementById("CheckerButton");
            if (checkerBtn) {
                checkerBtn.addEventListener("click", () => {
                    console.debug("[VL] Solution: CheckerButton geklickt");
                    setTimeout(handleSolutionCheckerResult, 500);
                });
            }
        }, 500);
    });

    /** Event-Listener für Tastenkürzel. */
    document.addEventListener("keydown", async e => {

        // ESC → Note schließen ohne Speichern (kein Modifier nötig)
        if (e.key === "Escape" && !e.ctrlKey && !e.shiftKey && !e.altKey) {
            if (isNoteOpen()) {
                e.preventDefault();
                cancelNote();
                return;
            }
        }

        // Alt+Zahl → Snippet per Tastenkürzel
        // e.code ('Digit0'–'Digit9', 'Numpad0'–'Numpad9') ist layout-unabhängig.
        if (e.altKey && !e.ctrlKey && !e.shiftKey) {
            const digitMatch = e.code?.match(/^(?:Digit|Numpad)(\d)$/); // Digit* + Numpad*
            if (digitMatch) {
                const sn = SNIPPETS.find(s => s.shortcutKey === digitMatch[1]);
                if (sn) {
                    e.preventDefault();
                    console.log(`[VL] Shortcut: Alt+${digitMatch[1]} → ${sn.label}`);
                    await applySnippet(sn);
                    return;
                }
            }
        }

        // Ab hier: nur STRG-Kombinationen (kein Shift, kein Alt)
        if (!e.ctrlKey || e.shiftKey || e.altKey) return;

        const key = e.key.toLowerCase();

        // STRG + S → Note speichern
        if (key === "s") {
            e.preventDefault();

            if (!isNoteOpen()) {
                console.warn("[VL] STRG+S ignoriert: Note ist nicht offen");
                return;
            }
            if (!DOM.note) {
                console.warn("[VL] STRG+S ignoriert: Textarea nicht vorhanden");
                return;
            }

            console.log("[VL] Shortcut: STRG+S → Note speichern");
            writeLines(DOM.note.value.split("\n"), true);
            return;
        }

        // STRG + O → Note öffnen
        if (key === "o") {
            e.preventDefault();
            console.log("[VL] Shortcut: STRG+O → Note öffnen");
            activateNote();
            scrollToNote();
            return;
        }

        // STRG + Z → Undo (ursprüngliche Note anhängen, nur wenn ↩-Modus aktiv)
        if (key === "z") {
            const ccBtn = document.getElementById("cc-btn");
            if (ccBtn?.dataset.vlMode === "undo") {
                e.preventDefault();
                console.log("[VL] Shortcut: STRG+Z → Undo");
                ccBtn.click();
            }
        }
    });

})();