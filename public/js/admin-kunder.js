'use strict';
/* Havstund — admin «Kunder», samlet side med tre faner:
   - Kunder:    søk (/api/customers/search) + profil (/api/crm/customers/:id/profile).
   - Meldinger: asynkron kundedialog (/api/meldinger/kunder, /api/meldinger).
   - Live chat: sanntids chat-innboks via Socket.IO (/api/chat/threads, /api/chat/thread/:id/messages).
   Ren frontend-konsolidering — backend-API-ene er uendret. */
(function () {

  // ---------- Delte hjelpere ----------
  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  var krFmt = new Intl.NumberFormat('no-NO', { style: 'currency', currency: 'NOK', maximumFractionDigits: 0 });
  function kr(v) { return krFmt.format(Number(v) || 0); }
  function dato(s) {
    if (!s) return '–';
    var d = new Date(s);
    return isNaN(d.getTime()) ? '–' : d.toLocaleDateString('no-NO');
  }
  function datoFull(v) {
    if (!v) return '';
    var d = new Date(v);
    if (isNaN(d.getTime())) return esc(v);
    return d.toLocaleString('no-NO', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  }
  function tid(ts) {
    if (!ts) return '';
    var d = new Date(ts);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleString('no-NO', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  }
  function initialer(navn) {
    var d = String(navn || '?').trim().split(/\s+/);
    return ((d[0] ? d[0][0] : '?') + (d.length > 1 ? d[d.length - 1][0] : '')).toUpperCase();
  }
  function api(sti, opt) {
    opt = opt || {};
    var cfg = { method: opt.method || 'GET', credentials: 'same-origin', headers: { Accept: 'application/json' } };
    if (opt.body !== undefined) { cfg.headers['Content-Type'] = 'application/json'; cfg.body = JSON.stringify(opt.body); }
    return fetch(sti, cfg);
  }
  function json(res) { return res.json().catch(function () { return null; }); }
  function laas(skjema, av) {
    if (!skjema) return;
    skjema.querySelectorAll('input,textarea,button,select').forEach(function (e) { e.disabled = !!av; });
  }

  // ==========================================================================
  //  FANE 1 — KUNDER (søk + profil)
  // ==========================================================================
  var valgtId = null;

  function sok(q) {
    var liste = $('treff');
    if (!liste) return;
    liste.innerHTML = '<li class="tom" style="border:none;cursor:default">Søker…</li>';
    api('/api/customers/search?q=' + encodeURIComponent(q))
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (res) {
        if (!res.ok) {
          liste.innerHTML = '<li class="tom" style="border:none;cursor:default">' + esc((res.d && res.d.error) || 'Feil ved søk') + '</li>';
          return;
        }
        var rows = res.d;
        if (!Array.isArray(rows) || !rows.length) {
          liste.innerHTML = '<li class="tom" style="border:none;cursor:default">Ingen treff.</li>';
          return;
        }
        liste.innerHTML = '';
        rows.forEach(function (k) {
          var li = document.createElement('li');
          li.setAttribute('data-id', k.id);
          li.innerHTML = '<div class="navn">' + esc(k.navn || '–') + '</div><div class="epost">' + esc(k.epost) + '</div>';
          li.addEventListener('click', function () { velg(k.id, li); });
          liste.appendChild(li);
        });
      })
      .catch(function () {
        liste.innerHTML = '<li class="tom" style="border:none;cursor:default">Feil ved søk.</li>';
      });
  }

  function velg(id, li) {
    valgtId = id;
    var alle = document.querySelectorAll('#treff li');
    for (var i = 0; i < alle.length; i++) alle[i].classList.remove('aktiv');
    if (li) li.classList.add('aktiv');
    lastProfil(id);
  }

  function lastProfil(id) {
    if (!$('profil-hint') || !$('profil')) return;
    $('profil-hint').textContent = 'Laster…';
    $('profil').innerHTML = '';
    api('/api/crm/customers/' + encodeURIComponent(id) + '/profile')
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (res) {
        if (!res.ok) {
          $('profil-hint').textContent = (res.d && res.d.error) || 'Kunne ikke hente profil.';
          return;
        }
        tegnProfil(res.d);
      })
      .catch(function () { $('profil-hint').textContent = 'Kunne ikke hente profil.'; });
  }

  function tegnProfil(p) {
    var b = p.bruker || {};
    var o = p.oppsummering || {};
    if ($('profil-tittel')) $('profil-tittel').textContent = b.navn || 'Kundeprofil';
    if ($('profil-hint')) $('profil-hint').textContent = esc(b.epost || '') + ' · kunde siden ' + dato(b.opprettet);

    var html = '';
    html += '<div class="kpis">' +
      '<div class="kpi"><div class="label">Bookinger</div><div class="val">' + (Number(o.antall_bookinger) || 0) + '</div></div>' +
      '<div class="kpi"><div class="label">Omsetning</div><div class="val">' + kr(o.omsetning) + '</div></div>' +
      '<div class="kpi"><div class="label">Meldinger</div><div class="val">' + (Number(o.antall_meldinger) || 0) + '</div></div>' +
      '<div class="kpi"><div class="label">Prosjekter</div><div class="val">' + (Number(o.antall_prosjekter) || 0) + '</div></div>' +
      '</div>';

    html += '<h3 style="margin-top:8px">Bookinger</h3>';
    if (p.bookinger && p.bookinger.length) {
      html += '<table class="tbl"><thead><tr><th>Aktivitet</th><th>Dato</th><th>Status</th><th class="num">Antall</th><th class="num">Beløp</th></tr></thead><tbody>';
      p.bookinger.forEach(function (x) {
        html += '<tr><td>' + esc(x.aktivitet || '–') + '</td><td>' + dato(x.dato) + '</td>' +
          '<td><span class="pill">' + esc(x.status) + '</span></td>' +
          '<td class="num">' + (Number(x.antall) || 0) + '</td>' +
          '<td class="num">' + kr(x.belop) + '</td></tr>';
      });
      html += '</tbody></table>';
    } else { html += '<p class="tom">Ingen bookinger.</p>'; }

    html += '<h3 style="margin-top:18px">Meldinger</h3>';
    if (p.meldinger && p.meldinger.length) {
      html += '<table class="tbl"><thead><tr><th>Avsender</th><th>Melding</th><th>Tid</th></tr></thead><tbody>';
      p.meldinger.forEach(function (m) {
        html += '<tr><td><span class="pill">' + esc(m.avsender) + '</span></td>' +
          '<td>' + esc(m.tekst) + '</td><td class="num">' + dato(m.opprettet) + '</td></tr>';
      });
      html += '</tbody></table>';
    } else { html += '<p class="tom">Ingen meldinger.</p>'; }

    html += '<h3 style="margin-top:18px">Prosjekter</h3>';
    if (p.prosjekter && p.prosjekter.length) {
      html += '<table class="tbl"><thead><tr><th>Tittel</th><th>Type</th><th>Status</th><th class="num">Opprettet</th></tr></thead><tbody>';
      p.prosjekter.forEach(function (pr) {
        html += '<tr><td>' + esc(pr.tittel) + '</td><td>' + esc(pr.type || '–') + '</td>' +
          '<td><span class="pill">' + esc(pr.status) + '</span></td>' +
          '<td class="num">' + dato(pr.opprettet) + '</td></tr>';
      });
      html += '</tbody></table>';
    } else { html += '<p class="tom">Ingen prosjekter.</p>'; }

    if ($('profil')) $('profil').innerHTML = html;
  }

  // ==========================================================================
  //  FANE 2 — MELDINGER (asynkron kundedialog)
  // ==========================================================================
  var meldValgtId = null;
  var meldValgtKunde = null;
  var meldLastet = false;

  function meldLastKunder() {
    var liste = $('meld-liste');
    if (!liste) return Promise.resolve();
    return api('/api/meldinger/kunder').then(function (res) { return res.ok ? json(res) : Promise.reject(); })
      .then(function (kunder) { meldRenderKunder(Array.isArray(kunder) ? kunder : []); })
      .catch(function () { liste.innerHTML = '<div class="liste-tom">Kunne ikke laste kunder.</div>'; });
  }

  function meldRenderKunder(kunder) {
    var liste = $('meld-liste');
    if (!liste) return;
    var q = (($('meld-sok') && $('meld-sok').value) || '').trim().toLowerCase();
    if (q) {
      kunder = kunder.filter(function (k) {
        return ((k.navn || '') + ' ' + (k.epost || '')).toLowerCase().indexOf(q) !== -1;
      });
    }
    if (!kunder.length) { liste.innerHTML = '<div class="liste-tom">Ingen kunder.</div>'; return; }
    liste.innerHTML = kunder.map(function (k) {
      var ulest = Number(k.uleste) || 0;
      var aktiv = String(k.bruker_id) === String(meldValgtId) ? ' active' : '';
      return '<div class="kunde-rad' + aktiv + '" data-id="' + esc(k.bruker_id) + '" data-navn="' + esc(k.navn || '') + '" data-epost="' + esc(k.epost || '') + '">' +
        '<div class="avatar">' + esc(initialer(k.navn || k.epost)) + '</div>' +
        '<div class="info"><div class="navn">' + esc(k.navn || k.epost || 'Ukjent') + '</div>' +
        '<div class="utdrag">' + esc(k.siste_tekst || '') + '</div></div>' +
        (ulest ? '<div class="badge-ulest">' + ulest + '</div>' : '') +
        '</div>';
    }).join('');
    liste.querySelectorAll('.kunde-rad').forEach(function (rad) {
      rad.addEventListener('click', function () {
        meldVelgKunde(rad.getAttribute('data-id'), { navn: rad.getAttribute('data-navn'), epost: rad.getAttribute('data-epost') });
      });
    });
  }

  function meldVelgKunde(id, info) {
    if (id == null) return;
    meldValgtId = id;
    meldValgtKunde = info || null;
    if ($('meld-panel')) $('meld-panel').style.display = '';
    if ($('meld-ingen')) $('meld-ingen').style.display = 'none';
    meldVisValgt();
    meldLastTraad();
    meldLastKunder();
  }

  function meldVisValgt() {
    var navnEl = $('meld-vk-navn');
    var epostEl = $('meld-vk-epost');
    if (navnEl) navnEl.textContent = (meldValgtKunde && meldValgtKunde.navn) || ('Kunde #' + meldValgtId);
    if (epostEl) epostEl.textContent = (meldValgtKunde && meldValgtKunde.epost) || '';
  }

  function meldLastTraad() {
    var traad = $('meld-traad');
    if (!traad || meldValgtId == null) return Promise.resolve();
    return api('/api/meldinger?bruker_id=' + encodeURIComponent(meldValgtId))
      .then(function (res) { return res.ok ? json(res) : Promise.reject(); })
      .then(function (data) {
        if (data && data.kunde) { meldValgtKunde = data.kunde; meldVisValgt(); }
        meldRenderTraad((data && Array.isArray(data.meldinger)) ? data.meldinger : []);
      })
      .catch(function () { traad.innerHTML = '<div class="pane-tom">Kunne ikke laste samtalen.</div>'; });
  }

  function meldRenderTraad(meldinger) {
    var traad = $('meld-traad');
    if (!traad) return;
    if (!meldinger.length) { traad.innerHTML = '<div class="pane-tom">Ingen meldinger ennå.</div>'; return; }
    traad.innerHTML = meldinger.map(function (m) {
      var fraOss = m.avsender === 'admin' || m.avsender === 'ansatt';
      var harPris = m.pris !== null && m.pris !== undefined && m.pris !== '' && !isNaN(Number(m.pris));
      if (fraOss && harPris) {
        return '<div class="tilbud-kort">' +
          '<div class="tk-tag">Pristilbud</div>' +
          '<div class="tk-belop">' + esc(kr(m.pris)) + '</div>' +
          '<div class="tk-tekst">' + esc(m.tekst || '') + '</div>' +
          '<div class="meta" style="margin-top:8px;color:var(--muted)">' + datoFull(m.opprettet) + '</div></div>';
      }
      return '<div class="melding ' + (fraOss ? 'fra-oss' : 'fra-kunde') + '">' +
        '<div class="meta">' + (fraOss ? 'Havstund' : 'Kunde') + ' · ' + datoFull(m.opprettet) + '</div>' +
        esc(m.tekst || '') + '</div>';
    }).join('');
    traad.scrollTop = traad.scrollHeight;
  }

  function meldHandterSvar(e) {
    e.preventDefault();
    if (meldValgtId == null) return;
    var tekstEl = $('meld-svar-tekst'), prisEl = $('meld-svar-pris');
    var tekst = tekstEl ? tekstEl.value.trim() : '';
    if (!tekst) { if (tekstEl) tekstEl.focus(); return; }
    var body = { tekst: tekst };
    if (prisEl && prisEl.value !== '' && !isNaN(Number(prisEl.value))) body.pris = Number(prisEl.value);
    var skjema = $('meld-svar-skjema');
    laas(skjema, true);
    api('/api/meldinger?bruker_id=' + encodeURIComponent(meldValgtId), { method: 'POST', body: body })
      .then(function (res) { if (!res.ok) throw new Error(); if (tekstEl) tekstEl.value = ''; if (prisEl) prisEl.value = ''; return meldLastTraad(); })
      .then(function () { return meldLastKunder(); })
      .catch(function () { alert('Kunne ikke sende svar. Prøv igjen.'); })
      .then(function () { laas(skjema, false); if (tekstEl) tekstEl.focus(); });
  }

  function meldInit() {
    if (meldLastet) return;
    meldLastet = true;
    if ($('meld-panel')) $('meld-panel').style.display = 'none';
    if ($('meld-ingen')) $('meld-ingen').style.display = '';
    if ($('meld-sok')) $('meld-sok').addEventListener('input', meldLastKunder);
    if ($('meld-svar-skjema')) $('meld-svar-skjema').addEventListener('submit', meldHandterSvar);
    meldLastKunder();
  }

  // ==========================================================================
  //  FANE 3 — LIVE CHAT (Socket.IO)
  // ==========================================================================
  var socket = null;
  var aktivTraad = null;
  var traadStatus = {};
  var chatLastet = false;

  function statusNavn(s) { return s === 'ansatt' ? 'Ansatt' : s === 'lukket' ? 'Lukket' : 'AI svarer'; }
  function statusPille(s) { return '<span class="pill ' + esc(s || 'apen') + '">' + statusNavn(s) + '</span>'; }

  function chatLastTraader() {
    var trList = $('chat-liste');
    if (!trList) return Promise.resolve();
    return fetch('/api/chat/threads', { credentials: 'same-origin' })
      .then(function (r) { if (!r.ok) throw new Error('threads'); return r.json(); })
      .then(function (rows) { chatRenderTraader(rows || []); })
      .catch(function () { trList.innerHTML = '<div class="tom" style="padding:20px">Kunne ikke laste samtaler. Prøv «Oppdater».</div>'; });
  }

  function chatRenderTraader(rows) {
    var trList = $('chat-liste');
    if (!trList) return;
    if (!rows.length) { trList.innerHTML = '<div class="tom" style="padding:20px">Ingen samtaler ennå.</div>'; return; }
    var html = '';
    rows.forEach(function (t) {
      traadStatus[t.id] = t.status;
      var aktiv = Number(t.id) === Number(aktivTraad) ? ' active' : '';
      var navn = t.navn ? esc(t.navn) : 'Gjest #' + t.id;
      var prev = t.siste_tekst ? esc(t.siste_tekst) : 'Ingen meldinger';
      var prefiks = t.siste_avsender === 'kunde' ? '' : (t.siste_avsender === 'ai' ? 'AI: ' : 'Du: ');
      html += '<div class="tr' + aktiv + '" data-id="' + t.id + '">' +
        '<div class="navn">' + navn + ' ' + statusPille(t.status) + '</div>' +
        '<div class="prev">' + esc(prefiks) + prev + '</div>' +
        '<div class="tid">' + tid(t.sist) + '</div></div>';
    });
    trList.innerHTML = html;
    Array.prototype.forEach.call(trList.querySelectorAll('.tr'), function (el) {
      el.addEventListener('click', function () { chatApneTraad(Number(el.getAttribute('data-id'))); });
    });
  }

  function chatApneTraad(id) {
    var trList = $('chat-liste');
    if (aktivTraad && socket) socket.emit('forlat', aktivTraad);
    aktivTraad = id;
    if ($('chat-alert')) $('chat-alert').style.display = 'none';
    if (trList) {
      Array.prototype.forEach.call(trList.querySelectorAll('.tr'), function (el) {
        el.classList.toggle('active', Number(el.getAttribute('data-id')) === id);
      });
    }
    if ($('chat-msgs')) $('chat-msgs').innerHTML = '<div class="tom">Laster meldinger…</div>';
    if ($('chat-hd')) $('chat-hd').style.display = 'flex';
    if ($('chat-reply')) $('chat-reply').style.display = 'flex';

    if (socket) socket.emit('bli_med', id);

    fetch('/api/chat/thread/' + id + '/messages', { credentials: 'same-origin' })
      .then(function (r) { if (!r.ok) throw new Error('messages'); return r.json(); })
      .then(function (data) {
        var traad = data.thread || {};
        traadStatus[id] = traad.status;
        if ($('chat-navn')) $('chat-navn').textContent = traad.navn || ('Gjest #' + id);
        if ($('chat-epost')) $('chat-epost').textContent = traad.epost || '';
        chatOppdaterStatusUI(traad.status);
        chatRenderMeldinger(data.meldinger || []);
      })
      .catch(function () { if ($('chat-msgs')) $('chat-msgs').innerHTML = '<div class="tom">Kunne ikke laste meldinger.</div>'; });
  }

  function chatOppdaterStatusUI(status) {
    var s = status || 'apen';
    var el = $('chat-status');
    if (el) { el.className = 'pill ' + s; el.textContent = statusNavn(s); }
    var btn = $('chat-overta');
    if (btn) btn.style.display = s === 'ansatt' ? 'none' : 'inline-flex';
  }

  function chatRenderMeldinger(liste) {
    var convMsgs = $('chat-msgs');
    if (!convMsgs) return;
    if (!liste.length) { convMsgs.innerHTML = '<div class="tom">Ingen meldinger i denne samtalen ennå.</div>'; return; }
    convMsgs.innerHTML = '';
    liste.forEach(function (m) { chatLeggTil(m.avsender, m.tekst); });
    convMsgs.scrollTop = convMsgs.scrollHeight;
  }

  function chatLeggTil(avsender, tekst) {
    var convMsgs = $('chat-msgs');
    if (!convMsgs) return;
    if (convMsgs.querySelector('.tom')) convMsgs.innerHTML = '';
    var navn = avsender === 'kunde' ? 'Kunde' : avsender === 'ai' ? 'AI' : 'Ansatt';
    var el = document.createElement('div');
    el.className = 'm ' + avsender;
    el.innerHTML = '<div class="who">' + esc(navn) + '</div><span></span>';
    el.querySelector('span').textContent = tekst;
    convMsgs.appendChild(el);
    convMsgs.scrollTop = convMsgs.scrollHeight;
  }

  function chatKobleSocket() {
    if (!window.io || socket) return;
    try {
      socket = window.io();
      socket.on('melding', function (m) {
        if (!m) return;
        if (Number(m.thread_id) === Number(aktivTraad)) chatLeggTil(m.avsender, m.tekst);
        chatLastTraader();
      });
      socket.on('ansatt_overtatt', function (d) {
        if (d && Number(d.thread_id) === Number(aktivTraad)) {
          traadStatus[aktivTraad] = 'ansatt';
          chatOppdaterStatusUI('ansatt');
        }
      });
      socket.on('hent_ansatt', function (d) {
        if (d && Number(d.thread_id) === Number(aktivTraad) && $('chat-alert')) {
          $('chat-alert').textContent = 'AI ber om hjelp — kunden trenger en ansatt. Vurder «Overta fra AI».';
          $('chat-alert').style.display = 'block';
        }
        chatLastTraader();
      });
    } catch (e) {
      // uten socket fungerer fortsatt liste + svar via reload
    }
  }

  function chatInit() {
    if (chatLastet) return;
    chatLastet = true;
    var replyForm = $('chat-reply');
    if (replyForm) {
      replyForm.addEventListener('submit', function (e) {
        e.preventDefault();
        var input = $('chat-reply-input');
        var tekst = input ? input.value.trim() : '';
        if (!tekst || !aktivTraad) return;
        if (input) input.value = '';
        if (socket) socket.emit('ansatt_svar', { thread_id: aktivTraad, tekst: tekst });
        else chatLeggTil('ansatt', tekst);
        if (input) input.focus();
      });
    }
    var overtaBtn = $('chat-overta');
    if (overtaBtn) {
      overtaBtn.addEventListener('click', function () {
        if (!aktivTraad) return;
        if (socket) socket.emit('ansatt_overtar', aktivTraad);
        traadStatus[aktivTraad] = 'ansatt';
        chatOppdaterStatusUI('ansatt');
        if ($('chat-alert')) $('chat-alert').style.display = 'none';
      });
    }
    var oppdaterBtn = $('chat-oppdater');
    if (oppdaterBtn) oppdaterBtn.addEventListener('click', chatLastTraader);

    chatKobleSocket();
    chatLastTraader();
  }

  // ==========================================================================
  //  Faner + oppstart
  // ==========================================================================
  function byttFane(navn) {
    document.querySelectorAll('.fane').forEach(function (f) { f.classList.toggle('active', f.getAttribute('data-pane') === navn); });
    document.querySelectorAll('.pane').forEach(function (p) { p.classList.toggle('active', p.id === 'pane-' + navn); });
    if (navn === 'meldinger') meldInit();
    else if (navn === 'chat') chatInit();
  }

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

  function init() {
    document.querySelectorAll('.fane').forEach(function (f) {
      f.addEventListener('click', function () { byttFane(f.getAttribute('data-pane')); });
    });

    var sokForm = $('sok-form');
    if (sokForm) {
      sokForm.addEventListener('submit', function (e) {
        e.preventDefault();
        var q = $('sok-input') ? $('sok-input').value.trim() : '';
        if (q) sok(q);
      });
    }

    var loggUt = $('logg-ut');
    if (loggUt) {
      loggUt.addEventListener('click', function (e) {
        e.preventDefault();
        api('/api/auth/logout', { method: 'POST' })
          .then(function () { window.location = '/konto'; })
          .catch(function () { window.location = '/konto'; });
      });
    }

    sjekkInnlogging();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
