/* Havstund — Min side (kundeportal). Les-modus: kunden ser sitt eget,
   kan kun sende meldinger. Matcher klassene i min-side.html. */
(function () {
  'use strict';

  function $(id) { return document.getElementById(id); }
  function esc(v) {
    if (v === null || v === undefined) return '';
    return String(v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function api(url, opt) {
    opt = opt || {};
    opt.credentials = 'same-origin';
    opt.headers = Object.assign({ Accept: 'application/json' }, opt.headers || {});
    return fetch(url, opt);
  }
  function json(res) { return res.json().catch(function () { return null; }); }

  var MND = ['jan', 'feb', 'mar', 'apr', 'mai', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'des'];
  function d(v) {
    if (!v) return null;
    var dt = new Date(v);
    return isNaN(dt.getTime()) ? null : dt;
  }
  function datoLang(v) {
    var dt = d(v);
    if (!dt) return esc(v);
    return dt.toLocaleDateString('no-NO', { day: '2-digit', month: 'long', year: 'numeric' });
  }
  function tid(v) {
    var dt = d(v);
    if (!dt) return '';
    return dt.toLocaleString('no-NO', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  }
  function kr(v) {
    var n = Number(v);
    if (isNaN(n)) return '';
    return n.toLocaleString('no-NO', { style: 'currency', currency: 'NOK', maximumFractionDigits: 0 });
  }
  function vis(container, tomId, harData) {
    var tom = $(tomId);
    if (tom) tom.hidden = !!harData;
    if (container) container.style.display = harData ? '' : 'none';
  }

  // status -> [label, css-klasse]
  function bookingStatus(s) {
    return { forespurt: ['Venter', 'status-venter'], bekreftet: ['Bekreftet', 'status-bekreftet'],
      avlyst: ['Avlyst', 'status-avlyst'], fullfort: ['Fullført', 'status-fullfort'] }[s] || [s || '', ''];
  }
  function prosjektStatus(s) {
    return { pabegynt: ['Påbegynt', 'status-pagaar'], under_arbeid: ['Under arbeid', 'status-pagaar'],
      ferdig: ['Ferdig', 'status-fullfort'], levert: ['Levert', 'status-fullfort'] }[s] || [s || '', 'status-pagaar'];
  }
  function merke(par) {
    if (!par || !par[0]) return '';
    return '<span class="status ' + par[1] + '">' + esc(par[0]) + '</span>';
  }

  /* ---------- Bruker ---------- */
  function lastBruker() {
    return api('/api/auth/me').then(function (res) {
      if (res.status === 401 || !res.ok) { window.location = '/konto'; return null; }
      return json(res);
    }).then(function (data) {
      var u = data && data.user;
      if (!u) { window.location = '/konto'; return null; }
      // Ansatte/admin hører hjemme i admin-dashbordet
      if (u.rolle === 'ansatt' || u.rolle === 'admin') { window.location = '/intranett'; return null; }
      if ($('kunde-navn')) $('kunde-navn').textContent = u.navn || u.epost || 'Kunde';
      return u;
    }).catch(function () { window.location = '/konto'; return null; });
  }

  /* ---------- Bookinger (Mine timer) ---------- */
  function lastBookinger() {
    var c = $('mine-bookinger');
    if (!c) return;
    api('/api/bookings').then(function (r) { return r.ok ? json(r) : Promise.reject(); })
      .then(function (data) {
        var rader = Array.isArray(data) ? data : (data && data.bookings) || [];
        if (!rader.length) { c.innerHTML = ''; vis(c, 'tom-bookinger', false); return; }
        vis(c, 'tom-bookinger', true);
        c.innerHTML = rader.map(function (b) {
          var dt = d(b.dato);
          var dag = dt ? dt.getDate() : '–';
          var mnd = dt ? MND[dt.getMonth()] : '';
          var meta = [];
          meta.push('<span>' + datoLang(b.dato) + (b.tid ? ' kl. ' + esc(b.tid) : '') + '</span>');
          if (b.antall != null) meta.push('<span>' + esc(b.antall) + ' pers.</span>');
          if (b.belop != null) meta.push('<span>' + esc(kr(b.belop)) + '</span>');
          return '<div class="booking">' +
            '<div class="b-date"><span class="d-day">' + dag + '</span><span class="d-mon">' + mnd + '</span></div>' +
            '<div class="b-body"><h3>' + esc(b.aktivitet_navn || b.aktivitet || 'Aktivitet') + '</h3>' +
            '<div class="b-meta">' + meta.join('') + '</div></div>' +
            merke(bookingStatus(b.status)) +
            '</div>';
        }).join('');
      })
      .catch(function () { c.innerHTML = '<div class="empty">Kunne ikke laste timene dine.</div>'; });
  }

  /* ---------- Prosjekter ---------- */
  function lastProsjekter() {
    var c = $('mine-prosjekter');
    if (!c) return;
    api('/api/projects').then(function (r) { return r.ok ? json(r) : Promise.reject(); })
      .then(function (data) {
        var rader = Array.isArray(data) ? data : (data && data.projects) || [];
        if (!rader.length) { c.innerHTML = ''; vis(c, 'tom-prosjekter', false); return; }
        vis(c, 'tom-prosjekter', true);
        c.innerHTML = rader.map(function (p) {
          var media = Array.isArray(p.media) ? p.media : [];
          var galleri = media.length
            ? '<div class="p-gallery">' + media.map(function (m) {
                return '<img src="' + esc(m.url) + '" alt="' + esc(m.tittel || p.tittel || '') + '" data-full="' + esc(m.url) + '" loading="lazy">';
              }).join('') + '</div>'
            : '<p class="p-empty-media">Bilder av arbeidet ditt kommer her etter hvert.</p>';
          return '<div class="project">' +
            '<div class="p-head"><div><h3>' + esc(p.tittel || '') + '</h3>' +
            (p.type ? '<div class="p-type">' + esc(p.type) + '</div>' : '') + '</div>' +
            merke(prosjektStatus(p.status)) + '</div>' +
            (p.beskrivelse ? '<p class="p-desc">' + esc(p.beskrivelse) + '</p>' : '') +
            galleri + '</div>';
        }).join('');
        // Lightbox
        c.querySelectorAll('.p-gallery img').forEach(function (img) {
          img.style.cursor = 'zoom-in';
          img.addEventListener('click', function () { lightbox(img.getAttribute('data-full')); });
        });
      })
      .catch(function () { c.innerHTML = '<div class="empty">Kunne ikke laste prosjektene dine.</div>'; });
  }

  function lightbox(url) {
    if (!url) return;
    var o = document.createElement('div');
    o.style.cssText = 'position:fixed;inset:0;background:rgba(8,30,52,.88);display:flex;align-items:center;justify-content:center;z-index:9999;padding:30px;cursor:zoom-out';
    var img = document.createElement('img');
    img.src = url;
    img.style.cssText = 'max-width:100%;max-height:100%;border-radius:12px;box-shadow:0 20px 60px rgba(0,0,0,.5)';
    o.appendChild(img);
    function lukk() { if (o.parentNode) o.parentNode.removeChild(o); document.removeEventListener('keydown', onKey); }
    function onKey(e) { if (e.key === 'Escape') lukk(); }
    o.addEventListener('click', lukk);
    document.addEventListener('keydown', onKey);
    document.body.appendChild(o);
  }

  /* ---------- Kvitteringer ---------- */
  function lastKvitteringer() {
    var c = $('mine-kvitteringer');
    if (!c) return;
    api('/api/receipts').then(function (r) { return r.ok ? json(r) : Promise.reject(); })
      .then(function (data) {
        var rader = Array.isArray(data) ? data : (data && data.receipts) || [];
        if (!rader.length) { c.innerHTML = ''; vis(c, 'tom-kvitteringer', false); return; }
        vis(c, 'tom-kvitteringer', true);
        c.innerHTML = rader.map(function (k) {
          var betalt = k.betalt === true || k.betalt === 'true' || k.betalt === 1;
          return '<div class="receipt">' +
            '<span class="r-date">' + esc(datoLang(k.dato)) + '</span>' +
            '<span class="r-desc">' + esc(k.beskrivelse || '') + '</span>' +
            '<span class="r-amount">' + esc(kr(k.belop)) + '</span>' +
            '<span class="status ' + (betalt ? 'status-betalt' : 'status-ikke-betalt') + '">' + (betalt ? 'Betalt' : 'Ikke betalt') + '</span>' +
            '</div>';
        }).join('');
      })
      .catch(function () { c.innerHTML = '<div class="empty">Kunne ikke laste kvitteringer.</div>'; });
  }

  /* ---------- Meldinger ---------- */
  function renderMelding(m) {
    var fraKunde = m.avsender === 'kunde';
    var harPris = m.pris !== null && m.pris !== undefined && m.pris !== '' && !isNaN(Number(m.pris));
    var offer = (harPris && !fraKunde)
      ? '<div class="offer"><div class="o-label">Pristilbud</div><div class="o-price">' + esc(kr(m.pris)) + '</div>' +
        (m.tekst ? '<div class="o-desc">' + esc(m.tekst) + '</div>' : '') + '</div>'
      : '';
    var bubble = (harPris && !fraKunde)
      ? '' // prisen vises i offer-kortet i stedet for boble
      : '<div class="bubble">' + esc(m.tekst || '') + '</div>';
    return '<div class="msg ' + (fraKunde ? 'kunde' : 'admin') + '">' +
      bubble + offer +
      '<div class="meta">' + (fraKunde ? 'Meg' : 'Havstund') + (m.opprettet ? ' · ' + tid(m.opprettet) : '') + '</div>' +
      '</div>';
  }

  function lastMeldinger() {
    var t = $('meldinger-traad');
    if (!t) return;
    api('/api/meldinger').then(function (r) { return r.ok ? json(r) : Promise.reject(); })
      .then(function (data) {
        var rader = Array.isArray(data) ? data : (data && data.meldinger) || [];
        if (!rader.length) { t.innerHTML = ''; vis(t, 'tom-meldinger', false); return; }
        vis(t, 'tom-meldinger', true);
        t.innerHTML = rader.map(renderMelding).join('');
        t.scrollTop = t.scrollHeight;
      })
      .catch(function () { t.innerHTML = '<div class="empty" style="border:none">Kunne ikke laste meldinger.</div>'; });
  }

  function settOppMelding() {
    var skjema = $('melding-skjema'), tekstEl = $('melding-tekst');
    if (!skjema || !tekstEl) return;
    skjema.addEventListener('submit', function (e) {
      e.preventDefault();
      var tekst = tekstEl.value.trim();
      if (!tekst) return;
      var knapp = skjema.querySelector('button[type="submit"]');
      if (knapp) knapp.disabled = true;
      api('/api/meldinger', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tekst: tekst }) })
        .then(function (res) { if (!res.ok) throw new Error(); tekstEl.value = ''; return lastMeldinger(); })
        .catch(function () { alert('Kunne ikke sende melding. Prøv igjen.'); })
        .then(function () { if (knapp) knapp.disabled = false; tekstEl.focus(); });
    });
  }

  function settOppLoggUt() {
    var k = $('logg-ut');
    if (!k) return;
    k.addEventListener('click', function (e) {
      e.preventDefault();
      api('/api/auth/logout', { method: 'POST' }).then(function () { window.location = '/'; }).catch(function () { window.location = '/'; });
    });
  }

  function init() {
    settOppLoggUt();
    settOppMelding();
    lastBruker().then(function (bruker) {
      if (!bruker) return;
      lastBookinger();
      lastProsjekter();
      lastKvitteringer();
      lastMeldinger();
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
