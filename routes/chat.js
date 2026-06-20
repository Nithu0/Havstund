/* Havstund — live chat (/api/chat).
   POST /thread                 -> opprett (eller gjenbruk) tråd, svar {thread_id}
   POST /thread/:id/message     -> lagre kundemelding, evt. AI-svar, emit realtime
   GET  /threads                -> ansatt/admin: alle tråder nyeste først
   GET  /thread/:id/messages    -> meldinger i tråden
   Realtime-rom: 'thread:<id>'. Tåler manglende DB (503 vennlig). */
const express = require('express');
const db = require('../db');
const ai = require('../lib/ai');
const { requireRole } = require('../lib/auth');

const router = express.Router();

const CHAT_COOKIE = 'havstund_chat';

function utilgjengelig(res) {
  return res.status(503).json({ error: 'Chat er midlertidig utilgjengelig. Prøv igjen om litt.' });
}

// Send en melding inn i rommet til en tråd
function emitMelding(req, threadId, melding) {
  try {
    const io = req.app.get('io');
    if (io) io.to('thread:' + threadId).emit('melding', melding);
  } catch (e) {
    console.error('chat emit feilet:', e.message);
  }
}

// POST /thread — opprett ny tråd, eller gjenbruk via cookie hvis den fortsatt finnes
router.post('/thread', async (req, res) => {
  if (!db.isConfigured()) return utilgjengelig(res);

  const { navn, epost } = req.body || {};
  const brukerId = req.user ? req.user.id : null;

  try {
    // Gjenbruk eksisterende tråd hvis cookie peker på en gyldig, ikke-lukket tråd
    const cookieId = Number(req.cookies && req.cookies[CHAT_COOKIE]);
    if (Number.isInteger(cookieId) && cookieId > 0) {
      const eksisterende = await db.one(
        "SELECT id FROM chat_threads WHERE id = $1 AND status <> 'lukket'",
        [cookieId]
      );
      if (eksisterende) {
        // Oppdater navn/epost hvis kunden nå har oppgitt det
        if (navn || epost) {
          await db.query(
            'UPDATE chat_threads SET navn = COALESCE($1, navn), epost = COALESCE($2, epost) WHERE id = $3',
            [navn || null, epost || null, cookieId]
          );
        }
        return res.json({ thread_id: eksisterende.id });
      }
    }

    const traad = await db.one(
      `INSERT INTO chat_threads (navn, epost, bruker_id, status)
       VALUES ($1, $2, $3, 'apen')
       RETURNING id`,
      [navn || null, epost || null, brukerId]
    );

    res.cookie(CHAT_COOKIE, String(traad.id), {
      httpOnly: false, // frontend leser den ikke, men ufarlig — holdes lesbar for enkelhet
      sameSite: 'lax',
      maxAge: 7 * 24 * 3600 * 1000,
      secure: process.env.NODE_ENV === 'production',
    });

    res.status(201).json({ thread_id: traad.id });
  } catch (e) {
    console.error('chat POST /thread feilet:', e.message);
    res.status(500).json({ error: 'Kunne ikke starte chat' });
  }
});

// POST /thread/:id/message — kunde sender melding
router.post('/thread/:id/message', async (req, res) => {
  if (!db.isConfigured()) return utilgjengelig(res);

  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Ugyldig tråd-id' });

  const tekst = String((req.body && req.body.tekst) || '').trim();
  if (!tekst) return res.status(400).json({ error: 'Melding kan ikke være tom' });
  if (tekst.length > 4000) return res.status(400).json({ error: 'Meldingen er for lang' });

  try {
    const traad = await db.one('SELECT id, status FROM chat_threads WHERE id = $1', [id]);
    if (!traad) return res.status(404).json({ error: 'Tråd ikke funnet' });

    // Lagre kundens melding
    const kundeMelding = await db.one(
      `INSERT INTO chat_messages (thread_id, avsender, tekst)
       VALUES ($1, 'kunde', $2)
       RETURNING id, thread_id, avsender, tekst, opprettet`,
      [id, tekst]
    );
    await db.query('UPDATE chat_threads SET sist = now() WHERE id = $1', [id]);
    emitMelding(req, id, kundeMelding);

    // AI svarer kun når tråden fortsatt er i AI-modus ('apen')
    let aiSvar = null;
    if (traad.status === 'apen') {
      const resultat = ai.svar(tekst);
      aiSvar = await db.one(
        `INSERT INTO chat_messages (thread_id, avsender, tekst)
         VALUES ($1, 'ai', $2)
         RETURNING id, thread_id, avsender, tekst, opprettet`,
        [id, resultat.svar]
      );
      await db.query('UPDATE chat_threads SET sist = now() WHERE id = $1', [id]);
      emitMelding(req, id, aiSvar);

      // Hvis AI ber om en ansatt, signaliser det til rommet (innboksen kan varsle)
      if (resultat.sendVidere) {
        try {
          const io = req.app.get('io');
          if (io) io.to('thread:' + id).emit('hent_ansatt', { thread_id: id });
        } catch (e) {
          console.error('chat hent_ansatt emit feilet:', e.message);
        }
      }
    }

    res.json({ ai: aiSvar });
  } catch (e) {
    console.error('chat POST /thread/:id/message feilet:', e.message);
    res.status(500).json({ error: 'Kunne ikke sende melding' });
  }
});

// GET /threads — kun ansatt/admin: alle tråder nyeste først, med siste melding
router.get('/threads', requireRole('ansatt', 'admin'), async (req, res) => {
  if (!db.isConfigured()) return utilgjengelig(res);

  try {
    const { rows } = await db.query(
      `SELECT t.id, t.navn, t.epost, t.status, t.opprettet, t.sist,
              m.tekst    AS siste_tekst,
              m.avsender AS siste_avsender,
              m.opprettet AS siste_tid
         FROM chat_threads t
         LEFT JOIN LATERAL (
           SELECT tekst, avsender, opprettet
             FROM chat_messages
            WHERE thread_id = t.id
            ORDER BY opprettet DESC
            LIMIT 1
         ) m ON true
        ORDER BY t.sist DESC`,
      []
    );
    res.json(rows);
  } catch (e) {
    console.error('chat GET /threads feilet:', e.message);
    res.status(500).json({ error: 'Kunne ikke hente tråder' });
  }
});

// GET /thread/:id/messages — alle meldinger i en tråd (eldste først)
router.get('/thread/:id/messages', async (req, res) => {
  if (!db.isConfigured()) return utilgjengelig(res);

  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Ugyldig tråd-id' });

  try {
    const traad = await db.one(
      'SELECT id, navn, epost, status, opprettet, sist FROM chat_threads WHERE id = $1',
      [id]
    );
    if (!traad) return res.status(404).json({ error: 'Tråd ikke funnet' });

    const { rows } = await db.query(
      `SELECT id, thread_id, avsender, tekst, opprettet
         FROM chat_messages
        WHERE thread_id = $1
        ORDER BY opprettet ASC`,
      [id]
    );
    res.json({ thread: traad, meldinger: rows });
  } catch (e) {
    console.error('chat GET /thread/:id/messages feilet:', e.message);
    res.status(500).json({ error: 'Kunne ikke hente meldinger' });
  }
});

module.exports = router;
