/* Havstund — felles frontend-hjelpere (bolge 98, steg 3).
   Samler hjelperne som ellers er DUPLISERT inline i hver side (jf.
   regnskap.js:32-63) slik at NYE sider (ansatt-modus) slipper å kopiere dem.
   Eksisterende sider (regnskap.js / intranett.js / bookinger.js) beholder
   sine egne kopier — dette er rent additivt og rører dem ikke.

   Namespace: window.Havstund = { api, esc, kr, timer, naaMaaned, iDag, feilBanner }.
*/
(function () {
  'use strict';

  // fetch med same-origin-cookie + JSON-header (som regnskap.js:api).
  function api(sti, opt) {
    opt = opt || {};
    opt.credentials = 'same-origin';
    opt.headers = Object.assign(
      { 'Content-Type': 'application/json', Accept: 'application/json' },
      opt.headers || {}
    );
    return fetch(sti, opt);
  }

  // HTML-escape (som regnskap.js:esc). Aldri rå interpolasjon i innerHTML.
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // Øre -> "kr 1 234,00" (som regnskap.js:kr).
  var krFmt = new Intl.NumberFormat('no-NO', { style: 'currency', currency: 'NOK' });
  function kr(ore) { return krFmt.format((Number(ore) || 0) / 100); }

  // Antall timer -> lokalisert tall (som regnskap.js:timer).
  function timer(t) { return (Number(t) || 0).toLocaleString('no-NO', { maximumFractionDigits: 2 }); }

  // Inneværende måned "YYYY-MM" (som regnskap.js:naaMaaned).
  function naaMaaned() {
    var d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
  }

  // I dag "YYYY-MM-DD" (som regnskap.js:iDag).
  function iDag() {
    var d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  // Feil-/statusbanner. el kan være et element ELLER en id-streng.
  // Tom/utelatt tekst skjuler banneret. Fail-safe hvis elementet mangler.
  function feilBanner(el, tekst) {
    if (typeof el === 'string') el = document.getElementById(el);
    if (!el) return;
    el.textContent = tekst || '';
    el.classList.toggle('vis', !!tekst);
  }

  window.Havstund = {
    api: api,
    esc: esc,
    kr: kr,
    timer: timer,
    naaMaaned: naaMaaned,
    iDag: iDag,
    feilBanner: feilBanner
  };
})();
