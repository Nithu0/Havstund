// describe/it/expect er globale (vitest.config.js -> globals: true)
//
// hentAnsatt (lib/ansatt.js, bolge 98 blocker 1): middleware som setter
// req.ansatt fra ansatte.user_id = req.user.id. Ikke i bruk ennaa (/api/min/*
// bygges senere), men verifisert her slik at neste runde kan montere den trygt.
//
// Vi muterer db-singletonen (samme monster som regnskap-testene) og driver
// middlewaren direkte med en fake req/res.
const db = require('../../db');

const { hentAnsatt } = require('../../lib/ansatt');

function fakeRes() {
  return {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(obj) { this.body = obj; return this; },
  };
}

describe('hentAnsatt', () => {
  it('koblet ansatt-rad -> setter req.ansatt og kaller next()', async () => {
    db.isConfigured = () => true;
    db.one = async (_text, params) => {
      expect(params[0]).toBe(2); // slaar opp paa req.user.id
      return { id: 9, user_id: 2, navn: 'Ola', timelonn_ore: 20000 };
    };
    const req = { user: { id: 2, rolle: 'ansatt' } };
    const res = fakeRes();
    let nesteKalt = false;
    await hentAnsatt(req, res, () => { nesteKalt = true; });
    expect(nesteKalt).toBe(true);
    expect(res.statusCode).toBeNull();
    expect(req.ansatt).toEqual({ id: 9, user_id: 2, navn: 'Ola', timelonn_ore: 20000 });
  });

  it('ingen koblet rad -> 403, next() ikke kalt', async () => {
    db.isConfigured = () => true;
    db.one = async () => null;
    const req = { user: { id: 3, rolle: 'ansatt' } };
    const res = fakeRes();
    let nesteKalt = false;
    await hentAnsatt(req, res, () => { nesteKalt = true; });
    expect(nesteKalt).toBe(false);
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toMatch(/Ingen ansatt-profil/i);
    expect(req.ansatt).toBeUndefined();
  });

  it('ingen innlogget bruker -> 401', async () => {
    db.isConfigured = () => true;
    db.one = async () => { throw new Error('skal ikke kalles'); };
    const req = {};
    const res = fakeRes();
    let nesteKalt = false;
    await hentAnsatt(req, res, () => { nesteKalt = true; });
    expect(nesteKalt).toBe(false);
    expect(res.statusCode).toBe(401);
  });

  it('db ikke konfigurert -> 503', async () => {
    db.isConfigured = () => false;
    const req = { user: { id: 2 } };
    const res = fakeRes();
    let nesteKalt = false;
    await hentAnsatt(req, res, () => { nesteKalt = true; });
    expect(nesteKalt).toBe(false);
    expect(res.statusCode).toBe(503);
  });

  it('db-feil under oppslag -> 500', async () => {
    db.isConfigured = () => true;
    db.one = async () => { throw new Error('boom'); };
    const req = { user: { id: 2 } };
    const res = fakeRes();
    let nesteKalt = false;
    await hentAnsatt(req, res, () => { nesteKalt = true; });
    expect(nesteKalt).toBe(false);
    expect(res.statusCode).toBe(500);
  });
});
