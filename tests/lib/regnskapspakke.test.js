// describe/it/expect er globale (vitest.config.js -> globals: true).
// Testene her er hjertet i Fase 3a: de bevokter invariantene i regnskapspakke-
// generatoren. Alle beløp er i ØRE (heltall). Ingen I/O, ren funksjon.
const { byggRegnskapspakke, vatTypeFraSats, SCHEMA_VERSION } = require('../../lib/regnskapspakke');

// Fast tidsstempel -> deterministisk output (funksjonen kaller aldri Date selv).
const GENERERT = '2026-07-09T00:00:00.000Z';

// --- Fabrikker for gyldige input-rader (25 % mva: 50000 brutto = 40000 + 10000).
function salgspost(over = {}) {
  return {
    id: 1,
    type: 'inntekt',
    dato: '2026-07-01',
    beskrivelse: 'Havstund booking',
    konto: 3000,
    mva_sats: 25,
    netto_ore: 40000,
    mva_ore: 10000,
    brutto_ore: 50000,
    betalingsmetode: 'kort',
    kilde: 'booking',
    booking_id: 42,
    fiken_status: 'ikke_sendt',
    ...over,
  };
}

function kjopspost(over = {}) {
  return {
    id: 2,
    type: 'utgift',
    dato: '2026-07-02',
    beskrivelse: 'Innkjøp varer',
    konto: 4000,
    mva_sats: 25,
    netto_ore: 8000,
    mva_ore: 2000,
    brutto_ore: 10000,
    betalingsmetode: 'bank',
    kilde: 'manuell',
    booking_id: null,
    fiken_status: 'ikke_sendt',
    ...over,
  };
}

function refusjonspost(over = {}) {
  // Refusjon lagres i dag som type='inntekt' med NEGATIVE beløp.
  return {
    id: 3,
    type: 'inntekt',
    dato: '2026-07-03',
    beskrivelse: 'Refusjon booking',
    konto: 3000,
    mva_sats: 25,
    netto_ore: -4000,
    mva_ore: -1000,
    brutto_ore: -5000,
    betalingsmetode: 'kort',
    kilde: 'booking',
    booking_id: 99,
    fiken_status: 'ikke_sendt',
    ...over,
  };
}

describe('byggRegnskapspakke — happy path', () => {
  it('2 salg + 1 kjøp + 1 kreditering gir korrekt pakke og kontrollsum', () => {
    const pakke = byggRegnskapspakke({
      periode: '2026-07',
      poster: [
        salgspost({ id: 1, booking_id: 42 }),
        salgspost({ id: 4, booking_id: 43, brutto_ore: 25000, netto_ore: 20000, mva_ore: 5000 }),
        kjopspost({ id: 2 }),
        refusjonspost({ id: 3 }),
      ],
      generert: GENERERT,
    });

    expect(pakke.schema_version).toBe('1.0');
    expect(pakke.schema_version).toBe(SCHEMA_VERSION);
    expect(pakke.periode).toBe('2026-07');
    expect(pakke.generert).toBe(GENERERT);
    expect(pakke.bilag).toHaveLength(4);

    // Kontrollsum = brutto gjennomstrømning (kreditering teller POSITIVT).
    // 50000 + 25000 + 10000 + 5000 = 90000. Mva: 10000+5000+2000+1000 = 18000.
    expect(pakke.kontrollsum).toEqual({ brutto_ore: 90000, mva_ore: 18000, antall_bilag: 4 });

    const handlinger = pakke.bilag.map((b) => b.handling);
    expect(handlinger).toEqual(['salg', 'salg', 'kjop', 'kreditering']);

    const salg = pakke.bilag[0];
    expect(salg).toMatchObject({
      bilag_ref: 'HAV-booking-42',
      handling: 'salg',
      kind: 'cash_sale',
      vatType: 'HIGH',
      netto_ore: 40000,
      mva_ore: 10000,
      brutto_ore: 50000,
    });

    const kjop = pakke.bilag[2];
    expect(kjop).toMatchObject({
      bilag_ref: 'HAV-manuell-2',
      handling: 'kjop',
      kind: 'cash_purchase',
      brutto_ore: 10000,
    });
  });

  it('tom periode (0 poster) gir gyldig tom pakke med kontrollsum 0 — kaster ikke', () => {
    const pakke = byggRegnskapspakke({ periode: '2026-07', poster: [], generert: GENERERT });
    expect(pakke.bilag).toEqual([]);
    expect(pakke.kontrollsum).toEqual({ brutto_ore: 0, mva_ore: 0, antall_bilag: 0 });
    expect(pakke.dagsoppgjor).toEqual([]);
    expect(pakke.timegrunnlag).toEqual([]);
  });

  it('generert defaulter til null når kalleren ikke setter den', () => {
    const pakke = byggRegnskapspakke({ periode: '2026-07', poster: [] });
    expect(pakke.generert).toBeNull();
  });
});

describe('byggRegnskapspakke — kreditering (refusjon -> positiv kreditnota)', () => {
  it('negativ inntektsrad blir handling:kreditering med POSITIVE beløp', () => {
    const pakke = byggRegnskapspakke({ periode: '2026-07', poster: [refusjonspost()], generert: GENERERT });
    const b = pakke.bilag[0];
    expect(b.handling).toBe('kreditering');
    expect(b.netto_ore).toBe(4000);
    expect(b.mva_ore).toBe(1000);
    expect(b.brutto_ore).toBe(5000);
    // Aldri negativt i output.
    expect(b.netto_ore).toBeGreaterThan(0);
    expect(b.brutto_ore).toBeGreaterThan(0);
  });

  it('kreditering flagges med krever_versjonering:true (Fase 4 eier versjonstate)', () => {
    const pakke = byggRegnskapspakke({ periode: '2026-07', poster: [refusjonspost()], generert: GENERERT });
    expect(pakke.bilag[0].krever_versjonering).toBe(true);
  });

  it('salg og kjøp har IKKE krever_versjonering-flagget', () => {
    const pakke = byggRegnskapspakke({ periode: '2026-07', poster: [salgspost(), kjopspost()], generert: GENERERT });
    expect(pakke.bilag[0].krever_versjonering).toBeUndefined();
    expect(pakke.bilag[1].krever_versjonering).toBeUndefined();
  });
});

describe('byggRegnskapspakke — invariant-brudd KASTER', () => {
  it('brutto som ikke er netto+mva kaster', () => {
    expect(() =>
      byggRegnskapspakke({
        periode: '2026-07',
        poster: [salgspost({ netto_ore: 30000, mva_ore: 10000, brutto_ore: 50000 })],
        generert: GENERERT,
      })
    ).toThrow(/!= brutto|matcher ikke/);
  });

  it('float-beløp (ikke heltall øre) kaster', () => {
    expect(() =>
      byggRegnskapspakke({
        periode: '2026-07',
        poster: [salgspost({ brutto_ore: 50000.5 })],
        generert: GENERERT,
      })
    ).toThrow(/heltall/);
  });

  it('kontrollsum-mismatch mot dagsoppgjor kaster', () => {
    expect(() =>
      byggRegnskapspakke({
        periode: '2026-07',
        poster: [salgspost()], // bilag-brutto = 50000
        dagsoppgjor: [{ dato: '2026-07-01', brutto_ore: 49999, mva_ore: 10000, antall_bilag: 1 }],
        generert: GENERERT,
      })
    ).toThrow(/dagsoppgjor-sum/);
  });

  it('dagsoppgjor som MATCHER kontrollsum kaster ikke', () => {
    const pakke = byggRegnskapspakke({
      periode: '2026-07',
      poster: [salgspost()],
      dagsoppgjor: [{ dato: '2026-07-01', brutto_ore: 50000, mva_ore: 10000, antall_bilag: 1, lukket_tid: '2026-07-01T18:00:00Z' }],
      generert: GENERERT,
    });
    expect(pakke.dagsoppgjor[0]).toMatchObject({ dato: '2026-07-01', brutto_ore: 50000, antall_bilag: 1 });
  });

  it('ugyldig type kaster', () => {
    expect(() =>
      byggRegnskapspakke({ periode: '2026-07', poster: [salgspost({ type: 'ukjent' })], generert: GENERERT })
    ).toThrow(/ukjent type/);
  });

  it('ugyldig mva_sats kaster (via mvaSplitt)', () => {
    expect(() =>
      byggRegnskapspakke({ periode: '2026-07', poster: [salgspost({ mva_sats: 7 })], generert: GENERERT })
    ).toThrow();
  });

  it('brutto 0 kaster', () => {
    expect(() =>
      byggRegnskapspakke({ periode: '2026-07', poster: [salgspost({ brutto_ore: 0, netto_ore: 0, mva_ore: 0 })], generert: GENERERT })
    ).toThrow(/brutto 0/);
  });

  it('ugyldig periode kaster', () => {
    expect(() => byggRegnskapspakke({ periode: '2026/07', poster: [] })).toThrow(/periode/);
    expect(() => byggRegnskapspakke({ periode: 'juli', poster: [] })).toThrow(/periode/);
  });
});

describe('byggRegnskapspakke — PII-frihet (kritisk)', () => {
  it('kunde-navn i kontakt-feltet lekker ALDRI til output', () => {
    const pakke = byggRegnskapspakke({
      periode: '2026-07',
      poster: [salgspost({ kontakt: 'Ola Nordmann' })],
      generert: GENERERT,
    });
    const serialisert = JSON.stringify(pakke);
    expect(serialisert).not.toContain('Ola Nordmann');
    expect(serialisert).not.toContain('kontakt');
  });

  it('e-post i en poster-rad (feilaktig i beskrivelse) kaster — nekter å produsere', () => {
    expect(() =>
      byggRegnskapspakke({
        periode: '2026-07',
        poster: [salgspost({ beskrivelse: 'Faktura til ola@havstund.no' })],
        generert: GENERERT,
      })
    ).toThrow(/PII-lekkasje/);
  });

  it('e-post i et ekstra kunde-felt (epost) skilles bort av whitelist — lekker ikke', () => {
    // Whitelist-konstruksjonen leser kun forretningsfelt; ukjente felt (epost,
    // kontakt) kopieres aldri. Derfor kastes det ikke her — feltet forsvinner.
    const pakke = byggRegnskapspakke({
      periode: '2026-07',
      poster: [salgspost({ epost: 'kunde@example.com' })],
      generert: GENERERT,
    });
    const serialisert = JSON.stringify(pakke);
    expect(serialisert).not.toContain('kunde@example.com');
    expect(serialisert).not.toContain('epost');
  });

  it('hele pakken er fri for e-postmønster (@) i happy path', () => {
    const pakke = byggRegnskapspakke({
      periode: '2026-07',
      poster: [salgspost(), kjopspost(), refusjonspost()],
      generert: GENERERT,
    });
    expect(JSON.stringify(pakke)).not.toMatch(/[^\s"@]+@[^\s"@]+\.[^\s"@]+/);
  });
});

describe('byggRegnskapspakke — timegrunnlag (PII-fritt, nøklet på ansatt_id)', () => {
  const ansatte = [
    { id: 10, navn: 'Kari Ansatt', epost: 'kari@havstund.no', timelonn_ore: 30000, konto: 5000 },
    { id: 11, navn: 'Per Ansatt', epost: 'per@havstund.no', timelonn_ore: 25000, konto: 5010 },
  ];

  it('aggregerer timer per ansatt og regner sum_ore = timer * timelonn_ore', () => {
    const pakke = byggRegnskapspakke({
      periode: '2026-07',
      poster: [],
      timeforinger: [
        { ansatt_id: 10, dato: '2026-07-01', timer: 5, aktivitet: 'drift' },
        { ansatt_id: 10, dato: '2026-07-02', timer: 2.5, aktivitet: 'drift' },
        { ansatt_id: 11, dato: '2026-07-01', timer: 4, aktivitet: 'salg' },
      ],
      ansatte,
      generert: GENERERT,
    });

    expect(pakke.timegrunnlag).toEqual([
      { ansatt_id: 10, timer: 7.5, timelonn_ore: 30000, konto: 5000, sum_ore: 225000 },
      { ansatt_id: 11, timer: 4, timelonn_ore: 25000, konto: 5010, sum_ore: 100000 },
    ]);
  });

  it('timegrunnlag inneholder verken navn eller epost (PII-fritt)', () => {
    const pakke = byggRegnskapspakke({
      periode: '2026-07',
      poster: [],
      timeforinger: [{ ansatt_id: 10, dato: '2026-07-01', timer: 5, aktivitet: 'drift' }],
      ansatte,
      generert: GENERERT,
    });
    const serialisert = JSON.stringify(pakke.timegrunnlag);
    expect(serialisert).not.toContain('Kari');
    expect(serialisert).not.toContain('@');
    expect(pakke.timegrunnlag[0]).not.toHaveProperty('navn');
  });

  it('ukjent ansatt_id (ikke i ansatte) kaster', () => {
    expect(() =>
      byggRegnskapspakke({
        periode: '2026-07',
        poster: [],
        timeforinger: [{ ansatt_id: 999, dato: '2026-07-01', timer: 5 }],
        ansatte,
        generert: GENERERT,
      })
    ).toThrow(/ukjent ansatt_id/);
  });
});

describe('vatTypeFraSats', () => {
  it('kartlegger satsene som lib/fiken.js', () => {
    expect(vatTypeFraSats(25)).toBe('HIGH');
    expect(vatTypeFraSats(15)).toBe('MEDIUM');
    expect(vatTypeFraSats(12)).toBe('LOW');
    expect(vatTypeFraSats(0)).toBe('NONE');
  });
});
