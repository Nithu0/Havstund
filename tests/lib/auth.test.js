// describe/it/expect/vi er globale (vitest.config.js -> globals: true)
const {
  requireRole, signToken, userFromToken, hashPassword, verifyPassword,
} = require('../../lib/auth');

function fakeRes() {
  return {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
}

describe('requireRole', () => {
  it('401 når ingen req.user', () => {
    const mw = requireRole('admin');
    const res = fakeRes();
    const next = vi.fn();
    mw({}, res, next);
    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('403 når feil rolle', () => {
    const mw = requireRole('admin');
    const res = fakeRes();
    const next = vi.fn();
    mw({ user: { rolle: 'kunde' } }, res, next);
    expect(res.statusCode).toBe(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('kaller next() når rollen matcher', () => {
    const mw = requireRole('admin');
    const res = fakeRes();
    const next = vi.fn();
    mw({ user: { rolle: 'admin' } }, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBeNull();
  });
});

describe('signToken / userFromToken', () => {
  it('roundtrip bevarer id og rolle', () => {
    const token = signToken({ id: 42, rolle: 'ansatt', navn: 'Ola' });
    const u = userFromToken(token);
    expect(u).toBeTruthy();
    expect(u.id).toBe(42);
    expect(u.rolle).toBe('ansatt');
  });

  it('returnerer null på ugyldig token', () => {
    expect(userFromToken('tull')).toBeNull();
  });
});

describe('hashPassword / verifyPassword', () => {
  it('verifiserer riktig passord til true og feil til false', async () => {
    const hash = await hashPassword('hemmelig123');
    expect(await verifyPassword('hemmelig123', hash)).toBe(true);
    expect(await verifyPassword('feilpassord', hash)).toBe(false);
  });
});
