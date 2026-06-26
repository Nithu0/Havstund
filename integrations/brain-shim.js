/* Havstund — brain-shim: ENESTE koblingspunkt mellom nettsiden og AI-brainen.
 *
 * Av/på: returnerer UMIDDELBART hvis BRAIN_ENABLED !== 'true'. Da finnes ingen
 * rute, ingen UI-eksponering, ingen deps i nettsidens hot path — null påvirkning
 * (rutebordet blir byte-identisk med et bygg uten denne modulen).
 *
 * Når påslått: registrerer tynne proxy-ruter /api/brain/ask + /api/brain/confirm
 * bak TO uavhengige lag:
 *   1. requireRole('admin')          — må være admin
 *   2. req.user.ai_agent_enabled      — utvalgt admin (egen kolonne)
 * Proxyen videresender til brain-prosessen (BRAIN_URL) med operatør-token. Ekte
 * Claude/SDK kjører ALDRI i nettsidens prosess.
 *
 * Wiring (server.js): require('./integrations/brain-shim')(app);  — én linje.
 */
const { requireRole } = require('../lib/auth');
const db = require('../db');

// Krav: admin OG utvalgt (ai_agent_enabled). To uavhengige lag. Flagget ligger
// IKKE i JWT-tokenet (det skal kunne revokeres uten å invalidere tokenet), så
// vi slår det opp ferskt fra DB per request.
async function requireSelectedAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Ikke innlogget' });
  if (req.user.rolle !== 'admin') return res.status(403).json({ error: 'Ingen tilgang' });
  try {
    if (!db.isConfigured()) {
      return res.status(503).json({ error: 'Database ikke tilgjengelig' });
    }
    const rad = await db.one('SELECT ai_agent_enabled FROM users WHERE id = $1', [req.user.id]);
    if (!rad || rad.ai_agent_enabled !== true) {
      return res.status(403).json({ error: 'AI-agent er ikke aktivert for din bruker' });
    }
    next();
  } catch (e) {
    console.error('brain-shim utvalgt-sjekk feilet:', e.message);
    res.status(500).json({ error: 'Intern feil' });
  }
}

// Videresend en JSON-request til brain-prosessen. Bruker global fetch (Node 18+).
async function proxyTilBrain(stien, body) {
  const base = (process.env.BRAIN_URL || '').replace(/\/+$/, '');
  const token = process.env.BRAIN_OPERATOR_TOKEN || '';
  const r = await fetch(`${base}${stien}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body || {}),
  });
  const tekst = await r.text();
  let data = null;
  if (tekst) {
    try {
      data = JSON.parse(tekst);
    } catch {
      data = { error: 'Ugyldig svar fra AI-agent' };
    }
  }
  return { status: r.status, data };
}

module.exports = function brainShim(app) {
  // AV/PÅ-PORTEN: ingenting registreres når flagget ikke er 'true'.
  if (process.env.BRAIN_ENABLED !== 'true') return;

  // requireRole('admin') OG requireSelectedAdmin — to uavhengige lag (belte +
  // bukseseler). requireRole gir 401 for anon / 403 for ikke-admin; det andre
  // laget gir 403 for admin uten flagget.
  const gate = [requireRole('admin'), requireSelectedAdmin];

  app.post('/api/brain/ask', ...gate, async (req, res) => {
    if (!process.env.BRAIN_URL) {
      return res.status(503).json({ error: 'AI-agent er ikke konfigurert (BRAIN_URL mangler)' });
    }
    try {
      const { status, data } = await proxyTilBrain('/agent/ask', {
        text: req.body && req.body.text,
        conversationId: req.body && req.body.conversationId,
        transcript: req.body && req.body.transcript,
      });
      res.status(status).json(data);
    } catch (e) {
      console.error('brain-shim /ask feilet:', e.message);
      res.status(502).json({ error: 'Kunne ikke nå AI-agenten' });
    }
  });

  app.post('/api/brain/confirm', ...gate, async (req, res) => {
    if (!process.env.BRAIN_URL) {
      return res.status(503).json({ error: 'AI-agent er ikke konfigurert (BRAIN_URL mangler)' });
    }
    try {
      const { status, data } = await proxyTilBrain('/agent/confirm', {
        toolUseId: req.body && req.body.toolUseId,
        confirmToken: req.body && req.body.confirmToken,
        conversationId: req.body && req.body.conversationId,
        transcript: req.body && req.body.transcript,
      });
      res.status(status).json(data);
    } catch (e) {
      console.error('brain-shim /confirm feilet:', e.message);
      res.status(502).json({ error: 'Kunne ikke nå AI-agenten' });
    }
  });

  console.log('  ✓ brain-shim aktiv  /api/brain/ask + /confirm (BRAIN_ENABLED=true)');
};
