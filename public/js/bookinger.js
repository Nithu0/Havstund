/* Havstund — dedikert booking-administrasjon (admin/ansatt). */
(function () {
  'use strict';

  var STATUSER = ['forespurt', 'bekreftet', 'fullfort', 'avlyst'];
  var STATUS_TEKST = { forespurt: 'Venter svar', bekreftet: 'Bekreftet', fullfort: 'Fullført', avlyst: 'Avlyst' };

  var alle = []; // alle bookinger (rådata)

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
  function kr(n) { return (Number(n) || 0).toLocaleString('no-NO') + ' kr'; }
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

  function init() {
    $('logg-ut').addEventListener('click', function (e) {
      e.preventDefault();
      api('/api/auth/logout', { method: 'POST' }).then(function () { window.location = '/konto'; }).catch(function () { window.location = '/konto'; });
    });
    ['sok', 'f-status', 'f-tid'].forEach(function (id) {
      var el = $(id);
      el.addEventListener(id === 'sok' ? 'input' : 'change', render);
    });
    lastBookinger();
  }

  // Ren komparator eksponeres for enhetstest (node/vitest) uten DOM/nettverk.
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { sammenlignBookinger: sammenlignBookinger };
  }

  // Tilgangssjekk (kun ansatt/admin) — kun i nettleser, ikke ved require i test.
  if (typeof document !== 'undefined' && typeof window !== 'undefined') {
    api('/api/auth/me').then(function (r) {
      if (r.status === 401) { window.location = '/konto'; return null; }
      return r.json();
    }).then(function (data) {
      if (!data || !data.user) { window.location = '/konto'; return; }
      if (data.user.rolle !== 'ansatt' && data.user.rolle !== 'admin') { window.location = '/min-side'; return; }
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
      else init();
    }).catch(function () { window.location = '/konto'; });
  }
})();
