/* Havstund — økonomi-modell (kalkulator).
   Ren vanilla JS. Leser inputs, regner per inntektsstrøm, kostnad, resultat,
   break-even, 12-mnd sesongprojeksjon, per-kilde-tabell. Scenarioer +
   localStorage. Bonus: POST /api/finance ved lagring hvis innlogget admin. */
(function () {
  'use strict';

  var LAGER_NOKKEL = 'havstund_okonomi';

  // Inputfelt-id-er (number-inputs i okonomi.html)
  var FELT = [
    'opplevelser_okter', 'opplevelser_deltakere', 'opplevelser_pris',
    'storevents_antall', 'storevents_inntekt',
    'servise_kunder', 'servise_snitt',
    'nettbutikk', 'tilskudd', 'kulturhub',
    'medlemmer', 'medlempris',
    'faste', 'lonn', 'variabel_pst',
  ];

  // Sesongkurve for opplevelser (jan..des). Lav vinter, topp juli.
  // Normaliseres ved bruk så snittet blir 1 (= månedsverdien).
  var SESONG_RAW = [0.45, 0.5, 0.7, 0.9, 1.15, 1.45, 1.7, 1.55, 1.1, 0.85, 0.6, 0.55];
  var MND = ['Jan', 'Feb', 'Mar', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Des'];

  // Scenario-verdisett. middels = standard.
  var SCENARIOER = {
    forsiktig: {
      opplevelser_okter: 8, opplevelser_deltakere: 6, opplevelser_pris: 550,
      storevents_antall: 1, storevents_inntekt: 12000,
      servise_kunder: 2, servise_snitt: 6000,
      nettbutikk: 8000, tilskudd: 15000, kulturhub: 5000,
      medlemmer: 40, medlempris: 149,
      faste: 35000, lonn: 45000, variabel_pst: 30,
    },
    middels: {
      opplevelser_okter: 16, opplevelser_deltakere: 8, opplevelser_pris: 650,
      storevents_antall: 2, storevents_inntekt: 18000,
      servise_kunder: 4, servise_snitt: 8000,
      nettbutikk: 18000, tilskudd: 25000, kulturhub: 12000,
      medlemmer: 120, medlempris: 199,
      faste: 45000, lonn: 70000, variabel_pst: 28,
    },
    optimistisk: {
      opplevelser_okter: 28, opplevelser_deltakere: 11, opplevelser_pris: 750,
      storevents_antall: 4, storevents_inntekt: 25000,
      servise_kunder: 8, servise_snitt: 10500,
      nettbutikk: 38000, tilskudd: 35000, kulturhub: 22000,
      medlemmer: 280, medlempris: 229,
      faste: 55000, lonn: 110000, variabel_pst: 26,
    },
  };

  // ---- Hjelpere ----
  function el(id) { return document.getElementById(id); }

  function num(id) {
    var n = el(id);
    if (!n) return 0;
    var v = parseFloat(n.value);
    return isFinite(v) ? v : 0;
  }

  // Norsk tallformat med mellomrom som tusenskille.
  function fmt(v) {
    var neg = v < 0;
    var avrundet = Math.round(Math.abs(v));
    var s = String(avrundet).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
    return (neg ? '−' : '') + s;
  }
  function kr(v) { return fmt(v) + ' kr'; }

  // Normalisert sesongkurve (snitt = 1).
  function sesongVekter() {
    var sum = 0, i;
    for (i = 0; i < 12; i++) sum += SESONG_RAW[i];
    var snitt = sum / 12;
    var ut = [];
    for (i = 0; i < 12; i++) ut.push(SESONG_RAW[i] / snitt);
    return ut;
  }

  // ---- Kjernemodell ----
  function lesModell() {
    var okter = num('opplevelser_okter');
    var deltakere = num('opplevelser_deltakere');
    var pris = num('opplevelser_pris');
    var storeAntall = num('storevents_antall');
    var storeInntekt = num('storevents_inntekt');

    var opplevSesongdel = okter * deltakere * pris; // den sesongavhengige delen
    var opplevFast = storeAntall * storeInntekt;    // store events (regnes flatt)
    var opplevelser = opplevSesongdel + opplevFast;

    var servise = num('servise_kunder') * num('servise_snitt');
    var nettbutikk = num('nettbutikk');
    var tilskudd = num('tilskudd');
    var kulturhub = num('kulturhub');
    var medlem = num('medlemmer') * num('medlempris');

    var inntekt = opplevelser + servise + nettbutikk + tilskudd + kulturhub + medlem;

    var faste = num('faste');
    var lonn = num('lonn');
    var variabelPst = num('variabel_pst');
    // Materialer: % av (opplevelse + nettbutikk)
    var variabel = (variabelPst / 100) * (opplevelser + nettbutikk);
    var kostnad = faste + lonn + variabel;

    var resultat = inntekt - kostnad;
    var margin = inntekt > 0 ? resultat / inntekt : 0;

    return {
      okter: okter, deltakere: deltakere, pris: pris,
      opplevSesongdel: opplevSesongdel, opplevFast: opplevFast,
      opplevelser: opplevelser, servise: servise, nettbutikk: nettbutikk,
      tilskudd: tilskudd, kulturhub: kulturhub, medlem: medlem,
      inntekt: inntekt,
      faste: faste, lonn: lonn, variabelPst: variabelPst, variabel: variabel,
      kostnad: kostnad, resultat: resultat, margin: margin,
    };
  }

  // Break-even: antall opplevelse-økter for å gå i null gitt øvrige tall.
  // Resultat(okter) = inntekt(okter) - kostnad(okter), lineær i okter.
  // pr-økt-inntekt = deltakere*pris ; pr-økt-variabel = (pst/100)*deltakere*pris
  // bidrag pr økt = deltakere*pris*(1 - pst/100)
  // basis (uten opplevelses-økter) = alt annet - kostnad-uten-okt-bidrag
  function breakEven(m) {
    var bidragPrOkt = m.deltakere * m.pris * (1 - m.variabelPst / 100);
    // Resultat med 0 økter:
    var inntekt0 = m.inntekt - m.opplevSesongdel;
    var variabel0 = (m.variabelPst / 100) * ((m.opplevFast) + m.nettbutikk);
    var kostnad0 = m.faste + m.lonn + variabel0;
    var resultat0 = inntekt0 - kostnad0;

    if (resultat0 >= 0) {
      return { iPluss: true, okter: 0, resultat0: resultat0 };
    }
    if (bidragPrOkt <= 0) {
      return { iPluss: false, umulig: true, okter: Infinity, resultat0: resultat0 };
    }
    var okter = -resultat0 / bidragPrOkt;
    return { iPluss: false, okter: Math.ceil(okter), eksakt: okter, resultat0: resultat0 };
  }

  // 12-mnd projeksjon: opplevelser-sesongdel vektes; store-events + øvrige flate.
  function projeksjon(m) {
    var v = sesongVekter();
    var mnd = [];
    var i, inntekt, resultat;
    var flatInntekt = m.opplevFast + m.servise + m.nettbutikk + m.tilskudd + m.kulturhub + m.medlem;
    for (i = 0; i < 12; i++) {
      var opplevSesong = m.opplevSesongdel * v[i];
      var opplevTot = opplevSesong + m.opplevFast;
      inntekt = opplevSesong + flatInntekt;
      var variabel = (m.variabelPst / 100) * (opplevTot + m.nettbutikk);
      var kostnad = m.faste + m.lonn + variabel;
      resultat = inntekt - kostnad;
      mnd.push({ navn: MND[i], inntekt: inntekt, kostnad: kostnad, resultat: resultat });
    }
    return mnd;
  }

  // ---- Render ----
  function settTekst(id, tekst) { var n = el(id); if (n) n.textContent = tekst; }

  function settResultatKlasse(id, verdi) {
    var n = el(id);
    if (!n) return;
    n.classList.remove('pos', 'neg');
    if (verdi > 0) n.classList.add('pos');
    else if (verdi < 0) n.classList.add('neg');
  }

  function renderStrommer(m) {
    settTekst('sum_opplevelser', kr(m.opplevelser));
    settTekst('sum_servise', kr(m.servise));
    settTekst('sum_nettbutikk', kr(m.nettbutikk));
    settTekst('sum_tilskudd', kr(m.tilskudd));
    settTekst('sum_kulturhub', kr(m.kulturhub));
    settTekst('sum_medlem', kr(m.medlem));
  }

  function renderKpi(m, proj, be) {
    settTekst('kpi_inntekt', kr(m.inntekt));
    settTekst('kpi_kostnad', kr(m.kostnad));
    settTekst('kpi_resultat', kr(m.resultat));
    settResultatKlasse('kpi_resultat', m.resultat);

    var marginPst = Math.round(m.margin * 100);
    settTekst('kpi_margin', 'margin ' + marginPst + ' %');

    var aar = 0, i;
    for (i = 0; i < proj.length; i++) aar += proj[i].resultat;
    settTekst('kpi_aar', kr(aar));
    settResultatKlasse('kpi_aar', aar);

    // Break-even
    if (be.iPluss) {
      settTekst('kpi_breakeven', '0');
    } else if (be.umulig) {
      settTekst('kpi_breakeven', '∞');
    } else {
      settTekst('kpi_breakeven', fmt(be.okter));
    }

    // Beste/verste måned
    var best = proj[0], verst = proj[0];
    for (i = 1; i < proj.length; i++) {
      if (proj[i].resultat > best.resultat) best = proj[i];
      if (proj[i].resultat < verst.resultat) verst = proj[i];
    }
    settTekst('kpi_minmax', best.navn + ' ' + fmt(best.resultat) + ' / ' + verst.navn + ' ' + fmt(verst.resultat));
  }

  function renderBars(proj) {
    var holder = el('bars');
    if (!holder) return;
    holder.innerHTML = '';

    // Maks skala = høyeste av inntekt og kostnad gjennom året.
    var maks = 1, i;
    for (i = 0; i < proj.length; i++) {
      if (proj[i].inntekt > maks) maks = proj[i].inntekt;
      if (proj[i].kostnad > maks) maks = proj[i].kostnad;
    }

    for (i = 0; i < proj.length; i++) {
      var p = proj[i];
      var hoyde = Math.max(2, Math.round((p.inntekt / maks) * 100));
      var kostHoyde = Math.round((p.kostnad / maks) * 100);
      var farge = p.resultat >= 0 ? 'var(--turq)' : '#c0492f';

      var wrap = document.createElement('div');
      wrap.className = 'barwrap';

      var bar = document.createElement('div');
      bar.className = 'bar';
      bar.style.height = hoyde + '%';
      bar.style.background = farge;
      bar.style.position = 'relative';
      bar.title = p.navn + ': inntekt ' + kr(p.inntekt) + ', kostnad ' + kr(p.kostnad) +
        ', resultat ' + kr(p.resultat);

      // Kostnadsnivå-strek (mørk linje på kostnadshøyden over hele søylebredden).
      var kostLinje = document.createElement('div');
      kostLinje.style.position = 'absolute';
      kostLinje.style.left = '-18%';
      kostLinje.style.right = '-18%';
      // Plasser streken relativt til søyletoppen (kost over/under inntekt).
      kostLinje.style.bottom = (kostHoyde - hoyde) + '%';
      kostLinje.style.height = '2px';
      kostLinje.style.background = 'var(--sea-deep)';
      kostLinje.style.opacity = '0.85';
      bar.appendChild(kostLinje);

      var lbl = document.createElement('div');
      lbl.className = 'barlbl';
      lbl.textContent = p.navn;

      wrap.appendChild(bar);
      wrap.appendChild(lbl);
      holder.appendChild(wrap);
    }
  }

  function renderBrk(m) {
    var tbody = el('brk');
    if (!tbody) return;
    tbody.innerHTML = '';

    var kilder = [
      { navn: 'Opplevelser', verdi: m.opplevelser },
      { navn: 'Servise', verdi: m.servise },
      { navn: 'Nettbutikk', verdi: m.nettbutikk },
      { navn: 'Skole + barneklubb', verdi: m.tilskudd },
      { navn: 'Kulturhub', verdi: m.kulturhub },
      { navn: 'Medlemskap', verdi: m.medlem },
    ];

    var maks = 1, i;
    for (i = 0; i < kilder.length; i++) if (kilder[i].verdi > maks) maks = kilder[i].verdi;

    for (i = 0; i < kilder.length; i++) {
      var k = kilder[i];
      var pst = Math.round((k.verdi / maks) * 100);

      var tr = document.createElement('tr');

      var tdNavn = document.createElement('td');
      tdNavn.textContent = k.navn;

      var tdBar = document.createElement('td');
      tdBar.className = 'barcell';
      var mini = document.createElement('div');
      mini.className = 'minibar';
      mini.style.width = Math.max(2, pst) + '%';
      tdBar.appendChild(mini);

      var tdVerdi = document.createElement('td');
      tdVerdi.textContent = kr(k.verdi);

      tr.appendChild(tdNavn);
      tr.appendChild(tdBar);
      tr.appendChild(tdVerdi);
      tbody.appendChild(tr);
    }
  }

  function renderBreakEven(m, be) {
    if (be.iPluss) {
      settTekst('be_big', '✓');
      settTekst('be_txt',
        'Allerede i pluss uten flere opplevelse-økter. ' +
        'De øvrige inntektene dekker kostnadene med ' + kr(be.resultat0) + ' i overskudd per måned.');
      return;
    }
    if (be.umulig) {
      settTekst('be_big', '—');
      settTekst('be_txt',
        'Opplevelse-økter gir ikke positivt bidrag med dagens deltakere/pris/materialprosent. ' +
        'Juster pris, deltakere eller materialandel.');
      return;
    }
    settTekst('be_big', fmt(be.okter));
    settTekst('be_txt',
      'opplevelse-økter per måned skal til for å dekke kostnadene (gitt øvrige tall). ' +
      'Du ligger nå på ' + fmt(m.okter) + ' økter.');
  }

  // ---- Hovedberegning ----
  function regn() {
    var m = lesModell();
    var be = breakEven(m);
    var proj = projeksjon(m);

    renderStrommer(m);
    renderKpi(m, proj, be);
    renderBars(proj);
    renderBrk(m);
    renderBreakEven(m, be);
  }

  // ---- Scenarioer / lagring ----
  function settInputs(verdier) {
    FELT.forEach(function (id) {
      var n = el(id);
      if (n && verdier[id] !== undefined && verdier[id] !== null) {
        n.value = verdier[id];
      }
    });
  }

  function lesInputs() {
    var ut = {};
    FELT.forEach(function (id) { ut[id] = num(id); });
    return ut;
  }

  function markerAktiv(scn) {
    var knapper = document.querySelectorAll('#scenarios button[data-scn]');
    knapper.forEach(function (b) {
      if (b.getAttribute('data-scn') === scn) b.classList.add('active');
      else b.classList.remove('active');
    });
  }

  function brukScenario(scn) {
    var sett = SCENARIOER[scn];
    if (!sett) return;
    settInputs(sett);
    markerAktiv(scn);
    regn();
  }

  function lagreLokalt() {
    try {
      localStorage.setItem(LAGER_NOKKEL, JSON.stringify(lesInputs()));
    } catch (e) { /* localStorage utilgjengelig — ignorer */ }
  }

  function lastLokalt() {
    try {
      var raw = localStorage.getItem(LAGER_NOKKEL);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (e) {
      return null;
    }
  }

  // Bonus: prøv å lagre til server hvis innlogget admin. Stille fallback.
  function lagreServer() {
    try {
      fetch('/api/finance', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ navn: 'Mitt scenario', data: lesInputs() }),
      }).catch(function () { /* ignorer */ });
    } catch (e) { /* ignorer */ }
  }

  function haandterLagre() {
    lagreLokalt();
    lagreServer();
    var knapp = el('lagre');
    if (knapp) {
      var orig = knapp.textContent;
      knapp.textContent = '✓ Lagret';
      setTimeout(function () { knapp.textContent = orig; }, 1400);
    }
  }

  function haandterNullstill() {
    try { localStorage.removeItem(LAGER_NOKKEL); } catch (e) { /* ignorer */ }
    brukScenario('middels');
  }

  // ---- Init ----
  function init() {
    // Koble scenario-knapper
    var scnKnapper = document.querySelectorAll('#scenarios button[data-scn]');
    scnKnapper.forEach(function (b) {
      b.addEventListener('click', function () {
        brukScenario(b.getAttribute('data-scn'));
      });
    });

    var lagre = el('lagre');
    if (lagre) lagre.addEventListener('click', haandterLagre);
    var nullstill = el('nullstill');
    if (nullstill) nullstill.addEventListener('click', haandterNullstill);

    // Regn på nytt ved hver input-endring
    FELT.forEach(function (id) {
      var n = el(id);
      if (n) n.addEventListener('input', regn);
    });

    // Last lagret state, ellers middels som default.
    var lagret = lastLokalt();
    if (lagret) {
      settInputs(lagret);
      markerAktiv(null); // ingen ren scenario-match — fjern aktiv-markering
      regn();
    } else {
      brukScenario('middels');
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
