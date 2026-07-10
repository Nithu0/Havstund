/* Havstund — ansatt-profil-oppslag (bolge 98, blocker 1).
   hentAnsatt: middleware som slaar opp den innloggede brukerens ansatt-rad
   (ansatte.user_id = req.user.id) og setter req.ansatt.

   Brukes IKKE ennaa — /api/min/* bygges i en senere runde. Den lever ferdig og
   testet her slik at den neste runden bare kan monteres foran min-rutene, etter
   requireRole('ansatt','admin') / requireAuth i middleware-kjeden.

   Kontrakt:
   - DB ikke konfigurert      -> 503 (samme degraderingsmonster som routes/regnskap)
   - ingen innlogget bruker   -> 401 (skal normalt fanges av auth foran, men fail-safe)
   - ingen koblet ansatt-rad  -> 403 ("Ingen ansatt-profil koblet til brukeren")
   - treff                    -> req.ansatt satt, next() */
const db = require('../db');

async function hentAnsatt(req, res, next) {
  if (!db.isConfigured()) {
    return res.status(503).json({ error: 'Ansatt-oppslag er midlertidig utilgjengelig.' });
  }
  if (!req.user || req.user.id == null) {
    return res.status(401).json({ error: 'Ikke innlogget' });
  }
  try {
    const ansatt = await db.one('SELECT * FROM ansatte WHERE user_id = $1', [req.user.id]);
    if (!ansatt) {
      return res.status(403).json({ error: 'Ingen ansatt-profil koblet til brukeren' });
    }
    req.ansatt = ansatt;
    next();
  } catch (e) {
    console.error('hentAnsatt feilet:', e.message);
    return res.status(500).json({ error: 'Kunne ikke sla opp ansatt-profil' });
  }
}

module.exports = { hentAnsatt };
