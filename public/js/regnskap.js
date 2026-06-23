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
    }).catch(function () {});
    lastFikenStatus();
  }

  // ---- FIKEN-STATUS ----
  function lastFikenStatus() {
    var el = $('fiken-status');
    if (!el) return;
    api('/api/regnskap/fiken/status').then(function (r) { return r.json(); }).then(function (d) {
      if (!d || d.error) { el.textContent = ''; return; }
      var n = Number(d.antall_usendt) || 0;
      el.textContent = d.konfigurert
        ? n + ' poster klare til å sendes til Fiken.'
        : 'Fiken er ikke koblet til ennå — ' + n + ' poster venter.';
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
        '<div class="fiken-note" style="margin-top:14px"><b>Lønnskjøring i Fiken:</b> brutto lønn bokføres på konto 5000, arbeidsgiveravgift på 5400, og feriepenger avsettes automatisk. Hver ansatt får lønnsslipp ut fra timene over.</div>';
    }).catch(function () {});
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
      if (p) {
        if (!confirm('Slette denne posten?')) return;
        api('/api/regnskap/poster/' + p, { method: 'DELETE' }).then(function () {
          lastPoster('inntekt', 'liste-inntekt'); lastPoster('utgift', 'liste-utgift'); lastOversikt();
        });
      } else if (t) {
        if (!confirm('Slette denne timeføringen?')) return;
        api('/api/regnskap/timer/' + t, { method: 'DELETE' }).then(function () { lastTimer(); lastLonn(); lastOversikt(); });
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
          if (!res.ok) { alert(d.error || 'Kunne ikke sende til Fiken.'); return; }
          if (!d.konfigurert) {
            alert('Fiken er ikke koblet til ennå. Legg inn Fiken-nøkkelen først, så sendes postene automatisk. (' + (Number(d.simulert) || 0) + ' poster ble simulert.)');
          } else {
            alert('Sendt: ' + (Number(d.sendt) || 0) + ', simulert: ' + (Number(d.simulert) || 0) + ', feilet: ' + (Number(d.feilet) || 0));
          }
          lastFikenStatus(); lastOversikt();
        })
        .catch(function () { alert('Noe gikk galt. Prøv igjen.'); })
        .then(function () { fikenBtn.disabled = false; fikenBtn.textContent = gammelTekst; });
    });

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
