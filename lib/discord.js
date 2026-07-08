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
