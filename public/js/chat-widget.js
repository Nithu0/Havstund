/* Havstund — flytende chat-widget (24/7 AI + ansatt-overtakelse).
   Injiserer egen boble + panel med eget DOM og egen CSS (ingen avhengighet
   til styles.css). Starter tråd ved første melding, sender til /api/chat,
   viser kunde-/AI-svar, og kobler til Socket.IO for live ansatt-svar. */
(function () {
  'use strict';

  if (window.__havstundChat) return; // unngå dobbel-injeksjon
  window.__havstundChat = true;

  var BLA = '#0e4a63';
  var DYP = '#082a36';
  var TURK = '#2bb6c2';
  var LEIRE = '#d2823f';
  var CREAM = '#f6efe3';

  var threadId = null;
  var socket = null;
  var apnet = false;
  var venterSvar = false;

  // ---------- CSS ----------
  var css =
    '.hv-chat-btn{position:fixed;right:20px;bottom:20px;z-index:9998;width:60px;height:60px;border:none;' +
    'border-radius:50%;background:' + LEIRE + ';color:#fff;font-size:26px;cursor:pointer;box-shadow:0 10px 30px rgba(8,42,54,.35);' +
    'transition:transform .15s,background .2s}' +
    '.hv-chat-btn:hover{transform:translateY(-2px);background:#a9602f}' +
    '.hv-chat-btn .hv-dot{position:absolute;top:-2px;right:-2px;width:14px;height:14px;border-radius:50%;' +
    'background:' + TURK + ';border:2px solid #fff;display:none}' +
    '.hv-chat-btn.has-new .hv-dot{display:block}' +
    '.hv-chat-panel{position:fixed;right:20px;bottom:90px;z-index:9999;width:340px;max-width:calc(100vw - 32px);' +
    'height:480px;max-height:calc(100vh - 120px);background:' + CREAM + ';border-radius:16px;overflow:hidden;' +
    'box-shadow:0 20px 60px rgba(8,42,54,.32);display:none;flex-direction:column;' +
    'font-family:"Segoe UI",system-ui,-apple-system,Roboto,Arial,sans-serif}' +
    '.hv-chat-panel.open{display:flex}' +
    '.hv-head{background:' + DYP + ';color:#fff;padding:14px 16px;display:flex;align-items:center;gap:10px}' +
    '.hv-head .hv-t{font-weight:800;font-size:16px;line-height:1.1}' +
    '.hv-head .hv-s{font-size:11px;opacity:.8;letter-spacing:.5px}' +
    '.hv-head .hv-x{margin-left:auto;background:none;border:none;color:#cfe2e7;font-size:22px;cursor:pointer;line-height:1}' +
    '.hv-status{font-size:11px;padding:6px 16px;background:rgba(43,182,194,.12);color:' + BLA + ';border-bottom:1px solid #e3d8c6}' +
    '.hv-msgs{flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:8px}' +
    '.hv-msg{max-width:82%;padding:9px 13px;border-radius:14px;font-size:14px;line-height:1.45;word-wrap:break-word;white-space:pre-wrap}' +
    '.hv-msg.kunde{align-self:flex-end;background:' + BLA + ';color:#fff;border-bottom-right-radius:4px}' +
    '.hv-msg.ai{align-self:flex-start;background:#fff;color:#12303a;border:1px solid #e3d8c6;border-bottom-left-radius:4px}' +
    '.hv-msg.ansatt{align-self:flex-start;background:' + TURK + ';color:#04323a;border-bottom-left-radius:4px}' +
    '.hv-who{font-size:10px;text-transform:uppercase;letter-spacing:1px;opacity:.7;margin-bottom:2px}' +
    '.hv-form{display:flex;gap:8px;padding:10px;border-top:1px solid #e3d8c6;background:#fffaf1}' +
    '.hv-form input{flex:1;font-size:14px;padding:10px 12px;border:1px solid #e3d8c6;border-radius:10px;background:#fff;color:#12303a;font-family:inherit}' +
    '.hv-form button{border:none;background:' + LEIRE + ';color:#fff;font-weight:700;font-size:14px;padding:0 16px;border-radius:10px;cursor:pointer}' +
    '.hv-form button:disabled{opacity:.5;cursor:default}' +
    '.hv-typing{align-self:flex-start;font-size:12px;color:#5d7681;padding:2px 4px}' +
    '@media(max-width:480px){.hv-chat-panel{right:8px;bottom:84px;height:70vh}}';

  var style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  // ---------- DOM ----------
  var btn = document.createElement('button');
  btn.className = 'hv-chat-btn';
  btn.setAttribute('aria-label', 'Åpne chat');
  btn.innerHTML = '💬<span class="hv-dot"></span>';

  var panel = document.createElement('div');
  panel.className = 'hv-chat-panel';
  panel.innerHTML =
    '<div class="hv-head">' +
    '<div><div class="hv-t">Havstund</div><div class="hv-s">Vi svarer med en gang 🌊</div></div>' +
    '<button class="hv-x" aria-label="Lukk">×</button>' +
    '</div>' +
    '<div class="hv-status" style="display:none"></div>' +
    '<div class="hv-msgs"></div>' +
    '<form class="hv-form">' +
    '<input type="text" placeholder="Skriv en melding…" autocomplete="off" maxlength="4000">' +
    '<button type="submit">Send</button>' +
    '</form>';

  document.body.appendChild(btn);
  document.body.appendChild(panel);

  var msgsEl = panel.querySelector('.hv-msgs');
  var statusEl = panel.querySelector('.hv-status');
  var form = panel.querySelector('.hv-form');
  var input = form.querySelector('input');
  var sendBtn = form.querySelector('button');

  // ---------- hjelpere ----------
  function visStatus(tekst) {
    if (tekst) {
      statusEl.textContent = tekst;
      statusEl.style.display = 'block';
    } else {
      statusEl.style.display = 'none';
    }
  }

  function leggTil(avsender, tekst) {
    var el = document.createElement('div');
    el.className = 'hv-msg ' + avsender;
    var navn = avsender === 'kunde' ? '' : avsender === 'ansatt' ? 'Ansatt' : 'Havstund';
    var who = navn ? '<div class="hv-who">' + navn + '</div>' : '';
    el.innerHTML = who + '<span></span>';
    el.querySelector('span').textContent = tekst; // tekst trygt (ingen HTML-injeksjon)
    msgsEl.appendChild(el);
    msgsEl.scrollTop = msgsEl.scrollHeight;
  }

  var typingEl = null;
  function visSkriver(pa) {
    if (pa && !typingEl) {
      typingEl = document.createElement('div');
      typingEl.className = 'hv-typing';
      typingEl.textContent = 'Havstund skriver…';
      msgsEl.appendChild(typingEl);
      msgsEl.scrollTop = msgsEl.scrollHeight;
    } else if (!pa && typingEl) {
      typingEl.remove();
      typingEl = null;
    }
  }

  function markerNytt() {
    if (!panel.classList.contains('open')) btn.classList.add('has-new');
  }

  // ---------- Socket.IO ----------
  function koble() {
    if (socket || !window.io || !threadId) return;
    try {
      socket = window.io();
      socket.on('connect', function () {
        socket.emit('bli_med', threadId);
      });
      // Live-meldinger fra ansatt (AI/kunde er allerede vist lokalt)
      socket.on('melding', function (m) {
        if (!m || Number(m.thread_id) !== Number(threadId)) return;
        if (m.avsender === 'ansatt') {
          leggTil('ansatt', m.tekst);
          markerNytt();
        }
      });
      socket.on('ansatt_overtatt', function (d) {
        if (!d || Number(d.thread_id) !== Number(threadId)) return;
        visStatus('En ansatt har tatt over samtalen 🌊');
      });
    } catch (e) {
      // Socket.IO ikke tilgjengelig — chat fungerer fortsatt via REST
    }
  }

  // ---------- API ----------
  function startTraad() {
    return fetch('/api/chat/thread', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({}),
    })
      .then(function (r) {
        if (!r.ok) throw new Error('thread');
        return r.json();
      })
      .then(function (data) {
        threadId = data.thread_id;
        koble();
        return threadId;
      });
  }

  function sendMelding(tekst) {
    venterSvar = true;
    sendBtn.disabled = true;
    leggTil('kunde', tekst);

    var kjede = threadId ? Promise.resolve(threadId) : startTraad();

    kjede
      .then(function () {
        visSkriver(true);
        return fetch('/api/chat/thread/' + threadId + '/message', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ tekst: tekst }),
        });
      })
      .then(function (r) {
        if (!r.ok) throw new Error('send');
        return r.json();
      })
      .then(function (data) {
        visSkriver(false);
        if (data && data.ai && data.ai.tekst) {
          leggTil('ai', data.ai.tekst);
        }
      })
      .catch(function () {
        visSkriver(false);
        leggTil('ai', 'Beklager, noe gikk galt. Prøv igjen om litt, eller send en e-post til post@havstund.no.');
      })
      .finally(function () {
        venterSvar = false;
        sendBtn.disabled = false;
        input.focus();
      });
  }

  // ---------- interaksjon ----------
  function apne() {
    panel.classList.add('open');
    btn.classList.remove('has-new');
    input.focus();
    if (!apnet) {
      apnet = true;
      leggTil('ai', 'Hei og velkommen til Havstund! 🌊 Spør meg gjerne om priser, opplevelser eller booking — jeg svarer med en gang.');
    }
  }
  function lukk() {
    panel.classList.remove('open');
  }

  btn.addEventListener('click', function () {
    if (panel.classList.contains('open')) lukk();
    else apne();
  });
  panel.querySelector('.hv-x').addEventListener('click', lukk);

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var tekst = input.value.trim();
    if (!tekst || venterSvar) return;
    input.value = '';
    sendMelding(tekst);
  });
})();
