/* Havstund — samlet admin-side: Bookinger + Agenda + Aktiviteter i tre faner.
   Rent refaktor: hver fane oppfører seg nøyaktig som sin gamle side.
   Bookinger lastes i init(); Agenda og Aktiviteter lastes lazy ved første
   åpning. Socket.IO (valgfritt) auto-oppdaterer bookinger + agenda. */
(function () {
  'use strict';

  /* ---------- Delte hjelpere ---------- */
  function $(id) { return document.getElementById(id); }
  function api(sti, opt) {
    opt = opt || {};
    opt.credentials = 'same-origin';
    if (opt.body && typeof opt.body !== 'string') {
      opt.headers = Object.assign({ 'Content-Type': 'application/json' }, opt.headers || {});
      opt.body = JSON.stringify(opt.body);
    }
    return fetch(sti, opt);
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  // Bookinger-fanen: kroner DIREKTE (beløp er allerede kroner, ikke øre).
  function kr(n) { return (Number(n) || 0).toLocaleString('no-NO') + ' kr'; }
  // Agenda + Aktiviteter: valutaformat — også kroner direkte (ingen /100).
  var krValutaFmt = new Intl.NumberFormat('no-NO', { style: 'currency', currency: 'NOK', maximumFractionDigits: 0 });
  function krValuta(v) { return krValutaFmt.format(Number(v) || 0); }

  /* ================= FANE: BOOKINGER ================= */
  var STATUSER = ['forespurt', 'bekreftet', 'fullfort', 'avlyst'];
  var STATUS_TEKST = { forespurt: 'Venter svar', bekreftet: 'Bekreftet', fullfort: 'Fullført', avlyst: 'Avlyst' };
  var alle = []; // alle bookinger (rådata)

  function dato(s) {
    if (!s) return '';
    var d = new Date(s);
    if (isNaN(d.getTime())) return String(s).slice(0, 10);
    return d.toLocaleDateString('no-NO', { day: '2-digit', month: '2-digit', year: 'numeric' });
  }
  function iDagISO() {
    var d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  // YYYY-MM-DD fra en booking-dato (ISO/Date) for sammenligning
  function datoISO(s) {
    if (!s) return '';
    if (typeof s === 'string') return s.slice(0, 10);
    try { return new Date(s).toISOString().slice(0, 10); } catch (_) { return ''; }
  }

  // Sorterings-komparator: nyeste dato først (synkende). localeCompare gir en
  // gyldig totalordning — 0 ved likhet — så Array.sort er stabil/forutsigbar.
  function sammenlignBookinger(a, b) {
    return datoISO(b.dato).localeCompare(datoISO(a.dato));
  }

  function lastBookinger() {
    api('/api/bookings').then(function (r) { return r.ok ? r.json() : Promise.reject(); })
      .then(function (data) {
        alle = Array.isArray(data) ? data : (data.bookings || []);
        tegnKpis();
        render();
      })
      .catch(function () { $('liste').innerHTML = '<p class="tom">Kunne ikke hente bookinger.</p>'; });
  }

  function tegnKpis() {
    var idag = iDagISO();
    var forespurt = 0, bekreftet = 0, kommende = 0;
    alle.forEach(function (b) {
      if (b.status === 'forespurt') forespurt++;
      if (b.status === 'bekreftet') bekreftet++;
      if (datoISO(b.dato) >= idag && b.status !== 'avlyst') kommende++;
    });
    $('k-forespurt').textContent = forespurt;
    $('k-bekreftet').textContent = bekreftet;
    $('k-kommende').textContent = kommende;
    $('k-total').textContent = alle.length;
  }

  function filtrert() {
    var q = ($('sok').value || '').trim().toLowerCase();
    var st = $('f-status').value;
    var tid = $('f-tid').value;
    var idag = iDagISO();
    return alle.filter(function (b) {
      if (st && b.status !== st) return false;
      if (tid === 'kommende' && !(datoISO(b.dato) >= idag)) return false;
      if (tid === 'tidligere' && !(datoISO(b.dato) < idag)) return false;
      if (q) {
        var hay = (b.navn || '') + ' ' + (b.epost || '') + ' ' + (b.aktivitet_navn || '') + ' ' + (b.tlf || '');
        if (hay.toLowerCase().indexOf(q) === -1) return false;
      }
      return true;
    });
  }

  function statusVelger(b) {
    var opts = STATUSER.map(function (s) {
      return '<option value="' + s + '"' + (s === b.status ? ' selected' : '') + '>' + STATUS_TEKST[s] + '</option>';
    }).join('');
    return '<select class="' + esc(b.status || 'forespurt') + '" data-id="' + esc(b.id) + '">' + opts + '</select>';
  }

  function render() {
    var rader = filtrert().slice().sort(sammenlignBookinger);
    if (!rader.length) { $('liste').innerHTML = '<p class="tom">Ingen bookinger som matcher.</p>'; return; }

    var html = '<table class="tbl"><thead><tr>' +
      '<th>Dato</th><th>Kunde</th><th>Aktivitet</th><th>Antall</th><th>Beløp</th><th>Melding</th><th>Status</th>' +
      '</tr></thead><tbody>';
    rader.forEach(function (b) {
      html += '<tr>' +
        '<td>' + esc(dato(b.dato)) + (b.tid ? '<br><span class="muted">' + esc(b.tid) + '</span>' : '') + '</td>' +
        '<td>' + esc(b.navn || '') +
          '<br><span class="muted">' + esc(b.epost || '') + (b.tlf ? ' · ' + esc(b.tlf) : '') + '</span></td>' +
        '<td>' + esc(b.aktivitet_navn || b.aktivitet || '—') + '</td>' +
        '<td>' + esc(b.antall) + '</td>' +
        '<td class="belop">' + esc(kr(b.belop)) + '</td>' +
        '<td class="melding">' + esc(b.melding || '') + '</td>' +
        '<td>' + statusVelger(b) + '</td>' +
        '</tr>';
    });
    html += '</tbody></table>';
    $('liste').innerHTML = html;

    $('liste').querySelectorAll('select[data-id]').forEach(function (sel) {
      sel.addEventListener('change', function () { endreStatus(sel.getAttribute('data-id'), sel.value, sel); });
    });
  }

  function endreStatus(id, status, sel) {
    sel.disabled = true;
    api('/api/bookings/' + encodeURIComponent(id), { method: 'PATCH', body: { status: status } })
      .then(function (r) { if (!r.ok) throw new Error(); return r.json(); })
      .then(function () {
        // oppdater lokal kopi + KPI + farge uten full reload
        var b = alle.filter(function (x) { return String(x.id) === String(id); })[0];
        if (b) b.status = status;
        sel.className = status;
        tegnKpis();
      })
      .catch(function () { alert('Kunne ikke endre status. Prøv igjen.'); lastBookinger(); })
      .then(function () { sel.disabled = false; });
  }

  function initBookinger() {
    ['sok', 'f-status', 'f-tid'].forEach(function (id) {
      var el = $(id);
      el.addEventListener(id === 'sok' ? 'input' : 'change', render);
    });
    lastBookinger();
  }

  /* ================= FANE: AGENDA ================= */
  var agendaLastet = false;
  var agendaIdag = '';

  function agendaIsoDato(d) {
    // YYYY-MM-DD i lokal tid (unngår UTC-skli fra toISOString)
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }
  function agendaVisDato(s) {
    if (!s) return '–';
    var d = new Date(s);
    return isNaN(d) ? esc(s) : d.toLocaleDateString('no-NO', { weekday: 'short', day: '2-digit', month: 'short' });
  }
  function agendaStatusPill(s) {
    var v = String(s || '').toLowerCase();
    var kjent = { forespurt: 1, bekreftet: 1, fullfort: 1, avlyst: 1 };
    var kl = kjent[v] ? v : 'forespurt';
    return (window.BookingStatus && window.BookingStatus.pille) ? window.BookingStatus.pille(s) : '<span class="pill ' + kl + '">' + esc(s || '–') + '</span>';
  }

  function agendaTegn(rows) {
    if (!rows.length) {
      $('agenda-tabell').innerHTML = '<p class="tom">Ingen bookinger fra og med valgt dato.</p>';
      $('agenda-hint').textContent = '0 bookinger.';
      return;
    }
    $('agenda-hint').textContent = rows.length.toLocaleString('no-NO') + ' booking' + (rows.length === 1 ? '' : 'er') + '.';
    var html = '<table class="tbl"><thead><tr>' +
      '<th>Dato</th><th>Tid</th><th>Aktivitet</th><th>Kunde</th><th>Kontakt</th>' +
      '<th class="num">Pers.</th><th>Status</th><th class="num">Beløp</th>' +
      '</tr></thead><tbody>';
    rows.forEach(function (r) {
      var kontakt = [r.epost, r.tlf].filter(Boolean).map(esc).join('<br>');
      html += '<tr>' +
        '<td>' + agendaVisDato(r.dato) + '</td>' +
        '<td>' + esc(r.tid || '–') + '</td>' +
        '<td>' + esc(r.aktivitet_navn || r.aktivitet || '–') + '</td>' +
        '<td>' + esc(r.navn || '–') + '</td>' +
        '<td>' + (kontakt || '–') + '</td>' +
        '<td class="num">' + (Number(r.antall) || 0).toLocaleString('no-NO') + '</td>' +
        '<td>' + agendaStatusPill(r.status) + '</td>' +
        '<td class="num belop">' + krValuta(r.belop) + '</td>' +
        '</tr>';
    });
    html += '</tbody></table>';
    $('agenda-tabell').innerHTML = html;
  }

  function agendaLast(d) {
    $('agenda-hint').textContent = 'Laster …';
    $('agenda-tabell').innerHTML = '';
    $('agenda-tittel').textContent = 'Bookinger fra ' + d;
    api('/api/bookings/agenda?dato=' + encodeURIComponent(d))
      .then(function (r) { return r.ok ? r.json() : []; })
      .then(function (data) {
        // Tål både ren array og innpakket { bookinger: [...] } / { rows: [...] }
        var rows = Array.isArray(data) ? data
          : (data && (data.bookinger || data.rows || data.data)) || [];
        if (!Array.isArray(rows)) rows = [];
        agendaTegn(rows);
      })
      .catch(function () {
        $('agenda-tabell').innerHTML = '<p class="tom">Kunne ikke hente agenda. Prøv igjen.</p>';
        $('agenda-hint').textContent = '';
      });
  }

  function initAgenda() {
    agendaIdag = agendaIsoDato(new Date());
    $('agenda-dato').value = agendaIdag;
    $('agenda-vis').addEventListener('click', function () {
      agendaLast($('agenda-dato').value || agendaIdag);
    });
    $('agenda-idag').addEventListener('click', function () {
      $('agenda-dato').value = agendaIdag;
      agendaLast(agendaIdag);
    });
  }

  /* ================= FANE: AKTIVITETER ================= */
  var aktiviteterLastet = false;

  // Pakker respons -> { ok, d } med parset JSON (tom kropp -> {}).
  function jres(r) {
    return r.text().then(function (t) {
      var d = {};
      if (t) { try { d = JSON.parse(t); } catch (e) { d = {}; } }
      return { ok: r.ok, status: r.status, d: d };
    });
  }
  function aktMelding(tekst, type) {
    var m = $('akt-melding');
    m.textContent = tekst;
    m.className = 'akt-melding vis ' + (type === 'ok' ? 'ok' : 'feil');
    if (type === 'ok') {
      setTimeout(function () { m.className = 'akt-melding'; }, 4000);
    }
  }

  function aktLast() {
    var omr = $('liste-omr');
    omr.innerHTML = '<p class="tom">Laster aktiviteter…</p>';
    api('/api/activities/admin/all')
      .then(jres)
      .then(function (res) {
        if (res.status === 401 || res.status === 403) {
          window.location = '/konto';
          return;
        }
        if (!res.ok) {
          omr.innerHTML = '<p class="tom">' + esc((res.d && res.d.error) || 'Kunne ikke hente aktiviteter.') + '</p>';
          return;
        }
        aktTegnListe(Array.isArray(res.d) ? res.d : []);
      })
      .catch(function () {
        omr.innerHTML = '<p class="tom">Kunne ikke hente aktiviteter.</p>';
      });
  }

  function aktTegnListe(rows) {
    var omr = $('liste-omr');
    if (!rows.length) {
      omr.innerHTML = '<p class="tom">Ingen aktiviteter ennå. Klikk «+ Ny aktivitet» for å legge til.</p>';
      return;
    }
    var html = '<table class="tbl"><thead><tr>' +
      '<th>Navn</th><th>Status</th><th class="num">Pris</th><th class="num">Kapasitet</th><th></th>' +
      '</tr></thead><tbody>';
    rows.forEach(function (a) {
      var aktiv = a.aktiv !== false;
      html += '<tr class="' + (aktiv ? '' : 'inaktiv') + '" data-id="' + esc(a.id) + '">' +
        '<td><div class="navn">' + esc(a.navn || '–') + '</div>' +
        '<div class="slug">' + esc(a.slug || '') + '</div></td>' +
        '<td>' + (aktiv ? '<span class="akt-pill">Aktiv</span>' : '<span class="akt-pill av">Skjult</span>') + '</td>' +
        '<td class="num">' + krValuta(a.pris) + '</td>' +
        '<td class="num">' + (Number(a.kapasitet) || 0) + '</td>' +
        '<td><div class="handling">' +
          '<button class="knapp sek liten" data-rediger="' + esc(a.id) + '">Rediger</button>' +
          (aktiv ? '<button class="knapp fare liten" data-slett="' + esc(a.id) + '">Slett</button>' : '') +
        '</div></td>' +
        '</tr>';
    });
    html += '</tbody></table>';
    omr.innerHTML = html;

    // Lagre rader for redigering (unngår nytt nettverkskall).
    window.__rader = {};
    rows.forEach(function (a) { window.__rader[String(a.id)] = a; });

    var redKnapper = omr.querySelectorAll('[data-rediger]');
    for (var i = 0; i < redKnapper.length; i++) {
      redKnapper[i].addEventListener('click', function () {
        aktAapne(window.__rader[this.getAttribute('data-rediger')]);
      });
    }
    var slettKnapper = omr.querySelectorAll('[data-slett]');
    for (var j = 0; j < slettKnapper.length; j++) {
      slettKnapper[j].addEventListener('click', function () {
        aktSlett(this.getAttribute('data-slett'));
      });
    }
  }

  function aktAapne(rad) {
    rad = rad || null;
    $('dlg-tittel').textContent = rad ? 'Rediger aktivitet' : 'Ny aktivitet';
    $('f-id').value = rad ? rad.id : '';
    $('f-navn').value = rad ? (rad.navn || '') : '';
    $('f-slug').value = rad ? (rad.slug || '') : '';
    $('f-beskrivelse').value = rad ? (rad.beskrivelse || '') : '';
    $('f-varighet').value = rad ? (rad.varighet || '') : '';
    $('f-bilde').value = rad ? (rad.bilde || '') : '';
    $('f-pris').value = rad ? (Number(rad.pris) || 0) : 0;
    $('f-kapasitet').value = rad ? (Number(rad.kapasitet) || 0) : 0;
    $('akt-overlay').classList.add('vis');
    $('f-navn').focus();
  }
  function aktLukk() { $('akt-overlay').classList.remove('vis'); }

  function aktLagre(e) {
    e.preventDefault();
    var id = $('f-id').value.trim();
    var kropp = {
      navn: $('f-navn').value.trim(),
      slug: $('f-slug').value.trim(),
      beskrivelse: $('f-beskrivelse').value.trim() || null,
      varighet: $('f-varighet').value.trim() || null,
      bilde: $('f-bilde').value.trim() || null,
      pris: Number($('f-pris').value) || 0,
      kapasitet: Number($('f-kapasitet').value) || 0
    };
    $('lagre').disabled = true;
    var sti = id ? '/api/activities/' + encodeURIComponent(id) : '/api/activities';
    var metode = id ? 'PUT' : 'POST';
    api(sti, { method: metode, body: kropp })
      .then(jres)
      .then(function (res) {
        $('lagre').disabled = false;
        if (res.status === 401 || res.status === 403) { window.location = '/konto'; return; }
        if (!res.ok) {
          aktMelding((res.d && res.d.error) || 'Kunne ikke lagre.', 'feil');
          return;
        }
        aktLukk();
        aktMelding(id ? 'Aktivitet oppdatert.' : 'Aktivitet opprettet.', 'ok');
        aktLast();
      })
      .catch(function () {
        $('lagre').disabled = false;
        aktMelding('Kunne ikke lagre.', 'feil');
      });
  }

  function aktSlett(id) {
    var rad = window.__rader && window.__rader[String(id)];
    var navn = rad ? rad.navn : 'denne aktiviteten';
    if (!window.confirm('Skjule «' + navn + '»? Den fjernes fra nettsiden, men historikk beholdes.')) return;
    api('/api/activities/' + encodeURIComponent(id), { method: 'DELETE' })
      .then(jres)
      .then(function (res) {
        if (res.status === 401 || res.status === 403) { window.location = '/konto'; return; }
        if (!res.ok) {
          aktMelding((res.d && res.d.error) || 'Kunne ikke slette.', 'feil');
          return;
        }
        aktMelding('Aktivitet skjult.', 'ok');
        aktLast();
      })
      .catch(function () { aktMelding('Kunne ikke slette.', 'feil'); });
  }

  function initAktiviteter() {
    $('ny-knapp').addEventListener('click', function () { aktAapne(null); });
    $('avbryt').addEventListener('click', aktLukk);
    $('skjema').addEventListener('submit', aktLagre);
    $('akt-overlay').addEventListener('click', function (e) {
      if (e.target === $('akt-overlay')) aktLukk();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && $('akt-overlay').classList.contains('vis')) aktLukk();
    });
  }

  /* ================= Faner + lazy-lasting ================= */
  function byttFane(navn) {
    ['bookinger', 'agenda', 'aktiviteter'].forEach(function (f) {
      var panel = $('fane-' + f);
      var knapp = $('fane-knapp-' + f);
      var aktiv = (f === navn);
      if (panel) { panel.classList.toggle('aktiv', aktiv); if (aktiv) panel.removeAttribute('hidden'); else panel.setAttribute('hidden', ''); }
      if (knapp) knapp.setAttribute('aria-selected', aktiv ? 'true' : 'false');
    });
    if (navn === 'agenda' && !agendaLastet) { agendaLastet = true; agendaLast($('agenda-dato').value || agendaIdag); }
    if (navn === 'aktiviteter' && !aktiviteterLastet) { aktiviteterLastet = true; aktLast(); }
  }

  /* ================= Sanntid (Socket.IO, valgfritt) ================= */
  function kobleSanntid() {
    if (!window.io) return;
    try {
      var socket = window.io();
      // emit ved connect (og reconnect) så rom-medlemskapet holder seg.
      socket.on('connect', function () { socket.emit('bli_med_ansatt'); });
      socket.on('ny_booking', function () {
        lastBookinger();
        if (agendaLastet) agendaLast($('agenda-dato').value || agendaIdag);
      });
    } catch (e) {
      // uten sanntid virker manuell oppdatering / «Vis» som normalt
    }
  }

  /* ================= Init ================= */
  function settOppLoggUt() {
    var k = $('logg-ut');
    if (!k) return;
    k.addEventListener('click', function (e) {
      e.preventDefault();
      api('/api/auth/logout', { method: 'POST' }).then(function () { window.location = '/konto'; }).catch(function () { window.location = '/konto'; });
    });
  }

  function init() {
    settOppLoggUt();

    // Fane-veksling.
    Array.prototype.forEach.call(document.querySelectorAll('.fane-btn'), function (btn) {
      btn.addEventListener('click', function () { byttFane(btn.getAttribute('data-fane')); });
    });

    // Wire alle faner (data lastes lazy for agenda/aktiviteter).
    initBookinger();
    initAgenda();
    initAktiviteter();

    kobleSanntid();
  }

  // Ren komparator eksponeres for enhetstest (node/vitest) uten DOM/nettverk.
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { sammenlignBookinger: sammenlignBookinger };
  }

  // Tilgangssjekk (kun admin — siden har admin-only Aktiviteter-CRUD) —
  // kun i nettleser, ikke ved require i test.
  if (typeof document !== 'undefined' && typeof window !== 'undefined') {
    api('/api/auth/me').then(function (r) {
      if (r.status === 401) { window.location = '/konto'; return null; }
      return r.json();
    }).then(function (data) {
      var u = data && data.user ? data.user : data;
      if (!u) { window.location = '/konto'; return; }
      if (u.rolle !== 'admin') { window.location = '/konto'; return; }
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
      else init();
    }).catch(function () { window.location = '/konto'; });
  }
})();
