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
    else if (navn === 'dagsoppgjor') lastDagsoppgjor();
  }
  function aktivFane() {
    var el = document.querySelector('.fane.active');
    return el ? el.getAttribute('data-pane') : 'oversikt';
  }

  // ---- Oppstart ----
  function init() {
    $('maaned').value = naaMaaned();
    fyllKonti();
    fyllStandardDato();

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

    lastOversikt();
  }

  // ---- Tilgangssjekk ----
  api('/api/auth/me').then(function (r) {
    if (r.status === 401) { window.location = '/konto'; return null; }
    return r.json();
  }).then(function (data) {
    if (!data || !data.user) { window.location = '/konto'; return; }
    if (data.user.rolle !== 'ansatt' && data.user.rolle !== 'admin') { window.location = '/min-side'; return; }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
  }).catch(function () { window.location = '/konto'; });
})();
