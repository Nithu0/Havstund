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

async function postWebhook(url, payload) {
  if (!url || typeof fetch !== 'function') return;
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    console.error('Discord-varsling feilet:', e.message);
  }
}

function felt(navn, verdi, inline) {
  return { name: navn, value: (verdi == null || verdi === '') ? '-' : String(verdi), inline: !!inline };
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

module.exports = { bookingVarsel, chatVarsel };
