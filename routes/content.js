/* Havstund — offentlig innhold (/api/content).
   Kun-lese speil av CMS-tabellen `content` for forsiden. HARD whitelist:
   bare nøklene under kan hentes offentlig — alt annet gir 404. Redigering
   skjer i /api/admin/content (rolle-beskyttet). Verdien lagres som TEXT og
   tolkes som tospråklig JSON {no,en}; ren tekst speiles til begge språk.
     GET /            -> alle whitelistede nøkler {nokkel: {no,en}, ...}
     GET /:nokkel     -> én whitelistet nøkkel {nokkel, verdi:{no,en}} (404 ellers) */
const express = require('express');
const db = require('../db');

const router = express.Router();

// HARD whitelist. Legg nye offentlige nøkler til her bevisst — aldri åpne opp
// hele content-tabellen, den kan inneholde interne/utkast-nøkler.
const WHITELIST = ['nyheter', 'hero_sitat', 'kampanje_banner'];
const ER_WHITELISTET = (n) => WHITELIST.includes(n);

// Kort cache: forsiden tåler noen sekunders forsinkelse på CMS-endringer,
// og dette avlaster DB for offentlig trafikk uten å bli "stale".
const CACHE = 'public, max-age=60';

// content.verdi er TEXT. Tolk som JSON {no,en}; fall tilbake til ren tekst
// speilet til begge språk. Returnerer alltid {no,en} med string-verdier.
function normaliser(verdi) {
  if (verdi == null) return { no: '', en: '' };
  try {
    const parsed = JSON.parse(verdi);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return {
        no: parsed.no != null ? String(parsed.no) : '',
        en: parsed.en != null ? String(parsed.en) : '',
      };
    }
  } catch {
    /* ikke JSON — behandle verdien som ren tekst */
  }
  const tekst = String(verdi);
  return { no: tekst, en: tekst };
}

// GET / -> alle whitelistede nøkler (manglende nøkkel -> tom {no,en})
router.get('/', async (_req, res) => {
  const ut = {};
  for (const n of WHITELIST) ut[n] = { no: '', en: '' };
  if (!db.isConfigured()) {
    // Uten DB: returner tomme skall så forsiden faller tilbake til HTML.
    res.set('Cache-Control', CACHE);
    return res.json(ut);
  }
  try {
    const { rows } = await db.query(
      'SELECT nokkel, verdi FROM content WHERE nokkel = ANY($1)',
      [WHITELIST]
    );
    // Dobbel sikring: godta bare whitelistede nøkler fra svaret, uavhengig
    // av SQL-filteret. En feilkonfigurert WHERE skal aldri lekke andre nøkler.
    for (const r of rows) if (ER_WHITELISTET(r.nokkel)) ut[r.nokkel] = normaliser(r.verdi);
    res.set('Cache-Control', CACHE);
    return res.json(ut);
  } catch (e) {
    console.error('content GET / feilet:', e.message);
    return res.status(500).json({ error: 'Kunne ikke hente innhold' });
  }
});

// GET /:nokkel -> én whitelistet nøkkel. 404 på alt utenfor whitelisten.
router.get('/:nokkel', async (req, res) => {
  const nokkel = req.params.nokkel;
  if (!ER_WHITELISTET(nokkel)) {
    return res.status(404).json({ error: 'Ukjent innholdsnøkkel' });
  }
  if (!db.isConfigured()) {
    res.set('Cache-Control', CACHE);
    return res.json({ nokkel, verdi: { no: '', en: '' } });
  }
  try {
    const rad = await db.one(
      'SELECT nokkel, verdi FROM content WHERE nokkel = $1',
      [nokkel]
    );
    res.set('Cache-Control', CACHE);
    return res.json({ nokkel, verdi: normaliser(rad ? rad.verdi : null) });
  } catch (e) {
    console.error('content GET /:nokkel feilet:', e.message);
    return res.status(500).json({ error: 'Kunne ikke hente innhold' });
  }
});

module.exports = router;
