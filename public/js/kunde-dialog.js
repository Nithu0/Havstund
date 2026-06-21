'use strict';

/* Havstund — admin kunde-dialog klient-logikk (vanilla JS) */

(function () {
  // ---- Tilstand ----
  var valgtKundeId = null;
  var innloggetBruker = null;

  // ---- Hjelpere ----

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

  function formaterDato(verdi) {
    if (!verdi) return '';
    var d = new Date(verdi);
    if (isNaN(d.getTime())) return escapeHtml(verdi);
    try {
      return d.toLocaleString('no-NO', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      });
    } catch (e) {
      return d.toISOString();
    }
  }

  function formaterDatoKort(verdi) {
    if (!verdi) return '';
    var d = new Date(verdi);
    if (isNaN(d.getTime())) return escapeHtml(verdi);
    try {
      return d.toLocaleDateString('no-NO', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric'
      });
    } catch (e) {
      return d.toISOString().slice(0, 10);
    }
  }

  function formaterBelop(verdi) {
    var tall = Number(verdi);
    if (isNaN(tall)) return '';
    try {
      return tall.toLocaleString('no-NO', {
        style: 'currency',
        currency: 'NOK',
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
      });
    } catch (e) {
      return tall.toFixed(2) + ' kr';
    }
  }

  // Felles fetch-wrapper med JSON + credentials
  function apiFetch(url, options) {
    var opts = options || {};
    var config = {
      method: opts.method || 'GET',
      credentials: 'same-origin',
      headers: { Accept: 'application/json' }
    };
    if (opts.body !== undefined) {
      config.headers['Content-Type'] = 'application/json';
      config.body = JSON.stringify(opts.body);
    }
    return fetch(url, config);
  }

  function lesJson(res) {
    return res
      .json()
      .catch(function () {
        return null;
      });
  }

  // ---- Auth ----

  function sjekkInnlogging() {
    return apiFetch('/api/auth/me')
      .then(function (res) {
        if (res.status === 401 || !res.ok) {
          window.location = '/konto';
          return null;
        }
        return lesJson(res);
      })
      .then(function (data) {
        if (!data || !data.user) {
          window.location = '/konto';
          return null;
        }
        var rolle = data.user.rolle;
        if (rolle !== 'ansatt' && rolle !== 'admin') {
          window.location = '/konto';
          return null;
        }
        innloggetBruker = data.user;
        return data.user;
      })
      .catch(function () {
        window.location = '/konto';
        return null;
      });
  }

  function loggUt() {
    apiFetch('/api/auth/logout', { method: 'POST' })
      .then(function () {
        window.location = '/';
      })
      .catch(function () {
        window.location = '/';
      });
  }

  // ---- Kundeliste ----

  function lastKunder() {
    var liste = $('kunde-liste');
    if (!liste) return Promise.resolve();
    return apiFetch('/api/meldinger/kunder')
      .then(function (res) {
        if (!res.ok) throw new Error('Kunne ikke hente kunder');
        return lesJson(res);
      })
      .then(function (kunder) {
        renderKunder(Array.isArray(kunder) ? kunder : []);
      })
      .catch(function () {
        liste.innerHTML = '<li class="feil">Kunne ikke laste kundeliste.</li>';
      });
  }

  function renderKunder(kunder) {
    var liste = $('kunde-liste');
    if (!liste) return;
    if (!kunder.length) {
      liste.innerHTML = '<li class="tom">Ingen kunder enda.</li>';
      return;
    }
    var html = kunder
      .map(function (k) {
        var uleste = Number(k.uleste) || 0;
        var aktivKlasse = String(k.bruker_id) === String(valgtKundeId) ? ' aktiv' : '';
        var ulestMerke =
          uleste > 0
            ? '<span class="ulest-merke" aria-label="' +
              uleste +
              ' uleste">' +
              escapeHtml(uleste) +
              '</span>'
            : '';
        return (
          '<li class="kunde-item' +
          aktivKlasse +
          '" data-id="' +
          escapeHtml(k.bruker_id) +
          '">' +
          '<button type="button" class="kunde-knapp" data-id="' +
          escapeHtml(k.bruker_id) +
          '">' +
          '<span class="kunde-navn">' +
          escapeHtml(k.navn || k.epost || 'Ukjent') +
          '</span>' +
          ulestMerke +
          '<span class="kunde-epost">' +
          escapeHtml(k.epost || '') +
          '</span>' +
          '<span class="kunde-siste">' +
          escapeHtml(k.siste_tekst || '') +
          '</span>' +
          '<span class="kunde-tid">' +
          formaterDato(k.siste_tid) +
          '</span>' +
          '</button>' +
          '</li>'
        );
      })
      .join('');
    liste.innerHTML = html;

    var knapper = liste.querySelectorAll('.kunde-knapp');
    for (var i = 0; i < knapper.length; i++) {
      knapper[i].addEventListener('click', function () {
        var id = this.getAttribute('data-id');
        velgKunde(id);
      });
    }
  }

  function markerAktivKunde() {
    var liste = $('kunde-liste');
    if (!liste) return;
    var items = liste.querySelectorAll('.kunde-item');
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      if (String(item.getAttribute('data-id')) === String(valgtKundeId)) {
        item.classList.add('aktiv');
      } else {
        item.classList.remove('aktiv');
      }
    }
  }

  // ---- Velg kunde ----

  function velgKunde(id) {
    if (id === null || id === undefined) return;
    valgtKundeId = id;

    var panel = $('dialog-panel');
    var ingen = $('ingen-valgt');
    if (panel) panel.style.display = '';
    if (ingen) ingen.style.display = 'none';

    markerAktivKunde();
    visValgtKunde();

    // Last alt for valgt kunde parallelt
    lastTraad();
    lastProsjekter();
    lastKvitteringer();
    // Oppdater ulest-merker (meldinger ansees som lest når åpnet)
    lastKunder();
  }

  // ---- Dialog-tråd ----

  function lastTraad() {
    var traad = $('dialog-traad');
    if (!traad || valgtKundeId === null) return Promise.resolve();
    return apiFetch('/api/meldinger?bruker_id=' + encodeURIComponent(valgtKundeId))
      .then(function (res) {
        if (!res.ok) throw new Error('Kunne ikke hente meldinger');
        return lesJson(res);
      })
      .then(function (meldinger) {
        renderTraad(Array.isArray(meldinger) ? meldinger : []);
      })
      .catch(function () {
        traad.innerHTML = '<p class="feil">Kunne ikke laste samtalen.</p>';
      });
  }

  function renderTraad(meldinger) {
    var traad = $('dialog-traad');
    if (!traad) return;

    if (!meldinger.length) {
      traad.innerHTML = '<p class="tom">Ingen meldinger enda.</p>';
      return;
    }

    traad.innerHTML = meldinger
      .map(function (m) {
        // Kunde = venstre, admin/ansatt = høyre
        var fraAdmin = m.avsender === 'admin' || m.avsender === 'ansatt';
        var sideKlasse = fraAdmin ? 'melding-hoyre' : 'melding-venstre';
        var prisHtml = '';
        if (m.pris !== null && m.pris !== undefined && m.pris !== '') {
          var prisTall = Number(m.pris);
          if (!isNaN(prisTall)) {
            prisHtml =
              '<div class="melding-pris"><strong>Pris: ' +
              formaterBelop(prisTall) +
              '</strong></div>';
          }
        }
        return (
          '<div class="melding ' +
          sideKlasse +
          '">' +
          '<div class="melding-tekst">' +
          escapeHtml(m.tekst || '') +
          '</div>' +
          prisHtml +
          '<div class="melding-tid">' +
          formaterDato(m.opprettet) +
          '</div>' +
          '</div>'
        );
      })
      .join('');

    // Scroll til bunn
    traad.scrollTop = traad.scrollHeight;
  }

  function valgtKundeName() {
    var liste = $('kunde-liste');
    if (!liste || valgtKundeId === null) return '';
    var item = liste.querySelector(
      '.kunde-item[data-id="' + cssEscape(valgtKundeId) + '"] .kunde-navn'
    );
    return item ? item.textContent : '';
  }

  function cssEscape(value) {
    return String(value).replace(/["\\]/g, '\\$&');
  }

  function visValgtKunde() {
    var el = $('valgt-kunde');
    if (!el) return;
    var navn = valgtKundeName();
    el.textContent = navn || ('Kunde #' + (valgtKundeId === null ? '' : valgtKundeId));
  }

  // ---- Svar-skjema ----

  function handterSvar(e) {
    e.preventDefault();
    if (valgtKundeId === null) return;

    var tekstEl = $('svar-tekst');
    var prisEl = $('svar-pris');
    var tekst = tekstEl ? tekstEl.value.trim() : '';

    if (!tekst) {
      if (tekstEl) tekstEl.focus();
      return;
    }

    var body = { tekst: tekst };
    if (prisEl && prisEl.value !== '') {
      var pris = Number(prisEl.value);
      if (!isNaN(pris)) body.pris = pris;
    }

    var skjema = $('svar-skjema');
    settDeaktivert(skjema, true);

    apiFetch('/api/meldinger?bruker_id=' + encodeURIComponent(valgtKundeId), {
      method: 'POST',
      body: body
    })
      .then(function (res) {
        if (!res.ok) throw new Error('Kunne ikke sende svar');
        if (tekstEl) tekstEl.value = '';
        if (prisEl) prisEl.value = '';
        return lastTraad();
      })
      .then(function () {
        return lastKunder();
      })
      .catch(function () {
        alert('Kunne ikke sende svar. Prøv igjen.');
      })
      .then(function () {
        settDeaktivert(skjema, false);
        if (tekstEl) tekstEl.focus();
      });
  }

  // ---- Prosjekter ----

  function lastProsjekter() {
    var liste = $('prosjekter-liste');
    if (!liste || valgtKundeId === null) return Promise.resolve();
    return apiFetch('/api/projects?bruker_id=' + encodeURIComponent(valgtKundeId))
      .then(function (res) {
        if (!res.ok) throw new Error('Kunne ikke hente prosjekter');
        return lesJson(res);
      })
      .then(function (prosjekter) {
        renderProsjekter(Array.isArray(prosjekter) ? prosjekter : []);
      })
      .catch(function () {
        liste.innerHTML = '<p class="feil">Kunne ikke laste prosjekter.</p>';
      });
  }

  var STATUS_VALG = ['pabegynt', 'under_arbeid', 'ferdig', 'levert'];

  function renderProsjekter(prosjekter) {
    var liste = $('prosjekter-liste');
    if (!liste) return;

    if (!prosjekter.length) {
      liste.innerHTML = '<p class="tom">Ingen prosjekter enda.</p>';
      return;
    }

    liste.innerHTML = prosjekter
      .map(function (p) {
        var media = Array.isArray(p.media) ? p.media : [];
        var mediaHtml = media
          .map(function (m) {
            return (
              '<a class="prosjekt-media" href="' +
              escapeHtml(m.url) +
              '" target="_blank" rel="noopener">' +
              escapeHtml(m.tittel || m.url) +
              '</a>'
            );
          })
          .join('');

        var statusOptions = STATUS_VALG.map(function (s) {
          var valgt = s === p.status ? ' selected' : '';
          return '<option value="' + escapeHtml(s) + '"' + valgt + '>' + escapeHtml(s) + '</option>';
        }).join('');
        // Behold ukjent status som ekstra valg
        if (p.status && STATUS_VALG.indexOf(p.status) === -1) {
          statusOptions =
            '<option value="' +
            escapeHtml(p.status) +
            '" selected>' +
            escapeHtml(p.status) +
            '</option>' +
            statusOptions;
        }

        return (
          '<div class="prosjekt-kort" data-id="' +
          escapeHtml(p.id) +
          '">' +
          '<div class="prosjekt-topp">' +
          '<h4 class="prosjekt-tittel">' +
          escapeHtml(p.tittel || '') +
          '</h4>' +
          '<span class="prosjekt-type">' +
          escapeHtml(p.type || '') +
          '</span>' +
          '</div>' +
          '<p class="prosjekt-beskrivelse">' +
          escapeHtml(p.beskrivelse || '') +
          '</p>' +
          '<label class="prosjekt-status-label">Status: ' +
          '<select class="prosjekt-status" data-id="' +
          escapeHtml(p.id) +
          '">' +
          statusOptions +
          '</select>' +
          '</label>' +
          '<div class="prosjekt-media-liste">' +
          mediaHtml +
          '</div>' +
          '<form class="legg-til-bilde" data-id="' +
          escapeHtml(p.id) +
          '">' +
          '<input type="url" class="bilde-url" placeholder="Bilde-URL" required>' +
          '<input type="text" class="bilde-tittel" placeholder="Tittel (valgfritt)">' +
          '<button type="submit">Legg til bilde</button>' +
          '</form>' +
          '</div>'
        );
      })
      .join('');

    // Status-endring
    var selects = liste.querySelectorAll('.prosjekt-status');
    for (var i = 0; i < selects.length; i++) {
      selects[i].addEventListener('change', function () {
        endreStatus(this.getAttribute('data-id'), this.value);
      });
    }

    // Legg-til-bilde
    var skjemaer = liste.querySelectorAll('.legg-til-bilde');
    for (var j = 0; j < skjemaer.length; j++) {
      skjemaer[j].addEventListener('submit', function (e) {
        e.preventDefault();
        var pid = this.getAttribute('data-id');
        var urlEl = this.querySelector('.bilde-url');
        var titEl = this.querySelector('.bilde-tittel');
        var url = urlEl ? urlEl.value.trim() : '';
        var tittel = titEl ? titEl.value.trim() : '';
        if (!url) {
          if (urlEl) urlEl.focus();
          return;
        }
        leggTilBilde(pid, url, tittel, this);
      });
    }
  }

  function endreStatus(prosjektId, status) {
    if (!prosjektId) return;
    apiFetch('/api/projects/' + encodeURIComponent(prosjektId), {
      method: 'PATCH',
      body: { status: status }
    })
      .then(function (res) {
        if (!res.ok) throw new Error('Kunne ikke endre status');
        return lastProsjekter();
      })
      .catch(function () {
        alert('Kunne ikke endre status. Prøv igjen.');
        lastProsjekter();
      });
  }

  function leggTilBilde(prosjektId, url, tittel, skjema) {
    if (!prosjektId) return;
    settDeaktivert(skjema, true);
    apiFetch('/api/projects/' + encodeURIComponent(prosjektId) + '/media', {
      method: 'POST',
      body: { url: url, tittel: tittel }
    })
      .then(function (res) {
        if (!res.ok) throw new Error('Kunne ikke legge til bilde');
        return lastProsjekter();
      })
      .catch(function () {
        alert('Kunne ikke legge til bilde. Prøv igjen.');
        settDeaktivert(skjema, false);
      });
  }

  function handterNyttProsjekt(e) {
    e.preventDefault();
    if (valgtKundeId === null) return;

    var skjema = $('nytt-prosjekt');
    if (!skjema) return;

    var tittelEl = skjema.querySelector('[name="tittel"]');
    var typeEl = skjema.querySelector('[name="type"]');
    var beskrivelseEl = skjema.querySelector('[name="beskrivelse"]');

    var tittel = tittelEl ? tittelEl.value.trim() : '';
    var type = typeEl ? typeEl.value.trim() : '';
    var beskrivelse = beskrivelseEl ? beskrivelseEl.value.trim() : '';

    if (!tittel) {
      if (tittelEl) tittelEl.focus();
      return;
    }

    settDeaktivert(skjema, true);

    apiFetch('/api/projects', {
      method: 'POST',
      body: {
        bruker_id: valgtKundeId,
        tittel: tittel,
        type: type,
        beskrivelse: beskrivelse
      }
    })
      .then(function (res) {
        if (!res.ok) throw new Error('Kunne ikke opprette prosjekt');
        if (typeof skjema.reset === 'function') skjema.reset();
        return lastProsjekter();
      })
      .catch(function () {
        alert('Kunne ikke opprette prosjekt. Prøv igjen.');
      })
      .then(function () {
        settDeaktivert(skjema, false);
      });
  }

  // ---- Kvitteringer ----

  function lastKvitteringer() {
    var liste = $('kvitteringer-liste');
    if (!liste || valgtKundeId === null) return Promise.resolve();
    return apiFetch('/api/receipts?bruker_id=' + encodeURIComponent(valgtKundeId))
      .then(function (res) {
        if (!res.ok) throw new Error('Kunne ikke hente kvitteringer');
        return lesJson(res);
      })
      .then(function (kvitteringer) {
        renderKvitteringer(Array.isArray(kvitteringer) ? kvitteringer : []);
      })
      .catch(function () {
        liste.innerHTML = '<p class="feil">Kunne ikke laste kvitteringer.</p>';
      });
  }

  function renderKvitteringer(kvitteringer) {
    var liste = $('kvitteringer-liste');
    if (!liste) return;

    if (!kvitteringer.length) {
      liste.innerHTML = '<p class="tom">Ingen kvitteringer enda.</p>';
      return;
    }

    liste.innerHTML = kvitteringer
      .map(function (k) {
        var betalt = k.betalt === true || k.betalt === 'true' || k.betalt === 1;
        var betaltKlasse = betalt ? 'betalt' : 'ubetalt';
        var betaltTekst = betalt ? 'Betalt' : 'Ubetalt';
        return (
          '<div class="kvittering-rad ' +
          betaltKlasse +
          '">' +
          '<span class="kvittering-dato">' +
          formaterDatoKort(k.dato) +
          '</span>' +
          '<span class="kvittering-beskrivelse">' +
          escapeHtml(k.beskrivelse || '') +
          '</span>' +
          '<span class="kvittering-belop">' +
          formaterBelop(k.belop) +
          '</span>' +
          '<span class="kvittering-status">' +
          escapeHtml(betaltTekst) +
          '</span>' +
          '</div>'
        );
      })
      .join('');
  }

  function handterNyKvittering(e) {
    e.preventDefault();
    if (valgtKundeId === null) return;

    var skjema = $('ny-kvittering');
    if (!skjema) return;

    var belopEl = skjema.querySelector('[name="belop"]');
    var beskrivelseEl = skjema.querySelector('[name="beskrivelse"]');
    var betaltEl = skjema.querySelector('[name="betalt"]');
    var datoEl = skjema.querySelector('[name="dato"]');

    var belop = belopEl ? Number(belopEl.value) : NaN;
    var beskrivelse = beskrivelseEl ? beskrivelseEl.value.trim() : '';
    var betalt = betaltEl ? (betaltEl.type === 'checkbox' ? betaltEl.checked : betaltEl.value === 'true') : false;
    var dato = datoEl ? datoEl.value : '';

    if (isNaN(belop)) {
      if (belopEl) belopEl.focus();
      return;
    }

    settDeaktivert(skjema, true);

    apiFetch('/api/receipts', {
      method: 'POST',
      body: {
        bruker_id: valgtKundeId,
        belop: belop,
        beskrivelse: beskrivelse,
        betalt: betalt,
        dato: dato
      }
    })
      .then(function (res) {
        if (!res.ok) throw new Error('Kunne ikke opprette kvittering');
        if (typeof skjema.reset === 'function') skjema.reset();
        return lastKvitteringer();
      })
      .catch(function () {
        alert('Kunne ikke opprette kvittering. Prøv igjen.');
      })
      .then(function () {
        settDeaktivert(skjema, false);
      });
  }

  // ---- Felles UI ----

  function settDeaktivert(skjema, deaktivert) {
    if (!skjema) return;
    var felter = skjema.querySelectorAll('input, textarea, button, select');
    for (var i = 0; i < felter.length; i++) {
      felter[i].disabled = !!deaktivert;
    }
  }

  function visIngenValgt() {
    var panel = $('dialog-panel');
    var ingen = $('ingen-valgt');
    if (panel) panel.style.display = 'none';
    if (ingen) ingen.style.display = '';
  }

  // ---- Init ----

  function init() {
    // Skjul dialog-panel til en kunde er valgt
    visIngenValgt();

    // Skjemaer
    var svarSkjema = $('svar-skjema');
    if (svarSkjema) svarSkjema.addEventListener('submit', handterSvar);

    var nyttProsjekt = $('nytt-prosjekt');
    if (nyttProsjekt) nyttProsjekt.addEventListener('submit', handterNyttProsjekt);

    var nyKvittering = $('ny-kvittering');
    if (nyKvittering) nyKvittering.addEventListener('submit', handterNyKvittering);

    var loggUtKnapp = $('logg-ut');
    if (loggUtKnapp) loggUtKnapp.addEventListener('click', loggUt);

    // Auth-sjekk -> deretter last kunder
    sjekkInnlogging().then(function (bruker) {
      if (!bruker) return;
      lastKunder();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
