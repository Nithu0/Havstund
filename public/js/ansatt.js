/* Havstund — «Min side» for ansatte (bolge 98, innstramming).
   Fokusert side med KUN det en ansatt trenger:
     Fane 1 «Kalender»  — egen timeføring (gjenbruk HavstundKalender i
                          ansatt-modus), «Send inn måneden», delt arbeidsplan
                          (LESE-ONLY, ALDRI lønn), og en diskret egen-lønn.
     Fane 2 «Meldinger» — chat-tråd med admin.

   Kaller KUN /api/min/*. Klienten sender ALDRI ansatt_id, status eller avsender —
   de settes server-side, og rettighet håndheves i API-et.

   Degraderer pent: 403 fra /api/min -> «ikke koblet til ansatt-profil».
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
  var aktivFane = 'kalender';
  var vaktplanApen = false;   // «Hele arbeidsplanen» utvidet?
  var chatTimer = null;       // poll-intervall mens Meldinger er aktiv

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

  /* ---------- Faner ---------- */
  function byttFane(navn) {
    aktivFane = navn;
    var faner = ['kalender', 'meldinger'];
    faner.forEach(function (f) {
      var panel = $('fane-' + f);
      var knapp = $('fane-knapp-' + f);
      var aktiv = (f === navn);
      if (panel) { panel.classList.toggle('aktiv', aktiv); if (aktiv) panel.removeAttribute('hidden'); else panel.setAttribute('hidden', ''); }
      if (knapp) knapp.setAttribute('aria-selected', aktiv ? 'true' : 'false');
    });
    // Månedsvelgeren hører til Kalender-fanen.
    var mndBoks = $('mnd-boks'); if (mndBoks) mndBoks.style.visibility = (navn === 'kalender') ? '' : 'hidden';
    if (navn === 'meldinger') { lastMeldinger(); startChatPoll(); }
    else { stoppChatPoll(); }
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

  /* ---------- Egen lønn (diskret) ---------- */
  // Defensiv felt-lesing: bakenden kan svare med enten {antall_timer,sum_ore}
  // eller {sum_timer,brutto_ore}. Vi viser ALDRI andres tall — /lonn er egen-only.
  function lastLonn() {
    if (blokkert) return Promise.resolve();
    return api(API_BASIS + '/lonn?maaned=' + encodeURIComponent(gjeldendeMaaned()))
      .then(function (r) {
        if (r.status === 403) { visBlokkert(); throw new Error('403'); }
        if (!r.ok) throw new Error('lonn ' + r.status);
        return r.json();
      }).then(function (d) {
        d = d || {};
        var antallTimer = (d.antall_timer != null) ? d.antall_timer : d.sum_timer;
        var sumOre = (d.sum_ore != null) ? d.sum_ore : d.brutto_ore;
        var sats = $('lonn-sats'); if (sats) sats.textContent = d.timelonn_ore != null ? kr(d.timelonn_ore) : '–';
        var timer = $('lonn-timer'); if (timer) timer.textContent = antallTimer != null ? fmtTimer(antallTimer) + ' t' : '–';
        var sum = $('lonn-sum'); if (sum) sum.textContent = sumOre != null ? kr(sumOre) : '–';
      }).catch(function () { /* stille: kalenderen er hovedflaten */ });
  }

  /* ---------- Delt arbeidsplan (vaktplan — LESE-ONLY, ALDRI lønn) ---------- */
  function settVpToggleTekst() {
    var t = $('vp-toggle');
    if (t) { t.textContent = vaktplanApen ? 'Skjul arbeidsplanen' : 'Vis arbeidsplanen'; t.setAttribute('aria-expanded', vaktplanApen ? 'true' : 'false'); }
  }

  function vekslVaktplan() {
    vaktplanApen = !vaktplanApen;
    var boks = $('vaktplan'); if (boks) boks.style.display = vaktplanApen ? '' : 'none';
    settVpToggleTekst();
    if (vaktplanApen) lastVaktplan();
  }

  function lastVaktplan() {
    if (blokkert || !vaktplanApen) return Promise.resolve();
    feil('feil-vaktplan', '');
    return api(API_BASIS + '/vaktplan?maaned=' + encodeURIComponent(gjeldendeMaaned()))
      .then(function (r) {
        if (r.status === 403) { visBlokkert(); throw new Error('403'); }
        if (!r.ok) throw new Error('vaktplan ' + r.status);
        return r.json();
      }).then(function (d) {
        renderVaktplan((d && Array.isArray(d.vaktplan)) ? d.vaktplan : []);
      }).catch(function (e) {
        if (String(e && e.message) !== '403') feil('feil-vaktplan', 'Kunne ikke hente arbeidsplanen.');
      });
  }

  // Grupper per dag -> vis navn + timer + status for ALLE ansatte. INGEN lønn:
  // endepunktet returnerer ingen sats/beløp, og vi leser aldri slike felt.
  function renderVaktplan(rader) {
    var boks = $('vaktplan');
    if (!boks) return;
    if (!rader.length) {
      boks.innerHTML = '<p class="vp-tom">Ingen registrerte vakter denne måneden ennå.</p>';
      return;
    }
    var perDag = {};
    var rekkefolge = [];
    rader.forEach(function (r) {
      var dato = String(r && r.dato != null ? r.dato : '').slice(0, 10);
      if (!dato) return;
      if (!perDag[dato]) { perDag[dato] = []; rekkefolge.push(dato); }
      perDag[dato].push(r);
    });
    var html = rekkefolge.map(function (dato) {
      var linjer = perDag[dato].map(function (r) {
        var st = r.status || '';
        return '<div class="vp-rad">' +
          '<span class="vp-navn">' + esc(r.navn || '(ukjent)') + '</span>' +
          '<span class="vp-timer">' + esc(fmtTimer(r.timer)) + ' t</span>' +
          '<span class="status-merke sm-' + esc(st) + '">' + esc(STATUS_TEKST[st] || st) + '</span>' +
          '</div>';
      }).join('');
      return '<div class="vp-dag"><h4>' + esc(formaterDato(dato)) + '</h4>' + linjer + '</div>';
    }).join('');
    boks.innerHTML = html;
  }

  /* ---------- Meldinger (chat med admin) ---------- */
  function lastMeldinger() {
    if (blokkert) return Promise.resolve();
    return api(API_BASIS + '/meldinger')
      .then(function (r) {
        if (r.status === 403) { visBlokkert(); throw new Error('403'); }
        if (!r.ok) throw new Error('meldinger ' + r.status);
        return r.json();
      }).then(function (d) {
        renderMeldinger((d && Array.isArray(d.meldinger)) ? d.meldinger : []);
      }).catch(function (e) {
        if (String(e && e.message) !== '403') feil('feil-chat', 'Kunne ikke hente meldinger.');
      });
  }

  function renderMeldinger(meldinger) {
    var liste = $('chat-liste');
    if (!liste) return;
    // Admins uleste meldinger -> prikk på fanen (kun når vi IKKE står i fanen).
    var uleste = meldinger.filter(function (m) { return m && m.avsender === 'admin' && !m.lest; }).length;
    var prikk = $('melding-prikk');
    if (prikk) prikk.classList.toggle('vis', uleste > 0 && aktivFane !== 'meldinger');

    if (!meldinger.length) {
      liste.innerHTML = '<p class="chat-tom">Ingen meldinger ennå. Skriv den første.</p>';
      return;
    }
    liste.innerHTML = meldinger.map(function (m) {
      var fraMeg = (m.avsender === 'ansatt');
      var navn = fraMeg ? 'Du' : 'Havstund';
      return '<div class="chat-boble ' + (fraMeg ? 'meg' : 'dem') + '">' +
        '<span class="chat-meta">' + esc(navn) + ' · ' + esc(formaterTid(m.opprettet)) + '</span>' +
        esc(m.tekst || '') +
        '</div>';
    }).join('');
    liste.scrollTop = liste.scrollHeight;
  }

  // POST /meldinger {tekst}. Sender ALDRI ansatt_id/avsender — server setter dem.
  function sendMelding(e) {
    if (e) e.preventDefault();
    if (blokkert) return;
    var ta = $('chat-tekst');
    var tekst = ta ? String(ta.value).trim() : '';
    if (!tekst) return;
    feil('feil-chat', '');
    var knapp = $('chat-send'); if (knapp) knapp.disabled = true;
    api(API_BASIS + '/meldinger', { method: 'POST', body: JSON.stringify({ tekst: tekst }) })
      .then(function (r) {
        if (r.status === 403) { visBlokkert(); throw new Error('403'); }
        if (!r.ok) throw new Error('send-melding ' + r.status);
        if (ta) ta.value = '';
        return lastMeldinger();   // refresh ved sending
      })
      .catch(function (e2) { if (String(e2 && e2.message) !== '403') feil('feil-chat', 'Kunne ikke sende meldingen.'); })
      .then(function () { if (knapp) knapp.disabled = false; });
  }

  function startChatPoll() {
    stoppChatPoll();
    chatTimer = setInterval(function () { if (aktivFane === 'meldinger' && !blokkert) lastMeldinger(); }, 15000);
  }
  function stoppChatPoll() {
    if (chatTimer) { clearInterval(chatTimer); chatTimer = null; }
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

  function formaterTid(ts) {
    if (!ts) return '';
    var d = new Date(ts);
    if (isNaN(d.getTime())) return String(ts);
    return d.toLocaleDateString('no-NO', { day: '2-digit', month: 'short' }) + ' ' +
      d.toLocaleTimeString('no-NO', { hour: '2-digit', minute: '2-digit' });
  }

  /* ---------- Lasting ---------- */
  function lastAlt() {
    if (blokkert || !kalender) return Promise.resolve();
    return Promise.all([
      kalender.setMaaned(gjeldendeMaaned()).catch(function () {}),
      lastLonn(),
      lastVaktplan()
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

    // Faner.
    Array.prototype.forEach.call(document.querySelectorAll('.fane-btn'), function (btn) {
      btn.addEventListener('click', function () { byttFane(btn.getAttribute('data-fane')); });
    });

    // Delt arbeidsplan-toggle.
    var vpToggle = $('vp-toggle'); if (vpToggle) vpToggle.addEventListener('click', vekslVaktplan);

    // Chat-skjema.
    var chatSkjema = $('chat-skjema'); if (chatSkjema) chatSkjema.addEventListener('submit', sendMelding);

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
      settVpToggleTekst();
      lastAlt();
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
