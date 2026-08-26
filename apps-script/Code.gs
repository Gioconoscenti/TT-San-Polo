/**
 * TTS San Polo — Backend Google Apps Script per allenatore.html e atleta.html.
 *
 * SETUP (una tantum):
 * 1. Sul Google Sheet del club: Estensioni > Apps Script.
 * 2. Incolla questo file come Code.gs (sostituendo il contenuto esistente).
 * 3. Progetto Apps Script > Impostazioni progetto (icona ingranaggio) > Proprietà script:
 *      aggiungi APP_TOKEN = una stringa segreta a scelta.
 *      Suggerimento per generarla: esegui una volta Logger.log(Utilities.getUuid())
 *      da una funzione qualsiasi e copia il risultato da Visualizza > Log.
 * 4. Dal menu a tendina in alto seleziona la funzione initSheets ed eseguila una volta
 *    (crea i fogli mancanti con le intestazioni corrette; non tocca i fogli già esistenti
 *    con dati, si limita ad aggiungerli se assenti).
 * 5. Deploy > Nuova implementazione > tipo "Web app":
 *      - Esegui come: Me
 *      - Chi ha accesso: Chiunque
 *    Copia l'URL che termina in /exec.
 * 6. Incolla l'URL nella costante API di allenatore.html e atleta.html (se cambiato),
 *    e incolla il valore di APP_TOKEN nella costante TOKEN di allenatore.html.
 *
 * ROTAZIONE CREDENZIALI (senza toccare questo codice):
 *   Impostazioni progetto > Proprietà script > modifica APP_TOKEN > Salva.
 *   Poi aggiorna la costante TOKEN in allenatore.html con lo stesso valore e ripubblica
 *   la pagina statica (non serve un nuovo Deploy dell'Apps Script).
 *
 * MODELLO DI FIDUCIA:
 * - Le richieste di lettura (doGet) sono pubbliche: servono anche alla pagina atleta.html,
 *   che non ha alcun segreto incorporato. I dati personali di Atleti (Telefono, Email,
 *   Tessera) vengono però rimossi dalla risposta se non viene fornito un token valido.
 * - La scrittura "addRow" sul foglio Presenze è pubblica (è l'auto-conferma presenza
 *   dell'atleta) ma viene comunque validata: sessione e atleta devono esistere davvero
 *   ed essere coerenti, ed è idempotente (una seconda conferma non crea un duplicato).
 * - Tutte le altre scritture (addRow su altri fogli, ogni updateRow, ogni deleteRow)
 *   richiedono un token valido: sono per il pannello allenatore.
 * - Non è comunque un sistema di autenticazione forte: chi apre il sorgente di
 *   allenatore.html vede comunque il token. Il vantaggio reale è che il token è
 *   ruotabile da qui senza toccare il codice, e che l'API non è più scrivibile da chiunque
 *   trovi l'URL "a freddo" (bot, scanner, link condiviso per errore).
 */

const SHEETS = {
  Atleti: {
    idCol: 'ID',
    required: ['Nome', 'Cognome'],
    fields: ['Nome', 'Cognome', 'Corsi', 'Categoria', 'Livello', 'Tessera', 'Giorni', 'Telefono', 'Email', 'Attivo'],
    // Campi restituiti a chi NON fornisce un token valido (niente Telefono/Email/Tessera).
    publicFields: ['ID', 'Nome', 'Cognome', 'Corsi', 'Livelli', 'Livello', 'Categoria', 'Giorni', 'Attivo']
  },
  Sessioni: {
    idCol: 'ID',
    required: ['Data'],
    fields: ['Data', 'Giorno', 'Corso', 'OraInizio', 'OraFine', 'Aperta', 'Note']
  },
  Presenze: {
    idCol: 'ID',
    required: ['ID_Sessione', 'ID_Atleta'],
    fields: ['ID_Sessione', 'ID_Atleta', 'Timestamp', 'Fonte'],
    uniqueOn: ['ID_Sessione', 'ID_Atleta']
  },
  Accoppiamenti: {
    idCol: 'ID',
    required: ['ID_Sessione', 'Atleta_A'],
    fields: ['ID_Sessione', 'Atleta_A', 'Atleta_B', 'Bye']
  },
  Template: {
    idCol: 'ID',
    required: ['Nome', 'Corso'],
    fields: ['Nome', 'Corso', 'OraInizio', 'OraFine']
  }
};

// ── Autorizzazione ─────────────────────────────────────────────
function getToken_() {
  return PropertiesService.getScriptProperties().getProperty('APP_TOKEN') || '';
}
function isAuthorized_(token) {
  const t = getToken_();
  return !!t && token === t;
}

// ── Helper output ──────────────────────────────────────────────
function jsonOut_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
function errorOut_(msg) {
  return jsonOut_({ error: msg });
}

// ── Helper foglio ──────────────────────────────────────────────
function getSheet_(name) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(name);
  if (!sh) throw new Error('Foglio non trovato: ' + name);
  return sh;
}

function sheetToObjects_(sh) {
  const values = sh.getDataRange().getValues();
  if (values.length < 2) return [];
  const headers = values[0];
  const tz = Session.getScriptTimeZone();
  return values.slice(1)
    .filter(row => row.some(c => c !== '' && c !== null))
    .map(row => {
      const o = {};
      headers.forEach((h, i) => {
        let val = row[i];
        // Le date vengono normalizzate qui, col fuso dello script, per evitare che il
        // client riceva un timestamp UTC che si legge come "un giorno prima" in Italia.
        if (Object.prototype.toString.call(val) === '[object Date]') {
          val = Utilities.formatDate(val, tz, 'yyyy-MM-dd');
        }
        o[h] = val;
      });
      return o;
    });
}

function stripPrivateFields_(obj, publicFields) {
  const o = {};
  publicFields.forEach(f => { if (f in obj) o[f] = obj[f]; });
  return o;
}

// Prossimo ID = massimo ID esistente + 1 (non l'indice di riga: getLastRow() collide
// con un ID già usato non appena una riga viene cancellata, perché l'indice si riduce
// ma gli ID già assegnati alle righe rimaste restano quelli che erano).
function getNextId_(sh, idCol) {
  const values = sh.getDataRange().getValues();
  if (values.length < 2) return 1;
  const idColIdx = values[0].indexOf(idCol);
  const ids = values.slice(1).map(r => Number(r[idColIdx]) || 0);
  return Math.max(0, ...ids) + 1;
}

// ── Anti formula-injection (=, +, -, @ a inizio cella) ──────────
function sanitizeValue_(v) {
  if (typeof v !== 'string') return v;
  return /^[=+\-@\t\r]/.test(v) ? "'" + v : v;
}
function sanitizeRow_(row) {
  const out = {};
  Object.keys(row).forEach(k => { out[k] = sanitizeValue_(row[k]); });
  return out;
}

// ── Validazione generica ────────────────────────────────────────
function validateSheet_(sheetName) {
  const def = SHEETS[sheetName];
  if (!def) throw new Error('Foglio non consentito: ' + sheetName);
  return def;
}
function validateFields_(def, row) {
  def.required.forEach(f => {
    if (row[f] === undefined || row[f] === null || row[f] === '') {
      throw new Error('Campo obbligatorio mancante: ' + f);
    }
  });
  const unknown = Object.keys(row).filter(k => !def.fields.includes(k));
  if (unknown.length) throw new Error('Campi non consentiti: ' + unknown.join(', '));
}

// Presenze: la sessione e l'atleta indicati devono esistere davvero (evita righe spazzatura).
function validatePresenzaRefs_(row) {
  const sessioni = sheetToObjects_(getSheet_('Sessioni'));
  if (!sessioni.some(s => String(s.ID) === String(row.ID_Sessione))) {
    throw new Error('Sessione inesistente');
  }
  const atleti = sheetToObjects_(getSheet_('Atleti'));
  const atl = atleti.find(a => String(a.ID) === String(row.ID_Atleta));
  if (!atl) throw new Error('Atleta inesistente');
  if (atl.Attivo !== 'SI') throw new Error('Atleta non attivo');
}

// ── doGet ────────────────────────────────────────────────────────
function doGet(e) {
  try {
    const action = e.parameter.action;
    const token = e.parameter.token || '';
    const authorized = isAuthorized_(token);

    const readMap = {
      getAtleti: 'Atleti',
      getSessioni: 'Sessioni',
      getPresenze: 'Presenze',
      getAccoppiamenti: 'Accoppiamenti',
      getTemplate: 'Template'
    };
    const sheetName = readMap[action];
    if (!sheetName) return errorOut_('Azione non valida: ' + action);

    const sh = getSheet_(sheetName);
    let data = sheetToObjects_(sh);

    if (sheetName === 'Atleti' && !authorized) {
      data = data.map(a => stripPrivateFields_(a, SHEETS.Atleti.publicFields));
    }
    return jsonOut_(data);
  } catch (err) {
    return errorOut_(err.message);
  }
}

// ── doPost ───────────────────────────────────────────────────────
function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    const token = body.token || '';
    const authorized = isAuthorized_(token);
    const action = body.action;

    if (action === 'addRow') {
      // Unica scrittura pubblica consentita: auto check-in presenza dell'atleta.
      const isPublicCheckin = body.sheet === 'Presenze';
      if (!authorized && !isPublicCheckin) return errorOut_('Non autorizzato');
      return handleAddRow_(body, authorized);
    }

    if (!authorized) return errorOut_('Non autorizzato');
    if (action === 'updateRow') return handleUpdateRow_(body);
    if (action === 'deleteRow') return handleDeleteRow_(body);
    return errorOut_('Azione non valida: ' + action);
  } catch (err) {
    return errorOut_(err.message);
  }
}

function handleAddRow_(body, authorized) {
  const def = validateSheet_(body.sheet);
  const row = Object.assign({}, body.row || {});

  if (body.sheet === 'Presenze') {
    // Timestamp e Fonte sono determinati dal server, non dal client, per evitare spoofing.
    row.Timestamp = new Date().toISOString();
    row.Fonte = authorized ? 'allenatore' : 'atleta';
  }

  validateFields_(def, row);
  if (body.sheet === 'Presenze') validatePresenzaRefs_(row);

  const sh = getSheet_(body.sheet);

  if (def.uniqueOn) {
    const existing = sheetToObjects_(sh).find(r =>
      def.uniqueOn.every(k => String(r[k]) === String(row[k]))
    );
    if (existing) return jsonOut_({ id: existing[def.idCol], duplicate: true });
  }

  const id = getNextId_(sh, def.idCol);
  const clean = sanitizeRow_(row);
  const headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  const rowArr = headers.map(h => h === def.idCol ? id : (clean[h] !== undefined ? clean[h] : ''));
  sh.appendRow(rowArr);
  return jsonOut_({ success: true, id: id });
}

function handleUpdateRow_(body) {
  const def = validateSheet_(body.sheet);
  const sh = getSheet_(body.sheet);
  const values = sh.getDataRange().getValues();
  const headers = values[0];
  const idColIdx = headers.indexOf(def.idCol);
  const rowIdx = values.findIndex((r, i) => i > 0 && String(r[idColIdx]) === String(body.id));
  if (rowIdx < 1) throw new Error('Riga non trovata: ' + body.id);

  const clean = sanitizeRow_(body.data || {});
  Object.keys(clean).forEach(k => {
    const colIdx = headers.indexOf(k);
    if (colIdx === -1) throw new Error('Campo non consentito: ' + k);
    sh.getRange(rowIdx + 1, colIdx + 1).setValue(clean[k]);
  });
  return jsonOut_({ success: true });
}

function handleDeleteRow_(body) {
  const def = validateSheet_(body.sheet);
  const sh = getSheet_(body.sheet);
  const values = sh.getDataRange().getValues();
  const headers = values[0];
  const idColIdx = headers.indexOf(def.idCol);
  const rowIdx = values.findIndex((r, i) => i > 0 && String(r[idColIdx]) === String(body.id));
  if (rowIdx < 1) throw new Error('Riga non trovata: ' + body.id);
  sh.deleteRow(rowIdx + 1);
  return jsonOut_({ success: true });
}

/**
 * Da eseguire una tantum manualmente (menu Esegui) per creare i fogli mancanti
 * con le intestazioni corrette. Non modifica fogli già esistenti.
 */
function initSheets() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  Object.keys(SHEETS).forEach(name => {
    let sh = ss.getSheetByName(name);
    if (!sh) sh = ss.insertSheet(name);
    if (sh.getLastRow() === 0) {
      sh.appendRow([SHEETS[name].idCol].concat(SHEETS[name].fields));
    }
  });
}
