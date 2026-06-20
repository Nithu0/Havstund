/* Havstund — intern chat-innboks for ansatte.
   - Sjekker rolle (ansatt/admin) ved last, ellers redirect /konto.
   - Lister tråder, åpner en tråd, mottar live-meldinger via Socket.IO.
   - Svar som ansatt (emit 'ansatt_svar'), og «Overta fra AI» (emit 'ansatt_overtar'). */
(function () {
  'use strict';

  var socket = null;
  var aktivTraad = null;        // id på åpen tråd
  var traadStatus = {};         // id -> status (apen|ansatt|lukket)

  var trList = document.getElementById('trList');
  var convHd = document.getElementById('convHd');
  var convNavn = document.getElementById('convNavn');
  var convEpost = document.getElementById('convEpost');
  var convStatus = document.getElementById('convStatus');
  var convMsgs = document.getElementById('convMsgs');
  var convAlert = document.getElementById('convAlert');
  var replyForm = document.getElementById('replyForm');
  var replyInput = document.getElementById('replyInput');
  var overtaBtn = document.getElementById('overta');
  var oppdaterBtn = document.getElementById('oppdater');

  // ---------- hjelpere ----------
  function esc(s) {
    var d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  }

  function tid(ts) {
    if (!ts) return '';
    try {
      var d = new Date(ts);
      return d.toLocaleString('no-NO', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
    } catch (e) {
      return '';
    }
  }

  function statusPille(s) {
    var navn = s === 'ansatt' ? 'Ansatt' : s === 'lukket' ? 'Lukket' : 'AI svarer';
    return '<span class="pill ' + esc(s || 'apen') + '">' + navn + '</span>';
  }

  // ---------- innlogging ----------
  function sjekkTilgang() {
    return fetch('/api/auth/me', { credentials: 'same-origin' })
      .then(function (r) {
        if (!r.ok) throw new Error('uautorisert');
        return r.json();
      })
      .then(function (data) {
        var u = data && data.user;
        if (!u || (u.rolle !== 'ansatt' && u.rolle !== 'admin')) {
          throw new Error('feil rolle');
        }
        return u;
      })
      .catch(function () {
        window.location.href = '/konto';
        return null;
      });
  }

  // ---------- trådliste ----------
  function lastTraader() {
    return fetch('/api/chat/threads', { credentials: 'same-origin' })
      .then(function (r) {
        if (!r.ok) throw new Error('threads');
        return r.json();
      })
      .then(function (rows) {
        renderTraader(rows || []);
      })
      .catch(function () {
        trList.innerHTML = '<div class="tom" style="padding:20px">Kunne ikke laste samtaler. Prøv «Oppdater».</div>';
      });
  }

  function renderTraader(rows) {
    if (!rows.length) {
      trList.innerHTML = '<div class="tom" style="padding:20px">Ingen samtaler ennå.</div>';
      return;
    }
    var html = '';
    rows.forEach(function (t) {
      traadStatus[t.id] = t.status;
      var aktiv = Number(t.id) === Number(aktivTraad) ? ' active' : '';
      var navn = t.navn ? esc(t.navn) : 'Gjest #' + t.id;
      var prev = t.siste_tekst ? esc(t.siste_tekst) : 'Ingen meldinger';
      var prefiks = t.siste_avsender === 'kunde' ? '' : (t.siste_avsender === 'ai' ? 'AI: ' : 'Du: ');
      html +=
        '<div class="tr' + aktiv + '" data-id="' + t.id + '">' +
        '<div class="navn">' + navn + ' ' + statusPille(t.status) + '</div>' +
        '<div class="prev">' + esc(prefiks) + prev + '</div>' +
        '<div class="tid">' + tid(t.sist) + '</div>' +
        '</div>';
    });
    trList.innerHTML = html;

    Array.prototype.forEach.call(trList.querySelectorAll('.tr'), function (el) {
      el.addEventListener('click', function () {
        apneTraad(Number(el.getAttribute('data-id')));
      });
    });
  }

  // ---------- en samtale ----------
  function apneTraad(id) {
    if (aktivTraad && socket) socket.emit('forlat', aktivTraad);
    aktivTraad = id;
    convAlert.style.display = 'none';

    // marker aktiv i listen
    Array.prototype.forEach.call(trList.querySelectorAll('.tr'), function (el) {
      el.classList.toggle('active', Number(el.getAttribute('data-id')) === id);
    });

    convMsgs.innerHTML = '<div class="tom">Laster meldinger…</div>';
    convHd.style.display = 'flex';
    replyForm.style.display = 'flex';

    if (socket) socket.emit('bli_med', id);

    fetch('/api/chat/thread/' + id + '/messages', { credentials: 'same-origin' })
      .then(function (r) {
        if (!r.ok) throw new Error('messages');
        return r.json();
      })
      .then(function (data) {
        var traad = data.thread || {};
        traadStatus[id] = traad.status;
        convNavn.textContent = traad.navn || ('Gjest #' + id);
        convEpost.textContent = traad.epost || '';
        oppdaterStatusUI(traad.status);
        renderMeldinger(data.meldinger || []);
      })
      .catch(function () {
        convMsgs.innerHTML = '<div class="tom">Kunne ikke laste meldinger.</div>';
      });
  }

  function oppdaterStatusUI(status) {
    var s = status || 'apen';
    var navn = s === 'ansatt' ? 'Ansatt' : s === 'lukket' ? 'Lukket' : 'AI svarer';
    convStatus.className = 'pill ' + s;
    convStatus.textContent = navn;
    overtaBtn.style.display = s === 'ansatt' ? 'none' : 'inline-flex';
  }

  function renderMeldinger(liste) {
    if (!liste.length) {
      convMsgs.innerHTML = '<div class="tom">Ingen meldinger i denne samtalen ennå.</div>';
      return;
    }
    convMsgs.innerHTML = '';
    liste.forEach(function (m) { leggTil(m.avsender, m.tekst); });
    convMsgs.scrollTop = convMsgs.scrollHeight;
  }

  function leggTil(avsender, tekst) {
    if (convMsgs.querySelector('.tom')) convMsgs.innerHTML = '';
    var navn = avsender === 'kunde' ? 'Kunde' : avsender === 'ai' ? 'AI' : 'Ansatt';
    var el = document.createElement('div');
    el.className = 'm ' + avsender;
    el.innerHTML = '<div class="who">' + esc(navn) + '</div><span></span>';
    el.querySelector('span').textContent = tekst;
    convMsgs.appendChild(el);
    convMsgs.scrollTop = convMsgs.scrollHeight;
  }

  // ---------- Socket.IO ----------
  function kobleSocket() {
    if (!window.io) return;
    try {
      socket = window.io();
      socket.on('melding', function (m) {
        if (!m) return;
        if (Number(m.thread_id) === Number(aktivTraad)) {
          leggTil(m.avsender, m.tekst);
        }
        // oppdater listen så forhåndsvisning/rekkefølge holder seg fersk
        lastTraader();
      });
      socket.on('ansatt_overtatt', function (d) {
        if (d && Number(d.thread_id) === Number(aktivTraad)) {
          traadStatus[aktivTraad] = 'ansatt';
          oppdaterStatusUI('ansatt');
        }
      });
      socket.on('hent_ansatt', function (d) {
        if (d && Number(d.thread_id) === Number(aktivTraad)) {
          convAlert.textContent = 'AI ber om hjelp — kunden trenger en ansatt. Vurder «Overta fra AI».';
          convAlert.style.display = 'block';
        }
        lastTraader();
      });
    } catch (e) {
      // uten socket fungerer fortsatt liste + svar via reload
    }
  }

  // ---------- handlinger ----------
  replyForm.addEventListener('submit', function (e) {
    e.preventDefault();
    var tekst = replyInput.value.trim();
    if (!tekst || !aktivTraad) return;
    replyInput.value = '';

    if (socket) {
      // serveren lagrer og emitter 'melding' tilbake til rommet (også til oss)
      socket.emit('ansatt_svar', { thread_id: aktivTraad, tekst: tekst });
    } else {
      // fallback: vis lokalt om vi ikke har socket
      leggTil('ansatt', tekst);
    }
    replyInput.focus();
  });

  overtaBtn.addEventListener('click', function () {
    if (!aktivTraad) return;
    if (socket) socket.emit('ansatt_overtar', aktivTraad);
    traadStatus[aktivTraad] = 'ansatt';
    oppdaterStatusUI('ansatt');
    convAlert.style.display = 'none';
  });

  oppdaterBtn.addEventListener('click', lastTraader);

  // ---------- oppstart ----------
  sjekkTilgang().then(function (bruker) {
    if (!bruker) return;
    kobleSocket();
    lastTraader();
  });
})();
