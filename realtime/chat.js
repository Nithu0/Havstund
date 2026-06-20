/* Havstund — realtime chat (Socket.IO).
   Rom: 'thread:<id>'. Hendelser:
     bli_med(thread_id)               -> join rommet
     ansatt_svar({thread_id,tekst})   -> lagre (hvis DB) + emit 'melding' til rommet
     ansatt_overtar(thread_id)        -> sett status='ansatt' + emit 'ansatt_overtatt'
   Robust: tåler manglende DB og rar input. */
const db = require('../db');

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
    // Kunde eller ansatt blir med i en tråd
    socket.on('bli_med', (thread_id) => {
      const id = tilId(thread_id);
      if (id) socket.join(rom(id));
    });

    socket.on('forlat', (thread_id) => {
      const id = tilId(thread_id);
      if (id) socket.leave(rom(id));
    });

    // Ansatt svarer i en tråd
    socket.on('ansatt_svar', async (data) => {
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

    // Ansatt overtar tråden fra AI
    socket.on('ansatt_overtar', async (thread_id) => {
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
