/* Havstund — realtime chat (Socket.IO).
   Rom: 'thread:<id>'. Hendelser:
     bli_med(thread_id)               -> join rommet
     ansatt_svar({thread_id,tekst})   -> lagre (hvis DB) + emit 'melding' til rommet
     ansatt_overtar(thread_id)        -> sett status='ansatt' + emit 'ansatt_overtatt'
   Robust: tåler manglende DB og rar input. */
const db = require('../db');
const { verifyChatToken } = require('../lib/chat-token');
const { userFromToken, COOKIE: AUTH_COOKIE } = require('../lib/auth');
// cookie-modulen følger med cookie-parser (server.js). Fall tilbake på enkel
// parsing hvis den mangler, så realtime aldri kræsjer på require.
let cookieLib = null;
try {
  cookieLib = require('cookie');
} catch {
  cookieLib = null;
}

const CHAT_COOKIE = 'havstund_chat';

// Parse rå Cookie-header fra socket-handshaken -> { navn: verdi }.
function parseCookies(header) {
  if (!header || typeof header !== 'string') return {};
  if (cookieLib && typeof cookieLib.parse === 'function') {
    try {
      return cookieLib.parse(header);
    } catch {
      return {};
    }
  }
  const ut = {};
  for (const del of header.split(';')) {
    const i = del.indexOf('=');
    if (i < 0) continue;
    const k = del.slice(0, i).trim();
    if (!k) continue;
    try {
      ut[k] = decodeURIComponent(del.slice(i + 1).trim());
    } catch {
      ut[k] = del.slice(i + 1).trim();
    }
  }
  return ut;
}

// Innlogget bruker (ansatt/admin) fra handshake-JWT, ellers null.
function socketBruker(socket) {
  const header =
    socket && socket.handshake && socket.handshake.headers && socket.handshake.headers.cookie;
  const cookies = parseCookies(header);
  return userFromToken(cookies[AUTH_COOKIE]);
}
function erAnsatt(socket) {
  const u = socketBruker(socket);
  return !!(u && (u.rolle === 'ansatt' || u.rolle === 'admin'));
}
// Har socketen lov å joine 'thread:<id>'? Ansatt/admin: alle tråder. Kunde:
// kun hvis den signerte havstund_chat-cookien verifiserer for nettopp denne id.
function kanJoine(socket, id) {
  if (erAnsatt(socket)) return true;
  const header =
    socket && socket.handshake && socket.handshake.headers && socket.handshake.headers.cookie;
  const cookies = parseCookies(header);
  return verifyChatToken(cookies[CHAT_COOKIE], id);
}

function rom(id) {
  return 'thread:' + id;
}

// Tolk et tråd-id robust (tall eller streng) -> positivt heltall eller null
function tilId(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

module.exports = function (io) {
  io.on('connection', (socket) => {
    // Kunde eller ansatt blir med i en tråd — KUN etter autorisasjon.
    // Ansatt/admin (gyldig JWT-cookie) får joine hvilken som helst tråd; en
    // kunde får kun joine tråden dens signerte havstund_chat-cookie gjelder.
    // Manglende/forfalsket cookie avvises — samme IDOR-vern som HTTP-siden.
    // Uten dette kunne enhver socket høste live-PII fra alle tråder.
    socket.on('bli_med', (thread_id) => {
      const id = tilId(thread_id);
      if (!id) return;
      if (kanJoine(socket, id)) socket.join(rom(id));
      else socket.emit('nektet', { thread_id: id });
    });

    socket.on('forlat', (thread_id) => {
      const id = tilId(thread_id);
      if (id) socket.leave(rom(id));
    });

    // Ansatt svarer i en tråd — kun ekte ansatt/admin (JWT). Uten denne
    // sjekken kunne enhver socket lagre meldinger som avsender='ansatt'
    // (impersonering + injisert innhold) i en hvilken som helst tråd.
    socket.on('ansatt_svar', async (data) => {
      if (!erAnsatt(socket)) return;
      const id = tilId(data && data.thread_id);
      const tekst = String((data && data.tekst) || '').trim();
      if (!id || !tekst) return;

      let melding = {
        thread_id: id,
        avsender: 'ansatt',
        tekst: tekst.slice(0, 4000),
        opprettet: new Date().toISOString(),
      };

      // Lagre hvis DB er tilgjengelig (best effort)
      if (db.isConfigured()) {
        try {
          const lagret = await db.one(
            `INSERT INTO chat_messages (thread_id, avsender, tekst)
             VALUES ($1, 'ansatt', $2)
             RETURNING id, thread_id, avsender, tekst, opprettet`,
            [id, melding.tekst]
          );
          if (lagret) melding = lagret;
          await db.query('UPDATE chat_threads SET sist = now() WHERE id = $1', [id]);
        } catch (e) {
          console.error('realtime ansatt_svar lagring feilet:', e.message);
        }
      }

      io.to(rom(id)).emit('melding', melding);
    });

    // Ansatt overtar tråden fra AI — kun ekte ansatt/admin (JWT). Hindrer at
    // en fremmed socket muterer tråd-status.
    socket.on('ansatt_overtar', async (thread_id) => {
      if (!erAnsatt(socket)) return;
      const id = tilId(thread_id);
      if (!id) return;

      if (db.isConfigured()) {
        try {
          await db.query(
            "UPDATE chat_threads SET status = 'ansatt', sist = now() WHERE id = $1",
            [id]
          );
        } catch (e) {
          console.error('realtime ansatt_overtar status feilet:', e.message);
        }
      }

      io.to(rom(id)).emit('ansatt_overtatt', { thread_id: id });
    });
  });
};
