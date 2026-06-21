/* Havstund — konto-side: innlogging, registrering, Min side. */
(function () {
  'use strict';

  var elUtlogget = document.getElementById('utlogget');
  var elInnlogget = document.getElementById('innlogget');

  function hent(id) { return document.getElementById(id); }

  function visMelding(el, tekst, type) {
    if (!el) return;
    el.textContent = tekst || '';
    el.classList.remove('feil', 'ok', 'vis');
    if (tekst) {
      el.classList.add('vis', type || 'feil');
    }
  }

  function api(sti, opt) {
    opt = opt || {};
    opt.credentials = 'same-origin';
    opt.headers = Object.assign({ 'Content-Type': 'application/json' }, opt.headers || {});
    return fetch(sti, opt);
  }

  // Pen feiltekst fra svar.
  function feilTekst(data, fallback) {
    if (data && typeof data.error === 'string') return data.error;
    return fallback || 'Noe gikk galt. Prøv igjen.';
  }

  /* ---------- Faner ---------- */
  function settOppFaner() {
    var tabs = document.querySelectorAll('.tab');
    Array.prototype.forEach.call(tabs, function (tab) {
      tab.addEventListener('click', function () {
        var navn = tab.getAttribute('data-tab');
        Array.prototype.forEach.call(tabs, function (t) { t.classList.remove('active'); });
        tab.classList.add('active');
        document.querySelectorAll('.pane').forEach(function (p) { p.classList.remove('active'); });
        var pane = hent('pane-' + navn);
        if (pane) pane.classList.add('active');
      });
    });
  }

  /* ---------- Visninger ---------- */
  function gaaTilRiktigSide(user) {
    if (user.rolle === 'ansatt' || user.rolle === 'admin') {
      window.location = '/intranett';
    } else {
      window.location = '/min-side';
    }
  }

  function visInnlogget(user) {
    elUtlogget.style.display = 'none';
    elInnlogget.style.display = 'block';

    hent('hilsen').textContent = 'Hei, ' + (user.navn || '') + '!';
    hent('vis-navn').textContent = user.navn || '—';
    hent('vis-epost').textContent = user.epost || '—';
    hent('vis-rolle').textContent = user.rolle || 'kunde';

    // Rolle-baserte snarveier.
    var erAnsattEllerAdmin = user.rolle === 'ansatt' || user.rolle === 'admin';
    hent('lenke-intranett').style.display = erAnsattEllerAdmin ? 'inline-flex' : 'none';
    hent('lenke-okonomi').style.display = user.rolle === 'admin' ? 'inline-flex' : 'none';

    lastBookinger();
  }

  function visUtlogget() {
    elInnlogget.style.display = 'none';
    elUtlogget.style.display = 'block';
  }

  /* ---------- Bookinger ---------- */
  function formaterDato(verdi) {
    if (!verdi) return '';
    var d = new Date(verdi);
    if (isNaN(d.getTime())) return String(verdi);
    return d.toLocaleDateString('no-NO', { day: '2-digit', month: 'short', year: 'numeric' });
  }

  function lastBookinger() {
    var liste = hent('booking-liste');
    var tom = hent('booking-tom');
    liste.innerHTML = '';
    tom.style.display = 'none';

    api('/api/bookings').then(function (r) {
      if (!r.ok) throw new Error('feil');
      return r.json();
    }).then(function (data) {
      var bookinger = Array.isArray(data) ? data : (data.bookings || []);
      if (!bookinger.length) {
        tom.style.display = 'block';
        return;
      }
      bookinger.forEach(function (b) {
        liste.appendChild(byggBooking(b));
      });
    }).catch(function () {
      tom.textContent = 'Klarte ikke å hente bookinger akkurat nå.';
      tom.style.display = 'block';
    });
  }

  function byggBooking(b) {
    var li = document.createElement('li');

    var topp = document.createElement('div');
    topp.className = 'b-topp';

    var akt = document.createElement('span');
    akt.className = 'b-akt';
    akt.textContent = b.aktivitet || b.aktivitet_navn || b.activity_navn || 'Aktivitet';

    var dato = document.createElement('span');
    dato.className = 'b-dato';
    dato.textContent = formaterDato(b.dato) + (b.tid ? ' · ' + b.tid : '');

    topp.appendChild(akt);
    topp.appendChild(dato);

    var bunn = document.createElement('div');
    bunn.className = 'b-bunn';

    var antall = document.createElement('span');
    antall.textContent = (b.antall != null ? b.antall : 1) + ' personer';

    var status = document.createElement('span');
    var s = (b.status || 'forespurt').toLowerCase();
    status.className = 'status-pill ' + s;
    status.textContent = b.status || 'forespurt';

    bunn.appendChild(antall);
    bunn.appendChild(status);

    li.appendChild(topp);
    li.appendChild(bunn);
    return li;
  }

  /* ---------- Skjema ---------- */
  function settOppLogin() {
    var skjema = hent('skjema-login');
    skjema.addEventListener('submit', function (e) {
      e.preventDefault();
      visMelding(hent('feil-login'), '');
      var knapp = skjema.querySelector('button[type="submit"]');
      knapp.disabled = true;

      var kropp = {
        epost: hent('login-epost').value.trim(),
        passord: hent('login-passord').value,
      };

      api('/api/auth/login', { method: 'POST', body: JSON.stringify(kropp) })
        .then(function (r) {
          return r.json().then(function (data) { return { ok: r.ok, data: data }; });
        })
        .then(function (res) {
          if (!res.ok) {
            visMelding(hent('feil-login'), feilTekst(res.data, 'Feil e-post eller passord.'), 'feil');
            return;
          }
          gaaTilRiktigSide(res.data.user);
        })
        .catch(function () {
          visMelding(hent('feil-login'), 'Klarte ikke å logge inn. Prøv igjen.', 'feil');
        })
        .then(function () { knapp.disabled = false; });
    });
  }

  function settOppRegister() {
    var skjema = hent('skjema-register');
    skjema.addEventListener('submit', function (e) {
      e.preventDefault();
      visMelding(hent('feil-register'), '');
      var knapp = skjema.querySelector('button[type="submit"]');
      knapp.disabled = true;

      var kropp = {
        navn: hent('reg-navn').value.trim(),
        epost: hent('reg-epost').value.trim(),
        passord: hent('reg-passord').value,
      };

      api('/api/auth/register', { method: 'POST', body: JSON.stringify(kropp) })
        .then(function (r) {
          return r.json().then(function (data) { return { ok: r.ok, data: data }; });
        })
        .then(function (res) {
          if (!res.ok) {
            visMelding(hent('feil-register'), feilTekst(res.data, 'Klarte ikke å opprette konto.'), 'feil');
            return;
          }
          gaaTilRiktigSide(res.data.user);
        })
        .catch(function () {
          visMelding(hent('feil-register'), 'Klarte ikke å opprette konto. Prøv igjen.', 'feil');
        })
        .then(function () { knapp.disabled = false; });
    });
  }

  function settOppLoggUt() {
    hent('knapp-logg-ut').addEventListener('click', function () {
      api('/api/auth/logout', { method: 'POST' })
        .then(function () { visUtlogget(); })
        .catch(function () { visUtlogget(); });
    });
  }

  /* ---------- Oppstart ---------- */
  function init() {
    settOppFaner();
    settOppLogin();
    settOppRegister();
    settOppLoggUt();

    api('/api/auth/me')
      .then(function (r) {
        if (r.status === 401) { visUtlogget(); return null; }
        if (!r.ok) { visUtlogget(); return null; }
        return r.json();
      })
      .then(function (data) {
        if (data && data.user) visInnlogget(data.user);
      })
      .catch(function () { visUtlogget(); });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
