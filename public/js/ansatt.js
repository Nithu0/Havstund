/* Havstund — ansatt-modus av selvbetjeningen (bolge 98, steg 5).
   Ny side: månedsvelger, gjenbrukbar kalender i ANSATT-modus, "Send inn
   måneden", og egen lønn-visning. Kaller KUN /api/min/* (den andre agentens
   backend). Klienten sender ALDRI ansatt_id eller status — status settes
   server-side, og rettighet håndheves i API-et.

   Degraderer pent: 403 fra /api/min -> "ikke koblet til ansatt-profil".
   Bruker felles.js (window.Havstund) + kalender.js (window.HavstundKalender).
*/
(function () {
  'use strict';

  var H = window.Havstund || {};
  function $(id) { return document.getElementById(id); }
  function api(sti, opt) { return H.api ? H.api(sti, opt) : fetch(sti, { credentials: 'same-origin' }); }
  function esc(s) { return H.esc ? H.esc(s) : String(s == null ? '' : s); }
  function kr(o) { return H.kr ? H.kr(o) : String(o); }
  function fmtTimer(t) { return H.timer ? H.timer(t) : String(Number(t) || 0); }
  function feil(el, tekst) { if (H.feilBanner) H.feilBanner(el, tekst); }

  var API_BASIS = '/api/min';
  var kalender = null;
  var valgtDato = null;   // dato som modalen står på
  var redigerId = null;   // id vi PATCH-er, eller null = ny (POST)
  var blokkert = false;   // 403 sett -> stopp videre kall

  var STATUS_TEKST = {
    utkast: 'Utkast', sendt_inn: 'Sendt inn', godkjent: 'Godkjent', avvist: 'Avvist', laast: 'Låst'
  };

  /* ---------- Måned ---------- */
  function gjeldendeMaaned() {
    var el = $('maaned');
    return (el && el.value) || (H.naaMaaned ? H.naaMaaned() : '');
  }

  /* ---------- 403 / blokkert ---------- */
  function visBlokkert() {
    blokkert = true;
    var b = $('blokkert'); if (b) b.style.display = '';
    var innhold = $('innhold'); if (innhold) innhold.style.display = 'none';
  }

  /* ---------- Send inn-knapp ---------- */
  function oppdaterSendInn(payload) {
    var knapp = $('send-inn');
    if (!knapp) return;
    var rader = (payload && Array.isArray(payload.timer)) ? payload.timer : [];
    var antall = rader.filter(function (t) {
      return t && (t.status === 'utkast' || t.status === 'avvist');
    }).length;
    knapp.disabled = antall === 0;
    knapp.textContent = antall > 0 ? 'Send inn måneden (' + antall + ')' : 'Send inn måneden';
  }

  function sendInn() {
    if (blokkert) return;
    var knapp = $('send-inn');
    if (knapp && knapp.disabled) return;
    feil('feil-topp', '');
    if (knapp) knapp.disabled = true;
    api(API_BASIS + '/timer/send-inn', {
      method: 'POST',
      body: JSON.stringify({ maaned: gjeldendeMaaned() })
    }).then(function (r) {
      if (r.status === 403) { visBlokkert(); throw new Error('403'); }
      if (!r.ok) throw new Error('send-inn ' + r.status);
      var ok = $('ok-melding');
      if (ok) { ok.textContent = 'Måneden er sendt inn til godkjenning.'; ok.classList.add('vis'); setTimeout(function () { ok.classList.remove('vis'); }, 4000); }
      return lastAlt();
    }).catch(function (e) {
      if (String(e && e.message) !== '403') feil('feil-topp', 'Kunne ikke sende inn måneden. Prøv igjen.');
    });
  }

  /* ---------- Lønn ---------- */
  function lastLonn() {
    if (blokkert) return Promise.resolve();
    return api(API_BASIS + '/lonn?maaned=' + encodeURIComponent(gjeldendeMaaned()))
      .then(function (r) {
        if (r.status === 403) { visBlokkert(); throw new Error('403'); }
        if (!r.ok) throw new Error('lonn ' + r.status);
        return r.json();
      }).then(function (d) {
        d = d || {};
        var sats = $('lonn-sats'); if (sats) sats.textContent = d.timelonn_ore != null ? kr(d.timelonn_ore) : '–';
        var timer = $('lonn-timer'); if (timer) timer.textContent = d.antall_timer != null ? fmtTimer(d.antall_timer) + ' t' : '–';
        var sum = $('lonn-sum'); if (sum) sum.textContent = d.sum_ore != null ? kr(d.sum_ore) : '–';
      }).catch(function () { /* stille: kalenderen er hovedflaten */ });
  }

  /* ---------- Dag-modal ---------- */
  function lukkModal() {
    var m = $('dag-modal'); if (m) m.classList.remove('vis');
    nullstillSkjema();
    valgtDato = null;
  }

  function nullstillSkjema() {
    redigerId = null;
    var f = $('form-foring'); if (f) f.reset();
    var merke = $('rediger-merke'); if (merke) merke.style.display = 'none';
    var avbryt = $('f-avbryt-rediger'); if (avbryt) avbryt.style.display = 'none';
    var lagre = $('f-lagre'); if (lagre) lagre.textContent = 'Lagre føring';
    feil('feil-foring', '');
  }

  // Åpne (eller re-render) modalen for en dato. Leser ferske føringer fra
  // kalenderens siste payload, slik at den stemmer etter mutasjoner.
  function aapneDag(dato) {
    valgtDato = dato;
    var data = kalender ? kalender.data() : { timer: [] };
    var egne = (data.timer || []).filter(function (t) { return t && String(t.dato).slice(0, 10) === dato; });

    var tittel = $('dag-tittel');
    if (tittel) tittel.textContent = 'Timer — ' + formaterDato(dato);

    var liste = $('dag-eksisterende');
    if (liste) {
      if (!egne.length) {
        liste.innerHTML = '<p class="hint" style="margin:4px 0 10px">Ingen føringer denne dagen ennå.</p>';
      } else {
        liste.innerHTML = egne.map(radHtml).join('');
        // Handling-knapper (rediger/slett) — kun for egne utkast/avvist.
        Array.prototype.forEach.call(liste.querySelectorAll('.knapp-lenke'), function (btn) {
          btn.addEventListener('click', function () {
            var id = btn.getAttribute('data-id');
            if (btn.classList.contains('rediger')) startRediger(id, egne);
            else if (btn.classList.contains('slett')) slettForing(id);
          });
        });
      }
    }
    nullstillSkjema();
    var m = $('dag-modal'); if (m) m.classList.add('vis');
    var tf = $('f-timer'); if (tf) tf.focus();
  }

  function radHtml(t) {
    var st = t.status || '';
    var kanEndre = (st === 'utkast' || st === 'avvist'); // PATCH: egne utkast/avvist
    var kanSlette = (st === 'utkast');                    // DELETE: kun egne utkast
    var tekst = esc(t.aktivitet || '');
    var notat = t.notat ? '<small>' + esc(t.notat) + '</small>' : '';
    var handling = '';
    if (kanEndre) handling += '<button type="button" class="knapp-lenke rediger" data-id="' + esc(t.id) + '">Rediger</button>';
    if (kanSlette) handling += '<button type="button" class="knapp-lenke slett" data-id="' + esc(t.id) + '">Slett</button>';
    return '<div class="foring-rad">' +
      '<span class="f-timer">' + esc(fmtTimer(t.timer)) + ' t</span>' +
      '<span class="f-tekst">' + (tekst || '<span style="color:var(--muted)">(uten aktivitet)</span>') + notat + '</span>' +
      '<span class="status-merke sm-' + esc(st) + '">' + esc(STATUS_TEKST[st] || st) + '</span>' +
      (handling ? '<span class="f-handling">' + handling + '</span>' : '') +
      '</div>';
  }

  function startRediger(id, egne) {
    var rad = egne.filter(function (t) { return String(t.id) === String(id); })[0];
    if (!rad) return;
    redigerId = id;
    var tf = $('f-timer'); if (tf) tf.value = rad.timer != null ? rad.timer : '';
    var af = $('f-aktivitet'); if (af) af.value = rad.aktivitet || '';
    var nf = $('f-notat'); if (nf) nf.value = rad.notat || '';
    var merke = $('rediger-merke'); if (merke) merke.style.display = '';
    var avbryt = $('f-avbryt-rediger'); if (avbryt) avbryt.style.display = '';
    var lagre = $('f-lagre'); if (lagre) lagre.textContent = 'Lagre endring';
    if (tf) tf.focus();
  }

  function slettForing(id) {
    if (!id) return;
    feil('feil-foring', '');
    api(API_BASIS + '/timer/' + encodeURIComponent(id), { method: 'DELETE' })
      .then(function (r) {
        if (r.status === 403) { lukkModal(); visBlokkert(); throw new Error('403'); }
        if (!r.ok) throw new Error('slett ' + r.status);
        return lastAlt();
      })
      .then(function () { if (valgtDato) aapneDag(valgtDato); })
      .catch(function (e) { if (String(e && e.message) !== '403') feil('feil-foring', 'Kunne ikke slette føringen.'); });
  }

  // Lagre: POST (ny) eller PATCH (endre). Sender ALDRI ansatt_id/status.
  function lagreForing(e) {
    if (e) e.preventDefault();
    if (!valgtDato) return;
    feil('feil-foring', '');
    var tf = $('f-timer');
    var timerVerdi = tf ? parseFloat(String(tf.value).replace(',', '.')) : NaN;
    if (!Number.isFinite(timerVerdi) || timerVerdi < 0 || timerVerdi > 24) {
      feil('feil-foring', 'Oppgi et gyldig timetall (0–24).');
      return;
    }
    var aktivitet = ($('f-aktivitet') && $('f-aktivitet').value.trim()) || '';
    var notat = ($('f-notat') && $('f-notat').value.trim()) || '';

    var kropp = { dato: valgtDato, timer: timerVerdi };
    if (aktivitet) kropp.aktivitet = aktivitet;
    if (notat) kropp.notat = notat;

    var url, metode;
    if (redigerId) { url = API_BASIS + '/timer/' + encodeURIComponent(redigerId); metode = 'PATCH'; }
    else { url = API_BASIS + '/timer'; metode = 'POST'; }

    var lagre = $('f-lagre'); if (lagre) lagre.disabled = true;
    api(url, { method: metode, body: JSON.stringify(kropp) })
      .then(function (r) {
        if (r.status === 403) { lukkModal(); visBlokkert(); throw new Error('403'); }
        if (!r.ok) throw new Error(metode + ' ' + r.status);
        return lastAlt();
      })
      .then(function () { if (valgtDato) aapneDag(valgtDato); })
      .catch(function (e2) { if (String(e2 && e2.message) !== '403') feil('feil-foring', 'Kunne ikke lagre føringen.'); })
      .then(function () { if (lagre) lagre.disabled = false; });
  }

  function formaterDato(dato) {
    var d = new Date(dato + 'T00:00:00');
    if (isNaN(d.getTime())) return dato;
    return d.toLocaleDateString('no-NO', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' });
  }

  /* ---------- Lasting ---------- */
  function lastAlt() {
    if (blokkert || !kalender) return Promise.resolve();
    return Promise.all([
      kalender.setMaaned(gjeldendeMaaned()).catch(function () {}),
      lastLonn()
    ]);
  }

  /* ---------- Auth + init ---------- */
  function settOppLoggUt() {
    var k = $('logg-ut');
    if (!k) return;
    k.addEventListener('click', function (e) {
      e.preventDefault();
      api('/api/auth/logout', { method: 'POST' }).then(function () { window.location = '/konto'; }).catch(function () { window.location = '/konto'; });
    });
  }

  function sjekkBruker() {
    return api('/api/auth/me')
      .then(function (r) { if (!r.ok) throw new Error('uautorisert'); return r.json(); })
      .then(function (data) {
        var u = data && data.user ? data.user : data;
        if (!u || (u.rolle !== 'ansatt' && u.rolle !== 'admin')) { window.location = '/konto'; return null; }
        return u;
      })
      .catch(function () { window.location = '/konto'; return null; });
  }

  function init() {
    settOppLoggUt();

    // Modal-lukking (kryss, backdrop, ESC).
    var lukk = $('dag-lukk'); if (lukk) lukk.addEventListener('click', lukkModal);
    var overlay = $('dag-modal');
    if (overlay) overlay.addEventListener('click', function (e) { if (e.target === overlay) lukkModal(); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') lukkModal(); });

    var form = $('form-foring'); if (form) form.addEventListener('submit', lagreForing);
    var avbryt = $('f-avbryt-rediger'); if (avbryt) avbryt.addEventListener('click', nullstillSkjema);
    var send = $('send-inn'); if (send) send.addEventListener('click', sendInn);

    var mnd = $('maaned');
    if (mnd) {
      if (!mnd.value && H.naaMaaned) mnd.value = H.naaMaaned();
      mnd.addEventListener('change', function () { lukkModal(); lastAlt(); });
    }

    sjekkBruker().then(function (bruker) {
      if (!bruker) return;
      // Ansatt-modus: kanGodkjenne:false, kanSeAndre:false, apiBasis:'/api/min'.
      // Rettighet håndheves i API-et — UI-modus er kun bekvemmelighet.
      kalender = window.HavstundKalender({
        ansattId: bruker.id,
        kanGodkjenne: false,
        kanSeAndre: false,
        apiBasis: API_BASIS,
        onVelgDag: function (dato) { aapneDag(dato); },
        onLastet: function (payload) { oppdaterSendInn(payload); },
        onFeil: function (status) { if (status === 403) visBlokkert(); }
      });
      var kalEl = $('kalender');
      if (kalEl) kalender.mount(kalEl);
      lastAlt();
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
