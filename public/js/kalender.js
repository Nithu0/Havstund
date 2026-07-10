/* Havstund — gjenbrukbar måneds-kalender (design §5.5, bolge 98).
   Vanilla, ingen npm-avhengighet. 7 kolonner, MANDAG først (norsk uke).
   Hver dag: sum timer + fargekode per status. closed_dates gråes ut og er
   ikke klikkbare. Klikk på en åpen dag kaller cfg.onVelgDag(dato, dagData).

   RETTIGHET håndheves ALLTID i API-et, aldri her. kanGodkjenne/kanSeAndre
   styrer kun UI-bekvemmelighet. I denne runden brukes kun ansatt-modus
   (kanGodkjenne:false, kanSeAndre:false, apiBasis:'/api/min').

   cfg:
     ansattId       — hvem kalenderen gjelder (avledes/håndheves i API-et)
     kanGodkjenne   — vis godkjenn-verktøy (ansatt: false)
     kanSeAndre     — vis andres føringer (ansatt: false)
     apiBasis       — rot for API-kall, f.eks. '/api/min'
     onVelgDag(dato, { sum, statuser, entries })
     onLastet(payload)   — kalt etter hver vellykket last
     onFeil(status)      — kalt ved 403 (mangler ansatt-kobling e.l.)

   Returnerer: { mount(container), setMaaned(m), refresh(), data() }
*/
(function () {
  'use strict';

  var H = window.Havstund || {};
  function esc(s) { return H.esc ? H.esc(s) : String(s == null ? '' : s); }
  function api(sti, opt) { return H.api ? H.api(sti, opt) : fetch(sti, { credentials: 'same-origin' }); }
  function fmtTimer(t) { return H.timer ? H.timer(t) : String(Number(t) || 0); }

  var UKEDAGER = ['Man', 'Tir', 'Ons', 'Tor', 'Fre', 'Lør', 'Søn'];

  // status -> css-modifier (fargekode). Rekkefølgen er PRESEDENS når en dag
  // har flere statuser samtidig: avvist (trenger handling) > utkast (ikke
  // sendt) > sendt_inn > godkjent > laast. Da "vinner" det som mest trenger
  // den ansattes oppmerksomhet.
  var PRESEDENS = ['avvist', 'utkast', 'sendt_inn', 'godkjent', 'laast'];
  function repStatus(statuser) {
    for (var i = 0; i < PRESEDENS.length; i++) {
      if (statuser.indexOf(PRESEDENS[i]) !== -1) return PRESEDENS[i];
    }
    return '';
  }

  // Liten padlock som INLINE SVG (ingen emoji, ingen ekstern ressurs).
  var LAS_SVG = '<svg class="kal-las" viewBox="0 0 24 24" width="12" height="12" aria-hidden="true">' +
    '<path fill="currentColor" d="M6 10V7a6 6 0 1112 0v3h1a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2v-8a2 2 0 012-2h1zm2 0h8V7a4 4 0 10-8 0v3z"/></svg>';

  function pad(n) { return String(n).padStart(2, '0'); }
  function datoStr(v) { return v == null ? '' : String(v).slice(0, 10); }

  function Kalender(cfg) {
    cfg = cfg || {};
    var apiBasis = cfg.apiBasis || '/api/min';
    var container = null;
    var maaned = null; // 'YYYY-MM'
    var payload = { timer: [], business_hours: [], closed_dates: [] };

    function mount(el) { container = el; return ctrl; }

    function setMaaned(m) { maaned = m; return refresh(); }

    function refresh() {
      if (!maaned) return Promise.resolve(payload);
      var url = apiBasis + '/kalender?maaned=' + encodeURIComponent(maaned);
      return api(url).then(function (r) {
        if (r.status === 403) { if (cfg.onFeil) cfg.onFeil(403); throw new Error('403'); }
        if (!r.ok) throw new Error('kalender ' + r.status);
        return r.json();
      }).then(function (d) {
        payload = {
          timer: Array.isArray(d && d.timer) ? d.timer : [],
          business_hours: Array.isArray(d && d.business_hours) ? d.business_hours : [],
          closed_dates: Array.isArray(d && d.closed_dates) ? d.closed_dates : []
        };
        render();
        if (cfg.onLastet) cfg.onLastet(payload);
        return payload;
      }).catch(function (e) {
        if (String(e && e.message) !== '403' && container) {
          container.innerHTML = '<div class="kal-feil">Kunne ikke laste kalenderen. Prøv igjen.</div>';
        }
        throw e;
      });
    }

    // Grupper timer-føringer per dato -> { sum, statuser[], antall }.
    function grupper() {
      var m = {};
      payload.timer.forEach(function (t) {
        var dato = t && t.dato ? datoStr(t.dato) : '';
        if (!dato) return;
        if (!m[dato]) m[dato] = { sum: 0, statuser: [], antall: 0 };
        m[dato].sum += Number(t.timer) || 0;
        m[dato].antall += 1;
        if (t.status && m[dato].statuser.indexOf(t.status) === -1) m[dato].statuser.push(t.status);
      });
      return m;
    }

    function render() {
      if (!container) return;
      if (!maaned) { container.innerHTML = ''; return; }
      var deler = String(maaned).split('-');
      var aar = Number(deler[0]);
      var mnd = Number(deler[1]); // 1..12
      if (!aar || !mnd || mnd < 1 || mnd > 12) { container.innerHTML = ''; return; }

      var antallDager = new Date(aar, mnd, 0).getDate();
      var forste = new Date(aar, mnd - 1, 1);
      var offset = (forste.getDay() + 6) % 7; // Man=0 .. Søn=6
      var lukket = {};
      payload.closed_dates.forEach(function (d) { lukket[datoStr(d)] = true; });
      var perDag = grupper();
      var idag = H.iDag ? H.iDag() : '';

      var html = '<div class="kal-grid kal-hoder">';
      UKEDAGER.forEach(function (u) { html += '<div class="kal-hode">' + u + '</div>'; });
      html += '</div><div class="kal-grid kal-dager">';
      for (var i = 0; i < offset; i++) html += '<div class="kal-tom"></div>';
      for (var dag = 1; dag <= antallDager; dag++) {
        var dato = aar + '-' + pad(mnd) + '-' + pad(dag);
        var d = perDag[dato];
        var erLukket = !!lukket[dato];
        var rep = d ? repStatus(d.statuser) : '';
        var laast = !!(d && d.statuser.indexOf('laast') !== -1);
        var klasser = ['kal-dag'];
        if (erLukket) klasser.push('kal-lukket');
        if (rep) klasser.push('kal-' + rep);
        if (dato === idag) klasser.push('kal-idag');

        var innhold = '<span class="kal-nr">' + dag + (laast ? ' ' + LAS_SVG : '') + '</span>';
        if (d && d.sum > 0) innhold += '<span class="kal-sum">' + esc(fmtTimer(d.sum)) + ' t</span>';
        else if (erLukket) innhold += '<span class="kal-merk">Stengt</span>';

        html += '<button type="button" class="' + klasser.join(' ') + '" data-dato="' + dato + '"' +
          (erLukket ? ' disabled aria-disabled="true"' : '') + '>' + innhold + '</button>';
      }
      html += '</div>';
      container.innerHTML = html;

      // Klikk -> onVelgDag. disabled-knapper (stengte dager) fyrer ikke.
      var knapper = container.querySelectorAll('.kal-dag');
      Array.prototype.forEach.call(knapper, function (btn) {
        if (btn.disabled) return;
        btn.addEventListener('click', function () {
          var dato = btn.getAttribute('data-dato');
          var dd = perDag[dato] || { sum: 0, statuser: [], antall: 0 };
          var egne = payload.timer.filter(function (t) { return t && datoStr(t.dato) === dato; });
          if (cfg.onVelgDag) cfg.onVelgDag(dato, { sum: dd.sum, statuser: dd.statuser, entries: egne });
        });
      });
    }

    var ctrl = { mount: mount, setMaaned: setMaaned, refresh: refresh, data: function () { return payload; } };
    return ctrl;
  }

  window.HavstundKalender = Kalender;
})();
