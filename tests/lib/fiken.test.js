// describe/it/expect/vi er globale (vitest.config.js -> globals: true)
// Tester lib/fiken.js Fase 4:
//  - mapPost: SALG (cash_sale) inneholder IKKE `paid`, men har spec-feltene
//    (date, kind, currency, lines, totalPaid, paymentAccount, paymentDate) +
//    valgfri saleNumber. KJOP (cash_purchase) beholder `paid`.
//  - filtrerAktive: fjerner deleted:true.
//  - finnAktivtSalg: filtrerer bort slettede salg (mock-fetch), gated paa konfig.
//  - reverserSalg / finnAktivtSalg er inerte (simulert) uten Fiken-konfig.
const fiken = require('../../lib/fiken');

describe('lib/fiken mapPost — spec-conformance (Fase 4)', () => {
  it('SALG (inntekt) sender IKKE `paid`, men spec-feltene', () => {
    const p = fiken.mapPost({
      type: 'inntekt', dato: '2026-07-09', brutto_ore: 130000,
      netto_ore: 104000, mva_ore: 26000, mva_sats: 25, beskrivelse: 'x', konto: 3000,
      saleNumber: 'HAV-booking-42-v1',
    });
    expect(p.kind).toBe('cash_sale');
    expect('paid' in p).toBe(false);              // ikke en saleRequest-property
    expect(p.currency).toBe('NOK');
    expect(p.date).toBe('2026-07-09');
    expect(p.paymentDate).toBe('2026-07-09');
    expect(typeof p.paymentAccount).toBe('string');
    expect(p.totalPaid).toBe(130000);
    expect(Array.isArray(p.lines)).toBe(true);
    expect(p.saleNumber).toBe('HAV-booking-42-v1');
  });

  it('SALG uten saleNumber utelater feltet (ikke undefined/null i payload)', () => {
    const p = fiken.mapPost({ type: 'inntekt', dato: '2026-07-09', brutto_ore: 100 });
    expect('saleNumber' in p).toBe(false);
  });

  it('KJOP (utgift) beholder `paid: true`', () => {
    const p = fiken.mapPost({ type: 'utgift', dato: '2026-07-09', netto_ore: 100, mva_ore: 25 });
    expect(p.kind).toBe('cash_purchase');
    expect(p.paid).toBe(true);
  });
});

describe('lib/fiken filtrerAktive', () => {
  it('fjerner deleted:true og beholder deleted:false', () => {
    const inn = [
      { saleId: 1, saleNumber: 'HAV-booking-42-v1', deleted: true },
      { saleId: 2, saleNumber: 'HAV-booking-42-v2', deleted: false },
    ];
    const ut = fiken.filtrerAktive(inn);
    expect(ut).toHaveLength(1);
    expect(ut[0].saleId).toBe(2);
  });

  it('taaler ikke-array input', () => {
    expect(fiken.filtrerAktive(null)).toEqual([]);
    expect(fiken.filtrerAktive(undefined)).toEqual([]);
  });
});

describe('lib/fiken gated (ukonfigurert = inert)', () => {
  const orig = { t: process.env.FIKEN_API_TOKEN, s: process.env.FIKEN_COMPANY_SLUG };
  afterEach(() => {
    if (orig.t == null) delete process.env.FIKEN_API_TOKEN; else process.env.FIKEN_API_TOKEN = orig.t;
    if (orig.s == null) delete process.env.FIKEN_COMPANY_SLUG; else process.env.FIKEN_COMPANY_SLUG = orig.s;
  });

  it('reverserSalg/finnAktivtSalg returnerer {simulert:true} uten konfig', async () => {
    delete process.env.FIKEN_API_TOKEN;
    delete process.env.FIKEN_COMPANY_SLUG;
    expect(fiken.isConfigured()).toBe(false);
    const a = await fiken.reverserSalg('sale-1', 'test');
    const b = await fiken.finnAktivtSalg('HAV-booking-42-v1');
    expect(a.simulert).toBe(true);
    expect(b.simulert).toBe(true);
  });
});

describe('lib/fiken finnAktivtSalg (konfigurert, mock-fetch)', () => {
  const orig = { t: process.env.FIKEN_API_TOKEN, s: process.env.FIKEN_COMPANY_SLUG, f: global.fetch };
  beforeEach(() => {
    process.env.FIKEN_API_TOKEN = 'test-token';
    process.env.FIKEN_COMPANY_SLUG = 'havstund-test';
  });
  afterEach(() => {
    if (orig.t == null) delete process.env.FIKEN_API_TOKEN; else process.env.FIKEN_API_TOKEN = orig.t;
    if (orig.s == null) delete process.env.FIKEN_COMPANY_SLUG; else process.env.FIKEN_COMPANY_SLUG = orig.s;
    global.fetch = orig.f;
  });

  function stubFetch(body) {
    global.fetch = async () => ({
      ok: true, status: 200,
      headers: { get: () => null },
      json: async () => body,
      text: async () => JSON.stringify(body),
    });
  }

  it('returnerer kun det aktive salget naar svaret har baade slettet -v1 og aktiv -v2', async () => {
    stubFetch([
      { saleId: 100, saleNumber: 'HAV-booking-42-v1', deleted: true },
      { saleId: 200, saleNumber: 'HAV-booking-42-v2', deleted: false },
    ]);
    const r = await fiken.finnAktivtSalg('HAV-booking-42-v2');
    expect(r.ok).toBe(true);
    expect(r.finnes).toBe(true);
    expect(r.saleId).toBe('200');
  });

  it('finnes:false naar alle treff er slettet', async () => {
    stubFetch([{ saleId: 100, saleNumber: 'HAV-booking-42-v1', deleted: true }]);
    const r = await fiken.finnAktivtSalg('HAV-booking-42-v1');
    expect(r.ok).toBe(true);
    expect(r.finnes).toBe(false);
    expect(r.saleId).toBeNull();
  });

  it('feil naar >1 aktivt salg (datainkonsistens)', async () => {
    stubFetch([
      { saleId: 1, deleted: false },
      { saleId: 2, deleted: false },
    ]);
    const r = await fiken.finnAktivtSalg('HAV-booking-42-v2');
    expect(r.ok).toBe(false);
    expect(r.antall).toBe(2);
  });
});
