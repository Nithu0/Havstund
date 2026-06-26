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

  // --- Demo-kunde + portaldata (idempotent) ---
  try {
    let kundeId;
    let nyKunde = false;

    const eksisterende = await one(
      'SELECT id FROM users WHERE epost = $1',
      ['kunde@havstund.no']
    );

    if (eksisterende) {
      kundeId = eksisterende.id;
    } else {
      const pw = await hashPassword('kunde123');
      const opprettet = await one(
        "INSERT INTO users (navn, epost, passord_hash, rolle) VALUES ($1,$2,$3,'kunde') RETURNING id",
        ['Demo Kunde', 'kunde@havstund.no', pw]
      );
      kundeId = opprettet.id;
      nyKunde = true;
    }

    const prosjektTelling = await one(
      'SELECT COUNT(*)::int AS n FROM projects WHERE bruker_id = $1',
      [kundeId]
    );
    let opprettetPortaldata = false;

    if (nyKunde || prosjektTelling.n === 0) {
      const prosjekt = await one(
        `INSERT INTO projects (bruker_id, tittel, type, status, beskrivelse)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [kundeId, 'Galakse-krus', 'keramikk', 'under_arbeid',
         'Et håndbygd krus med dyp blå glasur inspirert av nattehimmelen over havet.']
      );
      const media = [
        ['bilder/keramikk1.jpg', 'Råform — før første brenning'],
        ['bilder/havvegg.jpg', 'Glasurprøve mot havveggen'],
      ];
      for (const [url, tittel] of media) {
        await query(
          `INSERT INTO project_media (project_id, bruker_id, url, type, tittel)
           VALUES ($1, $2, $3, 'bilde', $4)`,
          [prosjekt.id, kundeId, url, tittel]
        );
      }
      opprettetPortaldata = true;
    }

    const kvitteringTelling = await one(
      'SELECT COUNT(*)::int AS n FROM receipts WHERE bruker_id = $1',
      [kundeId]
    );
    if (kvitteringTelling.n === 0) {
      await query(
        `INSERT INTO receipts (bruker_id, belop, beskrivelse, betalt, dato, opprettet)
         VALUES ($1, $2, $3, true, now(), now())`,
        [kundeId, 850, 'Håndbygging — depositum']
      );
      opprettetPortaldata = true;
    }

    const meldingTelling = await one(
      'SELECT COUNT(*)::int AS n FROM customer_messages WHERE bruker_id = $1',
      [kundeId]
    );
    if (meldingTelling.n === 0) {
      await query(
        `INSERT INTO customer_messages (bruker_id, avsender, tekst, pris, lest)
         VALUES ($1, 'kunde', $2, NULL, true)`,
        [kundeId, 'Hei! Kan jeg få et pristilbud på et kollektivt maleri for 8 personer?']
      );
      await query(
        `INSERT INTO customer_messages (bruker_id, avsender, tekst, pris, lest)
         VALUES ($1, 'admin', $2, $3, false)`,
        [kundeId, 'Så hyggelig! Her er et tilbud — 8 fliser, ett felles verk.', 6000]
      );
      opprettetPortaldata = true;
    }

    if (nyKunde || opprettetPortaldata) {
      console.log('  seed: demo-kunde + portaldata');
    }
  } catch (e) {
    console.error('  seed: demo-kunde feilet:', e.message);
  }

  // --- Demo-ansatt (for timeliste/lønn), idempotent ---
  try {
    const ant = await one('SELECT COUNT(*)::int AS n FROM ansatte');
    if (ant.n === 0) {
      await query(
        `INSERT INTO ansatte (navn, stilling, timelonn_ore, konto)
         VALUES ($1, $2, $3, 5000)`,
        ['Demo Ansatt', 'Keramiker', 22000]
      );
      console.log('  seed: demo-ansatt');
    }
  } catch (e) {
    console.error('  seed: demo-ansatt feilet:', e.message);
  }

  // --- Apningstider (Fase 2): 7 default-rader, idempotent ---
  // ukedag 0=mandag .. 6=sondag. Man-fre 10-16, lor 10-14, son stengt.
  try {
    const hours = [
      [0, '10:00', '16:00', false], // mandag
      [1, '10:00', '16:00', false], // tirsdag
      [2, '10:00', '16:00', false], // onsdag
      [3, '10:00', '16:00', false], // torsdag
      [4, '10:00', '16:00', false], // fredag
      [5, '10:00', '14:00', false], // lordag
      [6, null, null, true],        // sondag (stengt)
    ];
    for (const [ukedag, apner, stenger, stengt] of hours) {
      await query(
        `INSERT INTO business_hours (ukedag, apner, stenger, stengt)
         VALUES ($1, $2, $3, $4) ON CONFLICT (ukedag) DO NOTHING`,
        [ukedag, apner, stenger, stengt]
      );
    }
  } catch (e) {
    console.error('  seed: apningstider feilet:', e.message);
  }
};
