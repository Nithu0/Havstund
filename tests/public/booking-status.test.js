// describe/it/expect er globale (vitest.config.js -> globals: true).
// Ren enhetstest av den delte frontend-modulen public/js/booking-status.js:
// etikett, css-klasse og sorteringsrekkefølge per status, inkl. normalisering
// og trygg fallback for ukjente verdier. Ingen DOM, ingen nettverk.
const BookingStatus = require('../../public/js/booking-status');

describe('BookingStatus', () => {
  it('gir riktig klasse, etikett og rekkefølge for kjente statuser', () => {
    expect(BookingStatus.klasse('forespurt')).toBe('forespurt');
    expect(BookingStatus.klasse('fullfort')).toBe('fullfort');
    expect(BookingStatus.etikett('fullfort')).toBe('Fullført');
    expect(BookingStatus.rekkefolge('forespurt')).toBe(1);
    expect(BookingStatus.rekkefolge('avlyst')).toBe(4);
  });

  it('normaliserer store bokstaver og whitespace', () => {
    expect(BookingStatus.klasse('  BEKREFTET ')).toBe('bekreftet');
    expect(BookingStatus.etikett('Bekreftet')).toBe('Bekreftet');
  });

  it('sorterer via rekkefolge i livssyklus-orden', () => {
    const sortert = ['avlyst', 'forespurt', 'fullfort', 'bekreftet'].sort(
      (a, b) => BookingStatus.rekkefolge(a) - BookingStatus.rekkefolge(b)
    );
    expect(sortert).toEqual(['forespurt', 'bekreftet', 'fullfort', 'avlyst']);
  });

  it('faller trygt tilbake for ukjent status', () => {
    expect(BookingStatus.klasse('tull')).toBe('forespurt');
    expect(BookingStatus.rekkefolge('tull')).toBe(99);
    expect(BookingStatus.etikett('tull')).toBe('tull');
    expect(BookingStatus.etikett('')).toBe('–');
  });

  it('pille() bruker riktig klasse og escaper innhold', () => {
    const html = BookingStatus.pille('avlyst');
    expect(html).toContain('class="pill avlyst"');
    expect(html).toContain('Avlyst');
    expect(BookingStatus.pille('<x>')).not.toContain('<x>');
  });
});
