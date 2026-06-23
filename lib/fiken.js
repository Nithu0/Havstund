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
function mapPost(post) {
  const p = post || {};
  const felles = {
    date: isoDato(p.dato),
    currency: 'NOK',
    paid: true,
    paymentAccount: betalingsKonto(),
    paymentDate: isoDato(p.dato),
    lines: [lagLinje(p)],
  };
  if (p.type === 'inntekt') {
    return Object.assign({ kind: 'cash_sale', totalPaid: Number(p.brutto_ore) || 0 }, felles);
  }
  return Object.assign({ kind: 'cash_purchase' }, felles);
}

// Felles POST-hjelper. Kaster ALDRI — fanger alt og returnerer { ok, ... }.
async function fikenPost(sti, payload) {
  if (typeof fetch !== 'function') {
    return { ok: false, error: 'fetch ikke tilgjengelig (krever Node 18+)' };
  }
  try {
    const res = await fetch(BASE + sti, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + process.env.FIKEN_API_TOKEN,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      let detalj = '';
      try { detalj = await res.text(); } catch (_) { /* ignorer */ }
      return { ok: false, error: 'Fiken HTTP ' + res.status + (detalj ? ': ' + detalj.slice(0, 500) : '') };
    }

    // Suksess (2xx). Fiken returnerer 201 + Location-header med ny ressurs-URL;
    // ID-en er siste path-segment.
    let fikenId;
    const loc = res.headers.get('location') || res.headers.get('Location');
    if (loc) {
      const deler = loc.split('/').filter(Boolean);
      fikenId = deler[deler.length - 1];
    }
    return { ok: true, fikenId };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}

// Sender et SALG (inntekt) til Fiken -> POST /companies/{slug}/sales
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

module.exports = { isConfigured, mapPost, sendSalg, sendKjop };
