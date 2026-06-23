'use strict';
/* Havstund — admin kundedialog. Én «mappe» per kunde: dialog, prosjekter/bilder, kvitteringer. */
(function () {
  var valgtKundeId = null;
  var valgtKunde = null;

  function $(id) { return document.getElementById(id); }
  function esc(v) {
    if (v === null || v === undefined) return '';
    return String(v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function initialer(navn) {
    var d = String(navn || '?').trim().split(/\s+/);
    return ((d[0] ? d[0][0] : '?') + (d.length > 1 ? d[d.length - 1][0] : '')).toUpperCase();
  }
  function dato(v) {
    if (!v) return '';
    var d = new Date(v);
    if (isNaN(d.getTime())) return esc(v);
    return d.toLocaleString('no-NO', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  }
  function datoKort(v) {
    if (!v) return '';
    var d = new Date(v);
    if (isNaN(d.getTime())) return esc(v);
    return d.toLocaleDateString('no-NO', { day: '2-digit', month: '2-digit', year: 'numeric' });
  }
  function belop(v) {
    var n = Number(v);
    if (isNaN(n)) return '';
    return n.toLocaleString('no-NO', { style: 'currency', currency: 'NOK', maximumFractionDigits: 0 });
  }
  function api(url, opt) {
    opt = opt || {};
    var cfg = { method: opt.method || 'GET', credentials: 'same-origin', headers: { Accept: 'application/json' } };
    if (opt.body !== undefined) { cfg.headers['Content-Type'] = 'application/json'; cfg.body = JSON.stringify(opt.body); }
    return fetch(url, cfg);
  }
  function json(res) { return res.json().catch(function () { return null; }); }
  function laas(skjema, av) {
    if (!skjema) return;
    skjema.querySelectorAll('input,textarea,button,select').forEach(function (e) { e.disabled = !!av; });
  }

  var STATUS = [['pabegynt', 'Påbegynt'], ['under_arbeid', 'Under arbeid'], ['ferdig', 'Ferdig'], ['levert', 'Levert']];
  var TYPE_NAVN = { maleri: 'Maleri', keramikk: 'Keramikk', kollektivt: 'Kollektivt', annet: 'Annet' };

  // ---------- Auth ----------
  function sjekkInnlogging() {
    return api('/api/auth/me').then(function (res) {
      if (res.status === 401 || !res.ok) { window.location = '/konto'; return null; }
      return json(res);
    }).then(function (data) {
      if (!data || !data.user) { window.location = '/konto'; return null; }
      if (data.user.rolle !== 'ansatt' && data.user.rolle !== 'admin') { window.location = '/min-side'; return null; }
      return data.user;
    }).catch(function () { window.location = '/konto'; return null; });
  }

  // ---------- Kundeliste ----------
  function lastKunder() {
    var liste = $('kunde-liste');
    if (!liste) return Promise.resolve();
    return api('/api/meldinger/kunder').then(function (res) { return res.ok ? json(res) : Promise.reject(); })
      .then(function (kunder) { renderKunder(Array.isArray(kunder) ? kunder : []); })
      .catch(function () { liste.innerHTML = '<div class="liste-tom">Kunne ikke laste kunder.</div>'; });
  }

  function renderKunder(kunder) {
    var liste = $('kunde-liste');
    if (!liste) return;
    var q = ($('kunde-sok') && $('kunde-sok').value || '').trim().toLowerCase();
    if (q) {
      kunder = kunder.filter(function (k) {
        return ((k.navn || '') + ' ' + (k.epost || '')).toLowerCase().indexOf(q) !== -1;
      });
    }
    if (!kunder.length) { liste.innerHTML = '<div class="liste-tom">Ingen kunder.</div>'; return; }
    liste.innerHTML = kunder.map(function (k) {
      var ulest = Number(k.uleste) || 0;
      var aktiv = String(k.bruker_id) === String(valgtKundeId) ? ' active' : '';
      return '<div class="kunde-rad' + aktiv + '" data-id="' + esc(k.bruker_id) + '" data-navn="' + esc(k.navn || '') + '" data-epost="' + esc(k.epost || '') + '">' +
        '<div class="avatar">' + esc(initialer(k.navn || k.epost)) + '</div>' +
        '<div class="info"><div class="navn">' + esc(k.navn || k.epost || 'Ukjent') + '</div>' +
        '<div class="utdrag">' + esc(k.siste_tekst || '') + '</div></div>' +
        (ulest ? '<div class="badge-ulest">' + ulest + '</div>' : '') +
        '</div>';
    }).join('');
    liste.querySelectorAll('.kunde-rad').forEach(function (rad) {
      rad.addEventListener('click', function () {
        velgKunde(rad.getAttribute('data-id'), { navn: rad.getAttribute('data-navn'), epost: rad.getAttribute('data-epost') });
      });
    });
  }

  // ---------- Velg kunde ----------
  function velgKunde(id, info) {
    if (id == null) return;
    valgtKundeId = id;
    valgtKunde = info || null;
    if ($('dialog-panel')) $('dialog-panel').style.display = '';
    if ($('ingen-valgt')) $('ingen-valgt').style.display = 'none';
    visValgtKunde();
    byttFane('dialog');
    lastTraad();
    lastProsjekter();
    lastKvitteringer();
    lastKunder();
  }

  function visValgtKunde() {
    var n = $('valgt-kunde');
    if (!n) return;
    var navnEl = n.querySelector('.vk-navn');
    var epostEl = n.querySelector('.vk-epost');
    if (navnEl) navnEl.textContent = (valgtKunde && valgtKunde.navn) || ('Kunde #' + valgtKundeId);
    if (epostEl) epostEl.textContent = (valgtKunde && valgtKunde.epost) || '';
  }

  // ---------- Faner ----------
  function byttFane(navn) {
    document.querySelectorAll('.tab').forEach(function (t) { t.classList.toggle('active', t.getAttribute('data-tab') === navn); });
    document.querySelectorAll('.tab-pane').forEach(function (p) { p.classList.toggle('active', p.id === 'pane-' + navn); });
  }

  // ---------- Dialog ----------
  function lastTraad() {
    var traad = $('dialog-traad');
    if (!traad || valgtKundeId == null) return Promise.resolve();
    return api('/api/meldinger?bruker_id=' + encodeURIComponent(valgtKundeId))
      .then(function (res) { return res.ok ? json(res) : Promise.reject(); })
      .then(function (data) {
        if (data && data.kunde) { valgtKunde = data.kunde; visValgtKunde(); }
        renderTraad((data && Array.isArray(data.meldinger)) ? data.meldinger : []);
      })
      .catch(function () { traad.innerHTML = '<div class="pane-tom">Kunne ikke laste samtalen.</div>'; });
  }

  function renderTraad(meldinger) {
    var traad = $('dialog-traad');
    if (!traad) return;
    if (!meldinger.length) { traad.innerHTML = '<div class="pane-tom">Ingen meldinger ennå.</div>'; return; }
    traad.innerHTML = meldinger.map(function (m) {
      var fraOss = m.avsender === 'admin' || m.avsender === 'ansatt';
      var harPris = m.pris !== null && m.pris !== undefined && m.pris !== '' && !isNaN(Number(m.pris));
      if (fraOss && harPris) {
        return '<div class="tilbud-kort">' +
          '<div class="tk-tag">Pristilbud</div>' +
          '<div class="tk-belop">' + esc(belop(m.pris)) + '</div>' +
          '<div class="tk-tekst">' + esc(m.tekst || '') + '</div>' +
          '<div class="meta" style="margin-top:8px;color:var(--muted)">' + dato(m.opprettet) + '</div></div>';
      }
      return '<div class="melding ' + (fraOss ? 'fra-oss' : 'fra-kunde') + '">' +
        '<div class="meta">' + (fraOss ? 'Havstund' : 'Kunde') + ' · ' + dato(m.opprettet) + '</div>' +
        esc(m.tekst || '') + '</div>';
    }).join('');
    traad.scrollTop = traad.scrollHeight;
  }

  function handterSvar(e) {
    e.preventDefault();
    if (valgtKundeId == null) return;
    var tekstEl = $('svar-tekst'), prisEl = $('svar-pris');
    var tekst = tekstEl ? tekstEl.value.trim() : '';
    if (!tekst) { if (tekstEl) tekstEl.focus(); return; }
    var body = { tekst: tekst };
    if (prisEl && prisEl.value !== '' && !isNaN(Number(prisEl.value))) body.pris = Number(prisEl.value);
    var skjema = $('svar-skjema');
    laas(skjema, true);
    api('/api/meldinger?bruker_id=' + encodeURIComponent(valgtKundeId), { method: 'POST', body: body })
      .then(function (res) { if (!res.ok) throw new Error(); if (tekstEl) tekstEl.value = ''; if (prisEl) prisEl.value = ''; return lastTraad(); })
      .then(function () { return lastKunder(); })
      .catch(function () { alert('Kunne ikke sende svar. Prøv igjen.'); })
      .then(function () { laas(skjema, false); if (tekstEl) tekstEl.focus(); });
  }

  // ---------- Prosjekter & bilder ----------
  function lastProsjekter() {
    var liste = $('prosjekter-liste');
    if (!liste || valgtKundeId == null) return Promise.resolve();
    return api('/api/projects?bruker_id=' + encodeURIComponent(valgtKundeId))
      .then(function (res) { return res.ok ? json(res) : Promise.reject(); })
      .then(function (p) { renderProsjekter(Array.isArray(p) ? p : []); })
      .catch(function () { liste.innerHTML = '<div class="pane-tom">Kunne ikke laste prosjekter.</div>'; });
  }

  function renderProsjekter(prosjekter) {
    var liste = $('prosjekter-liste');
    if (!liste) return;
    if (!prosjekter.length) { liste.innerHTML = '<div class="pane-tom">Ingen prosjekter ennå.</div>'; return; }
    liste.innerHTML = prosjekter.map(function (p) {
      var media = Array.isArray(p.media) ? p.media : [];
      var bilder = media.map(function (m) {
        return '<figure><a href="' + esc(m.url) + '" target="_blank" rel="noopener"><img src="' + esc(m.url) + '" alt="' + esc(m.tittel || '') + '" loading="lazy"></a>' +
          (m.tittel ? '<figcaption>' + esc(m.tittel) + '</figcaption>' : '') + '</figure>';
      }).join('');
      var statusOpts = STATUS.map(function (s) {
        return '<option value="' + s[0] + '"' + (s[0] === p.status ? ' selected' : '') + '>' + s[1] + '</option>';
      }).join('');
      var typeNavn = TYPE_NAVN[p.type] || p.type || 'Prosjekt';
      return '<div class="blokk" data-id="' + esc(p.id) + '">' +
        '<span class="type-tag">' + esc(typeNavn) + '</span>' +
        '<h3>' + esc(p.tittel || '') + '</h3>' +
        (p.beskrivelse ? '<p class="beskr">' + esc(p.beskrivelse) + '</p>' : '') +
        '<label style="font-size:13px;color:var(--muted)">Status: ' +
        '<select class="prosjekt-status" data-id="' + esc(p.id) + '" style="margin-left:6px">' + statusOpts + '</select></label>' +
        (bilder ? '<div class="bilde-rute">' + bilder + '</div>' : '') +
        '<form class="bilde-skjema" data-id="' + esc(p.id) + '">' +
        '<input type="file" class="f-fil" accept="image/*">' +
        '<input type="text" class="f-tit" placeholder="Tittel (valgfritt)">' +
        '<button type="submit" class="btn btn-primary btn-sm">Last opp kunstverk</button>' +
        '</form></div>';
    }).join('');

    liste.querySelectorAll('.prosjekt-status').forEach(function (sel) {
      sel.addEventListener('change', function () { endreStatus(sel.getAttribute('data-id'), sel.value); });
    });
    liste.querySelectorAll('.bilde-skjema').forEach(function (sk) {
      sk.addEventListener('submit', function (e) { e.preventDefault(); lastOppBilde(sk); });
    });
  }

  function endreStatus(pid, status) {
    if (!pid) return;
    api('/api/projects/' + encodeURIComponent(pid), { method: 'PATCH', body: { status: status } })
      .then(function (res) { if (!res.ok) throw new Error(); return lastProsjekter(); })
      .catch(function () { alert('Kunne ikke endre status.'); lastProsjekter(); });
  }

  function lastOppBilde(skjema) {
    var pid = skjema.getAttribute('data-id');
    var filEl = skjema.querySelector('.f-fil');
    var titEl = skjema.querySelector('.f-tit');
    var fil = filEl && filEl.files ? filEl.files[0] : null;
    if (!fil) { if (filEl) filEl.focus(); return; }
    if (fil.size > 2.5 * 1024 * 1024) { alert('Bildet er for stort — velg et mindre bilde (maks ~2,5 MB).'); return; }
    var reader = new FileReader();
    laas(skjema, true);
    reader.onload = function () {
      api('/api/projects/' + encodeURIComponent(pid) + '/media', { method: 'POST', body: { fil: reader.result, tittel: titEl ? titEl.value.trim() : '' } })
        .then(function (res) { if (!res.ok) throw new Error(); return lastProsjekter(); })
        .catch(function () { alert('Kunne ikke laste opp bildet. Prøv igjen.'); laas(skjema, false); });
    };
    reader.onerror = function () { alert('Kunne ikke lese bildet.'); laas(skjema, false); };
    reader.readAsDataURL(fil);
  }

  function handterNyttProsjekt(e) {
    e.preventDefault();
    if (valgtKundeId == null) return;
    var skjema = $('nytt-prosjekt');
    var tittel = ($('np-tittel') && $('np-tittel').value || '').trim();
    var type = ($('np-type') && $('np-type').value) || '';
    var beskrivelse = ($('np-beskrivelse') && $('np-beskrivelse').value || '').trim();
    if (!tittel) { if ($('np-tittel')) $('np-tittel').focus(); return; }
    laas(skjema, true);
    api('/api/projects', { method: 'POST', body: { bruker_id: valgtKundeId, tittel: tittel, type: type, beskrivelse: beskrivelse } })
      .then(function (res) { if (!res.ok) throw new Error(); if (skjema.reset) skjema.reset(); return lastProsjekter(); })
      .catch(function () { alert('Kunne ikke opprette prosjekt.'); })
      .then(function () { laas(skjema, false); });
  }

  // ---------- Kvitteringer ----------
  function lastKvitteringer() {
    var liste = $('kvitteringer-liste');
    if (!liste || valgtKundeId == null) return Promise.resolve();
    return api('/api/receipts?bruker_id=' + encodeURIComponent(valgtKundeId))
      .then(function (res) { return res.ok ? json(res) : Promise.reject(); })
      .then(function (data) {
        var rader = Array.isArray(data) ? data : (data && data.receipts) || [];
        renderKvitteringer(rader);
      })
      .catch(function () { liste.innerHTML = '<div class="pane-tom">Kunne ikke laste kvitteringer.</div>'; });
  }

  function renderKvitteringer(kvit) {
    var liste = $('kvitteringer-liste');
    if (!liste) return;
    if (!kvit.length) { liste.innerHTML = '<div class="pane-tom">Ingen kvitteringer ennå.</div>'; return; }
    liste.innerHTML = kvit.map(function (k) {
      var betalt = k.betalt === true || k.betalt === 'true' || k.betalt === 1;
      return '<div class="kvit-rad">' +
        '<div class="kv-belop">' + esc(belop(k.belop)) + '</div>' +
        '<div class="kv-info"><div class="kv-beskr">' + esc(k.beskrivelse || '') + '</div>' +
        '<div class="kv-dato">' + datoKort(k.dato) + '</div></div>' +
        '<span class="status-pill ' + (betalt ? 'betalt' : 'ubetalt') + '">' + (betalt ? 'Betalt' : 'Ubetalt') + '</span>' +
        '</div>';
    }).join('');
  }

  function handterNyKvittering(e) {
    e.preventDefault();
    if (valgtKundeId == null) return;
    var skjema = $('ny-kvittering');
    var belopV = $('nk-belop') ? Number($('nk-belop').value) : NaN;
    var beskrivelse = ($('nk-beskrivelse') && $('nk-beskrivelse').value || '').trim();
    var betalt = $('nk-betalt') ? $('nk-betalt').checked : false;
    var datoV = $('nk-dato') ? $('nk-dato').value : '';
    if (isNaN(belopV)) { if ($('nk-belop')) $('nk-belop').focus(); return; }
    laas(skjema, true);
    api('/api/receipts', { method: 'POST', body: { bruker_id: valgtKundeId, belop: belopV, beskrivelse: beskrivelse, betalt: betalt, dato: datoV } })
      .then(function (res) { if (!res.ok) throw new Error(); if (skjema.reset) skjema.reset(); return lastKvitteringer(); })
      .catch(function () { alert('Kunne ikke opprette kvittering.'); })
      .then(function () { laas(skjema, false); });
  }

  // ---------- Init ----------
  function init() {
    if ($('dialog-panel')) $('dialog-panel').style.display = 'none';
    if ($('ingen-valgt')) $('ingen-valgt').style.display = '';

    document.querySelectorAll('.tab').forEach(function (t) {
      t.addEventListener('click', function () { byttFane(t.getAttribute('data-tab')); });
    });
    if ($('kunde-sok')) $('kunde-sok').addEventListener('input', lastKunder);
    if ($('svar-skjema')) $('svar-skjema').addEventListener('submit', handterSvar);
    if ($('nytt-prosjekt')) $('nytt-prosjekt').addEventListener('submit', handterNyttProsjekt);
    if ($('ny-kvittering')) $('ny-kvittering').addEventListener('submit', handterNyKvittering);
    if ($('logg-ut')) $('logg-ut').addEventListener('click', function (e) {
      e.preventDefault();
      api('/api/auth/logout', { method: 'POST' }).then(function () { window.location = '/konto'; }).catch(function () { window.location = '/konto'; });
    });

    sjekkInnlogging().then(function (bruker) { if (bruker) lastKunder(); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
