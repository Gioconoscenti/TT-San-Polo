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
 * 4. Dal menu a tendina in alto, esegui in ordine queste funzioni una tantum (▶):
 *      - initSheets: crea i fogli mancanti con le intestazioni corrette; non tocca i fogli
 *        già esistenti con dati, si limita ad aggiungerli se assenti.
 *      - migraCategorieCorsi: rinomina i vecchi nomi dei Corsi (Giovani/Adulti/Regionali/
 *        Nazionali) nei nuovi (Corso Giovanile/Corso Adulti/Serie Regionale/Agonista
 *        Nazionale) in tutte le righe già presenti in Atleti, Sessioni e Template. Sicura
 *        da rieseguire: se non trova valori vecchi non cambia nulla.
 *      - seedSettimanaTipo: crea i Template della settimana tipo del club (vedi HANDOFF.md
 *        per l'orario completo). Idempotente: salta i Template già esistenti con la stessa
 *        combinazione Giorno+Corso+OraInizio+OraFine, quindi è sicura da rilanciare.
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
 * - Le scritture "addRow" e "deleteRow" sul foglio Presenze sono pubbliche (sono
 *   l'auto-conferma/rimozione presenza dell'atleta) ma vengono comunque validate:
 *   per addRow, sessione e atleta devono esistere davvero ed essere coerenti, ed è
 *   idempotente (una seconda conferma non crea un duplicato). Non c'è un'identità reale
 *   per atleta, quindi chiunque selezioni un nome dalla pagina può segnarlo presente o
 *   rimuoverlo: è un compromesso accettato per tenere il flusso senza login (vedi HANDOFF.md).
 * - Tutte le altre scritture (addRow su altri fogli, updateRow, deleteRow su altri fogli)
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
    // Giorno (facoltativo) è il giorno della settimana usato dalla generazione automatica
    // di sessioni per periodo ("settimana tipo"): un template senza Giorno resta comunque
    // utilizzabile per compilare manualmente una singola sessione.
    fields: ['Nome', 'Corso', 'OraInizio', 'OraFine', 'Giorno']
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

    // Uniche scritture pubbliche consentite: auto check-in/rimozione presenza dell'atleta.
    const isPublicPresenza = body.sheet === 'Presenze' && (action === 'addRow' || action === 'deleteRow');

    if (!authorized && !isPublicPresenza) return errorOut_('Non autorizzato');

    if (action === 'addRow') return handleAddRow_(body, authorized);
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
 * Da eseguire manualmente (menu Esegui), anche più volte: crea i fogli mancanti con le
 * intestazioni corrette, e per i fogli già esistenti aggiunge in coda le sole colonne
 * previste in SHEETS che non ci sono ancora (es. quando si introduce un nuovo campo come
 * "Giorno" su un foglio Template creato prima che esistesse). Non tocca colonne o dati già
 * presenti.
 */
function initSheets() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  Object.keys(SHEETS).forEach(name => {
    let sh = ss.getSheetByName(name);
    if (!sh) sh = ss.insertSheet(name);
    const attese = [SHEETS[name].idCol].concat(SHEETS[name].fields);
    if (sh.getLastRow() === 0) {
      sh.appendRow(attese);
      return;
    }
    const headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
    const mancanti = attese.filter(h => headers.indexOf(h) === -1);
    if (mancanti.length) {
      sh.getRange(1, headers.length + 1, 1, mancanti.length).setValues([mancanti]);
    }
  });
}

// Vecchio nome Corso -> nuovo nome Corso. 'Torneo' non viene rinominato: le sessioni
// torneo sono gestite dal flag Aperta, non da un Corso dedicato.
const RINOMINA_CORSI_ = {
  'Giovani': 'Corso Giovanile',
  'Adulti': 'Corso Adulti',
  'Regionali': 'Serie Regionale',
  'Nazionali': 'Agonista Nazionale'
};

function rinominaCorsoSingolo_(valore) {
  return RINOMINA_CORSI_[valore] || valore;
}

/**
 * Da eseguire una tantum manualmente (menu Esegui), dopo initSheets e prima di
 * seedSettimanaTipo: rinomina i vecchi nomi dei Corsi nei nuovi, in tutte le righe già
 * presenti in Atleti (dove Corsi/Livelli può contenere più valori separati da virgola),
 * Sessioni e Template (valore singolo). Sicura da rieseguire: se un valore è già nel
 * formato nuovo (o è 'Torneo') resta invariato.
 */
function migraCategorieCorsi() {
  const shAtleti = getSheet_('Atleti');
  const valuesA = shAtleti.getDataRange().getValues();
  const headersA = valuesA[0];
  const colCorsiIdx = headersA.indexOf('Corsi') !== -1 ? headersA.indexOf('Corsi') : headersA.indexOf('Livelli');
  let modificheA = 0;
  if (colCorsiIdx !== -1) {
    for (let i = 1; i < valuesA.length; i++) {
      const raw = valuesA[i][colCorsiIdx];
      if (!raw) continue;
      const nuovo = String(raw).split(',').map(v => rinominaCorsoSingolo_(v.trim())).join(', ');
      if (nuovo !== raw) {
        shAtleti.getRange(i + 1, colCorsiIdx + 1).setValue(nuovo);
        modificheA++;
      }
    }
  }

  const conteggi = { Sessioni: 0, Template: 0 };
  ['Sessioni', 'Template'].forEach(nomeFoglio => {
    const sh = getSheet_(nomeFoglio);
    const values = sh.getDataRange().getValues();
    const headers = values[0];
    const colIdx = headers.indexOf('Corso');
    if (colIdx === -1) return;
    for (let i = 1; i < values.length; i++) {
      const raw = values[i][colIdx];
      if (!raw) continue;
      const nuovo = rinominaCorsoSingolo_(raw);
      if (nuovo !== raw) {
        sh.getRange(i + 1, colIdx + 1).setValue(nuovo);
        conteggi[nomeFoglio]++;
      }
    }
  });

  Logger.log('Atleti aggiornati: ' + modificheA + ', Sessioni aggiornate: ' + conteggi.Sessioni + ', Template aggiornati: ' + conteggi.Template);
}

// Orario settimanale del club: Giorno, Corso, OraInizio, OraFine. Gli slot con due gruppi
// paralleli (settore giovanile + agonisti nazionali) compaiono come due righe separate,
// stesso Giorno/orario, Corso diverso.
const SETTIMANA_TIPO_ = [
  { Giorno: 'Lunedì', Corso: 'Corso Adulti', OraInizio: '18:30', OraFine: '19:45' },
  { Giorno: 'Lunedì', Corso: 'Serie Regionale', OraInizio: '20:00', OraFine: '21:45' },
  { Giorno: 'Martedì', Corso: 'Corso Adulti', OraInizio: '12:45', OraFine: '14:00' },
  { Giorno: 'Martedì', Corso: 'Corso Giovanile', OraInizio: '16:30', OraFine: '18:15' },
  { Giorno: 'Martedì', Corso: 'Settore Giovanile', OraInizio: '18:15', OraFine: '20:15' },
  { Giorno: 'Martedì', Corso: 'Agonista Nazionale', OraInizio: '18:15', OraFine: '20:15' },
  { Giorno: 'Martedì', Corso: 'Corso Adulti', OraInizio: '20:30', OraFine: '21:45' },
  { Giorno: 'Mercoledì', Corso: 'Settore Giovanile', OraInizio: '16:30', OraFine: '18:15' },
  { Giorno: 'Mercoledì', Corso: 'Agonista Nazionale', OraInizio: '16:30', OraFine: '18:15' },
  { Giorno: 'Mercoledì', Corso: 'Corso Adulti', OraInizio: '18:30', OraFine: '19:45' },
  { Giorno: 'Mercoledì', Corso: 'Serie Regionale', OraInizio: '20:00', OraFine: '21:45' },
  { Giorno: 'Giovedì', Corso: 'Corso Giovanile', OraInizio: '16:30', OraFine: '18:15' },
  { Giorno: 'Giovedì', Corso: 'Settore Giovanile', OraInizio: '18:15', OraFine: '20:15' },
  { Giorno: 'Giovedì', Corso: 'Agonista Nazionale', OraInizio: '18:15', OraFine: '20:15' },
  { Giorno: 'Giovedì', Corso: 'Corso Adulti', OraInizio: '20:30', OraFine: '21:45' },
  { Giorno: 'Venerdì', Corso: 'Settore Giovanile', OraInizio: '16:30', OraFine: '18:15' },
  { Giorno: 'Venerdì', Corso: 'Agonista Nazionale', OraInizio: '16:30', OraFine: '18:15' },
  { Giorno: 'Venerdì', Corso: 'Serie Regionale', OraInizio: '18:30', OraFine: '20:00' },
  { Giorno: 'Sabato', Corso: 'Corso Adulti', OraInizio: '10:00', OraFine: '11:15' },
  { Giorno: 'Sabato', Corso: 'Serie Regionale', OraInizio: '10:00', OraFine: '11:30' }
];

/**
 * Da eseguire manualmente (menu Esegui), dopo initSheets e migraCategorieCorsi, anche più
 * volte: crea i Template della settimana tipo del club (SETTIMANA_TIPO_ sopra). Per ogni riga:
 * - se esiste già un Template identico (stesso Giorno+Corso+OraInizio+OraFine), non fa nulla;
 * - se esiste un Template con lo stesso Corso+OraInizio+OraFine ma senza Giorno (capita se
 *   seedSettimanaTipo è stata eseguita prima che initSheets aggiungesse la colonna Giorno),
 *   completa quella riga invece di crearne una nuova;
 * - altrimenti crea una nuova riga.
 * Richiede che il foglio Template abbia già la colonna Giorno (eseguire prima initSheets()).
 */
function seedSettimanaTipo() {
  const sh = getSheet_('Template');
  const headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  const giornoColIdx = headers.indexOf('Giorno');
  if (giornoColIdx === -1) {
    throw new Error('Il foglio Template non ha ancora la colonna Giorno: esegui prima initSheets().');
  }
  const idColIdx = headers.indexOf('ID');
  const esistenti = sheetToObjects_(sh);
  let creati = 0, riparati = 0, invariati = 0;

  SETTIMANA_TIPO_.forEach(t => {
    const esatta = esistenti.some(e =>
      e.Giorno === t.Giorno && e.Corso === t.Corso && e.OraInizio === t.OraInizio && e.OraFine === t.OraFine
    );
    if (esatta) { invariati++; return; }

    const parziale = esistenti.find(e =>
      !e.Giorno && e.Corso === t.Corso && e.OraInizio === t.OraInizio && e.OraFine === t.OraFine
    );
    if (parziale) {
      const raw = sh.getDataRange().getValues();
      const rowIdx = raw.findIndex((r, i) => i > 0 && String(r[idColIdx]) === String(parziale.ID));
      if (rowIdx > 0) sh.getRange(rowIdx + 1, giornoColIdx + 1).setValue(t.Giorno);
      parziale.Giorno = t.Giorno;
      riparati++;
      return;
    }

    const id = getNextId_(sh, 'ID');
    const row = { Nome: t.Corso, Corso: t.Corso, OraInizio: t.OraInizio, OraFine: t.OraFine, Giorno: t.Giorno };
    const rowArr = headers.map(h => h === 'ID' ? id : (row[h] !== undefined ? row[h] : ''));
    sh.appendRow(rowArr);
    esistenti.push(Object.assign({ ID: id }, row));
    creati++;
  });

  Logger.log('Template creati: ' + creati + ', riparati (Giorno mancante): ' + riparati + ', già corretti: ' + invariati);
}
