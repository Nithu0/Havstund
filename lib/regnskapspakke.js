/* Havstund — regnskapspakke-generator (Fase 3a: REN KJERNE).

   byggRegnskapspakke() tar ferdig-hentede rader inn og returnerer et VALIDERT,
   PII-fritt pakke-objekt (eller KASTER hvis en invariant brytes). Ingen I/O,
   ingen sideeffekter, ingen DB-tilgang, ingen nettverk. Ruta, ZIP-strømmen,
   HMAC-signaturen og admin-gaten bygges i en SENERE fase — IKKE her.

   Kjerneprinsipper (bindende, fra bolge99 §7):
   - Pakken er PII-FRI. Ingen kunde-persondata (navn, epost, tlf, adresse,
     melding, kontakt) noe sted. Bilagslaget ser kun bilag_ref + beløp.
   - Alle beløp er HELTALL i ØRE. Aldri flyttall, aldri negativt i output.
   - handling ∈ {salg, kjop, kreditering}. Fortegn er ALDRI semantikk — en
     refusjon (lagret negativt i regnskap_poster i dag) bæres som handling
     'kreditering' med POSITIVE beløp.
   - Generatoren NEKTER (kaster) å produsere pakken hvis en invariant brytes.

   Determinisme: funksjonen kaller ALDRI Date.now()/new Date(). Tidsstempelet
   `generert` tas inn som parameter (ISO-streng). Produksjonskalleren (ruta i
   en senere fase) setter `generert: new Date().toISOString()`; tester sender en
   fast streng slik at output blir bit-for-bit deterministisk og testbart. */

'use strict';

// Gjenbruk av øre-splitt fra regnskaps-hjelperne. mvaSplitt(brutto_ore, sats)
// validerer satsen (GYLDIGE_SATSER) og at brutto >= 0, og gir den kanoniske
// netto/mva-splitten. Vi mater den ALLTID med absoluttverdi av brutto.
const { mvaSplitt, GYLDIGE_SATSER } = require('./regnskap');

const SCHEMA_VERSION = '1.0';

// Vår mva-sats (0/12/15/25) -> Fiken sin vatType-enum.
// DUPLISERT bevisst fra lib/fiken.js:vatTypeFraSats — den funksjonen er ikke
// eksportert, og Fase 3a-regelen forbyr å røre lib/fiken.js. Kartet er lite og
// stabilt; hold de to i sync hvis Fiken utvider enumet.
function vatTypeFraSats(sats) {
  const n = Number(sats) || 0;
  if (n === 25) return 'HIGH';
  if (n === 15) return 'MEDIUM';
  if (n === 12) return 'LOW';
  return 'NONE';
}

// Felt som ALDRI skal leses fra en input-rad inn i pakken (kunde-PII-kilder).
// Whitelist-konstruksjonen under garanterer allerede at de utelates — dette er
// kun dokumentasjon + brukes i en defensiv nøkkel-skann.
const PII_NOKLER = ['kontakt', 'navn', 'epost', 'email', 'e-post', 'tlf', 'telefon', 'melding', 'adresse'];

// Kaster med tydelig, kontekstrik melding.
function kast(melding) {
  throw new Error('byggRegnskapspakke: ' + melding);
}

// Krever at et beløp er et ikke-negativt heltall (øre). Float/negativt avvises.
function kreverOreHeltall(verdi, felt, ref) {
  if (!Number.isInteger(verdi)) {
    kast(`${felt} må være et heltall i øre (fikk ${verdi}) i ${ref}`);
  }
  if (verdi < 0) {
    kast(`${felt} kan ikke være negativt i output (fikk ${verdi}) i ${ref}`);
  }
}

// Deterministisk bilag_ref fra kilde + id. 'booking' foretrekker booking_id.
function bilagRef(post) {
  const kilde = post.kilde || 'manuell';
  if (kilde === 'booking' && post.booking_id != null) {
    return `HAV-booking-${post.booking_id}`;
  }
  return `HAV-${kilde}-${post.id}`;
}

// Mapper én regnskap_poster-rad til ett bilag. WHITELIST: vi leser KUN
// forretningsfeltene under — kunde-PII (kontakt, epost, ...) kopieres aldri.
function byggBilag(post) {
  if (!post || typeof post !== 'object') kast('poster-rad må være et objekt');
  const ref = bilagRef(post);

  // --- Beløp: input kan være negativt (refusjon). Absoluttverdi + fortegn->handling.
  const bruttoInn = post.brutto_ore;
  const nettoInn = post.netto_ore;
  const mvaInn = post.mva_ore;

  // Input-heltallssjekk FØR abs (float-input avvises tidlig).
  if (!Number.isInteger(bruttoInn)) kast(`brutto_ore må være heltall i øre (fikk ${bruttoInn}) i ${ref}`);
  if (nettoInn != null && !Number.isInteger(nettoInn)) kast(`netto_ore må være heltall i øre (fikk ${nettoInn}) i ${ref}`);
  if (mvaInn != null && !Number.isInteger(mvaInn)) kast(`mva_ore må være heltall i øre (fikk ${mvaInn}) i ${ref}`);

  if (bruttoInn === 0) kast(`bilag med brutto 0 er ugyldig i ${ref}`);

  const absBrutto = Math.abs(bruttoInn);
  const sats = post.mva_sats == null ? 0 : post.mva_sats;

  // Utled kanonisk netto/mva fra absoluttverdien via mvaSplitt (validerer også
  // satsen mot GYLDIGE_SATSER og kaster ved ugyldig sats).
  const splitt = mvaSplitt(absBrutto, sats);

  // Kryss-sjekk mot lagret splitt (etter abs). Fanger "brutto != netto+mva":
  // en rad {brutto:50000, netto:30000, mva:10000} gir derived netto 40000 !=
  // abs(input) 30000 -> kast. (Invariant 1.)
  if (nettoInn != null && mvaInn != null) {
    const absNetto = Math.abs(nettoInn);
    const absMva = Math.abs(mvaInn);
    if (absNetto + absMva !== absBrutto) {
      kast(`netto+mva (${absNetto}+${absMva}) != brutto (${absBrutto}) i ${ref}`);
    }
    if (absNetto !== splitt.netto_ore || absMva !== splitt.mva_ore) {
      kast(`lagret mva-splitt (netto ${absNetto}/mva ${absMva}) matcher ikke sats ${sats} (forventet netto ${splitt.netto_ore}/mva ${splitt.mva_ore}) i ${ref}`);
    }
  }

  // --- handling + Fiken kind fra type + fortegn.
  let handling;
  let kind;
  const type = post.type;
  if (type === 'inntekt') {
    if (bruttoInn > 0) {
      handling = 'salg';
      kind = 'cash_sale';
    } else {
      handling = 'kreditering';
      kind = 'cash_sale'; // kreditnota mot samme salgstype; Fiken-kind avklares i Fase 4
    }
  } else if (type === 'utgift') {
    handling = 'kjop';
    kind = 'cash_purchase';
  } else {
    kast(`ukjent type "${type}" (forventet inntekt|utgift) i ${ref}`);
  }

  const bilag = {
    bilag_ref: ref,
    kilde: post.kilde || 'manuell',
    post_id: post.id,
    booking_id: post.booking_id != null ? post.booking_id : null,
    dato: typeof post.dato === 'string' ? post.dato.slice(0, 10) : null,
    beskrivelse: post.beskrivelse != null ? String(post.beskrivelse) : '',
    handling,
    kind,
    konto: post.konto != null ? Number(post.konto) : null,
    mva_sats: splitt.mva_sats,
    vatType: vatTypeFraSats(sats),
    netto_ore: splitt.netto_ore,
    mva_ore: splitt.mva_ore,
    brutto_ore: splitt.brutto_ore,
  };

  // Kreditering trenger en versjonert bilag_ref (Fiken kollisjon: en kreditnota
  // deler kildens id). Fase 4 eier fikenId/versjon-state og løser kollisjonen —
  // her flagger vi kun behovet, vi bygger IKKE versjonstate.
  if (handling === 'kreditering') {
    bilag.krever_versjonering = true;
  }

  // Output-beløp MÅ være ikke-negative heltall (invariant 3).
  kreverOreHeltall(bilag.netto_ore, 'netto_ore', ref);
  kreverOreHeltall(bilag.mva_ore, 'mva_ore', ref);
  kreverOreHeltall(bilag.brutto_ore, 'brutto_ore', ref);

  return bilag;
}

// Statuser som teller i lønnsgrunnlaget. En time SKAL være godkjent (eller
// låst = godkjent + periode-låst) før den kan bli til lønn. utkast/sendt_inn/
// avvist er IKKE lønnsklare og ekskluderes.
const LONNSKLARE_STATUS = new Set(['godkjent', 'laast']);

// Blocker 3 (bølge 98): avgjør om en timeføring skal telle i lønnsgrunnlaget.
// PENGESTI-INVARIANT: en ugodkjent time skal ALDRI nå Fiken-lønn.
//
// Bakoverkompat-VALG (a): filtreringen skjer HER i generatoren, på hver rad som
// bærer status-feltet. Grunn: generatoren er den ene RENE flaskehalsen alle
// lønns-kall går gjennom — å håndheve invarianten her (framfor å stole på at
// hver DB-kaller husker å legge til en WHERE-klausul) gir én, testbar sperre.
//   * Rad MED status: telles kun hvis status ∈ {godkjent, laast}.
//   * Rad UTEN status-felt (undefined/null): behandles som 'godkjent'
//     (bakoverkomp). Eldre kall — og DB-rader fra før status-kolonnen — mangler
//     feltet; DB-default er uansett 'godkjent' (se migrate()), så dette speiler
//     lagringslaget og hindrer at eksisterende lønn forsvinner. Et TOMT/ukjent
//     status-felt ('' eller 'utkast'...) er derimot IKKE godkjent og ekskluderes.
function erLonnsklar(t) {
  const s = t.status;
  if (s == null) return true; // felt mangler -> bakoverkomp (behandles som godkjent)
  return LONNSKLARE_STATUS.has(s);
}

// Aggreger timeforinger per ansatt -> timegrunnlag. PII-VALG: vi nøkler på
// ansatt_id, IKKE navn/epost, så hele pakken forblir trygt PII-fri. Del 2
// (Fiken-lønn) slår opp navn fra ansatt_id ved behov.
function byggTimegrunnlag(timeforinger, ansatte) {
  const ansattById = new Map();
  for (const a of ansatte || []) {
    if (a && a.id != null) ansattById.set(a.id, a);
  }

  // Summer timer per ansatt_id (deterministisk innsettingsrekkefølge).
  const perAnsatt = new Map();
  for (const t of timeforinger || []) {
    if (!t || t.ansatt_id == null) kast('timeføring mangler ansatt_id');
    // PENGESTI-SPERRE: hopp over ikke-lønnsklare føringer (utkast/sendt_inn/
    // avvist). En ugodkjent time skal ALDRI ende i lønnsgrunnlaget.
    if (!erLonnsklar(t)) continue;
    const timer = Number(t.timer);
    if (!Number.isFinite(timer) || timer < 0) {
      kast(`ugyldig timer-verdi (${t.timer}) for ansatt ${t.ansatt_id}`);
    }
    perAnsatt.set(t.ansatt_id, (perAnsatt.get(t.ansatt_id) || 0) + timer);
  }

  const rader = [];
  for (const [ansatt_id, sumTimer] of perAnsatt) {
    const a = ansattById.get(ansatt_id);
    if (!a) kast(`ukjent ansatt_id ${ansatt_id} (ikke i ansatte-listen)`);
    const timelonn_ore = a.timelonn_ore;
    if (!Number.isInteger(timelonn_ore) || timelonn_ore < 0) {
      kast(`timelonn_ore må være ikke-negativt heltall for ansatt ${ansatt_id} (fikk ${timelonn_ore})`);
    }
    const konto = a.konto != null ? Number(a.konto) : 5000;
    // timer er NUMERIC(5,2) (kan være brøk, f.eks. 7.50). sum_ore rundes til
    // nærmeste øre — eneste tillatte avrunding, og resultatet er et heltall.
    const sum_ore = Math.round(sumTimer * timelonn_ore);
    kreverOreHeltall(sum_ore, 'sum_ore', `timegrunnlag ansatt ${ansatt_id}`);
    rader.push({
      ansatt_id,
      timer: sumTimer,
      timelonn_ore,
      konto,
      sum_ore,
    });
  }
  return rader;
}

// Kopier per-dag-summene fra dagsoppgjor uvendret (kun kontrollsum-felter,
// ingen PII). Beløp valideres som ikke-negative heltall.
function byggDagsoppgjor(dagsoppgjor) {
  const rader = [];
  for (const d of dagsoppgjor || []) {
    if (!d || d.dato == null) kast('dagsoppgjor-rad mangler dato');
    const dato = typeof d.dato === 'string' ? d.dato.slice(0, 10) : null;
    const brutto_ore = Number(d.brutto_ore) || 0;
    const mva_ore = Number(d.mva_ore) || 0;
    const antall_bilag = Number(d.antall_bilag) || 0;
    kreverOreHeltall(brutto_ore, 'brutto_ore', `dagsoppgjor ${dato}`);
    kreverOreHeltall(mva_ore, 'mva_ore', `dagsoppgjor ${dato}`);
    if (!Number.isInteger(antall_bilag) || antall_bilag < 0) {
      kast(`antall_bilag må være ikke-negativt heltall i dagsoppgjor ${dato}`);
    }
    rader.push({
      dato,
      brutto_ore,
      mva_ore,
      antall_bilag,
      lukket_tid: d.lukket_tid != null ? String(d.lukket_tid) : null,
    });
  }
  return rader;
}

// Enkel "YYYY-MM"-validering.
function kreverPeriode(periode) {
  if (typeof periode !== 'string' || !/^\d{4}-\d{2}$/.test(periode)) {
    kast(`periode må være "YYYY-MM" (fikk ${JSON.stringify(periode)})`);
  }
}

/**
 * Bygg en validert, PII-fri regnskapspakke fra ferdig-hentede rader.
 *
 * @param {object}   arg
 * @param {string}   arg.periode        "YYYY-MM".
 * @param {object[]} [arg.poster]       regnskap_poster-rader.
 * @param {object[]} [arg.dagsoppgjor]  dagsoppgjor-rader (kontrollsum per dag).
 * @param {object[]} [arg.timeforinger] timeforinger-rader.
 * @param {object[]} [arg.ansatte]      ansatte-rader (id -> timelonn/konto).
 * @param {string|null} [arg.generert]  ISO-tidsstempel satt av kalleren. Den
 *   RENE funksjonen kaller aldri new Date() selv (determinisme/testbarhet).
 * @returns {object} pakke-objekt (aldri PII, aldri negative/float beløp).
 * @throws  ved ethvert invariant-brudd.
 */
function byggRegnskapspakke(arg) {
  if (!arg || typeof arg !== 'object') kast('argument må være et objekt');
  const {
    periode,
    poster = [],
    dagsoppgjor = [],
    timeforinger = [],
    ansatte = [],
    generert = null,
  } = arg;

  kreverPeriode(periode);
  if (!Array.isArray(poster)) kast('poster må være en liste');
  if (generert != null && typeof generert !== 'string') kast('generert må være en ISO-streng eller null');

  // --- Bilag (whitelist-konstruksjon; kunde-PII kopieres aldri inn).
  const bilag = poster.map(byggBilag);

  // --- Kontrollsum over alle bilag (positive beløp, brutto gjennomstrømning).
  let sumBrutto = 0;
  let sumMva = 0;
  for (const b of bilag) {
    sumBrutto += b.brutto_ore;
    sumMva += b.mva_ore;
  }
  const kontrollsum = {
    brutto_ore: sumBrutto,
    mva_ore: sumMva,
    antall_bilag: bilag.length,
  };

  const dager = byggDagsoppgjor(dagsoppgjor);
  const timegrunnlag = byggTimegrunnlag(timeforinger, ansatte);

  // --- Invariant 2: dagsoppgjor-summen (hvis gitt) MÅ matche bilags-kontrollsum.
  // Merk: dette forutsetter at dagsoppgjor.brutto_ore lagres i SAMME konvensjon
  // som bilagslaget (absoluttverdi/brutto gjennomstrømning). Er den semantikken
  // ulik i produksjon, avdekker denne sjekken det ved å kaste (som ønsket).
  if (dager.length > 0) {
    const dagsSum = dager.reduce((s, d) => s + d.brutto_ore, 0);
    if (dagsSum !== kontrollsum.brutto_ore) {
      kast(`dagsoppgjor-sum (${dagsSum}) matcher ikke bilags-kontrollsum (${kontrollsum.brutto_ore})`);
    }
  }

  const pakke = {
    schema_version: SCHEMA_VERSION,
    periode,
    generert,
    bilag,
    dagsoppgjor: dager,
    timegrunnlag,
    kontrollsum,
  };

  // --- Invariant 5 (HARD): PII-fri. Defensiv skann av den serialiserte pakken
  // etter e-postmønster. En epost i output er ALDRI legitimt i en PII-fri pakke;
  // whitelist-konstruksjonen skal allerede ha holdt kontakt/epost ute, men denne
  // beltet-og-selene-sjekken fanger PII som måtte ha lekket via f.eks.
  // beskrivelse. beskrivelse SKAL være PII-fri oppstrøms.
  const serialisert = JSON.stringify(pakke);
  if (/[^\s"@]+@[^\s"@]+\.[^\s"@]+/.test(serialisert)) {
    kast('PII-lekkasje: pakken inneholder et e-postmønster (@) — nektet å produsere');
  }
  // Defensiv nøkkel-skann: ingen kjent PII-nøkkel skal finnes som feltnavn.
  for (const nokkel of PII_NOKLER) {
    if (new RegExp(`"${nokkel}"\\s*:`, 'i').test(serialisert)) {
      kast(`PII-lekkasje: pakken inneholder feltet "${nokkel}" — nektet å produsere`);
    }
  }

  return pakke;
}

module.exports = { byggRegnskapspakke, vatTypeFraSats, SCHEMA_VERSION, GYLDIGE_SATSER };
