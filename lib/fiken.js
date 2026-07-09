/* Havstund — Fiken-integrasjon (regnskap).
   Sender salg (inntekt) og kjøp (utgift) til Fiken sitt API v2.
   Base: https://api.fiken.no/api/v2

   MILJØ-STYRT: modulen gjør INGENTING hvis den ikke er konfigurert.
   Da returnerer send-funksjonene { ok:false, simulert:true } i stedet for å kaste.
   Konfigureres via miljøvariabler på Railway (ingen hemmeligheter i koden):
     FIKEN_API_TOKEN        -> personlig API-token fra Fiken (Rediger konto -> API)
     FIKEN_COMPANY_SLUG     -> firma-slug (finnes i Fiken-URLen, f.eks "havstund-as")
     FIKEN_PAYMENT_ACCOUNT  -> valgfri betalingskonto, default "1920:10001" (bank)

   Felt/struktur er basert på Fiken sin offisielle OpenAPI-spec (api.fiken.no/api/v2):
   - Beløp i ØRE (heltall). regnskap_poster har allerede øre -> sendes uvendret.
   - Salgs- OG kjøpslinjer (orderLine) bruker feltet `account` for kontonummer.
   - vatType per linje: HIGH=25%, MEDIUM=15%, LOW=12%, NONE=ingen.
   - Dato i format YYYY-MM-DD. kind: 'cash_sale' / 'cash_purchase' (kontant/betalt). */

const BASE = 'https://api.fiken.no/api/v2';

// True bare hvis BÅDE token og firma-slug er satt.
function isConfigured() {
  return !!(process.env.FIKEN_API_TOKEN && process.env.FIKEN_COMPANY_SLUG);
}

// Betalingskonto (Fiken-format "kontonr:underkonto"). Kan overstyres via env.
function betalingsKonto() {
  return process.env.FIKEN_PAYMENT_ACCOUNT || '1920:10001';
}

// Vår mva-sats (0/12/15/25) -> Fiken sin vatType-enum.
function vatTypeFraSats(sats) {
  const n = Number(sats) || 0;
  if (n === 25) return 'HIGH';
  if (n === 15) return 'MEDIUM';
  if (n === 12) return 'LOW';
  return 'NONE';
}

// Gjør dato (Date eller string) om til YYYY-MM-DD.
function isoDato(d) {
  if (!d) return null;
  if (typeof d === 'string') return d.slice(0, 10);
  try { return new Date(d).toISOString().slice(0, 10); } catch (_) { return null; }
}

// Bygger én Fiken orderLine fra en regnskap_poster-rad (felles for salg/kjøp).
function lagLinje(post) {
  return {
    description: String(post.beskrivelse || '').slice(0, 200), // Fiken: maks 200 tegn
    netPrice: Number(post.netto_ore) || 0,                     // netto i øre
    vat: Number(post.mva_ore) || 0,                            // mva-beløp i øre
    vatType: vatTypeFraSats(post.mva_sats),                    // HIGH/MEDIUM/LOW/NONE
    account: post.konto != null ? String(post.konto) : undefined, // f.eks "3000"
  };
}

// Bygger full payload (brukes også til logging/feilsøk). type styrer kind.
//
// Fase 4 spec-conformance: `paid` er IKKE en property paa Fiken `saleRequest`
// (required: date, kind, lines, currency; ovrige: saleNumber, totalPaid,
// paymentAccount, paymentDate, ... — men INGEN `paid`). Et betalt kontantsalg
// uttrykkes via paymentDate + paymentAccount + totalPaid, ikke via et `paid`-flagg.
// `paid` beholdes KUN paa kjop (purchaseRequest — antatt aa ha feltet, IKKE
// verifisert mot spec enda; se docs/proposals/2026-07-09_fase4-...).
function mapPost(post) {
  const p = post || {};
  const dato = isoDato(p.dato);
  const linjer = [lagLinje(p)];
  if (p.type === 'inntekt') {
    const salg = {
      date: dato,
      kind: 'cash_sale',
      currency: 'NOK',
      totalPaid: Number(p.brutto_ore) || 0,
      paymentAccount: betalingsKonto(),
      paymentDate: dato,
      lines: linjer,
    };
    // Versjonert idempotens-noekkel naar den finnes (HAV-booking-<id>-v<n>).
    if (p.saleNumber) salg.saleNumber = String(p.saleNumber);
    return salg;
  }
  // Kjop -> purchaseRequest. `paid` beholdt (kontantkjop markeres betalt).
  return {
    date: dato,
    kind: 'cash_purchase',
    currency: 'NOK',
    paid: true,
    paymentAccount: betalingsKonto(),
    paymentDate: dato,
    lines: linjer,
  };
}

// Felles request-hjelper. Kaster ALDRI — fanger alt og returnerer { ok, ... }.
// Brukes av POST (salg/kjop), PATCH (reversering) og GET (idempotens-oppslag).
async function fikenRequest(metode, sti, payload) {
  if (typeof fetch !== 'function') {
    return { ok: false, error: 'fetch ikke tilgjengelig (krever Node 18+)' };
  }
  try {
    const opts = {
      method: metode,
      headers: {
        'Authorization': 'Bearer ' + process.env.FIKEN_API_TOKEN,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
    };
    if (payload !== undefined && payload !== null) opts.body = JSON.stringify(payload);
    const res = await fetch(BASE + sti, opts);

    if (!res.ok) {
      let detalj = '';
      try { detalj = await res.text(); } catch (_) { /* ignorer */ }
      return { ok: false, status: res.status, error: 'Fiken HTTP ' + res.status + (detalj ? ': ' + detalj.slice(0, 500) : '') };
    }

    // Suksess (2xx). POST/PATCH returnerer ofte 201/200 + Location-header med
    // ny ressurs-URL; ID-en er siste path-segment. GET har en JSON-kropp.
    let fikenId;
    const loc = res.headers.get('location') || res.headers.get('Location');
    if (loc) {
      const deler = loc.split('/').filter(Boolean);
      fikenId = deler[deler.length - 1];
    }
    let data;
    try { data = await res.json(); } catch (_) { data = undefined; }
    return { ok: true, status: res.status, fikenId, data };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}

// Bakoverkompat: fikenPost bevart som tynn POST-wrapper.
function fikenPost(sti, payload) {
  return fikenRequest('POST', sti, payload);
}

// Ren hjelper (uten nett) — filtrerer bort slettede salg. Fiken sitt
// GET /sales HAR IKKE et `deleted`-query-filter, saa et oppslag paa en gjenbrukt
// `saleNumber` returnerer OGSAA slettede salg. Klienten MAA selv lese `deleted`
// og beholde kun deleted === false. Eksportert for enhetstesting.
function filtrerAktive(salg) {
  return (Array.isArray(salg) ? salg : []).filter((s) => s && s.deleted === false);
}

// Henter saleId fra et Fiken sale-objekt (spec: `saleId`; noen svar bruker `id`).
function salgId(s) {
  return s && (s.saleId != null ? s.saleId : s.id) != null
    ? String(s.saleId != null ? s.saleId : s.id)
    : null;
}

// Sender et SALG (inntekt) til Fiken -> POST /companies/{slug}/sales
// post.saleNumber (valgfri) baerer den versjonerte idempotens-noekkelen videre.
async function sendSalg(post) {
  if (!isConfigured()) return { ok: false, simulert: true, grunn: 'Fiken ikke konfigurert' };
  const payload = mapPost(Object.assign({}, post, { type: 'inntekt' }));
  return fikenPost('/companies/' + process.env.FIKEN_COMPANY_SLUG + '/sales', payload);
}

// Sender et KJØP (utgift) til Fiken -> POST /companies/{slug}/purchases
async function sendKjop(post) {
  if (!isConfigured()) return { ok: false, simulert: true, grunn: 'Fiken ikke konfigurert' };
  const payload = mapPost(Object.assign({}, post, { type: 'utgift' }));
  return fikenPost('/companies/' + process.env.FIKEN_COMPANY_SLUG + '/purchases', payload);
}

// Reverserer et salg -> PATCH /companies/{slug}/sales/{saleId}/delete?description=
// Fiken sletter IKKE raden, men lager en reverstransaksjon og setter deleted:true.
// KREVER en persistert saleId. GATED: inert (simulert) uten Fiken-konfig.
async function reverserSalg(saleId, beskrivelse) {
  if (!isConfigured()) return { ok: false, simulert: true, grunn: 'Fiken ikke konfigurert' };
  if (!saleId) return { ok: false, error: 'saleId mangler — kan ikke reversere' };
  const q = beskrivelse ? '?description=' + encodeURIComponent(String(beskrivelse).slice(0, 200)) : '';
  return fikenRequest(
    'PATCH',
    '/companies/' + process.env.FIKEN_COMPANY_SLUG + '/sales/' + encodeURIComponent(saleId) + '/delete' + q
  );
}

// Idempotens-oppslag paa en (versjonert) saleNumber. Returnerer det ENESTE
// aktive salget (deleted === false) for noekkelen.
//   -> { ok, finnes:false, saleId:null }        naar ingen aktiv rad
//   -> { ok, finnes:true,  saleId }             naar noeyaktig én aktiv rad
//   -> { ok:false, error, antall }              naar >1 aktiv rad (datainkonsistens)
// GATED: inert (simulert) uten Fiken-konfig.
async function finnAktivtSalg(saleNumber) {
  if (!isConfigured()) return { ok: false, simulert: true, grunn: 'Fiken ikke konfigurert' };
  const r = await fikenRequest(
    'GET',
    '/companies/' + process.env.FIKEN_COMPANY_SLUG + '/sales?saleNumber=' + encodeURIComponent(saleNumber)
  );
  if (!r.ok) return r;
  const aktive = filtrerAktive(r.data);
  if (aktive.length === 0) return { ok: true, finnes: false, saleId: null };
  if (aktive.length === 1) return { ok: true, finnes: true, saleId: salgId(aktive[0]) };
  return { ok: false, error: 'datainkonsistens: flere aktive salg for samme saleNumber', antall: aktive.length };
}

module.exports = {
  isConfigured,
  mapPost,
  sendSalg,
  sendKjop,
  reverserSalg,
  finnAktivtSalg,
  filtrerAktive,
};
