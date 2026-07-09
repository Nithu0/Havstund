/* Havstund — Discord-varsling.
   Sender bookinger og kundemeldinger til Discord-kanaler via webhooks.
   Webhook-URLene settes som MILJØVARIABLER på Railway (ingen hemmeligheter i koden):
     DISCORD_WEBHOOK_GENERAL    -> #general   (bookinger/forespørsler)
     DISCORD_WEBHOOK_MELDINGER  -> #meldinger (kundens chat-meldinger)
     DISCORD_WEBHOOK_BILDER     -> #bilder    (kunde-bilder, senere)
   Feil svelges (fire-and-forget) — Discord-trøbbel skal aldri stoppe en booking. */

const WEBHOOKS = {
  general: process.env.DISCORD_WEBHOOK_GENERAL,
  meldinger: process.env.DISCORD_WEBHOOK_MELDINGER,
  bilder: process.env.DISCORD_WEBHOOK_BILDER,
};

const { logger } = require('./logger');

function sendEn(url, kropp) {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: kropp,
  });
}

// Leser retry_after (sekunder) fra Discord 429-svar. Faller trygt tilbake til
// 1s hvis body ikke kan leses/parses. Aldri kast — dette skal ikke velte kallet.
async function retryAfterMs(res) {
  try {
    const data = await res.clone().json();
    const sek = Number(data && data.retry_after);
    if (Number.isFinite(sek) && sek >= 0) return Math.min(sek * 1000, 10000);
  } catch { /* ignorer — bruk fallback */ }
  return 1000;
}

async function postWebhook(url, payload) {
  if (!url || typeof fetch !== 'function') return;
  const kropp = JSON.stringify(payload);
  try {
    let res = await sendEn(url, kropp);
    // 429 rate-limit: ÉN retry som respekterer Discord sin retry_after.
    if (res.status === 429) {
      const ventMs = await retryAfterMs(res);
      await new Promise((r) => setTimeout(r, ventMs));
      res = await sendEn(url, kropp);
    }
    if (!res.ok) {
      let utdrag = '';
      try { utdrag = (await res.text()).slice(0, 300); } catch { /* body utilgjengelig */ }
      logger.warn({ status: res.status, body: utdrag }, 'Discord-webhook svarte ikke-ok');
    }
  } catch (e) {
    // Fire-and-forget: en Discord-feil skal ALDRI velte kallet som utløste den.
    logger.warn({ err: e && e.message }, 'Discord-varsling feilet');
  }
}

// Discord embed field value har hard grense pa 1024 tegn. Trunker slik at et
// enkelt langt felt (typisk kundens melding) ikke gir Discord 400 og taper hele
// varselet (fire-and-forget svelger feilen, saa varselet forsvinner ellers sporlos).
function felt(navn, verdi, inline) {
  const s = (verdi == null || verdi === '') ? '-' : String(verdi);
  return { name: navn, value: s.length > 1024 ? s.slice(0, 1021) + '...' : s, inline: !!inline };
}

// Ny booking -> #general
function bookingVarsel(b, aktivitetNavn) {
  return postWebhook(WEBHOOKS.general, {
    username: 'Havstund Booking',
    embeds: [{
      title: '📋 Ny booking-forespørsel',
      color: 2201299,
      fields: [
        felt('🎨 Aktivitet', aktivitetNavn, true),
        felt('👥 Antall', b.antall, true),
        felt('👤 Navn', b.navn, true),
        felt('📞 Telefon', b.tlf, true),
        felt('✉️ E-post', b.epost, true),
        felt('📅 Dato', (b.dato || '') + (b.tid ? ' ' + b.tid : ''), true),
        felt('💬 Melding', b.melding),
      ],
      footer: { text: 'Havstund · booking #' + b.id },
    }],
  });
}

// Ny chat-melding fra kunde -> #meldinger
function chatVarsel(threadId, tekst, navn) {
  const hvem = navn ? (', ' + navn) : '';
  return postWebhook(WEBHOOKS.meldinger, {
    username: 'Havstund Chat',
    content: '💬 **Ny kundemelding** (tråd #' + threadId + hvem + ')\n> ' + String(tekst).slice(0, 1500),
  });
}

// Ny melding fra kunde i kundeportalen (Min side) -> #meldinger
function kundeMeldingVarsel(kunde, tekst) {
  const navn = (kunde && kunde.navn) ? kunde.navn : 'Kunde';
  const epost = (kunde && kunde.epost) ? (' · ' + kunde.epost) : '';
  return postWebhook(WEBHOOKS.meldinger, {
    username: 'Havstund Min side',
    embeds: [{
      title: '✉️ Ny melding fra kunde',
      color: 2201299,
      description: '> ' + String(tekst).slice(0, 1800),
      footer: { text: 'Havstund · ' + navn + epost + ' · svar i Kundedialog' },
    }],
  });
}

module.exports = { bookingVarsel, chatVarsel, kundeMeldingVarsel };
