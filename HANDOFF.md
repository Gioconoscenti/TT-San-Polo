# Handoff — TTS San Polo, Gestione Corsi

Questo documento serve a trasferire la gestione dell'app (in particolare la parte
"allenatore") a qualcun altro senza perdere il controllo di sicurezza sui dati del club.
Tienilo aggiornato: è il punto di riferimento per chiunque prenda in mano il progetto dopo di te.

## 1. Architettura in breve

```
allenatore.html  ──┐
                    ├──►  Google Apps Script (Web App, /exec)  ──►  Google Sheet
atleta.html      ──┘         apps-script/Code.gs (in questo repo)
```

- **allenatore.html** e **atleta.html**: due pagine statiche, nessun server proprio.
  Sono ospitate ovunque si possa servire un file HTML (GitHub Pages, hosting statico, ecc.).
- **apps-script/Code.gs**: unico backend. Gira su Google Apps Script, legato a un
  Google Sheet che è il "database" (fogli Atleti, Sessioni, Presenze, Accoppiamenti, Template).
- Non c'è un vero server applicativo: tutta la logica di validazione vive nello script.

## 2. Dove vivono oggi i dati

- Repository del codice: https://github.com/Gioconoscenti/TT-San-Polo — **pubblica**.
- Account Google proprietario dello Sheet/Apps Script: `________________`
- Link al Google Sheet: `________________`
- Link al progetto Apps Script: `________________`
- URL di deploy (`/exec`) attualmente in uso in `allenatore.html`/`atleta.html`: vedi
  costante `API` in entrambi i file.
- Dove sono ospitate le due pagine HTML: GitHub Pages, https://gioconoscenti.github.io/TT-San-Polo/
  (build "legacy" dal branch `main`, root `/`).

**Nota**: la build "legacy" di GitHub Pages può restare bloccata in stato "building" dopo un
push e non aggiornare la pagina live, anche per giorni, senza segnalare errori. Se dopo un
push la pagina live non riflette le modifiche (es. `curl -sI <url> | grep Last-Modified`
mostra una data vecchia), forza una nuova build con:
```
gh api -X POST repos/Gioconoscenti/TT-San-Polo/pages/builds
```
poi verifica con `gh api repos/Gioconoscenti/TT-San-Polo/pages/builds/latest` che passi a
`"status":"built"`.

## 3. Segreti e come ruotarli

Ci sono due credenziali distinte, con scopi diversi:

| Credenziale | Dove vive | A cosa serve | Chi può cambiarla |
|---|---|---|---|
| `PWD` in `allenatore.html` | codice HTML | Gate d'accesso alla UI del pannello (non è vera sicurezza: chi legge il sorgente la vede) | Chi può modificare e ripubblicare `allenatore.html` |
| `APP_TOKEN` in Apps Script (Proprietà script) | `PropertiesService` su Apps Script | Autorizza le scritture/letture sensibili sull'API (vera barriera server-side) | Chi ha accesso all'editor Apps Script, **senza toccare codice** |

**Per ruotare `APP_TOKEN`** (es. sospetto che sia trapelato, o cambio gestione):
1. Apps Script > Impostazioni progetto > Proprietà script > modifica `APP_TOKEN` > Salva.
2. Aggiorna la costante `TOKEN` in `allenatore.html` con lo stesso valore e ripubblica la pagina.
3. Non serve un nuovo Deploy dell'Apps Script per questo passaggio.

**Per ruotare `PWD`**: modifica la costante `PWD` in `allenatore.html` e ripubblica.

Importante: questo repository **è pubblico**, quindi chiunque può leggere la cronologia dei
commit e risalire a un token committato in passato anche dopo averlo cambiato nel file
attuale. Non è un rischio nuovo introdotto dal repo pubblico in sé — lo stesso token è
comunque visibile a chi apre `allenatore.html` e ne guarda il sorgente, quindi il modello di
fiducia parte già dal presupposto che non sia un vero segreto — ma significa che una
rotazione futura di `APP_TOKEN` non "cancella" quello vecchio dalla cronologia git: se sospetti
che un token specifico sia stato abusato, ruotalo su Apps Script (l'unico posto che conta
davvero) e non preoccuparti di ripulire git.

## 4. Come ripubblicare l'Apps Script dopo una modifica al codice

Modificare `apps-script/Code.gs` nel repo **non aggiorna da solo** il backend live: il file
in questo repo è la sorgente di riferimento, ma va copiato nell'editor Apps Script.

1. Apri l'editor Apps Script collegato allo Sheet.
2. Incolla il contenuto aggiornato di `Code.gs`.
3. Deploy > Gestisci implementazioni > icona matita sulla implementazione attiva >
   Versione: Nuova versione > Esegui il deploy.
4. L'URL `/exec` resta lo stesso: non serve aggiornare nulla nelle pagine HTML per una
   modifica di sola logica interna.

(Per chi vuole automatizzare questo passaggio in futuro: lo strumento ufficiale è
[`clasp`](https://github.com/google/clasp), che permette di sincronizzare `Code.gs` da riga
di comando invece di copia-incolla manuale.)

## 5. Trasferire la proprietà a un account del club

Oggi (agosto 2026) tutto è sotto il tuo controllo. Prima di trasferire la gestione,
scegli una delle due strade:

### Opzione A — Consigliata: crea un account dedicato al club ORA
1. Crea un account Google intestato al club (es. `asd.tennistavolosanpolo@gmail.com`),
   non alla persona che di volta in volta lo gestisce.
2. Sposta lì il Google Sheet (Drive > Condividi > icona ingranaggio > Trasferisci proprietà,
   oppure fai una copia e ricrea l'Apps Script se il trasferimento diretto non è disponibile
   sul tipo di account).
3. Ricrea/ridistribuisci l'Apps Script su quell'account seguendo la sezione 1 di
   `apps-script/Code.gs` (i commenti in testa al file).
4. Aggiorna `API` in `allenatore.html`/`atleta.html` con il nuovo URL `/exec`.
5. Tu resti editor collaboratore finché serve; il vantaggio è che **non c'è un "trasferimento"
   da fare più avanti** — la proprietà è già del club fin dall'inizio, e revocare il tuo
   accesso in futuro è un'operazione di un minuto (Condividi > rimuovi utente).

### Opzione B — Trasferire in un secondo momento un asset già esistente sul tuo account
1. Google Drive > file dello Sheet > Condividi > aggiungi il nuovo proprietario come
   editor > icona ingranaggio > "Trasferisci proprietà" (richiede che il nuovo account
   accetti l'invito).
2. Se l'Apps Script è "container-bound" (creato da Estensioni > Apps Script sullo stesso
   Sheet), si trasferisce insieme al foglio. Se invece è un progetto Apps Script standalone,
   va condiviso/trasferito separatamente da script.google.com.
3. Il nuovo proprietario deve rifare il Deploy (i deploy non sempre si trasferiscono in modo
   pulito insieme alla proprietà) — verifica che l'URL `/exec` resti valido o aggiornalo nelle
   pagine HTML.

### Checklist dopo il trasferimento (qualunque opzione)
- [ ] Il nuovo proprietario apre lo Sheet e vede i dati.
- [ ] Il nuovo proprietario apre l'editor Apps Script e vede `Code.gs`.
- [ ] Il nuovo proprietario trova ed è in grado di modificare `APP_TOKEN` in Proprietà script.
- [ ] Il nuovo proprietario riesce a fare un nuovo Deploy (Gestisci implementazioni).
- [ ] `allenatore.html`/`atleta.html` puntano all'URL `/exec` corretto e funzionante.
- [ ] Hai revocato il tuo accesso una volta verificato tutto, se concordato.

## 6. Divisione delle responsabilità dopo l'handoff

**Chi gestisce il club può fare senza saper programmare:**
- Aggiungere/modificare/disattivare atleti dal foglio Google (o dal pannello allenatore).
- Creare sessioni, template, generare accoppiamenti dal pannello allenatore.
- Cambiare `PWD` e `APP_TOKEN` seguendo la sezione 3.
- Consultare/esportare i dati direttamente dal Google Sheet.

**Richiede ancora chi sa scrivere codice (o un futuro sviluppatore):**
- Qualsiasi modifica a `Code.gs` (nuova validazione, nuovo campo, nuova azione).
- Qualsiasi modifica a `allenatore.html`/`atleta.html` (nuove funzionalità, fix di bug).
- Ripubblicazione delle pagine statiche sull'hosting scelto.

## 7. Nota di migrazione dallo script precedente

Lo script Apps Script originale (senza token, senza validazioni) assegnava l'ID di ogni
nuova riga come `sheet.getLastRow()`. Questo ha un bug: dopo una `deleteRow`, `getLastRow()`
si abbassa e la riga successiva può ricevere un ID già usato da una riga rimasta nel foglio.
Il foglio **Accoppiamenti** è il più esposto, perché `generaAcc()` in `allenatore.html`
cancella e rigenera gli accoppiamenti a ogni sessione.

**Prima di sostituire lo script in produzione con `apps-script/Code.gs`:**
1. Apri il foglio Accoppiamenti e ordina/controlla la colonna ID: se trovi valori duplicati,
   quelle righe sono ambigue per `updateRow`/`deleteRow` (solo la prima trovata viene presa).
   Deciditi su come sistemarle (es. rinumerare manualmente la colonna ID in modo che sia
   univoca) prima o subito dopo il passaggio al nuovo script.
2. Controlla allo stesso modo Atleti, Sessioni, Template, Presenze, anche se meno esposti
   (si cancella meno spesso da lì).
3. `apps-script/Code.gs` assegna i nuovi ID come "massimo ID esistente + 1" invece che come
   riga corrente, quindi il problema non si ripresenta una volta migrato — ma non corregge
   da solo eventuali duplicati già presenti.

## 8. Tassonomia Corsi e settimana tipo

I nomi dei Corsi/Livelli sono cambiati rispetto alle prime versioni dell'app:

| Vecchio nome | Nuovo nome |
|---|---|
| Giovani | Corso Giovanile |
| — (nuovo) | Settore Giovanile |
| Adulti | Corso Adulti |
| Regionali | Serie Regionale |
| Nazionali | Agonista Nazionale |
| Torneo | rimosso (usa il flag "Aperta a tutti" sulla sessione) |

Se trovi dati vecchi (es. un atleta con `Corsi=Regionali`) è perché non è ancora stata
eseguita la migrazione: vedi `apps-script/Code.gs`, funzione `migraCategorieCorsi()`.

**Settore Giovanile** e **Corso Giovanile** sono due gruppi di atleti distinti (non lo stesso
gruppo con due nomi): il primo è il livello più avanzato/agonistico del settore giovani,
allenato insieme agli Agonisti Nazionali nello stesso slot orario.

Orario settimanale attuale (usato per generare i Template via `seedSettimanaTipo()` in
`apps-script/Code.gs`):

| Giorno | Orario | Corso |
|---|---|---|
| Lunedì | 18:30–19:45 | Corso Adulti |
| Lunedì | 20:00–21:45 | Serie Regionale *(occasionalmente "torneo del lunedì": va marcato a mano come "Aperta a tutti" sulla singola sessione)* |
| Martedì | 12:45–14:00 | Corso Adulti |
| Martedì | 16:30–18:15 | Corso Giovanile |
| Martedì | 18:15–20:15 | Settore Giovanile + Agonista Nazionale (due sessioni parallele) |
| Martedì | 20:30–21:45 | Corso Adulti |
| Mercoledì | 16:30–18:15 | Settore Giovanile + Agonista Nazionale (due sessioni parallele) |
| Mercoledì | 18:30–19:45 | Corso Adulti |
| Mercoledì | 20:00–21:45 | Serie Regionale |
| Giovedì | 16:30–18:15 | Corso Giovanile |
| Giovedì | 18:15–20:15 | Settore Giovanile + Agonista Nazionale (due sessioni parallele) |
| Giovedì | 20:30–21:45 | Corso Adulti |
| Venerdì | 16:30–18:15 | Settore Giovanile + Agonista Nazionale (due sessioni parallele) |
| Venerdì | 18:30–20:00 | Serie Regionale |
| Sabato | 10:00–11:15 | Corso Adulti |
| Sabato | 10:00–11:30 | Serie Regionale |

## 9. Rischi noti e accettati in questa versione

- **Nessuna identità reale per l'auto check-in**: in `atleta.html` chiunque può selezionare
  il nome di un altro atleta dalla tendina e segnarlo presente **o rimuoverne la presenza**
  (stesso perimetro pubblico, per simmetria: chi può registrarsi può anche disdire). È un
  compromesso accettato per tenere il flusso semplice (nessun login per gli atleti). Se in
  futuro serve di più, la strada naturale è un link personale "magico" per atleta (con un
  token nell'URL) invece
  della tendina libera.
- **`PWD` in `allenatore.html` non è vera autenticazione**: è solo un gate contro accessi
  accidentali. La protezione reale sui dati è `APP_TOKEN`, verificato server-side.
- **Pagina allenatore comunque pubblica**: essendo un file statico, chiunque abbia l'URL
  della pagina (non solo dell'API) può aprirla e vedere il sorgente, incluso il valore di
  `TOKEN`. Se in futuro serve isolarla davvero, va messa dietro un vero login (es. Cloudflare
  Access, Netlify Identity, o un piccolo backend con sessioni) — non è stato fatto in questa
  iterazione perché è un cambio di architettura più grande.
- **Quote Google Apps Script**: il piano gratuito ha limiti di esecuzioni/tempo per account.
  In una serata con molti check-in simultanei, monitora eventuali errori di quota nei log
  di Apps Script (Esecuzioni, nel menu laterale dell'editor).
