/* Havstund — delt bookingstatus-modul (ren frontend, ingen backend, ingen PII).
   Én kilde til etikett, farge (css-klasse) og sorteringsrekkefølge for de fire
   bookingstatusene, slik at admin-agenda (og andre admin-visninger) rendrer
   status likt. Klassene matcher .pill.<klasse> i public/css/styles.css.
   Eksponeres som window.BookingStatus i nettleser; module.exports i test/node. */
(function (global) {
  'use strict';

  // Kanonisk livssyklus-rekkefølge. Ukjent status sorteres sist.
  var DEF = {
    forespurt: { etikett: 'Forespurt', klasse: 'forespurt', rekkefolge: 1 },
    bekreftet: { etikett: 'Bekreftet', klasse: 'bekreftet', rekkefolge: 2 },
    fullfort: { etikett: 'Fullført', klasse: 'fullfort', rekkefolge: 3 },
    avlyst: { etikett: 'Avlyst', klasse: 'avlyst', rekkefolge: 4 },
  };
  var UKJENT = { etikett: '–', klasse: 'forespurt', rekkefolge: 99 };

  function norm(status) {
    return String(status == null ? '' : status)
      .trim()
      .toLowerCase();
  }
  function info(status) {
    return DEF[norm(status)] || UKJENT;
  }
  function etikett(status) {
    var s = norm(status);
    if (DEF[s]) return DEF[s].etikett;
    // Ukjent, men ikke-tom: vis råteksten framfor et intetsigende «–».
    return status ? String(status) : UKJENT.etikett;
  }
  function klasse(status) {
    return info(status).klasse;
  }
  function rekkefolge(status) {
    return info(status).rekkefolge;
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  // Ferdig pille-markup identisk med den admin-agenda brukte fra før.
  function pille(status) {
    return '<span class="pill ' + klasse(status) + '">' + esc(etikett(status)) + '</span>';
  }

  var BookingStatus = {
    STATUSER: ['forespurt', 'bekreftet', 'fullfort', 'avlyst'],
    etikett: etikett,
    klasse: klasse,
    rekkefolge: rekkefolge,
    pille: pille,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = BookingStatus;
  if (global) global.BookingStatus = BookingStatus;
})(typeof window !== 'undefined' ? window : this);
