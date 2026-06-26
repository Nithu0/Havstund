/* Havstund — AI-assistent frontend (intranett).
 *
 * Panelet vises KUN hvis /api/auth/me melder ai_agent_enabled === true (utvalgt
 * admin). All trafikk går via nettsidens egne proxy-ruter /api/brain/ask og
 * /api/brain/confirm (som er bak admin + utvalgt-gating server-side). Et SKRIVE-
 * forslag rendres med en «Send»-knapp; ingenting utføres før admin trykker.
 */
(function () {
  'use strict';

  var panel = document.getElementById('aiAssistent');
  if (!panel) return;

  var samtale = document.getElementById('aiSamtale');
  var input = document.getElementById('aiInput');
  var sendBtn = document.getElementById('aiSend');
  var conversationId = null;
  var transcript = [];

  // Vis panelet kun for utvalgt admin.
  fetch('/api/auth/me', { credentials: 'same-origin' })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (data) {
      if (data && data.user && data.user.ai_agent_enabled === true) {
        panel.style.display = '';
      }
    })
    .catch(function () { /* skjult som standard */ });

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function leggTil(rolle, html) {
    var rad = document.createElement('div');
    rad.style.margin = '6px 0';
    var hvem = rolle === 'bruker' ? 'Du' : 'AI';
    rad.innerHTML = '<b>' + hvem + ':</b> ' + html;
    samtale.appendChild(rad);
    samtale.scrollTop = samtale.scrollHeight;
    return rad;
  }

  function settAktiv(aktiv) {
    sendBtn.disabled = !aktiv;
    input.disabled = !aktiv;
  }

  function renderForslag(proposal, tekst) {
    if (tekst) leggTil('ai', escapeHtml(tekst));
    var boks = document.createElement('div');
    boks.style.cssText = 'border:1px solid var(--turq,#5bb);border-radius:10px;padding:10px;margin:6px 0;background:#f3fbfb';
    boks.innerHTML =
      '<div style="font-size:13px;color:var(--muted,#567)">Forslag: <b>' +
      escapeHtml(proposal.toolName) + '</b></div>' +
      '<div style="margin:6px 0;font-size:13px">' + escapeHtml(proposal.summary || '') + '</div>';
    var btn = document.createElement('button');
    btn.className = 'btn';
    btn.textContent = 'Send (utfør)';
    var avbryt = document.createElement('button');
    avbryt.className = 'btn btn-ghost';
    avbryt.textContent = 'Avbryt';
    avbryt.style.marginLeft = '8px';
    boks.appendChild(btn);
    boks.appendChild(avbryt);
    samtale.appendChild(boks);
    samtale.scrollTop = samtale.scrollHeight;

    avbryt.addEventListener('click', function () {
      boks.remove();
      leggTil('ai', '<i>Forslag avbrutt.</i>');
    });

    btn.addEventListener('click', function () {
      btn.disabled = true;
      avbryt.disabled = true;
      settAktiv(false);
      fetch('/api/brain/confirm', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          toolUseId: proposal.toolUseId,
          confirmToken: proposal.confirmToken,
          conversationId: conversationId,
          transcript: transcript,
        }),
      })
        .then(function (r) { return r.json().then(function (b) { return { status: r.status, body: b }; }); })
        .then(function (res) {
          boks.remove();
          if (res.status >= 400) {
            leggTil('ai', '<span style="color:#b00">' + escapeHtml((res.body && res.body.error) || 'Kunne ikke utføre') + '</span>');
          } else {
            leggTil('ai', escapeHtml((res.body && res.body.text) || 'Utført.'));
            if (res.body && res.body.transcript) transcript = res.body.transcript;
          }
        })
        .catch(function () { leggTil('ai', '<span style="color:#b00">Nettverksfeil.</span>'); })
        .finally(function () { settAktiv(true); });
    });
  }

  function spor() {
    var tekst = (input.value || '').trim();
    if (!tekst) return;
    leggTil('bruker', escapeHtml(tekst));
    input.value = '';
    settAktiv(false);
    fetch('/api/brain/ask', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: tekst, conversationId: conversationId, transcript: transcript }),
    })
      .then(function (r) { return r.json().then(function (b) { return { status: r.status, body: b }; }); })
      .then(function (res) {
        if (res.status >= 400) {
          leggTil('ai', '<span style="color:#b00">' + escapeHtml((res.body && res.body.error) || 'Feil') + '</span>');
          return;
        }
        var body = res.body || {};
        conversationId = body.conversationId || conversationId;
        if (body.transcript) transcript = body.transcript;
        if (body.kind === 'proposal' && body.proposal) {
          renderForslag(body.proposal, body.text);
        } else {
          leggTil('ai', escapeHtml(body.text || '(tomt svar)'));
        }
      })
      .catch(function () { leggTil('ai', '<span style="color:#b00">Nettverksfeil.</span>'); })
      .finally(function () { settAktiv(true); });
  }

  sendBtn.addEventListener('click', spor);
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); spor(); }
  });
})();
