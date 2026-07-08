/* Havstund — booking-side (aktiviteter.html).
   Henter aktiviteter, fyller kort + dropdown, sender booking. */
(function () {
  'use strict';

  var korurl = '/api/activities';
  var kortBoks = document.getElementById('aktivitet-kort');
  var velg = document.getElementById('f-aktivitet');
  var form = document.getElementById('booking-form');
  var bekreftelse = document.getElementById('bekreftelse');
  var feilboks = document.getElementById('skjema-feil');

  var aktiviteter = [];

  function kr(n) {
    return Number(n || 0).toLocaleString('no-NO');
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function visFeil(melding) {
    if (!feilboks) return;
    feilboks.textContent = melding;
    feilboks.style.display = 'block';
  }

  function skjulFeil() {
    if (feilboks) feilboks.style.display = 'none';
  }

  // Tegn pris-kort
  function tegnKort() {
    if (!kortBoks) return;
    if (!aktiviteter.length) {
      kortBoks.innerHTML = '<p class="lead">Ingen aktiviteter tilgjengelig akkurat nå.</p>';
      return;
    }
    kortBoks.innerHTML = aktiviteter.map(function (a) {
      var bilde = a.bilde
        ? '<img src="' + escapeHtml(a.bilde) + '" alt="' + escapeHtml(a.navn) + '" style="height:170px;width:100%;object-fit:cover">'
        : '';
      return (
        '<div class="price reveal in">' +
          bilde +
          '<div class="top">' +
            '<h3>' + escapeHtml(a.navn) + '</h3>' +
            '<div class="meta">' + escapeHtml(a.varighet || '') + '</div>' +
            '<div class="amount">' + kr(a.pris) + ' <small>kr / person</small></div>' +
          '</div>' +
          '<ul><li>' + escapeHtml(a.beskrivelse || '') + '</li>' +
            '<li>Inntil ' + escapeHtml(String(a.kapasitet)) + ' personer</li></ul>' +
          '<div class="foot">' +
            '<button type="button" class="btn btn-primary" data-velg="' + a.id + '">Book denne</button>' +
          '</div>' +
        '</div>'
      );
    }).join('');

    // Knapper hopper til skjema og forhåndsvelger
    var knapper = kortBoks.querySelectorAll('[data-velg]');
    for (var i = 0; i < knapper.length; i++) {
      knapper[i].addEventListener('click', function () {
        if (velg) velg.value = this.getAttribute('data-velg');
        var seksjon = document.getElementById('book');
        if (seksjon) seksjon.scrollIntoView({ behavior: 'smooth' });
      });
    }
  }

  // Fyll dropdown
  function fyllDropdown() {
    if (!velg) return;
    var alt = '<option value="">Velg aktivitet …</option>';
    alt += aktiviteter.map(function (a) {
      return '<option value="' + a.id + '">' +
        escapeHtml(a.navn) + ' — ' + kr(a.pris) + ' kr/person</option>';
    }).join('');
    velg.innerHTML = alt;
  }

  // Hent aktiviteter
  function lastAktiviteter() {
    fetch(korurl, { credentials: 'same-origin' })
      .then(function (r) {
        if (!r.ok) throw new Error('Henting feilet (' + r.status + ')');
        return r.json();
      })
      .then(function (data) {
        aktiviteter = Array.isArray(data) ? data : [];
        tegnKort();
        fyllDropdown();
      })
      .catch(function (e) {
        if (kortBoks) kortBoks.innerHTML = '<p class="lead">Kunne ikke laste aktiviteter akkurat nå.</p>';
        console.error('Aktiviteter:', e.message);
      });
  }

  // Forhåndsfyll navn/e-post hvis innlogget
  function lastBruker() {
    fetch('/api/auth/me', { credentials: 'same-origin' })
      .then(function (r) {
        if (!r.ok) return null;
        return r.json();
      })
      .then(function (data) {
        if (!data || !data.user) return;
        var navn = document.getElementById('f-navn');
        var epost = document.getElementById('f-epost');
        if (navn && data.user.navn) navn.value = data.user.navn;
        if (epost && data.user.epost) epost.value = data.user.epost;
      })
      .catch(function () { /* ikke innlogget — greit */ });
  }

  // Send booking
  function sendBooking(e) {
    e.preventDefault();
    skjulFeil();
    if (!form) return;

    var data = {
      activity_id: velg ? velg.value : '',
      navn: val('f-navn'),
      epost: val('f-epost'),
      tlf: val('f-tlf'),
      dato: val('f-dato'),
      tid: val('f-tid'),
      antall: val('f-antall'),
      melding: val('f-melding'),
    };

    if (!data.activity_id) return visFeil('Velg en aktivitet.');
    if (!data.navn) return visFeil('Fyll inn navn.');
    if (!data.epost) return visFeil('Fyll inn e-post.');
    if (!data.dato) return visFeil('Velg en dato.');

    var knapp = form.querySelector('button[type="submit"]');
    if (knapp) { knapp.disabled = true; knapp.textContent = 'Sender …'; }

    fetch('/api/bookings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(data),
    })
      .then(function (r) {
        return r.json().then(function (body) {
          return { ok: r.ok, body: body };
        });
      })
      .then(function (res) {
        if (!res.ok) {
          var b = res.body || {};
          var kode = b.code || b.feil;
          if (kode === 'fullt') throw new Error('Beklager, det er dessverre fullt for valgt dato/tidspunkt. Prøv et annet tidspunkt.');
          if (kode === 'stengt') throw new Error('Vi holder dessverre stengt den valgte datoen. Velg en annen dag.');
          throw new Error(b.error || 'Noe gikk galt. Prøv igjen.');
        }
        visBekreftelse();
        form.reset();
        lastBruker();
      })
      .catch(function (err) {
        visFeil(err.message);
      })
      .finally(function () {
        if (knapp) { knapp.disabled = false; knapp.textContent = 'Send booking'; }
      });
  }

  function visBekreftelse() {
    if (form) form.style.display = 'none';
    if (bekreftelse) {
      bekreftelse.style.display = 'block';
      bekreftelse.scrollIntoView({ behavior: 'smooth' });
    }
  }

  function val(id) {
    var el = document.getElementById(id);
    return el ? el.value.trim() : '';
  }

  function nyBooking() {
    if (bekreftelse) bekreftelse.style.display = 'none';
    if (form) form.style.display = 'block';
  }

  // Init
  document.addEventListener('DOMContentLoaded', function () {
    lastAktiviteter();
    lastBruker();
    if (form) form.addEventListener('submit', sendBooking);
    var nyKnapp = document.getElementById('ny-booking');
    if (nyKnapp) nyKnapp.addEventListener('click', nyBooking);
  });
})();
