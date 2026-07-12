/* Havstund — regnskap (admin). Fiken-formet: konto, MVA-kode, beløp i øre. */
(function () {
  'use strict';

  // ---- Kontoplan (norsk standard, tilpasset Havstund) ----
  var INNTEKT_KONTI = [
    { n: 3000, t: 'Salg, avgiftspliktig (25%)', sats: 25 },
    { n: 3200, t: 'Salg varer / butikk (25%)', sats: 25 },
    { n: 3100, t: 'Salg, avgiftsfritt (0%)', sats: 0 },
  ];
  var UTGIFT_KONTI = [
    { n: 4000, t: 'Varekjøp (leire, glasur, materialer)', sats: 25 },
    { n: 6300, t: 'Leie lokale', sats: 25 },
    { n: 6420, t: 'Leie utstyr/maskiner', sats: 25 },
    { n: 6540, t: 'Inventar og utstyr', sats: 25 },
    { n: 6800, t: 'Kontorrekvisita', sats: 25 },
    { n: 6900, t: 'Telefon / internett', sats: 25 },
    { n: 7140, t: 'Reise', sats: 12 },
    { n: 7320, t: 'Markedsføring', sats: 25 },
    { n: 7700, t: 'Annen driftskostnad', sats: 0 },
  ];
  var MVA_SATSER = [25, 15, 12, 0];

  // Fiken MVA-kode ut fra type + sats
  function mvaKode(type, sats) {
    if (type === 'inntekt') return sats === 25 ? 3 : sats === 15 ? 33 : sats === 12 ? 31 : 6;
    return sats === 25 ? 1 : sats === 15 ? 11 : sats === 12 ? 12 : 0;
  }

  // ---- Hjelpere ----
  var krFmt = new Intl.NumberFormat('no-NO', { style: 'currency', currency: 'NOK' });
  function kr(ore) { return krFmt.format((Number(ore) || 0) / 100); }
  function tilOre(krVerdi) {
    var n = parseFloat(String(krVerdi).replace(/\s/g, '').replace(',', '.'));
    return Number.isFinite(n) ? Math.round(n * 100) : 0;
  }
  function timer(t) { return (Number(t) || 0).toLocaleString('no-NO', { maximumFractionDigits: 2 }); }
  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function api(sti, opt) {
    opt = opt || {};
    opt.credentials = 'same-origin';
    opt.headers = Object.assign({ 'Content-Type': 'application/json' }, opt.headers || {});
    return fetch(sti, opt);
  }
  function visFeil(id, tekst) {
    var el = $(id); if (!el) return;
    el.textContent = tekst || '';
    el.classList.toggle('vis', !!tekst);
  }
  function naaMaaned() {
    var d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
  }
  function iDag() {
    var d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function maaned() { return $('maaned').value || naaMaaned(); }

  // ---- Fyll select-er ----
  function fyllKonti() {
    function opt(k) { return '<option value="' + k.n + '" data-sats="' + k.sats + '">' + k.n + ' — ' + esc(k.t) + '</option>'; }
    document.querySelectorAll('.konto-inn').forEach(function (s) { s.innerHTML = INNTEKT_KONTI.map(opt).join(''); });
    document.querySelectorAll('.konto-ut').forEach(function (s) { s.innerHTML = UTGIFT_KONTI.map(opt).join(''); });
    document.querySelectorAll('.mva-sel').forEach(function (s) {
      s.innerHTML = MVA_SATSER.map(function (v) { return '<option value="' + v + '">' + v + '%</option>'; }).join('');
    });
    // Når konto endres: sett MVA til kontoens standardsats
    document.querySelectorAll('.konto-inn,.konto-ut').forEach(function (sel) {
      sel.addEventListener('change', function () {
        var sats = sel.options[sel.selectedIndex].getAttribute('data-sats');
        var mva = sel.closest('form').querySelector('.mva-sel');
        if (mva && sats != null) mva.value = sats;
      });
    });
  }

  // ---- OVERSIKT ----
  function lastOversikt() {
    api('/api/regnskap/oversikt?maaned=' + maaned()).then(function (r) { return r.json(); }).then(function (d) {
      if (!d || d.error) return;
      $('o-inntekt').textContent = kr(d.inntekt_netto);
      $('o-utgift').textContent = kr(d.utgift_netto);
      var resEl = $('o-resultat');
      resEl.textContent = kr(d.resultat_ore);
      resEl.className = 'val ' + (d.resultat_ore >= 0 ? 'pos' : 'neg');
      $('o-mva').textContent = kr(d.mva_aa_betale);
      $('o-timer').textContent = timer(d.sum_timer) + ' t';
      $('o-lonn').textContent = kr(d.lonn_ore);
      tegnGraf(d);
    }).catch(function () {});
    lastFikenStatus();
  }

  // ---- Graf (Chart.js): inntekt / utgift / resultat ----
  var grafInstans = null;
  function tegnGraf(d) {
    var el = $('oversikt-graf');
    if (!el || typeof Chart !== 'function') return;
    var verdier = [d.inntekt_netto / 100, d.utgift_netto / 100, d.resultat_ore / 100];
    var farger = ['#1f7a4d', '#b03a2e', d.resultat_ore >= 0 ? '#163e66' : '#b03a2e'];
    if (grafInstans) {
      grafInstans.data.datasets[0].data = verdier;
      grafInstans.data.datasets[0].backgroundColor = farger;
      grafInstans.update();
      return;
    }
    grafInstans = new Chart(el, {
      type: 'bar',
      data: { labels: ['Inntekter', 'Utgifter', 'Resultat'],
        datasets: [{ data: verdier, backgroundColor: farger, borderRadius: 8, maxBarThickness: 90 }] },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false },
          tooltip: { callbacks: { label: function (c) { return kr(Math.round(c.parsed.y * 100)); } } } },
        scales: { y: { beginAtZero: true, ticks: { callback: function (v) { return v.toLocaleString('no-NO') + ' kr'; } } } }
      }
    });
  }

  // ---- Excel-eksport (SheetJS, lastes ved behov) ----
  function lastXLSX() {
    if (window.XLSX) return Promise.resolve();
    return new Promise(function (res, rej) {
      var s = document.createElement('script');
      s.src = 'https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js';
      s.onload = res; s.onerror = rej;
      document.head.appendChild(s);
    });
  }
  function eksporterExcel() {
    var m = maaned();
    lastXLSX()
      .then(function () { return api('/api/regnskap/poster?maaned=' + m).then(function (r) { return r.json(); }); })
      .then(function (rows) {
        rows = Array.isArray(rows) ? rows : [];
        if (!rows.length) { alert('Ingen poster å eksportere for ' + m + '.'); return; }
        var data = rows.map(function (p) {
          return {
            Dato: String(p.dato || '').slice(0, 10),
            Type: p.type,
            Beskrivelse: p.beskrivelse,
            Kontakt: p.kontakt || '',
            Konto: p.konto || '',
            'MVA %': p.mva_sats || 0,
            'Netto (kr)': (p.netto_ore || 0) / 100,
            'MVA (kr)': (p.mva_ore || 0) / 100,
            'Brutto (kr)': (p.brutto_ore || 0) / 100
          };
        });
        var ws = XLSX.utils.json_to_sheet(data);
        var wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, m);
        XLSX.writeFile(wb, 'havstund-regnskap-' + m + '.xlsx');
      })
      .catch(function () { alert('Kunne ikke eksportere. Prøv igjen.'); });
  }

  // ---- FIKEN-STATUS ----
  function lastFikenStatus() {
    var el = $('fiken-status');
    if (!el) return;
    api('/api/regnskap/fiken/status').then(function (r) { return r.json(); }).then(function (d) {
      if (!d || d.error) { el.textContent = ''; return; }
      var n = Number(d.antall_usendt) || 0;
      el.textContent = d.konfigurert
        ? n + ' poster klare til eksport.'
        : 'Regnskapsprogram er ikke koblet til ennå — ' + n + ' poster venter.';
    }).catch(function () { el.textContent = ''; });
  }

  // ---- POSTER (inntekt/utgift) ----
  function radPost(p) {
    var vedleggLenke = p.har_vedlegg
      ? '<br><a href="/api/regnskap/poster/' + p.id + '/vedlegg" target="_blank" rel="noopener" style="font-size:12px;font-weight:700;color:var(--teal)">Kvittering</a>'
      : '';
    return '<tr>' +
      '<td>' + esc(p.dato) + '</td>' +
      '<td>' + esc(p.beskrivelse) + (p.kontakt ? '<br><span style="color:var(--muted);font-size:12px">' + esc(p.kontakt) + '</span>' : '') + vedleggLenke + '</td>' +
      '<td><span class="konto-tag">' + (p.konto || '–') + '</span></td>' +
      '<td class="num">' + kr(p.netto_ore) + '</td>' +
      '<td class="num">' + (p.mva_sats ? p.mva_sats + '%' : '–') + '</td>' +
      '<td class="num belop">' + kr(p.brutto_ore) + '</td>' +
      '<td class="num"><button class="slett" data-slett-post="' + p.id + '">Slett</button></td>' +
      '</tr>';
  }
  function tabellPoster(rows) {
    if (!rows.length) return '<p class="tom">Ingen poster denne måneden ennå.</p>';
    var netto = 0, brutto = 0;
    rows.forEach(function (p) { netto += Number(p.netto_ore); brutto += Number(p.brutto_ore); });
    return '<table class="tbl"><thead><tr>' +
      '<th>Dato</th><th>Beskrivelse</th><th>Konto</th><th class="num">Netto</th><th class="num">MVA</th><th class="num">Brutto</th><th></th>' +
      '</tr></thead><tbody>' +
      rows.map(radPost).join('') +
      '<tr class="sum-rad"><td colspan="3">Sum</td><td class="num">' + kr(netto) + '</td><td></td><td class="num">' + kr(brutto) + '</td><td></td></tr>' +
      '</tbody></table>';
  }
  function lastPoster(type, listeId) {
    api('/api/regnskap/poster?type=' + type + '&maaned=' + maaned()).then(function (r) { return r.json(); }).then(function (rows) {
      $(listeId).innerHTML = tabellPoster(Array.isArray(rows) ? rows : []);
    }).catch(function () { $(listeId).innerHTML = '<p class="tom">Kunne ikke hente.</p>'; });
  }

  function sendPost(type, form, feilId, listeId) {
    var f = form.elements;
    visFeil(feilId, '');
    var sats = Number(f.mva_sats.value);
    var kropp = {
      type: type,
      dato: f.dato.value,
      beskrivelse: f.beskrivelse.value.trim(),
      kontakt: f.kontakt ? f.kontakt.value.trim() : '',
      konto: Number(f.konto.value),
      mva_sats: sats,
      mva_kode: mvaKode(type, sats),
      netto_ore: tilOre(f.netto.value),
      betalingsmetode: f.betalingsmetode ? f.betalingsmetode.value : null,
      kilde: 'manuell',
    };
    if (!kropp.beskrivelse) { visFeil(feilId, 'Skriv en beskrivelse.'); return; }
    if (!kropp.netto_ore) { visFeil(feilId, 'Skriv et beløp.'); return; }

    function gjorPost(body) {
      api('/api/regnskap/poster', { method: 'POST', body: JSON.stringify(body) })
        .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
        .then(function (res) {
          if (!res.ok) { visFeil(feilId, res.d.error || 'Kunne ikke lagre.'); return; }
          form.reset(); fyllStandardDato();
          lastPoster(type, listeId); lastOversikt();
        })
        .catch(function () { visFeil(feilId, 'Noe gikk galt. Prøv igjen.'); });
    }

    // Kvittering (valgfri, kun utgift): les som data-URL og legg ved før POST.
    var fil = f.vedlegg && f.vedlegg.files ? f.vedlegg.files[0] : null;
    if (fil) {
      var MAKS = 2.5 * 1024 * 1024; // ~2,5 MB
      if (fil.size > MAKS) {
        visFeil(feilId, 'Bildet er for stort — velg et mindre bilde (maks ~2,5 MB).');
        return;
      }
      var reader = new FileReader();
      reader.onload = function () { kropp.vedlegg = reader.result; gjorPost(kropp); };
      reader.onerror = function () { visFeil(feilId, 'Kunne ikke lese bildet. Prøv igjen.'); };
      reader.readAsDataURL(fil);
      return;
    }

    gjorPost(kropp);
  }

  // ---- ANSATTE ----
  var ansattCache = [];
  function lastAnsatte() {
    return api('/api/regnskap/ansatte').then(function (r) { return r.json(); }).then(function (rows) {
      ansattCache = Array.isArray(rows) ? rows : [];
      // liste
      var aktive = ansattCache.filter(function (a) { return a.aktiv; });
      $('liste-ansatt').innerHTML = aktive.length
        ? '<table class="tbl"><thead><tr><th>Navn</th><th>Stilling</th><th class="num">Timelønn</th></tr></thead><tbody>' +
          aktive.map(function (a) {
            return '<tr><td>' + esc(a.navn) + '</td><td>' + esc(a.stilling || '–') + '</td><td class="num belop">' + kr(a.timelonn_ore) + '/t</td></tr>';
          }).join('') + '</tbody></table>'
        : '<p class="tom">Ingen ansatte lagt til ennå.</p>';
      // dropdown
      var sel = $('timer-ansatt');
      sel.innerHTML = aktive.map(function (a) { return '<option value="' + a.id + '">' + esc(a.navn) + '</option>'; }).join('');
    }).catch(function () {});
  }

  // ---- TIMER ----
  function lastTimer() {
    api('/api/regnskap/timer?maaned=' + maaned()).then(function (r) { return r.json(); }).then(function (rows) {
      rows = Array.isArray(rows) ? rows : [];
      if (!rows.length) { $('liste-timer').innerHTML = '<p class="tom">Ingen timer ført denne måneden.</p>'; return; }
      var sum = 0; rows.forEach(function (t) { sum += Number(t.timer); });
      $('liste-timer').innerHTML = '<table class="tbl"><thead><tr><th>Dato</th><th>Ansatt</th><th>Aktivitet</th><th class="num">Timer</th><th></th></tr></thead><tbody>' +
        rows.map(function (t) {
          return '<tr><td>' + esc(t.dato) + '</td><td>' + esc(t.ansatt_navn) + '</td><td>' + esc(t.aktivitet || '–') + '</td>' +
            '<td class="num belop">' + timer(t.timer) + '</td>' +
            '<td class="num"><button class="slett" data-slett-time="' + t.id + '">Slett</button></td></tr>';
        }).join('') +
        '<tr class="sum-rad"><td colspan="3">Sum timer</td><td class="num">' + timer(sum) + '</td><td></td></tr>' +
        '</tbody></table>';
    }).catch(function () {});
  }

  // ---- LØNN (med feriepenger + arbeidsgiveravgift for AS) ----
  function lastLonn() {
    api('/api/regnskap/lonn?maaned=' + maaned()).then(function (r) { return r.json(); }).then(function (d) {
      if (!d || d.error) { $('liste-lonn').innerHTML = '<p class="tom">Kunne ikke hente.</p>'; return; }
      if (!d.ansatte.length) { $('liste-lonn').innerHTML = '<p class="tom">Legg til ansatte og før timer først.</p>'; return; }

      var ferieSats = parseFloat(($('sats-ferie') || {}).value) || 0;
      var agaSats = parseFloat(($('sats-aga') || {}).value) || 0;
      var brutto = Number(d.total_brutto_ore);
      var ferie = Math.round(brutto * ferieSats / 100);
      var aga = Math.round((brutto + ferie) * agaSats / 100);
      var total = brutto + ferie + aga;

      $('liste-lonn').innerHTML =
        '<table class="tbl"><thead><tr><th>Ansatt</th><th>Konto</th><th class="num">Timer</th><th class="num">Timelønn</th><th class="num">Brutto lønn</th></tr></thead><tbody>' +
        d.ansatte.map(function (a) {
          return '<tr><td>' + esc(a.navn) + (a.stilling ? '<br><span style="color:var(--muted);font-size:12px">' + esc(a.stilling) + '</span>' : '') + '</td>' +
            '<td><span class="konto-tag">' + a.konto + '</span></td>' +
            '<td class="num">' + timer(a.sum_timer) + '</td>' +
            '<td class="num">' + kr(a.timelonn_ore) + '</td>' +
            '<td class="num belop">' + kr(a.brutto_ore) + '</td></tr>';
        }).join('') +
        '</tbody></table>' +
        '<table class="tbl" style="margin-top:18px;max-width:520px">' +
        '<tr><td>Brutto lønn</td><td class="num belop">' + kr(brutto) + '</td></tr>' +
        '<tr><td>+ Feriepenger (' + ferieSats + '%)</td><td class="num">' + kr(ferie) + '</td></tr>' +
        '<tr><td>+ Arbeidsgiveravgift (' + agaSats + '%)</td><td class="num">' + kr(aga) + '</td></tr>' +
        '<tr class="sum-rad"><td>= Total arbeidsgiverkostnad</td><td class="num">' + kr(total) + '</td></tr>' +
        '</table>' +
        '<div class="fiken-note" style="margin-top:14px"><b>Lønnskjøring:</b> brutto lønn bokføres på konto 5000, arbeidsgiveravgift på 5400, og feriepenger avsettes automatisk i regnskapet. Hver ansatt får lønnsslipp ut fra timene over.</div>';
    }).catch(function () {});
  }

  // ---- DAGSOPPGJØR («lukk dagen» + regnskapspakke) ----
  function lastDagsoppgjor() {
    var m = maaned();
    visFeil('feil-dagsoppgjor', '');
    Promise.all([
      api('/api/regnskap/poster?maaned=' + m).then(function (r) { return r.ok ? r.json() : []; }),
      api('/api/regnskap/dagsoppgjor?maaned=' + m).then(function (r) { return r.ok ? r.json() : []; })
    ]).then(function (svar) {
      var poster = Array.isArray(svar[0]) ? svar[0] : [];
      var lukkede = Array.isArray(svar[1]) ? svar[1] : [];
      tegnDagsoppgjor(poster, lukkede);
    }).catch(function () {
      $('liste-dagsoppgjor').innerHTML = '<p class="tom">Kunne ikke hente dagsoppgjør.</p>';
    });
  }

  function tegnDagsoppgjor(poster, lukkede) {
    // Lukkede dager: dato (YYYY-MM-DD) -> lagret rad (viser serverens snapshot).
    var lukket = {};
    lukkede.forEach(function (d) { lukket[String(d.dato).slice(0, 10)] = d; });
    // Åpne dager: grupper poster per dag med ABS-brutto — SAMME konvensjon som
    // serveren bruker når dagen lukkes (SUM(ABS(brutto_ore))), så tallet i
    // bekreftelsen matcher det som faktisk lagres.
    var apne = {};
    poster.forEach(function (p) {
      var dag = String(p.dato).slice(0, 10);
      if (lukket[dag]) return; // hører til en allerede lukket dag
      if (!apne[dag]) apne[dag] = { antall: 0, brutto: 0 };
      apne[dag].antall += 1;
      apne[dag].brutto += Math.abs(Number(p.brutto_ore) || 0);
    });

    // Union av dager, sortert stigende på dato (samme som resten av siden).
    var sett = {};
    Object.keys(lukket).forEach(function (k) { sett[k] = true; });
    Object.keys(apne).forEach(function (k) { sett[k] = true; });
    var dager = Object.keys(sett).sort();

    if (!dager.length) {
      $('liste-dagsoppgjor').innerHTML = '<p class="tom">Ingen bilag eller lukkede dager denne måneden ennå.</p>';
      return;
    }

    var rader = dager.map(function (dag) {
      var l = lukket[dag];
      if (l) {
        var tid = l.lukket_tid ? String(l.lukket_tid).slice(0, 10) : '';
        var undertekst = l.lukket_av
          ? '<br><span style="color:var(--muted);font-size:12px">' + esc(l.lukket_av) + (tid ? ' · ' + esc(tid) : '') + '</span>'
          : '';
        return '<tr>' +
          '<td>' + esc(dag) + '</td>' +
          '<td class="num">' + (Number(l.antall_bilag) || 0) + '</td>' +
          '<td class="num belop">' + kr(l.brutto_ore) + '</td>' +
          '<td><span class="laast-tag">Låst</span>' + undertekst + '</td>' +
          '<td></td>' +
          '</tr>';
      }
      var a = apne[dag];
      return '<tr>' +
        '<td>' + esc(dag) + '</td>' +
        '<td class="num">' + a.antall + '</td>' +
        '<td class="num belop">' + kr(a.brutto) + '</td>' +
        '<td><span class="aapen-tag">Åpen</span></td>' +
        '<td class="num"><button class="lukk-btn" data-lukk-dag="' + esc(dag) + '" data-lukk-brutto="' + a.brutto + '" data-lukk-antall="' + a.antall + '">Lukk dag</button></td>' +
        '</tr>';
    }).join('');

    $('liste-dagsoppgjor').innerHTML =
      '<table class="tbl"><thead><tr>' +
      '<th>Dato</th><th class="num">Bilag</th><th class="num">Brutto</th><th>Status</th><th></th>' +
      '</tr></thead><tbody>' + rader + '</tbody></table>';
  }

  function lukkDag(dato) {
    visFeil('feil-dagsoppgjor', '');
    api('/api/regnskap/dagsoppgjor/' + dato, { method: 'POST' })
      .then(function (r) {
        return r.json().then(
          function (d) { return { ok: r.ok, status: r.status, d: d }; },
          function () { return { ok: r.ok, status: r.status, d: {} }; }
        );
      })
      .then(function (res) {
        if (!res.ok) {
          if (res.status === 403) visFeil('feil-dagsoppgjor', 'Kun admin kan lukke dager.');
          else if (res.status === 409) visFeil('feil-dagsoppgjor', 'Dagen er allerede lukket.');
          else visFeil('feil-dagsoppgjor', (res.d && res.d.error) || 'Kunne ikke lukke dagen.');
        }
        lastDagsoppgjor(); // refresh uansett (409 → oppdatert låsestatus)
      })
      .catch(function () { visFeil('feil-dagsoppgjor', 'Noe gikk galt. Prøv igjen.'); });
  }

  function lastPakke() {
    var m = maaned();
    var el = $('pakke-status');
    visFeil('feil-pakke', '');
    if (el) el.textContent = 'Genererer pakke …';
    api('/api/regnskap/pakke/' + m)
      .then(function (r) {
        return r.json().then(
          function (d) { return { ok: r.ok, status: r.status, d: d }; },
          function () { return { ok: r.ok, status: r.status, d: {} }; }
        );
      })
      .then(function (res) {
        if (el) el.textContent = '';
        if (!res.ok) {
          if (res.status === 403) { visFeil('feil-pakke', 'Kun admin kan laste ned regnskapspakken.'); return; }
          if (res.status === 422) {
            var detalj = (res.d && res.d.detalj) || (res.d && res.d.error) || 'ukjent årsak';
            visFeil('feil-pakke', 'Månedens data balanserer ikke — ' + detalj + '. Rett før du kan generere pakken.');
            return;
          }
          visFeil('feil-pakke', (res.d && res.d.error) || 'Kunne ikke lage regnskapspakken.');
          return;
        }
        var pakke = res.d && res.d.pakke;
        var manifest = res.d && res.d.manifest;
        if (!pakke) { visFeil('feil-pakke', 'Tomt svar fra serveren.'); return; }
        // Kompakt JSON.stringify — NØYAKTIG bytene serveren hashet/signerte
        // (manifest.sha256). Pretty-print ville brutt byte-for-byte-verifisering.
        lastNedJson(pakke, 'regnskapspakke-' + m + '.json');
        if (el) {
          el.textContent = (manifest && manifest.signert === false)
            ? 'Pakke lastet ned. Manifest usignert (mangler serverkonfig).'
            : 'Pakke lastet ned. Manifest signert.';
        }
      })
      .catch(function () { if (el) el.textContent = ''; visFeil('feil-pakke', 'Noe gikk galt. Prøv igjen.'); });
  }

  function lastNedJson(obj, filnavn) {
    var blob = new Blob([JSON.stringify(obj)], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = filnavn;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 0);
  }

  // ---- Datostandard ----
  function fyllStandardDato() {
    document.querySelectorAll('input[type="date"]').forEach(function (i) { if (!i.value) i.value = iDag(); });
  }

  // ---- AI-forslag fra kvittering (kun admin m/ AI-agent påslått) ----
  // Kjeden: fil → base64 → POST /api/brain/ask (bilde-blokk) → forslag →
  // POST /api/brain/confirm. Degraderer pent når brain er av (401/403/404/503).
  var aiForslag = null;      // sisteproposal (toolUseId + confirmToken + summary)
  var aiConversationId = null;

  function aiDegrader(melding) {
    var s = $('ai-status'); if (s) s.textContent = melding || 'AI-assistent ikke tilgjengelig — fyll inn manuelt.';
    var boks = $('ai-forslag'); if (boks) boks.style.display = 'none';
    aiForslag = null;
  }

  function erAvSkrudd(status) {
    return status === 401 || status === 403 || status === 404 || status === 503;
  }

  function aiLesKvittering() {
    visFeil('feil-ai', '');
    var input = $('ai-fil');
    var fil = input && input.files ? input.files[0] : null;
    if (!fil) { visFeil('feil-ai', 'Velg et kvitteringsbilde først.'); return; }
    var LOV = ['image/png', 'image/jpeg', 'image/webp'];
    if (LOV.indexOf(fil.type) === -1) { visFeil('feil-ai', 'Kun PNG, JPEG eller WEBP.'); return; }
    var MAKS = 5 * 1024 * 1024; // 5 MB
    if (fil.size > MAKS) { visFeil('feil-ai', 'Bildet er for stort — velg et mindre bilde (maks 5 MB).'); return; }
    var reader = new FileReader();
    reader.onerror = function () { visFeil('feil-ai', 'Kunne ikke lese bildet. Prøv igjen.'); };
    reader.onload = function () {
      // reader.result = "data:<type>;base64,<data>" — send kun base64-delen.
      var deler = String(reader.result).split(',');
      var base64 = deler.length > 1 ? deler[1] : '';
      if (!base64) { visFeil('feil-ai', 'Kunne ikke lese bildet. Prøv igjen.'); return; }
      aiSend(fil.type, base64);
    };
    reader.readAsDataURL(fil);
  }

  function aiSend(mediaType, data) {
    var knapp = $('ai-foreslaa');
    var status = $('ai-status');
    if (knapp) knapp.disabled = true;
    if (status) status.textContent = 'Leser kvittering …';
    var boks = $('ai-forslag'); if (boks) boks.style.display = 'none';
    api('/api/brain/ask', {
      method: 'POST',
      body: JSON.stringify({
        text: 'Les denne kvitteringen og foreslå en utgiftspost.',
        images: [{ type: 'image', source: { type: 'base64', media_type: mediaType, data: data } }]
      })
    })
      .then(function (r) {
        return r.json().then(
          function (d) { return { ok: r.ok, status: r.status, d: d }; },
          function () { return { ok: r.ok, status: r.status, d: {} }; }
        );
      })
      .then(function (res) {
        if (status) status.textContent = '';
        if (!res.ok) {
          if (erAvSkrudd(res.status)) { aiDegrader(); return; }
          if (res.status === 413) { visFeil('feil-ai', 'Bildet er for stort for serveren — velg et mindre/komprimert bilde.'); return; }
          visFeil('feil-ai', (res.d && res.d.error) || 'Kunne ikke lese kvitteringen. Prøv igjen.');
          return;
        }
        aiVisForslag(res.d || {});
      })
      .catch(function () { if (status) status.textContent = ''; aiDegrader('AI-assistent ikke tilgjengelig — fyll inn manuelt.'); })
      .then(function () { if (knapp) knapp.disabled = false; });
  }

  function aiVisForslag(turn) {
    var boks = $('ai-forslag');
    if (!boks) return;
    aiConversationId = turn.conversationId || null;
    var tekst = turn.text ? '<p style="margin-bottom:8px">' + esc(turn.text) + '</p>' : '';
    if (turn.kind === 'proposal' && turn.proposal) {
      aiForslag = turn.proposal;
      boks.innerHTML = '<div class="fiken-note">' + tekst +
        '<p><b>Forslag:</b> ' + esc(turn.proposal.summary || '') + '</p>' +
        '<button type="button" id="ai-bekreft" class="btn btn-primary" style="margin-top:10px">Bekreft og lagre</button>' +
        '<button type="button" id="ai-avvis" class="btn btn-ghost" style="margin-top:10px;margin-left:8px">Avvis</button>' +
        '</div>';
      boks.style.display = 'block';
      $('ai-bekreft').addEventListener('click', aiBekreft);
      $('ai-avvis').addEventListener('click', function () { boks.style.display = 'none'; aiForslag = null; });
    } else {
      // Endelig svar uten skrive-forslag (f.eks. skygge-modus eller uklart bilde).
      aiForslag = null;
      boks.innerHTML = '<div class="fiken-note">' + (tekst || esc('Ingen konkret post foreslått — fyll inn manuelt.')) + '</div>';
      boks.style.display = 'block';
    }
  }

  function aiBekreft() {
    if (!aiForslag) return;
    visFeil('feil-ai', '');
    var knapp = $('ai-bekreft');
    if (knapp) { knapp.disabled = true; knapp.textContent = 'Lagrer …'; }
    api('/api/brain/confirm', {
      method: 'POST',
      body: JSON.stringify({
        toolUseId: aiForslag.toolUseId,
        confirmToken: aiForslag.confirmToken,
        conversationId: aiConversationId || undefined
      })
    })
      .then(function (r) {
        return r.json().then(
          function (d) { return { ok: r.ok, status: r.status, d: d }; },
          function () { return { ok: r.ok, status: r.status, d: {} }; }
        );
      })
      .then(function (res) {
        if (!res.ok) {
          if (erAvSkrudd(res.status)) { aiDegrader(); return; }
          visFeil('feil-ai', (res.d && res.d.error) || 'Kunne ikke lagre forslaget.');
          if (knapp) { knapp.disabled = false; knapp.textContent = 'Bekreft og lagre'; }
          return;
        }
        var boks = $('ai-forslag');
        if (boks) boks.innerHTML = '<div class="fiken-note">' + esc((res.d && res.d.text) || 'Utført.') + '</div>';
        aiForslag = null;
        // Ny post kan ha blitt opprettet — oppdater listen + oversikten.
        lastPoster('utgift', 'liste-utgift');
        lastOversikt();
      })
      .catch(function () {
        visFeil('feil-ai', 'Noe gikk galt. Prøv igjen.');
        if (knapp) { knapp.disabled = false; knapp.textContent = 'Bekreft og lagre'; }
      });
  }

  // ---- ADMIN-TIMEKALENDER (bolge 98, steg 7) ----
  // Gjenbruker den landede kalender-komponenten (window.HavstundKalender) for
  // "admin selv"-visning (apiBasis '/api/min'), og en manuell grid mot
  // /api/regnskap/timer for andre ansatte (komponenten stotter ikke ansatt_id).
  // RUTING (design 5.5): valgt == admin selv -> /api/min ; ellers ->
  // /api/regnskap/timer med ansatt_id EKSPLISITT. Rettighet handheves ALLTID i
  // API-et; UI-modus er kun bekvemmelighet.
  var admMe = null;             // innlogget bruker ({ id, rolle, ... })
  var admAnsatte = [];          // aktive ansatte (fra /api/regnskap/ansatte)
  var admAdminAnsattId = null;  // admin sin egen ansatte-rad (user_id === me.id), ellers null
  var admValgtAnsattId = null;  // valgt i nedtrekket
  var admModus = 'andre';       // 'selv' | 'andre'
  var admKalender = null;       // komponent-instans (kun 'selv')
  var admAndreData = [];        // rader for 'andre' (fra /api/regnskap/timer)
  var admValgtDato = null;      // dato modalen star pa
  var admOppsett = false;       // er modal/knapper wiret? (unnga dobbel-wiring)

  var ADM_UKEDAGER = ['Man', 'Tir', 'Ons', 'Tor', 'Fre', 'Lør', 'Søn'];
  var ADM_PRESEDENS = ['avvist', 'utkast', 'sendt_inn', 'godkjent', 'laast'];
  var ADM_STATUS_TEKST = { utkast: 'Utkast', sendt_inn: 'Sendt inn', godkjent: 'Godkjent', avvist: 'Avvist', laast: 'Låst' };
  var ADM_LAS_SVG = '<svg class="kal-las" viewBox="0 0 24 24" width="12" height="12" aria-hidden="true">' +
    '<path fill="currentColor" d="M6 10V7a6 6 0 1112 0v3h1a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2v-8a2 2 0 012-2h1zm2 0h8V7a4 4 0 10-8 0v3z"/></svg>';

  function admDatoStr(v) { return v == null ? '' : String(v).slice(0, 10); }
  function admPad(n) { return String(n).padStart(2, '0'); }
  function admFeil(t) { visFeil('feil-adm-kal', t); }
  function admFeilForing(t) { visFeil('feil-adm-foring', t); }
  function admOk(t) {
    var el = $('ok-adm-kal'); if (!el) return;
    el.textContent = t || ''; el.classList.toggle('vis', !!t);
    if (t) setTimeout(function () { el.classList.remove('vis'); }, 4000);
  }
  function admValgtNavn() {
    var a = admAnsatte.filter(function (x) { return Number(x.id) === Number(admValgtAnsattId); })[0];
    return a ? a.navn : 'ansatt';
  }
  function admRepStatus(statuser) {
    for (var i = 0; i < ADM_PRESEDENS.length; i++) {
      if (statuser.indexOf(ADM_PRESEDENS[i]) !== -1) return ADM_PRESEDENS[i];
    }
    return '';
  }
  function admFormaterDato(dato) {
    var d = new Date(dato + 'T00:00:00');
    if (isNaN(d.getTime())) return dato;
    return d.toLocaleDateString('no-NO', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' });
  }

  // Rader for en dag — leser fra komponentens payload ('selv') eller manuell array ('andre').
  function admDataForDag(dato) {
    var rader;
    if (admModus === 'selv' && admKalender) rader = (admKalender.data().timer) || [];
    else rader = admAndreData || [];
    return rader.filter(function (t) { return t && admDatoStr(t.dato) === dato; });
  }

  // Manuell manedsgrid for 'andre' — samme kal-*-klasser som komponenten.
  function admRenderManuellGrid(el, m, rader) {
    if (!el) return;
    var deler = String(m).split('-');
    var aar = Number(deler[0]); var mnd = Number(deler[1]);
    if (!aar || !mnd || mnd < 1 || mnd > 12) { el.innerHTML = ''; return; }
    var antallDager = new Date(aar, mnd, 0).getDate();
    var offset = (new Date(aar, mnd - 1, 1).getDay() + 6) % 7; // Man=0 .. Søn=6
    var perDag = {};
    rader.forEach(function (t) {
      var dato = admDatoStr(t && t.dato); if (!dato) return;
      if (!perDag[dato]) perDag[dato] = { sum: 0, statuser: [] };
      perDag[dato].sum += Number(t.timer) || 0;
      var st = t.status || 'utkast';
      if (perDag[dato].statuser.indexOf(st) === -1) perDag[dato].statuser.push(st);
    });
    var iDagStr = iDag();
    var html = '<div class="kal-grid kal-hoder">';
    ADM_UKEDAGER.forEach(function (u) { html += '<div class="kal-hode">' + u + '</div>'; });
    html += '</div><div class="kal-grid kal-dager">';
    for (var i = 0; i < offset; i++) html += '<div class="kal-tom"></div>';
    for (var dag = 1; dag <= antallDager; dag++) {
      var dato = aar + '-' + admPad(mnd) + '-' + admPad(dag);
      var d = perDag[dato];
      var rep = d ? admRepStatus(d.statuser) : '';
      var laast = !!(d && d.statuser.indexOf('laast') !== -1);
      var klasser = ['kal-dag'];
      if (rep) klasser.push('kal-' + rep);
      if (dato === iDagStr) klasser.push('kal-idag');
      var innhold = '<span class="kal-nr">' + dag + (laast ? ' ' + ADM_LAS_SVG : '') + '</span>';
      if (d && d.sum > 0) innhold += '<span class="kal-sum">' + esc(timer(d.sum)) + ' t</span>';
      html += '<button type="button" class="' + klasser.join(' ') + '" data-dato="' + dato + '">' + innhold + '</button>';
    }
    html += '</div>';
    el.innerHTML = html;
    Array.prototype.forEach.call(el.querySelectorAll('.kal-dag'), function (btn) {
      btn.addEventListener('click', function () { admAapneDag(btn.getAttribute('data-dato')); });
    });
  }

  function admMaanedVerdi() { return maaned(); }

  // Hent + tegn 'andre'-kalenderen. Returnerer promise (for admRefresh-kjeding).
  function admHentAndre() {
    var m = admMaanedVerdi();
    var el = $('adm-kalender');
    return api('/api/regnskap/timer?ansatt_id=' + encodeURIComponent(admValgtAnsattId) + '&maaned=' + encodeURIComponent(m))
      .then(function (r) { if (!r.ok) throw new Error('timer ' + r.status); return r.json(); })
      .then(function (rader) { admAndreData = Array.isArray(rader) ? rader : []; admRenderManuellGrid(el, m, admAndreData); })
      .catch(function () { if (el) el.innerHTML = '<div class="kal-feil">Kunne ikke laste kalenderen. Prøv igjen.</div>'; });
  }

  function admLastKalender() {
    if (admValgtAnsattId == null) return Promise.resolve();
    admFeil('');
    var el = $('adm-kalender'); if (!el) return Promise.resolve();
    if (admModus === 'selv') {
      if (!admKalender && window.HavstundKalender) {
        admKalender = window.HavstundKalender({
          ansattId: admMe && admMe.id,
          kanGodkjenne: true,
          kanSeAndre: true,
          apiBasis: '/api/min',
          onVelgDag: function (dato) { admAapneDag(dato); },
          onLastet: function () {},
          onFeil: function (s) { if (s === 403) admFeil('Din bruker er ikke koblet til en ansatt-profil.'); }
        });
      }
      if (!admKalender) { el.innerHTML = '<div class="kal-feil">Kalenderen kunne ikke lastes.</div>'; return Promise.resolve(); }
      admKalender.mount(el);
      return admKalender.setMaaned(admMaanedVerdi()).catch(function () {});
    }
    return admHentAndre();
  }

  function admRefresh() {
    if (admModus === 'selv' && admKalender) return admKalender.refresh().catch(function () {});
    return admHentAndre();
  }

  function admBanner() {
    var b = $('adm-vegne'); if (!b) return;
    if (admModus === 'andre') { b.textContent = 'Du fører timer på vegne av ' + admValgtNavn(); b.style.display = ''; }
    else { b.style.display = 'none'; b.textContent = ''; }
  }

  function admByttAnsatt(id) {
    admValgtAnsattId = Number(id);
    admModus = (admAdminAnsattId != null && admValgtAnsattId === admAdminAnsattId) ? 'selv' : 'andre';
    admBanner();
    admLukkModal();
    admLastKalender();
  }

  // ----- Dag-modal -----
  function admLukkModal() {
    var m = $('adm-dag-modal'); if (m) m.classList.remove('vis');
    admValgtDato = null;
    admFeilForing('');
  }

  function admRadHtml(t) {
    var st = t.status || 'utkast';
    var tekst = esc(t.aktivitet || '');
    var notat = t.notat ? '<small>' + esc(t.notat) + '</small>' : '';
    var handling = '';
    if (st === 'laast') {
      handling += '<button type="button" class="knapp-lenke rediger" data-adm-handling="korriger" data-id="' + esc(t.id) + '">Korriger</button>';
    } else {
      if (st !== 'godkjent') handling += '<button type="button" class="knapp-lenke godkjenn" data-adm-handling="godkjenn" data-id="' + esc(t.id) + '">Godkjenn</button>';
      if (st !== 'avvist') handling += '<button type="button" class="knapp-lenke slett" data-adm-handling="avvis" data-id="' + esc(t.id) + '">Avvis</button>';
    }
    return '<div class="foring-rad">' +
      '<span class="f-timer">' + esc(timer(t.timer)) + ' t</span>' +
      '<span class="f-tekst">' + (tekst || '<span style="color:var(--muted)">(uten aktivitet)</span>') + notat + '</span>' +
      '<span class="status-merke sm-' + esc(st) + '">' + esc(ADM_STATUS_TEKST[st] || st) + '</span>' +
      (handling ? '<span class="f-handling">' + handling + '</span>' : '') +
      '</div>';
  }

  function admAapneDag(dato) {
    admValgtDato = dato;
    var egne = admDataForDag(dato);
    var tittel = $('adm-dag-tittel'); if (tittel) tittel.textContent = 'Timer — ' + admFormaterDato(dato);
    var vb = $('adm-vegne-modal');
    if (vb) {
      if (admModus === 'andre') { vb.textContent = 'Du fører timer på vegne av ' + admValgtNavn(); vb.style.display = ''; }
      else { vb.style.display = 'none'; vb.textContent = ''; }
    }
    var liste = $('adm-dag-eksisterende');
    if (liste) {
      if (!egne.length) {
        liste.innerHTML = '<p class="hint" style="margin:4px 0 10px;color:var(--muted);font-size:13px">Ingen føringer denne dagen ennå.</p>';
      } else {
        liste.innerHTML = egne.map(admRadHtml).join('');
        Array.prototype.forEach.call(liste.querySelectorAll('[data-adm-handling]'), function (btn) {
          btn.addEventListener('click', function () {
            var id = btn.getAttribute('data-id');
            var h = btn.getAttribute('data-adm-handling');
            if (h === 'godkjenn') admGodkjenn(id);
            else if (h === 'avvis') admAvvis(id);
            else if (h === 'korriger') admKorriger(id);
          });
        });
      }
    }
    admFeilForing('');
    var f = $('adm-form-foring'); if (f) f.reset();
    var m = $('adm-dag-modal'); if (m) m.classList.add('vis');
    var tf = $('adm-f-timer'); if (tf) tf.focus();
  }

  // ----- Admin-handlinger (alle mot /api/regnskap/timer/*; server handhever) -----
  function admHandling(url, kropp) {
    admFeilForing('');
    return api(url, { method: 'POST', body: JSON.stringify(kropp || {}) })
      .then(function (r) {
        return r.json().then(
          function (d) { return { ok: r.ok, status: r.status, d: d }; },
          function () { return { ok: r.ok, status: r.status, d: {} }; }
        );
      })
      .then(function (res) {
        if (!res.ok) {
          if (res.status === 403) { admFeilForing('Kun admin kan gjøre dette.'); return; }
          admFeilForing((res.d && res.d.error) || 'Handlingen kunne ikke utføres.'); return;
        }
        return admRefresh().then(function () { if (admValgtDato) admAapneDag(admValgtDato); lastLonn(); lastOversikt(); });
      })
      .catch(function () { admFeilForing('Noe gikk galt. Prøv igjen.'); });
  }

  function admGodkjenn(id) {
    admHandling('/api/regnskap/timer/' + encodeURIComponent(id) + '/godkjenn', {});
  }

  function admAvvis(id) {
    var b = prompt('Begrunnelse for avvisning (vises til den ansatte):');
    if (b === null) return;                         // avbrutt
    if (!String(b).trim()) { admFeilForing('Avvisning krever en begrunnelse.'); return; }
    admHandling('/api/regnskap/timer/' + encodeURIComponent(id) + '/avvis', { begrunnelse: String(b).trim() });
  }

  function admKorriger(id) {
    var rad = admDataForDag(admValgtDato).filter(function (t) { return String(t.id) === String(id); })[0];
    var forslag = rad ? String(rad.timer) : '';
    var tsvar = prompt('Nytt timetall for denne føringen (0–24):', forslag);
    if (tsvar === null) return;
    var tverdi = parseFloat(String(tsvar).replace(',', '.'));
    if (!Number.isFinite(tverdi) || tverdi < 0 || tverdi > 24) { admFeilForing('Oppgi et gyldig timetall (0–24).'); return; }
    var b = prompt('Begrunnelse for korrigering (valgfritt):', '');
    if (b === null) return;                         // avbrutt
    var kropp = { timer: tverdi };
    if (String(b).trim()) kropp.begrunnelse = String(b).trim();
    admHandling('/api/regnskap/timer/' + encodeURIComponent(id) + '/korriger', kropp);
  }

  function admLaasMaaned() {
    var m = admMaanedVerdi();
    admFeil('');
    if (!confirm('Lås alle timer for ' + m + '? Låste rader kan bare endres via «Korriger». Dette kan ikke angres.')) return;
    // Kontrakt: POST /api/regnskap/timer/laas?maaned= — sender maaned bade i query og body.
    api('/api/regnskap/timer/laas?maaned=' + encodeURIComponent(m), { method: 'POST', body: JSON.stringify({ maaned: m }) })
      .then(function (r) {
        return r.json().then(
          function (d) { return { ok: r.ok, status: r.status, d: d }; },
          function () { return { ok: r.ok, status: r.status, d: {} }; }
        );
      })
      .then(function (res) {
        if (!res.ok) {
          if (res.status === 403) { admFeil('Kun admin kan låse måneden.'); return; }
          admFeil((res.d && res.d.error) || 'Kunne ikke låse måneden.'); return;
        }
        admOk('Måneden er låst.');
        admRefresh(); lastLonn();
      })
      .catch(function () { admFeil('Noe gikk galt. Prøv igjen.'); });
  }

  // Ny foring pa vegne av valgt ansatt. ansatt_id sendes ALLTID eksplisitt.
  function admLagreForing(e) {
    if (e) e.preventDefault();
    if (admValgtDato == null || admValgtAnsattId == null) return;
    admFeilForing('');
    var tf = $('adm-f-timer');
    var tverdi = tf ? parseFloat(String(tf.value).replace(',', '.')) : NaN;
    if (!Number.isFinite(tverdi) || tverdi <= 0 || tverdi > 24) { admFeilForing('Oppgi et gyldig timetall (0–24).'); return; }
    var aktivitet = ($('adm-f-aktivitet') && $('adm-f-aktivitet').value.trim()) || '';
    var notat = ($('adm-f-notat') && $('adm-f-notat').value.trim()) || '';
    var kropp = { ansatt_id: Number(admValgtAnsattId), dato: admValgtDato, timer: tverdi };
    if (aktivitet) kropp.aktivitet = aktivitet;
    if (notat) kropp.notat = notat;
    var lagre = $('adm-f-lagre'); if (lagre) lagre.disabled = true;
    api('/api/regnskap/timer', { method: 'POST', body: JSON.stringify(kropp) })
      .then(function (r) {
        return r.json().then(
          function (d) { return { ok: r.ok, status: r.status, d: d }; },
          function () { return { ok: r.ok, status: r.status, d: {} }; }
        );
      })
      .then(function (res) {
        if (!res.ok) { admFeilForing((res.d && res.d.error) || 'Kunne ikke lagre føringen.'); return; }
        return admRefresh().then(function () { if (admValgtDato) admAapneDag(admValgtDato); lastLonn(); lastOversikt(); });
      })
      .catch(function () { admFeilForing('Noe gikk galt. Prøv igjen.'); })
      .then(function () { if (lagre) lagre.disabled = false; });
  }

  // Wires modal/knapper EN gang, henter me + ansatte, setter default-valg.
  function initAdmKalender() {
    var panel = $('adm-kal-panel'); if (!panel) return;
    if (!admOppsett) {
      admOppsett = true;
      var lukk = $('adm-dag-lukk'); if (lukk) lukk.addEventListener('click', admLukkModal);
      var overlay = $('adm-dag-modal');
      if (overlay) overlay.addEventListener('click', function (e) { if (e.target === overlay) admLukkModal(); });
      document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && $('adm-dag-modal') && $('adm-dag-modal').classList.contains('vis')) admLukkModal(); });
      var form = $('adm-form-foring'); if (form) form.addEventListener('submit', admLagreForing);
      var laas = $('adm-laas'); if (laas) laas.addEventListener('click', admLaasMaaned);
    }

    Promise.all([
      api('/api/auth/me').then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; }),
      api('/api/regnskap/ansatte').then(function (r) { return r.ok ? r.json() : []; }).catch(function () { return []; })
    ]).then(function (svar) {
      admMe = (svar[0] && svar[0].user) ? svar[0].user : svar[0];
      var alle = Array.isArray(svar[1]) ? svar[1] : [];
      admAnsatte = alle.filter(function (a) { return a.aktiv; });
      panel.style.display = '';
      if (!admAnsatte.length) {
        var tomEl = $('adm-kalender'); if (tomEl) tomEl.innerHTML = '<p class="tom">Legg til en aktiv ansatt for å føre timer.</p>';
        var selTom = $('adm-ansatt'); if (selTom) selTom.innerHTML = '';
        return;
      }
      var egen = (admMe && admMe.id != null)
        ? admAnsatte.filter(function (a) { return Number(a.user_id) === Number(admMe.id); })[0]
        : null;
      admAdminAnsattId = egen ? Number(egen.id) : null;
      var sel = $('adm-ansatt');
      if (sel) {
        sel.innerHTML = admAnsatte.map(function (a) {
          var egenMerke = (admAdminAnsattId != null && Number(a.id) === admAdminAnsattId) ? ' (meg)' : '';
          return '<option value="' + a.id + '">' + esc(a.navn) + egenMerke + '</option>';
        }).join('');
        // Wires KUN her (init kalles en gang via admOppsett-flagget for wiring;
        // men select fylles hver gang) — bruk onchange for a unnga duplikat-listenere.
        sel.onchange = function () { admByttAnsatt(sel.value); };
      }
      var startId = admAdminAnsattId != null ? admAdminAnsattId : Number(admAnsatte[0].id);
      if (sel) sel.value = String(startId);
      admByttAnsatt(startId);
    });
  }

  // Kalt ved fane-/maned-bytte NAAR admin-kalenderen alt er initialisert.
  function admLastHvisKlar() {
    if (brukerRolle === 'admin' && admValgtAnsattId != null) admLastKalender();
  }

  // ---- PERSONALMELDINGER (admin-side av ansatt-chatten, /api/personalchat) ----
  // Speiler kunde-dialogen: venstre liste (ansatte m/ uleste), hoyre samtale +
  // svar. avsender settes ALLTID server-side; her sendes kun {tekst}. ansatt_id
  // ligger i URL-en. Rettighet handheves i API-et (admin-only -> 403 ellers).
  var pmValgtAnsattId = null;
  var pmOppsett = false;

  function pmTid(v) {
    if (!v) return '';
    var d = new Date(v);
    if (isNaN(d.getTime())) return esc(v);
    return d.toLocaleString('no-NO', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  function pmLastOversikt() {
    var liste = $('pm-liste'); if (!liste) return;
    api('/api/personalchat').then(function (r) {
      if (r.status === 403) { liste.innerHTML = '<p class="tom" style="padding:14px">Kun admin.</p>'; return null; }
      if (!r.ok) throw new Error('personalchat ' + r.status);
      return r.json();
    }).then(function (rows) {
      if (rows === null) return;
      pmRenderOversikt(Array.isArray(rows) ? rows : []);
    }).catch(function () { liste.innerHTML = '<p class="tom" style="padding:14px">Kunne ikke hente meldinger.</p>'; });
  }

  function pmRenderOversikt(rader) {
    var liste = $('pm-liste'); if (!liste) return;
    if (!rader.length) { liste.innerHTML = '<p class="tom" style="padding:14px">Ingen ansatte ennå.</p>'; return; }
    liste.innerHTML = rader.map(function (a) {
      var uleste = Number(a.uleste) || 0;
      var aktiv = String(a.ansatt_id) === String(pmValgtAnsattId) ? ' aktiv' : '';
      var utdrag = a.siste_tekst
        ? (a.siste_avsender === 'admin' ? 'Du: ' : '') + esc(a.siste_tekst)
        : 'Ingen meldinger ennå';
      return '<button type="button" class="pm-rad' + aktiv + '" data-pm-id="' + esc(a.ansatt_id) + '">' +
        '<span class="pm-navn">' + esc(a.navn) + (a.stilling ? ' <small>' + esc(a.stilling) + '</small>' : '') + '</span>' +
        '<span class="pm-utdrag">' + utdrag + '</span>' +
        (uleste ? '<span class="pm-badge">' + uleste + '</span>' : '') +
        '</button>';
    }).join('');
    Array.prototype.forEach.call(liste.querySelectorAll('.pm-rad'), function (b) {
      b.addEventListener('click', function () { pmVelg(b.getAttribute('data-pm-id')); });
    });
  }

  function pmVelg(id) {
    var n = Number(id);
    if (!Number.isInteger(n) || n <= 0) return;
    pmValgtAnsattId = n;
    pmLastOversikt();   // oppdater aktiv-markering
    pmLastTraad();
  }

  function pmLastTraad() {
    var traad = $('pm-traad'); if (!traad || pmValgtAnsattId == null) return;
    var skjema = $('pm-svar-skjema'); if (skjema) skjema.style.display = '';
    visFeil('feil-pm', '');
    traad.innerHTML = '<p class="tom" style="padding:0">Laster …</p>';
    api('/api/personalchat/' + encodeURIComponent(pmValgtAnsattId)).then(function (r) {
      if (r.status === 403) { traad.innerHTML = '<p class="tom" style="padding:0">Kun admin.</p>'; return null; }
      if (!r.ok) throw new Error('personalchat traad ' + r.status);
      return r.json();
    }).then(function (d) {
      if (d === null) return;
      var ansatt = (d && d.ansatt) || {};
      var tittel = $('pm-tittel'); if (tittel) tittel.textContent = ansatt.navn || 'Ansatt';
      pmRenderTraad((d && Array.isArray(d.meldinger)) ? d.meldinger : []);
      pmLastOversikt();  // uleste er nullstilt server-side ved GET -> oppdater badge
    }).catch(function () { traad.innerHTML = '<p class="tom" style="padding:0">Kunne ikke hente samtalen.</p>'; });
  }

  function pmRenderTraad(meldinger) {
    var traad = $('pm-traad'); if (!traad) return;
    if (!meldinger.length) { traad.innerHTML = '<p class="tom" style="padding:0">Ingen meldinger ennå.</p>'; return; }
    traad.innerHTML = meldinger.map(function (m) {
      var fraAdmin = m.avsender === 'admin';
      return '<div class="pm-melding ' + (fraAdmin ? 'fra-oss' : 'fra-ansatt') + '">' +
        '<div class="pm-meta">' + (fraAdmin ? 'Havstund' : 'Ansatt') + ' · ' + pmTid(m.opprettet) + '</div>' +
        '<div class="pm-tekst">' + esc(m.tekst || '') + '</div>' +
        '</div>';
    }).join('');
    traad.scrollTop = traad.scrollHeight;
  }

  function pmSend(e) {
    if (e) e.preventDefault();
    if (pmValgtAnsattId == null) return;
    var tekstEl = $('pm-tekst');
    var tekst = tekstEl ? tekstEl.value.trim() : '';
    visFeil('feil-pm', '');
    if (!tekst) { visFeil('feil-pm', 'Skriv en melding.'); if (tekstEl) tekstEl.focus(); return; }
    var knapp = $('pm-send'); if (knapp) knapp.disabled = true;
    api('/api/personalchat/' + encodeURIComponent(pmValgtAnsattId), { method: 'POST', body: JSON.stringify({ tekst: tekst }) })
      .then(function (r) {
        return r.json().then(
          function (d) { return { ok: r.ok, status: r.status, d: d }; },
          function () { return { ok: r.ok, status: r.status, d: {} }; }
        );
      })
      .then(function (res) {
        if (!res.ok) {
          if (res.status === 403) { visFeil('feil-pm', 'Kun admin kan svare.'); return; }
          visFeil('feil-pm', (res.d && res.d.error) || 'Kunne ikke sende meldingen.'); return;
        }
        if (tekstEl) tekstEl.value = '';
        pmLastTraad(); pmLastOversikt();
      })
      .catch(function () { visFeil('feil-pm', 'Noe gikk galt. Prøv igjen.'); })
      .then(function () { if (knapp) knapp.disabled = false; });
  }

  // Wires svar-skjema EN gang. Data lastes forst ved fane-bytte (pmLastOversikt).
  function pmInit() {
    if (pmOppsett) return;
    pmOppsett = true;
    var skjema = $('pm-svar-skjema');
    if (skjema) skjema.addEventListener('submit', pmSend);
  }

  // ---- Faner ----
  function byttFane(navn) {
    document.querySelectorAll('.fane').forEach(function (f) { f.classList.toggle('active', f.getAttribute('data-pane') === navn); });
    document.querySelectorAll('.pane').forEach(function (p) { p.classList.toggle('active', p.id === 'pane-' + navn); });
    lastFane(navn);
  }
  function lastFane(navn) {
    if (navn === 'oversikt') lastOversikt();
    else if (navn === 'inntekter') lastPoster('inntekt', 'liste-inntekt');
    else if (navn === 'utgifter') lastPoster('utgift', 'liste-utgift');
    else if (navn === 'lonn') { lastAnsatte().then(function () { lastTimer(); lastLonn(); }); }
    else if (navn === 'vaktplan') admLastHvisKlar();
    else if (navn === 'meldinger') pmLastOversikt();
    else if (navn === 'dagsoppgjor') lastDagsoppgjor();
  }
  function aktivFane() {
    var el = document.querySelector('.fane.active');
    return el ? el.getAttribute('data-pane') : 'oversikt';
  }

  // ---- Oppstart ----
  var brukerRolle = null;
  function init() {
    $('maaned').value = naaMaaned();
    fyllKonti();
    fyllStandardDato();

    // AI-kvittering: kun admin ser panelet (shimen krever admin + AI-agent-flagg).
    // Ansatt får det aldri; ikke-utvalgt admin får en pen degradering ved bruk.
    if (brukerRolle === 'admin') {
      var aiPanel = $('ai-kvittering-panel');
      if (aiPanel) aiPanel.style.display = 'block';
      var aiKnapp = $('ai-foreslaa');
      if (aiKnapp) aiKnapp.addEventListener('click', aiLesKvittering);
      // Admin-timekalender: ansatt-velger + kalender + godkjenn/avvis/las/korriger.
      initAdmKalender();
      // Personalmeldinger: wire svar-skjema (data lastes ved fane-bytte).
      pmInit();
      // Vis admin-kun faner (Vaktplan + Personalmeldinger). API håndhever uansett.
      document.querySelectorAll('.fane-admin').forEach(function (f) { f.style.display = ''; });
    }

    document.querySelectorAll('.fane').forEach(function (f) {
      f.addEventListener('click', function () { byttFane(f.getAttribute('data-pane')); });
    });
    $('maaned').addEventListener('change', function () { lastFane(aktivFane()); });
    ['sats-ferie', 'sats-aga'].forEach(function (id) {
      var el = $(id); if (el) el.addEventListener('input', lastLonn);
    });

    $('form-inntekt').addEventListener('submit', function (e) { e.preventDefault(); sendPost('inntekt', e.target, 'feil-inntekt', 'liste-inntekt'); });
    $('form-utgift').addEventListener('submit', function (e) { e.preventDefault(); sendPost('utgift', e.target, 'feil-utgift', 'liste-utgift'); });

    $('form-ansatt').addEventListener('submit', function (e) {
      e.preventDefault(); visFeil('feil-ansatt', '');
      var f = e.target.elements;
      var kropp = { navn: f.navn.value.trim(), stilling: f.stilling.value.trim(), timelonn_ore: tilOre(f.timelonn.value) };
      if (!kropp.navn) { visFeil('feil-ansatt', 'Skriv navn.'); return; }
      api('/api/regnskap/ansatte', { method: 'POST', body: JSON.stringify(kropp) })
        .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
        .then(function (res) { if (!res.ok) { visFeil('feil-ansatt', res.d.error || 'Kunne ikke lagre.'); return; } e.target.reset(); lastAnsatte().then(lastLonn); })
        .catch(function () { visFeil('feil-ansatt', 'Noe gikk galt.'); });
    });

    $('form-timer').addEventListener('submit', function (e) {
      e.preventDefault(); visFeil('feil-timer', '');
      var f = e.target.elements;
      var kropp = { ansatt_id: Number(f.ansatt_id.value), dato: f.dato.value, timer: Number(f.timer.value), aktivitet: f.aktivitet.value.trim() };
      if (!kropp.ansatt_id) { visFeil('feil-timer', 'Velg en ansatt.'); return; }
      api('/api/regnskap/timer', { method: 'POST', body: JSON.stringify(kropp) })
        .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
        .then(function (res) { if (!res.ok) { visFeil('feil-timer', res.d.error || 'Kunne ikke lagre.'); return; } f.timer.value = ''; f.aktivitet.value = ''; lastTimer(); lastLonn(); lastOversikt(); })
        .catch(function () { visFeil('feil-timer', 'Noe gikk galt.'); });
    });

    // Slett (delegert)
    document.addEventListener('click', function (e) {
      var p = e.target.getAttribute && e.target.getAttribute('data-slett-post');
      var t = e.target.getAttribute && e.target.getAttribute('data-slett-time');
      var ld = e.target.getAttribute && e.target.getAttribute('data-lukk-dag');
      if (ld) {
        var brutto = Number(e.target.getAttribute('data-lukk-brutto')) || 0;
        var antall = Number(e.target.getAttribute('data-lukk-antall')) || 0;
        if (!confirm('Lukk ' + ld + '? Brutto ' + kr(brutto) + ', ' + antall + ' bilag. Dette kan ikke angres.')) return;
        lukkDag(ld);
        return;
      }
      if (p) {
        if (!confirm('Slette denne posten?')) return;
        api('/api/regnskap/poster/' + p, { method: 'DELETE' })
          .then(function (r) { if (!r.ok) throw new Error('DELETE poster ' + r.status); return r; })
          .then(function () {
            lastPoster('inntekt', 'liste-inntekt'); lastPoster('utgift', 'liste-utgift'); lastOversikt();
          })
          .catch(function () { alert('Kunne ikke slette posten. Prøv igjen.'); });
      } else if (t) {
        if (!confirm('Slette denne timeføringen?')) return;
        api('/api/regnskap/timer/' + t, { method: 'DELETE' })
          .then(function (r) { if (!r.ok) throw new Error('DELETE timer ' + r.status); return r; })
          .then(function () { lastTimer(); lastLonn(); lastOversikt(); })
          .catch(function () { alert('Kunne ikke slette timeføringen. Prøv igjen.'); });
      }
    });

    $('logg-ut').addEventListener('click', function (e) {
      e.preventDefault();
      api('/api/auth/logout', { method: 'POST' }).then(function () { window.location = '/konto'; }).catch(function () { window.location = '/konto'; });
    });

    var fikenBtn = $('fiken-send');
    if (fikenBtn) fikenBtn.addEventListener('click', function () {
      fikenBtn.disabled = true;
      var gammelTekst = fikenBtn.textContent;
      fikenBtn.textContent = 'Sender …';
      api('/api/regnskap/fiken/send', { method: 'POST' })
        .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
        .then(function (res) {
          var d = res.d || {};
          if (!res.ok) { alert(d.error || 'Kunne ikke eksportere.'); return; }
          if (!d.konfigurert) {
            alert('Regnskapsprogram er ikke koblet til ennå. Legg inn nøkkelen til regnskapsprogrammet først, så eksporteres postene automatisk. (' + (Number(d.simulert) || 0) + ' poster ble simulert.)');
          } else {
            alert('Eksportert: ' + (Number(d.sendt) || 0) + ', simulert: ' + (Number(d.simulert) || 0) + ', feilet: ' + (Number(d.feilet) || 0));
          }
          lastFikenStatus(); lastOversikt();
        })
        .catch(function () { alert('Noe gikk galt. Prøv igjen.'); })
        .then(function () { fikenBtn.disabled = false; fikenBtn.textContent = gammelTekst; });
    });

    if ($('eksporter-excel')) $('eksporter-excel').addEventListener('click', eksporterExcel);
    if ($('last-pakke')) $('last-pakke').addEventListener('click', lastPakke);

    // Deep-link: åpne fane fra location.hash (#okonomi, #meldinger, …) hvis den finnes.
    var hashNavn = (location.hash || '').replace('#', '');
    if (hashNavn && document.getElementById('pane-' + hashNavn)) {
      byttFane(hashNavn);
    }

    lastOversikt();
  }

  // ---- Tilgangssjekk ----
  api('/api/auth/me').then(function (r) {
    if (r.status === 401) { window.location = '/konto'; return null; }
    return r.json();
  }).then(function (data) {
    if (!data || !data.user) { window.location = '/konto'; return; }
    if (data.user.rolle !== 'ansatt' && data.user.rolle !== 'admin') { window.location = '/min-side'; return; }
    brukerRolle = data.user.rolle;
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
  }).catch(function () { window.location = '/konto'; });
})();
