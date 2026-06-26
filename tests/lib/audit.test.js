// describe/it/expect/vi er globale (vitest.config.js -> globals: true)
// MERK: vi.mock fanger ikke require() i denne oppsettet — vi muter
// db-singletonens metoder direkte i stedet.
const db = require('../../db');
const audit = require('../../lib/audit');

describe('lib/audit', () => {
  let lagretQuery, lagretIsConfigured;

  beforeEach(() => {
    lagretQuery = db.query;
    lagretIsConfigured = db.isConfigured;
  });
  afterEach(() => {
    db.query = lagretQuery;
    db.isConfigured = lagretIsConfigured;
  });

  it('writeAudit skriver INSERT med riktige felter når db er på', async () => {
    let kalt = null;
    db.isConfigured = () => true;
    db.query = (text, params) => { kalt = { text, params }; return Promise.resolve({ rows: [] }); };

    const res = await audit.writeAudit({ id: 7, navn: 'Kari' }, 'booking.refund', { id: 3, belop: 100 });

    expect(res).toMatchObject({ ok: true });
    expect(kalt.text).toContain('INSERT INTO audit_log');
    expect(kalt.params[0]).toBe(7);
    expect(kalt.params[1]).toBe('Kari');
    expect(kalt.params[2]).toBe('booking.refund');
    expect(JSON.parse(kalt.params[3])).toMatchObject({ id: 3, belop: 100 });
  });

  it('writeAudit kaster IKKE når db.query feiler (fire-and-forget)', async () => {
    db.isConfigured = () => true;
    db.query = () => Promise.reject(new Error('db nede'));

    // writeAudit skal svelge feilen og resolve (ikke reject) — et plain await
    // som ikke kaster er beviset.
    const res = await audit.writeAudit({ id: 1, navn: 'X' }, 'noe', {});
    expect(res).toMatchObject({ ok: false });
  });

  it('writeAudit kaster IKKE når db er av; returnerer ok:false', async () => {
    db.isConfigured = () => false;
    db.query = () => { throw new Error('skal ikke kalles'); };

    const res = await audit.writeAudit(null, 'system.handling', null);
    expect(res).toMatchObject({ ok: false });
  });

  it('writeAudit håndterer null actor uten kast', async () => {
    let kalt = null;
    db.isConfigured = () => true;
    db.query = (text, params) => { kalt = params; return Promise.resolve({ rows: [] }); };

    const res = await audit.writeAudit(null, 'system.start', { x: 1 });
    expect(res).toMatchObject({ ok: true });
    expect(kalt[0]).toBe(null);
    expect(kalt[1]).toBe(null);
  });
});
