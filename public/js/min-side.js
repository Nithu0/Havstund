/* Havstund — Min side (kundeportal) klient-logikk. Vanilla JS. */
(function () {
  'use strict';

  /* ---------- Hjelpere ---------- */

  function $(id) {
    return document.getElementById(id);
  }

  function escapeHtml(value) {
    if (value === null || value === undefined) return '';
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function setEmptyState(id, text) {
    var el = $(id);
    if (el) el.textContent = text;
  }

  async function apiFetch(url, options) {
    var opts = Object.assign(
      {
        credentials: 'same-origin',
        headers: { Accept: 'application/json' },
      },
      options || {}
    );
    var res = await fetch(url, opts);
    return res;
  }

  async function apiGetJson(url) {
    var res = await apiFetch(url);
    if (!res.ok) {
      var err = new Error('Forespørsel feilet: ' + res.status);
      err.status = res.status;
      throw err;
    }
    return res.json();
  }

  function formatDato(value, withTime) {
    if (!value) return '';
    var d = new Date(value);
    if (isNaN(d.getTime())) return String(value);
    var opts = withTime
      ? { day: '2-digit', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' }
      : { day: '2-digit', month: 'long', year: 'numeric' };
    try {
      return d.toLocaleDateString('no-NO', opts);
    } catch (e) {
      return d.toLocaleDateString();
    }
  }

  function formatBelop(value) {
    if (value === null || value === undefined || value === '') return '';
    var num = Number(value);
    if (isNaN(num)) return String(value);
    try {
      return num.toLocaleString('no-NO', {
        style: 'currency',
        currency: 'NOK',
        minimumFractionDigits: 0,
        maximumFractionDigits: 2,
      });
    } catch (e) {
      return num.toFixed(2) + ' kr';
    }
  }

  function statusKlasse(status) {
    if (!status) return '';
    return 'status-' + String(status).toLowerCase().replace(/\s+/g, '_');
  }

  function statusMerke(status) {
    if (!status) return '';
    return (
      '<span class="status-merke ' +
      escapeHtml(statusKlasse(status)) +
      '">' +
      escapeHtml(status) +
      '</span>'
    );
  }

  function clear(el) {
    if (el) el.innerHTML = '';
  }

  /* ---------- Auth ---------- */

  async function lastBruker() {
    var res = await apiFetch('/api/auth/me');
    if (res.status === 401) {
      window.location = '/konto';
      return null;
    }
    if (!res.ok) {
      throw new Error('Kunne ikke hente bruker: ' + res.status);
    }
    var data = await res.json();
    var user = (data && data.user) || null;
    if (!user) {
      window.location = '/konto';
      return null;
    }

    var navnEl = $('kunde-navn');
    if (navnEl) navnEl.textContent = user.navn || user.epost || 'Kunde';

    // Valgfri intranett-lenke for ansatt/admin (ingen redirect).
    if (user.rolle === 'ansatt' || user.rolle === 'admin') {
      visIntranettLenke();
    }

    return user;
  }

  function visIntranettLenke() {
    if ($('intranett-lenke')) return;
    var navnEl = $('kunde-navn');
    if (!navnEl || !navnEl.parentNode) return;
    var a = document.createElement('a');
    a.id = 'intranett-lenke';
    a.href = '/intranett';
    a.className = 'intranett-lenke';
    a.textContent = 'Gå til intranett';
    navnEl.parentNode.appendChild(a);
  }

  /* ---------- Bookinger ---------- */

  async function lastBookinger() {
    var container = $('mine-bookinger');
    if (!container) return;
    try {
      var bookinger = await apiGetJson('/api/bookings');
      if (!Array.isArray(bookinger) || bookinger.length === 0) {
        clear(container);
        setEmptyState('mine-bookinger-tom', 'Du har ingen bookinger ennå.');
        if (!$('mine-bookinger-tom')) {
          container.innerHTML = '<p class="tom-tilstand">Du har ingen bookinger ennå.</p>';
        }
        return;
      }
      var html = bookinger
        .map(function (b) {
          return (
            '<div class="booking-kort">' +
            '<div class="booking-hode">' +
            '<span class="booking-navn">' +
            escapeHtml(b.aktivitet_navn) +
            '</span>' +
            statusMerke(b.status) +
            '</div>' +
            '<div class="booking-detaljer">' +
            '<span class="booking-dato">' +
            escapeHtml(formatDato(b.dato)) +
            (b.tid ? ' kl. ' + escapeHtml(b.tid) : '') +
            '</span>' +
            (b.antall !== undefined && b.antall !== null
              ? '<span class="booking-antall">' + escapeHtml(b.antall) + ' pers.</span>'
              : '') +
            (b.belop !== undefined && b.belop !== null
              ? '<span class="booking-belop">' + escapeHtml(formatBelop(b.belop)) + '</span>'
              : '') +
            '</div>' +
            '</div>'
          );
        })
        .join('');
      container.innerHTML = html;
    } catch (e) {
      console.error('Feil ved lasting av bookinger:', e);
      container.innerHTML = '<p class="feil-tilstand">Kunne ikke laste bookinger.</p>';
    }
  }

  /* ---------- Prosjekter ---------- */

  async function lastProsjekter() {
    var container = $('mine-prosjekter');
    if (!container) return;
    try {
      var prosjekter = await apiGetJson('/api/projects');
      if (!Array.isArray(prosjekter) || prosjekter.length === 0) {
        clear(container);
        if ($('mine-prosjekter-tom')) {
          setEmptyState('mine-prosjekter-tom', 'Du har ingen prosjekter ennå.');
        } else {
          container.innerHTML = '<p class="tom-tilstand">Du har ingen prosjekter ennå.</p>';
        }
        return;
      }
      var html = prosjekter
        .map(function (p) {
          var galleri = '';
          if (Array.isArray(p.media) && p.media.length > 0) {
            galleri =
              '<div class="prosjekt-galleri">' +
              p.media
                .map(function (m) {
                  if (!m || !m.url) return '';
                  var url = escapeHtml(m.url);
                  var tittel = escapeHtml(m.tittel || '');
                  if (m.type === 'video') {
                    return (
                      '<video class="prosjekt-media" controls src="' +
                      url +
                      '" title="' +
                      tittel +
                      '"></video>'
                    );
                  }
                  return (
                    '<img class="prosjekt-bilde" src="' +
                    url +
                    '" alt="' +
                    tittel +
                    '" title="' +
                    tittel +
                    '" data-full="' +
                    url +
                    '" />'
                  );
                })
                .join('') +
              '</div>';
          }
          return (
            '<div class="prosjekt-kort">' +
            '<div class="prosjekt-hode">' +
            '<span class="prosjekt-tittel">' +
            escapeHtml(p.tittel) +
            '</span>' +
            statusMerke(p.status) +
            '</div>' +
            (p.type ? '<span class="prosjekt-type">' + escapeHtml(p.type) + '</span>' : '') +
            (p.opprettet
              ? '<span class="prosjekt-dato">' + escapeHtml(formatDato(p.opprettet)) + '</span>'
              : '') +
            (p.beskrivelse
              ? '<p class="prosjekt-beskrivelse">' + escapeHtml(p.beskrivelse) + '</p>'
              : '') +
            galleri +
            '</div>'
          );
        })
        .join('');
      container.innerHTML = html;

      // Lightbox for bilder.
      var bilder = container.querySelectorAll('.prosjekt-bilde');
      Array.prototype.forEach.call(bilder, function (img) {
        img.addEventListener('click', function () {
          aapneLightbox(img.getAttribute('data-full'), img.getAttribute('alt'));
        });
      });
    } catch (e) {
      console.error('Feil ved lasting av prosjekter:', e);
      container.innerHTML = '<p class="feil-tilstand">Kunne ikke laste prosjekter.</p>';
    }
  }

  function aapneLightbox(url, alt) {
    if (!url) return;
    var overlay = document.createElement('div');
    overlay.className = 'lightbox-overlay';

    var img = document.createElement('img');
    img.className = 'lightbox-bilde';
    img.src = url;
    img.alt = alt || '';

    overlay.appendChild(img);

    function lukk() {
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      document.removeEventListener('keydown', onKey);
    }
    function onKey(e) {
      if (e.key === 'Escape') lukk();
    }

    overlay.addEventListener('click', lukk);
    document.addEventListener('keydown', onKey);

    document.body.appendChild(overlay);
  }

  /* ---------- Kvitteringer ---------- */

  async function lastKvitteringer() {
    var container = $('mine-kvitteringer');
    if (!container) return;
    try {
      var kvitteringer = await apiGetJson('/api/receipts');
      if (!Array.isArray(kvitteringer) || kvitteringer.length === 0) {
        clear(container);
        if ($('mine-kvitteringer-tom')) {
          setEmptyState('mine-kvitteringer-tom', 'Du har ingen kvitteringer ennå.');
        } else {
          container.innerHTML = '<p class="tom-tilstand">Du har ingen kvitteringer ennå.</p>';
        }
        return;
      }
      var html = kvitteringer
        .map(function (k) {
          var betaltKlasse = k.betalt ? 'betalt' : 'ubetalt';
          var betaltTekst = k.betalt ? 'Betalt' : 'Ikke betalt';
          return (
            '<div class="kvittering-rad">' +
            '<span class="kvittering-dato">' +
            escapeHtml(formatDato(k.dato)) +
            '</span>' +
            '<span class="kvittering-beskrivelse">' +
            escapeHtml(k.beskrivelse) +
            '</span>' +
            '<span class="kvittering-belop">' +
            escapeHtml(formatBelop(k.belop)) +
            '</span>' +
            '<span class="kvittering-betalt ' +
            betaltKlasse +
            '">' +
            escapeHtml(betaltTekst) +
            '</span>' +
            '</div>'
          );
        })
        .join('');
      container.innerHTML = html;
    } catch (e) {
      console.error('Feil ved lasting av kvitteringer:', e);
      container.innerHTML = '<p class="feil-tilstand">Kunne ikke laste kvitteringer.</p>';
    }
  }

  /* ---------- Meldinger ---------- */

  function erKunde(avsender) {
    if (!avsender) return false;
    var a = String(avsender).toLowerCase();
    return a === 'kunde' || a === 'meg';
  }

  function renderMelding(m) {
    var kunde = erKunde(m.avsender);
    var side = kunde ? 'melding-hoyre' : 'melding-venstre';
    var prisHtml = '';
    if (m.pris !== undefined && m.pris !== null && m.pris !== '') {
      prisHtml =
        '<div class="melding-pris">Pris: ' + escapeHtml(formatBelop(m.pris)) + '</div>';
    }
    return (
      '<div class="melding-boble ' +
      side +
      '">' +
      '<div class="melding-avsender">' +
      escapeHtml(m.avsender || (kunde ? 'Meg' : 'Havstund')) +
      '</div>' +
      '<div class="melding-tekst">' +
      escapeHtml(m.tekst) +
      '</div>' +
      prisHtml +
      (m.opprettet
        ? '<div class="melding-tid">' + escapeHtml(formatDato(m.opprettet, true)) + '</div>'
        : '') +
      '</div>'
    );
  }

  function scrollTilBunn() {
    var traad = $('meldinger-traad');
    if (traad) traad.scrollTop = traad.scrollHeight;
  }

  async function lastMeldinger() {
    var traad = $('meldinger-traad');
    if (!traad) return;
    try {
      var meldinger = await apiGetJson('/api/meldinger');
      if (!Array.isArray(meldinger) || meldinger.length === 0) {
        if ($('meldinger-tom')) {
          setEmptyState('meldinger-tom', 'Ingen meldinger ennå. Send oss gjerne en melding!');
          traad.innerHTML = '';
        } else {
          traad.innerHTML =
            '<p class="tom-tilstand">Ingen meldinger ennå. Send oss gjerne en melding!</p>';
        }
        return;
      }
      traad.innerHTML = meldinger.map(renderMelding).join('');
      scrollTilBunn();
    } catch (e) {
      console.error('Feil ved lasting av meldinger:', e);
      traad.innerHTML = '<p class="feil-tilstand">Kunne ikke laste meldinger.</p>';
    }
  }

  function settOppMeldingSkjema() {
    var skjema = $('melding-skjema');
    var tekstFelt = $('melding-tekst');
    if (!skjema || !tekstFelt) return;

    skjema.addEventListener('submit', async function (e) {
      e.preventDefault();
      var tekst = tekstFelt.value.trim();
      if (!tekst) return;

      var sendKnapp = skjema.querySelector('button[type="submit"], input[type="submit"]');
      if (sendKnapp) sendKnapp.disabled = true;

      try {
        var res = await apiFetch('/api/meldinger', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify({ tekst: tekst }),
        });
        if (!res.ok) {
          throw new Error('Sending feilet: ' + res.status);
        }

        var traad = $('meldinger-traad');
        if (traad) {
          // Fjern evt. tom-tilstand før innsetting.
          var tom = traad.querySelector('.tom-tilstand');
          if (tom) tom.remove();
          var nyMelding = {
            avsender: 'Meg',
            tekst: tekst,
            opprettet: new Date().toISOString(),
          };
          traad.insertAdjacentHTML('beforeend', renderMelding(nyMelding));
          scrollTilBunn();
        }
        tekstFelt.value = '';
        tekstFelt.focus();
      } catch (err) {
        console.error('Feil ved sending av melding:', err);
        alert('Kunne ikke sende melding. Prøv igjen.');
      } finally {
        if (sendKnapp) sendKnapp.disabled = false;
      }
    });
  }

  /* ---------- Logg ut ---------- */

  function settOppLoggUt() {
    var knapp = $('logg-ut');
    if (!knapp) return;
    knapp.addEventListener('click', async function (e) {
      e.preventDefault();
      try {
        await apiFetch('/api/auth/logout', { method: 'POST' });
      } catch (err) {
        console.error('Feil ved utlogging:', err);
      } finally {
        window.location = '/';
      }
    });
  }

  /* ---------- Init ---------- */

  async function init() {
    settOppLoggUt();
    settOppMeldingSkjema();

    var bruker;
    try {
      bruker = await lastBruker();
    } catch (e) {
      console.error('Feil ved autentisering:', e);
      return;
    }
    if (!bruker) return; // redirect har skjedd

    // Last innhold parallelt; hver funksjon håndterer egne feil.
    lastBookinger();
    lastProsjekter();
    lastKvitteringer();
    lastMeldinger();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
