/* Havstund — seeding av startdata (admin-bruker, aktiviteter, innhold).
   Kjøres ved oppstart; gjør ingenting hvis data allerede finnes. */
const { hashPassword } = require('../lib/auth');

module.exports = async function seed({ query, one }) {
  // --- Admin-bruker ---
  const u = await one('SELECT COUNT(*)::int AS n FROM users');
  if (u.n === 0) {
    const pw = await hashPassword(process.env.ADMIN_PASSWORD || 'havstund2026');
    await query(
      "INSERT INTO users (navn, epost, passord_hash, rolle) VALUES ($1,$2,$3,'admin')",
      ['Admin', (process.env.ADMIN_EPOST || 'admin@havstund.no'), pw]
    );
    console.log('  seed: admin-bruker (' + (process.env.ADMIN_EPOST || 'admin@havstund.no') + ')');
  }

  // --- Aktiviteter (priser fra forretningsplanen) ---
  const a = await one('SELECT COUNT(*)::int AS n FROM activities');
  if (a.n === 0) {
    const acts = [
      ['drop-in', 'Drop-in', 'Lag noe ekte med egne hender — ingen erfaring nødvendig.', '1,5 time', 650, 8, 'bilder/2-kai.jpg', 1],
      ['handbygging', 'Håndbygging', 'Skål, kopp eller fat med din egen glasur fra dette havet.', '2 timer', 850, 8, 'bilder/1b-rorbuer.jpg', 2],
      ['halvdag', 'Halvdag', 'Fordypning med dreiing på hjul.', 'Halvdag', 1450, 6, 'bilder/3-havfiske.jpg', 3],
      ['heldag', 'Heldag', 'Den fulle opplevelsen — dreiing, glasering og «the reveal».', 'Heldag', 2650, 6, 'bilder/5-midnatt.jpg', 4],
      ['kurs', 'Kurs', 'Fast kurs over 5–6 uker for lokale.', '5–6 uker', 2950, 8, 'bilder/1a-havn.jpg', 5],
      ['gruppe', 'Gruppe-event', 'Teambuilding, bursdag eller følge. Minstepris 12 000 kr.', 'Etter avtale', 950, 24, 'bilder/4-hjell.jpg', 6],
    ];
    for (const x of acts) {
      await query(
        'INSERT INTO activities (slug,navn,beskrivelse,varighet,pris,kapasitet,bilde,sortering) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
        x
      );
    }
    console.log('  seed: ' + acts.length + ' aktiviteter');
  }

  // --- Redigerbart innhold (eksempler) ---
  const defaults = {
    'hero.tittel': 'Lag noe ekte av Lofoten — med dine egne hender',
    'hero.tagline': 'Et øyeblikk med havet',
    'kontakt.epost': 'post@havstund.no',
  };
  for (const [nokkel, verdi] of Object.entries(defaults)) {
    await query(
      'INSERT INTO content (nokkel, verdi) VALUES ($1,$2) ON CONFLICT (nokkel) DO NOTHING',
      [nokkel, verdi]
    );
  }
};
