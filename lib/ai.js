/* Havstund — regelbasert AI-svar for live chat (ingen ekstern API).
   Nøkkelord-matching mot vanlige kundespørsmål. Vennlig, kort, norsk.
   Eksport: svar(tekst) -> { svar: string, sendVidere: boolean }
   sendVidere=true betyr at en ansatt bør hentes inn. */

// Normaliser tekst for søk (små bokstaver, fjern aksenter ikke nødvendig på norsk)
function norm(t) {
  return String(t || '').toLowerCase().trim();
}

// Sjekk om teksten inneholder noen av nøkkelordene
function har(t, ord) {
  return ord.some((o) => t.includes(o));
}

const PRISER =
  'Prisene våre: Drop-in 650 kr · Håndbygging 850 kr · Halvdag 1450 kr · ' +
  'Heldag 2650 kr · Kurs 2950 kr · Grupper fra 950 kr per person. ' +
  'Du kan booke på /aktiviteter.';

const ADRESSE =
  'Du finner oss på Ballstad i Lofoten — et keramikk- og kunststudio rett ved havet. ' +
  '«Et øyeblikk med havet.»';

// Regler i prioritert rekkefølge. Første match vinner.
const REGLER = [
  {
    navn: 'hilsen',
    ord: ['hei', 'hallo', 'heisann', 'god morgen', 'god dag', 'halla', 'yo'],
    svar:
      'Hei og velkommen til Havstund! 🌊 Hvordan kan jeg hjelpe deg i dag? ' +
      'Du kan spørre om opplevelser, priser, booking eller hvor vi holder til.',
    sendVidere: false,
  },
  {
    navn: 'pris',
    ord: ['pris', 'koste', 'koster', 'hva tar', 'betale', 'kr ', 'kroner', 'kostnad'],
    svar: PRISER,
    sendVidere: false,
  },
  {
    navn: 'aapningstid',
    ord: ['åpningstid', 'apningstid', 'åpent', 'apent', 'når har', 'nar har', 'når er', 'nar er', 'klokka', 'tider'],
    svar:
      'Vi holder åpent for booket opplevelser og drop-in. Tidspunkt varierer med sesongen — ' +
      'se ledige tider og book på /aktiviteter, eller skriv her så finner en ansatt et tidspunkt som passer deg.',
    sendVidere: false,
  },
  {
    navn: 'adresse',
    ord: ['hvor', 'adresse', 'ligger', 'finne dere', 'finner dere', 'veibeskrivelse', 'ballstad', 'lofoten'],
    svar: ADRESSE,
    sendVidere: false,
  },
  {
    navn: 'book',
    ord: ['book', 'booke', 'bestille', 'bestill', 'reservere', 'reservasjon', 'melde meg', 'plass'],
    svar:
      'Så hyggelig! Du booker enkelt på /aktiviteter — velg opplevelse, dato og antall, ' +
      'så får du bekreftelse. Trenger du hjelp med en spesiell dato? Bare si fra, så ordner en ansatt det.',
    sendVidere: false,
  },
  {
    navn: 'kurs',
    ord: ['kurs', 'workshop', 'lære', 'lere', 'undervisning', 'dreie'],
    svar:
      'Kurset vårt koster 2950 kr og gir deg en grundig innføring i keramikk ved havet. ' +
      'Vi har også Halvdag (1450), Heldag (2650) og Håndbygging (850). Book på /aktiviteter.',
    sendVidere: false,
  },
  {
    navn: 'barn',
    ord: ['barn', 'familie', 'familier', 'unger', 'datter', 'sønn', 'sonn', 'aldersgrense', 'alder'],
    svar:
      'Ja, vi tar gjerne imot barn og familier! Håndbygging (850 kr) og Drop-in (650 kr) ' +
      'passer fint for barn. Vil du ha det tilrettelagt for en bestemt alder, hjelper en ansatt deg gjerne.',
    sendVidere: false,
  },
  {
    navn: 'gruppe',
    ord: ['gruppe', 'grupper', 'team', 'bedrift', 'firma', 'selskap', 'bursdag', 'vennegjeng', 'arrangement'],
    svar:
      'Grupper er noe av det vi liker aller best! Gruppeopplevelser starter fra 950 kr per person. ' +
      'Fortell gjerne hvor mange dere er og ønsket dato, så setter en ansatt sammen et tilbud.',
    sendVidere: false,
  },
  {
    navn: 'nordlys',
    ord: ['nordlys', 'aurora', 'midnattssol', 'midnattsol'],
    svar:
      'Lofoten er magisk for nordlys (vinter) og midnattssol (sommer). ' +
      'Vi holder til rett ved havet på Ballstad — en flott base for å oppleve lyset. ' +
      'Selve nordlyset kan vi dessverre ikke garantere, men keramikk ved havet kan vi! 🌌',
    sendVidere: false,
  },
  {
    navn: 'kontakt',
    ord: ['kontakt', 'e-post', 'epost', 'mail', 'ringe', 'telefon', 'snakke med'],
    svar:
      'Du når oss på post@havstund.no, eller bare skriv her — en ansatt svarer deg så snart som mulig. ' +
      'Legg gjerne igjen e-posten din om vi skulle bli frakoblet.',
    sendVidere: false,
  },
  {
    navn: 'takk',
    ord: ['takk', 'tusen takk', 'flott', 'supert', 'topp'],
    svar: 'Bare hyggelig! 🌊 Si fra om det er noe mer du lurer på.',
    sendVidere: false,
  },
];

function svar(tekst) {
  const t = norm(tekst);

  if (!t) {
    return {
      svar:
        'Hei! Skriv gjerne hva du lurer på — for eksempel priser, opplevelser, booking eller hvor vi holder til.',
      sendVidere: false,
    };
  }

  for (const regel of REGLER) {
    if (har(t, regel.ord)) {
      return { svar: regel.svar, sendVidere: regel.sendVidere };
    }
  }

  // Ingen match — gi et generelt svar og hent inn en ansatt.
  return {
    svar:
      'Takk for meldingen! Det her vil jeg gjerne at en av oss svarer ordentlig på. ' +
      'Jeg henter en ansatt — i mellomtiden kan du legge igjen e-posten din, ' +
      'så tar vi kontakt om vi ikke rekker å svare med en gang. ' +
      'Imens kan du se opplevelsene våre på /aktiviteter.',
    sendVidere: true,
  };
}

module.exports = { svar };
