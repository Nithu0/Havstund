/* Havstund — intern dashboard-logikk (vanilla JS).
   Auth-sjekk + redirect, stats, søylediagram, booking-admin, innholds-CMS. */
(function () {
  'use strict';

  var STATUSER = ['forespurt', 'bekreftet', 'avlyst', 'fullfort'];

  function api(sti, opts) {
    opts = opts || {};
    opts.credentials = 'same-origin';
    if (opts.body && typeof opts.body !== 'string') {
      opts.headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
      opts.body = JSON.stringify(opts.body);
    }
    return fetch(sti, opts);
  }

  function kr(n) {
    var v = Number(n) || 0;
    return v.toLocaleString('no-NO') + ' kr';
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function dagNavn(isoDato) {
    var d = new Date(isoDato + 'T00:00:00');
    var navn = ['søn', 'man', 'tir', 'ons', 'tor', 'fre', 'lør'];
    if (isNaN(d.getTime())) return isoDato;
    return navn[d.getDay()];
  }

  function formatDato(s) {
    if (!s) return '';
    var d = new Date(s);
    if (isNaN(d.getTime())) return String(s).slice(0, 10);
    return d.toLocaleDateString('no-NO', { day: '2-digit', month: '2-digit', year: 'numeric' });
  }

  // ---- 1. Auth-sjekk (kun ansatt/admin) ----
  function init() {
    api('/api/auth/me')
      .then(function (r) {
        if (!r.ok) throw new Error('uautorisert');
        return r.json();
      })
      .then(function (data) {
        var user = data && data.user ? data.user : data;
        if (!user || (user.rolle !== 'ansatt' && user.rolle !== 'admin')) {
          window.location.href = '/konto';
          return;
        }
        startDashboard(user);
      })
      .catch(function () {
        window.location.href = '/konto';
      });
  }

  function startDashboard(user) {
    var navnEl = document.getElementById('whoNavn');
    if (navnEl) navnEl.innerHTML = 'Innlogget som <b>' + esc(user.navn || '') + '</b> (' + esc(user.rolle) + ')';

    if (user.rolle === 'admin') {
      var ok = document.getElementById('okonomiLink');
      if (ok) ok.style.display = '';
    }

    var logout = document.getElementById('logoutBtn');
    if (logout) {
      logout.addEventListener('click', function () {
        api('/api/auth/logout', { method: 'POST' }).finally(function () {
          window.location.href = '/konto';
        });
      });
    }

    lastStats();
    lastBookinger();
    lastInnhold();
  }

  // ---- 2. Stats + søylediagram ----
  function lastStats() {
    api('/api/admin/stats')
      .then(function (r) { return r.ok ? r.json() : Promise.reject(); })
      .then(function (s) {
        settTekst('kpiIdag', String(s.besokIdag));
        settTekst('kpi7d', String(s.besok7d));
        settTekst('kpiNye', String(s.bookingerNye));
        var oms = document.getElementById('kpiOms');
        if (oms) oms.innerHTML = esc(kr(s.omsetning30d));
        tegnSoyler(s.serie || []);
      })
      .catch(function () {
        var c = document.getElementById('chart');
        if (c) c.innerHTML = '<p class="muted-note">Kunne ikke hente statistikk.</p>';
      });
  }

  function settTekst(id, txt) {
    var el = document.getElementById(id);
    if (el) el.textContent = txt;
  }

  function tegnSoyler(serie) {
    var chart = document.getElementById('chart');
    if (!chart) return;
    chart.innerHTML = '';
    if (!serie.length) {
      chart.innerHTML = '<p class="muted-note">Ingen besøksdata ennå.</p>';
      return;
    }
    var maks = serie.reduce(function (m, d) { return Math.max(m, Number(d.besok) || 0); }, 0);
    serie.forEach(function (d) {
      var antall = Number(d.besok) || 0;
      var hoyde = maks > 0 ? Math.round((antall / maks) * 100) : 0;

      var wrap = document.createElement('div');
      wrap.className = 'bar-wrap';

      var bar = document.createElement('div');
      bar.className = 'bar';
      bar.style.height = (antall > 0 ? Math.max(hoyde, 6) : 2) + '%';
      var bv = document.createElement('span');
      bv.className = 'b-val';
      bv.textContent = String(antall);
      bar.appendChild(bv);

      var label = document.createElement('div');
      label.className = 'bar-label';
      label.textContent = dagNavn(d.dag);

      wrap.appendChild(bar);
      wrap.appendChild(label);
      chart.appendChild(wrap);
    });
  }

  // ---- 3. Bookinger + statusvelger ----
  function lastBookinger() {
    api('/api/bookings')
      .then(function (r) { return r.ok ? r.json() : Promise.reject(); })
      .then(function (data) {
        var rader = Array.isArray(data) ? data : (data.bookings || []);
        tegnBookinger(rader);
      })
      .catch(function () {
        var w = document.getElementById('bookingWrap');
        if (w) w.innerHTML = '<p class="muted-note">Kunne ikke hente bookinger.</p>';
      });
  }

  function tegnBookinger(rader) {
    var wrap = document.getElementById('bookingWrap');
    if (!wrap) return;
    if (!rader.length) {
      wrap.innerHTML = '<p class="muted-note">Ingen bookinger ennå.</p>';
      return;
    }

    var html = '<table class="tbl"><thead><tr>' +
      '<th>Kunde</th><th>Aktivitet</th><th>Dato</th><th>Antall</th><th>Beløp</th><th>Status</th>' +
      '</tr></thead><tbody>';

    rader.forEach(function (b) {
      var aktivitet = b.aktivitet_navn || b.aktivitet || b.activity_navn || b.aktivitetsnavn || '—';
      html += '<tr data-id="' + esc(b.id) + '">' +
        '<td>' + esc(b.navn) + '<br><span class="muted-note">' + esc(b.epost || '') + '</span></td>' +
        '<td>' + esc(aktivitet) + '</td>' +
        '<td>' + esc(formatDato(b.dato)) + (b.tid ? ' ' + esc(b.tid) : '') + '</td>' +
        '<td>' + esc(b.antall) + '</td>' +
        '<td class="belop">' + esc(kr(b.belop)) + '</td>' +
        '<td>' + statusVelger(b.status) + '</td>' +
        '</tr>';
    });
    html += '</tbody></table>';
    wrap.innerHTML = html;

    wrap.querySelectorAll('select[data-status]').forEach(function (sel) {
      sel.addEventListener('change', function () {
        var tr = sel.closest('tr');
        var id = tr.getAttribute('data-id');
        endreStatus(id, sel.value, sel);
      });
    });
  }

  function statusVelger(naa) {
    var opts = STATUSER.map(function (s) {
      return '<option value="' + s + '"' + (s === naa ? ' selected' : '') + '>' +
        s.charAt(0).toUpperCase() + s.slice(1) + '</option>';
    }).join('');
    return '<select data-status>' + opts + '</select>';
  }

  function endreStatus(id, status, sel) {
    sel.disabled = true;
    api('/api/bookings/' + encodeURIComponent(id), { method: 'PATCH', body: { status: status } })
      .then(function (r) {
        if (!r.ok) throw new Error();
        // Oppdater KPI-er siden status påvirker omsetning/nye
        lastStats();
      })
      .catch(function () {
        alert('Kunne ikke endre status. Prøv igjen.');
        lastBookinger();
      })
      .finally(function () { sel.disabled = false; });
  }

  // ---- 4. Innholds-CMS ----
  function lastInnhold() {
    api('/api/admin/content')
      .then(function (r) { return r.ok ? r.json() : Promise.reject(); })
      .then(function (rader) { tegnInnhold(Array.isArray(rader) ? rader : []); })
      .catch(function () {
        var w = document.getElementById('contentWrap');
        if (w) w.innerHTML = '<p class="muted-note">Kunne ikke hente innhold.</p>';
      });
  }

  function tegnInnhold(rader) {
    var wrap = document.getElementById('contentWrap');
    if (!wrap) return;
    if (!rader.length) {
      wrap.innerHTML = '<p class="muted-note">Ingen innholdsrader ennå.</p>';
      return;
    }
    wrap.innerHTML = '';
    rader.forEach(function (rad) {
      var row = document.createElement('div');
      row.className = 'content-row';

      var k = document.createElement('div');
      k.className = 'nokkel';
      k.textContent = rad.nokkel;

      var ta = document.createElement('textarea');
      ta.value = rad.verdi == null ? '' : rad.verdi;

      var cell = document.createElement('div');
      cell.className = 'save-cell';
      var btn = document.createElement('button');
      btn.className = 'btn btn-ghost';
      btn.textContent = 'Lagre';
      var tag = document.createElement('span');
      tag.className = 'saved-tag';
      tag.style.display = 'none';
      tag.textContent = 'Lagret ✓';

      btn.addEventListener('click', function () {
        btn.disabled = true;
        tag.style.display = 'none';
        api('/api/admin/content/' + encodeURIComponent(rad.nokkel), {
          method: 'PUT',
          body: { verdi: ta.value },
        })
          .then(function (r) {
            if (!r.ok) throw new Error();
            tag.style.display = '';
            setTimeout(function () { tag.style.display = 'none'; }, 2500);
          })
          .catch(function () { alert('Kunne ikke lagre «' + rad.nokkel + '».'); })
          .finally(function () { btn.disabled = false; });
      });

      cell.appendChild(btn);
      cell.appendChild(tag);
      row.appendChild(k);
      row.appendChild(ta);
      row.appendChild(cell);
      wrap.appendChild(row);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
