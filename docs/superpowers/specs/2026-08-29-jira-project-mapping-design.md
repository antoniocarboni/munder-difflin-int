# Jira project mapping — design

Status: approved (brainstorming), pending implementation plan.
Branch: `feature/jira-project-mapping`.

## Contesto e problema

munder-difflin deve far prendere in carico agli agenti le issue Jira assegnate
all'utente ("To Do", poll ogni 5 minuti): crea una card sul kanban della hive
e la assegna all'agente competente. Perché il poll sappia *quale* repo e
*quale* agente corrispondono a *quale* progetto Jira, serve una mappa
progetto → repo → branch base → agenti.

Oggi quella mappa è `<hive>/jira-map.json`, un file scritto a mano che il
prompt della mission legge a ogni giro. Problemi: nessuna validazione al
salvataggio (si scopre un path o un branch sbagliato solo quando il poll
fallisce), nessuna scoperta per l'utente, fuori posto rispetto al resto della
configurazione dell'app (che vive in `config.json` con UI dedicata), fragile
rispetto alla realtà (repo spostato, agente archiviato → il file continua a
dichiarare qualcosa che non esiste più).

Obiettivo: rendere la mappa una configurazione di prima classe — schema,
persistenza in `config.json`, UI, validazione al salvataggio — esattamente
come integrazioni e repo registrati. Il file `jira-map.json` sparisce.

## Cosa esiste già (verificato nel codice reale)

- `ScheduledMission` in `src/main/config.ts` (~riga 27): `{ id, label,
  intervalMs, to, body, enabled, kind?, ... }`. `to` è generico — può
  puntare a qualunque agent id, non è vincolato a `'god'` (vedi `MissionRow`
  in `src/renderer/src/components/triggers/SchedulesSection.tsx:198`).
  `OPS_STANDUP_MISSION` e `HEARTBEAT_MISSION` (config.ts ~riga 65, 98)
  puntano entrambe a `'god'` con un pattern di seeding one-shot
  (`opsStandupSeeded`, `heartbeatSeeded`).
- Integrazioni: registro in `src/shared/integrations.ts`. Esiste già un
  descrittore Jira (`kind: 'custom-rest'`, `idSuggestion: 'jira'`, baseUrl
  `https://<site>.atlassian.net/rest/api/3`, auth Basic base64). UI in
  `IntegrationsRegistry.tsx`, montata in `SettingsModal.tsx:1786` sotto
  Connections. Esiste già `integrationsTest(req: {id, path?})` (preload
  `src/preload/index.ts:1323`) — un test REST generico riusabile per
  verificare che una chiave Jira esista davvero (`GET /project/<KEY>`).
- Broker: `IntegrationBroker` (`src/main/integrationBroker.ts`) è un proxy
  loopback `127.0.0.1`-only. Un worker (o **god**, che è spawnato con lo
  stesso `spawnAgentCore` e riceve `MD_BROKER_URL`/`MD_BROKER_TOKEN` allo
  stesso modo) chiama `/i/<integrationId>/<path>` con un capability token;
  il broker inietta il secret e inoltra. Oggi espone **solo** integrazioni
  registrate, non dati di config arbitrari.
- `registeredRepos: string[]` (config.ts ~riga 220): lista piatta di path,
  nessuna chiave Jira, nessun branch — non riusabile così com'è.
- `updateConfig(patch: Partial<HarnessConfig>)` (preload ~riga 679): via
  IPC per persistere config, unica via corretta (l'app sovrascrive
  `config.json` scritto a mano mentre gira).
- Kanban: `<hive>/tasks.json`, card con `project`, `repo`, `assignee`,
  `status` (todo/doing/blocked/done). **God scrive `tasks.json` come file
  diretto**, non via IPC (da `PROTOCOL.md`) — la creazione/assegnazione
  della card resta prompt-engineering nel body della mission, non richiede
  codice app nuovo.
- Agenti: `<hive>/registry.json` → `{ godId, agents: { [id]: { archived,
  ... } } }`. `archived: boolean` per agente, già presente.
- `capabilities/SKILL.md`: file statico bundlato in ogni agente (non
  generato per-agente), documenta genericamente broker + integrazioni
  disponibili ("discover what's live at run time").
- Verificato nella config reale dell'utente: la mission di poll Jira **non
  esiste ancora** — solo `ops-standup` e `heartbeat` sono configurate. Il
  poll è quindi un meccanismo nuovo da costruire, non una mission esistente
  da adattare.

## Decisioni già prese (fuori scope ridiscuterle)

- Presa in carico: issue assegnate all'utente + stato "To Do", poll ogni 5
  minuti (default).
- Transizioni di stato su Jira: automatiche, fatte dal poll al momento del
  claim (non da un singolo agente — single point of failure).
- Commenti su Jira: solo l'agente Pam (PM), template fisso, cap ~600
  caratteri, solo ai passaggi che contano (preso in carico, pronto per QA,
  chiuso). Il dettaglio tecnico resta sulla card della hive.
- Convenzione branch, verificata su repo reali: `feature/<KEY>-<num>-<slug>`,
  sprint su `stage/sprint-<NN>`, feature nascono da `develop` e vi
  rientrano.
- Queste policy (commento, convenzione branch) **non diventano campi di
  config editabili** — restano prosa fissa nel body della mission (vedi
  sezione D), per non riaprire in UI decisioni già chiuse.

## A. Modello dati

Nuovi campi in `HarnessConfig`, specchiati nei tre punti esistenti
(`src/main/config.ts`, `src/renderer/src/store/config.ts`,
`src/preload/index.ts`):

```ts
export interface JiraProjectBinding {
  key: string;            // chiave Jira, es. "BURD"
  repo: string;           // path assoluto del repo locale
  baseBranch: string;     // branch da cui nascono le feature, es. "develop"
  agents?: string[];      // agent id che coprono il progetto; assente/vuoto = tutti
  enabled: boolean;       // escludere un progetto senza cancellarlo
}

export interface JiraPollSettings {
  pollIntervalMs: number;        // default 300_000 (5 min)
  assigneeFilter: 'currentUser'; // fisso oggi, ma dato — non costante hardcoded altrove
  statusFilter: string;          // default 'To Do'
}
```

`jiraProjects: JiraProjectBinding[]` (default `[]`) e `jiraPoll:
JiraPollSettings` (default coi valori sopra) in `HarnessConfig`. Config
esistente senza questi campi si carica senza errori (stesso pattern di
`registeredRepos`).

### Migrazione one-shot da `jira-map.json`

Al boot (stesso punto dove oggi gira `withTriggerDefaults`/
`migrateTriggersV1`): se `<hive>/jira-map.json` esiste e `jiraProjects` è
vuoto/assente, importa `projects[]` → `JiraProjectBinding[]` (`key`, `repo`,
`baseBranch`, `agents`, `enabled: true`) e `claimFilter.pollIntervalMs` →
`jiraPoll.pollIntervalMs`. Guardia one-shot `jiraProjectsImported: boolean`
in `HarnessConfig` (mirror di `opsStandupSeeded`): impedisce una
re-importazione dopo che l'utente ha cancellato i binding a mano. Il file
`jira-map.json` **non viene toccato né cancellato** dal codice — resta lì
finché l'utente non lo rimuove; nessun percorso di codice lo legge più dopo
l'import.

## B. Validazione

Handler IPC dedicato, es. `validateJiraBinding(binding, allBindings):
FieldErrors`, chiamato dalla UI su blur/submit per riga (errori inline,
stesso pattern di `errBaseUrl`/`errHeader` in `IntegrationsRegistry`) **e**
ri-eseguito come gate finale dentro l'handler di `updateConfig` prima di
persistere — un binding che fallisce viene rifiutato con l'errore per
campo, mai un salvataggio parziale silenzioso.

Regole, in ordine (fail-fast per riga):

1. **Chiave duplicata** — confronto case-insensitive contro le altre righe
   (esclusa se stessa in edit).
2. **Formato chiave** — regex `^[A-Z][A-Z0-9]{1,9}$`; nessuna rete.
3. **Repo** — `existsSync(repo)`, poi `isRepo(repo)` (già in
   `src/main/git.ts`); se fallisce qui, non valuta il branch.
4. **Base branch** — `getBranches(repo)` (già in `git.ts`): cercato in
   `local` **o** in `remote` con prefisso `origin/` (il prompt dice
   "locale o `origin/`" — basta una delle due).
5. **Agenti** — ogni id in `agents[]` deve esistere in
   `registry.json.agents` con `archived === false`.
6. **Chiave Jira reale** — *solo se* l'integrazione `jira` è configurata,
   abilitata e ha un secret: riusa `integrationsTest({id:'jira',
   path:'/project/<KEY>'})`; risposta non-2xx → campo rifiutato con
   messaggio esplicito. Se l'integrazione non è pronta, questo check è
   **skippato** (non bloccante) — l'utente può preparare i binding prima di
   collegare Jira, ma la UI lo segnala (sezione C).

## C. UI

Nuovo componente `JiraProjectsRegistry.tsx`, montato subito sotto
`<IntegrationsRegistry />` in `SettingsModal.tsx:1786` (stessa tab
Connections — è configurazione, non un trigger). Ricalca lo stile esistente:
lista righe, `+ Add project`, edit inline, `Remove`, toggle `enabled`, `Test`
per riga.

- **Banner di stato integrazione**: se `jira` non è configurata/abilitata,
  banner con link/scroll alla card Jira in Connections. Non blocca la
  creazione dei binding (repo/branch restano validabili offline), blocca
  solo il check di esistenza remota della chiave (regola B.6).
- **Riga**: chiave (testo libero + validazione, non una select sui ~50
  progetti Jira del sito — la maggior parte archiviati con prefisso `zzz`;
  qui si registrano solo i pochi progetti che contano, non si enumera il
  sito), repo (file picker, come i `registeredRepos` esistenti), base
  branch (select popolata da `getBranches`), agenti (multi-select dal
  registry, vuoto = tutti), enabled toggle.
- **Pannello impostazioni globali del poll**: sopra la lista, `pollIntervalMs`
  editabile (default 5 min); assignee/status filter mostrati **in sola
  lettura** (decisione già presa, non riaperta in UI).

## D. Broker + mission

### Broker

`IntegrationBroker` guadagna una rotta separata dal proxy `/i/<id>/<path>`:
`GET /jira-bindings`, autenticata con qualunque capability token valido (non
è un proxy verso un'integrazione specifica, quindi non richiede
`allowedIds` — sono dati di config, zero credenziali). Nuova dependency
iniettata: `getJiraBindings: () => { bindings: JiraProjectBinding[]; poll:
JiraPollSettings }`, filtrata a `enabled: true`.

`capabilities/SKILL.md` guadagna un paragrafo nella sezione 3
("Integrazioni") che documenta `GET /jira-bindings` con lo stesso taglio
delle altre rotte brokerate.

### Mission

Nuova `JIRA_POLL_MISSION` in `config.ts`, stesso pattern di
`OPS_STANDUP_MISSION`/`HEARTBEAT_MISSION`:

- `id: 'jira-poll'`, `to: 'god'` — god decide quale agente assegnare per
  ogni claim, è una decisione di orchestrazione, nessun altro target ha
  senso qui (il campo `to` è tecnicamente generico, ma per questa mission
  la scelta è nel merito, non solo convenzione).
- `intervalMs`: da `jiraPoll.pollIntervalMs` (default 5 min).
- `enabled: false` di default — **opt-in**, come l'heartbeat: fa
  transizioni di stato su Jira e crea card, non è un semplice messaggio.
- `body`: prosa generica e stabile che descrive la procedura fissa — fetch
  `GET /jira-bindings` dal broker; per ogni binding attivo, cerca issue
  assegnate all'utente in "To Do"; al claim: transizione automatica su
  Jira, card in `tasks.json` (`project`, `repo`, `assignee`, `status:
  doing`), branch `feature/<KEY>-<num>-<slug>` da `baseBranch`; commento
  Jira delegato a Pam col template e cap ~600 caratteri, solo ai passaggi
  che contano. I **dati** (quali progetti, repo, agenti) restano nei
  binding — aggiungere un progetto non tocca il body.
- Guardia di seeding `jiraPollSeeded: boolean` (mirror di
  `heartbeatSeeded`): non ri-aggiunta dopo cancellazione manuale.

## Definizione di fatto

1. Un progetto Jira si aggiunge, modifica e disattiva interamente dalla UI;
   `jira-map.json` sparisce dal punto di vista del codice (nessun percorso
   lo legge più dopo l'import one-shot).
2. Un repo inesistente, un branch sbagliato o un agente archiviato vengono
   rifiutati al salvataggio con un messaggio che dice quale campo è
   sbagliato e perché.
3. Una config esistente senza i nuovi campi si carica senza errori.
4. Il poll (`jira-poll` mission) legge i binding dal broker
   (`GET /jira-bindings`), non da un file; aggiungere un progetto non
   richiede di toccare la schedule.
5. `npm run typecheck` pulito (node + web) e `npm run test:focused` verde,
   con test nuovi su: validazione (ognuna delle 6 regole), migrazione da
   config priva del campo, migrazione one-shot da `jira-map.json`, guardia
   `/jira-bindings` (token valido/non valido, solo `enabled: true`
   restituiti).

## Fuori scope

- Editing di `assigneeFilter`/`statusFilter` in UI (restano dato di config
  ma sola lettura, sezione C).
- `conventions`/`commentTemplate`/`jiraWrites` come campi strutturati:
  restano prosa fissa nel body della mission (sezione D).
- Enumerazione/ricerca sui progetti Jira del sito Atlassian (~50, con
  archiviati `zzz`): la sezione registra solo i binding configurati, non è
  un browser del sito Jira.
- Cancellazione automatica di `jira-map.json` dopo l'import.

## Note di lavoro

- Repo di terzi, non di proprietà: lavoro su `feature/jira-project-mapping`
  (già creato).
- Mai il trailer `Co-Authored-By` nei commit.
- App è un dev build lanciato da shell (`npm run dev`): mai scrivere a mano
  `config.json` mentre gira, sempre via IPC (`updateConfig`).
