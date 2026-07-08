// describe/it/expect er globale (vitest.config.js -> globals: true).
// Tester IDOR-tettingen i live chat: signert eierskaps-cookie kreves for
// anonym tilgang. Forfalsket/manglende cookie -> 404 (eksistens skjules);
// gyldig signert -> 200; ansatt/admin -> 200; GET lekker IKKE bruker_id.
// CJS-monster: vi muterer db-singletonen (samme ref som routes/chat.js holder).
const express = require('express');
const cookieParser = require('cookie-parser');

const db = require('../../db');
// Samme modul-singleton (samme SECRET) som routes/chat.js bruker -> et token
// signert her validerer i ruta.
const { signChatToken } = require('../../lib/chat-token');

// Én tråd i "DB": id 1, eid av kunde 42.
const state = {
  traad: { id: 1, navn: 'Kari', epost: 'k@x.no', status: 'apen', bruker_id: 42, opprettet: 't', sist: 't' },
};

db.isConfigured = () => true;
db.one = async (text) => {
  // Returner en KOPI så ruta si `delete traad.bruker_id` ikke muterer state.
  if (/FROM chat_threads WHERE id = \$1/i.test(text)) return { ...state.traad };
  if (/INSERT INTO chat_messages/i.test(text)) {
    return { id: 9, thread_id: 1, avsender: 'kunde', tekst: 'hei', opprettet: 't' };
  }
  return null;
};
db.query = async () => ({ rows: [] });

const router = require('../../routes/chat');

function lagApp(user) {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use((req, _res, next) => { if (user) req.user = user; next(); });
  app.use('/api/chat', router);
  return app;
}
function lytt(app) {
  return new Promise((resolve) => { const srv = app.listen(0, () => resolve(srv)); });
}
async function get(srv, sti, cookie) {
  const { port } = srv.address();
  const r = await fetch(`http://127.0.0.1:${port}${sti}`, { headers: cookie ? { Cookie: cookie } : {} });
  let body = null; try { body = await r.json(); } catch { /* ignore */ }
  return { status: r.status, body };
}
async function postMsg(srv, sti, cookie) {
  const { port } = srv.address();
  const headers = Object.assign({ 'Content-Type': 'application/json' }, cookie ? { Cookie: cookie } : {});
  const r = await fetch(`http://127.0.0.1:${port}${sti}`, {
    method: 'POST', headers, body: JSON.stringify({ tekst: 'hei' }),
  });
  let body = null; try { body = await r.json(); } catch { /* ignore */ }
  return { status: r.status, body };
}

const GYLDIG = 'havstund_chat=' + signChatToken(1);
const FORFALSKET = 'havstund_chat=1.deadbeefdeadbeef';
const ANSATT = { id: 2, rolle: 'ansatt', navn: 'Ola' };

describe('chat IDOR-tetting', () => {
  it('GET messages: forfalsket cookie -> 404 (skjuler eksistens)', async () => {
    const srv = await lytt(lagApp());
    try {
      const res = await get(srv, '/api/chat/thread/1/messages', FORFALSKET);
      expect(res.status).toBe(404);
    } finally { srv.close(); }
  });

  it('GET messages: ingen cookie -> 404', async () => {
    const srv = await lytt(lagApp());
    try {
      const res = await get(srv, '/api/chat/thread/1/messages');
      expect(res.status).toBe(404);
    } finally { srv.close(); }
  });

  it('GET messages: gyldig signert cookie -> 200 og lekker IKKE bruker_id', async () => {
    const srv = await lytt(lagApp());
    try {
      const res = await get(srv, '/api/chat/thread/1/messages', GYLDIG);
      expect(res.status).toBe(200);
      expect(res.body.thread).toBeTruthy();
      expect(res.body.thread).not.toHaveProperty('bruker_id');
    } finally { srv.close(); }
  });

  it('GET messages: ansatt uten cookie -> 200, fortsatt ingen bruker_id', async () => {
    const srv = await lytt(lagApp(ANSATT));
    try {
      const res = await get(srv, '/api/chat/thread/1/messages');
      expect(res.status).toBe(200);
      expect(res.body.thread).not.toHaveProperty('bruker_id');
    } finally { srv.close(); }
  });

  it('POST message: forfalsket cookie -> 404', async () => {
    const srv = await lytt(lagApp());
    try {
      const res = await postMsg(srv, '/api/chat/thread/1/message', FORFALSKET);
      expect(res.status).toBe(404);
    } finally { srv.close(); }
  });

  it('POST message: gyldig signert cookie -> 200', async () => {
    const srv = await lytt(lagApp());
    try {
      const res = await postMsg(srv, '/api/chat/thread/1/message', GYLDIG);
      expect(res.status).toBe(200);
    } finally { srv.close(); }
  });

  it('POST message: ansatt uten cookie -> 200', async () => {
    const srv = await lytt(lagApp(ANSATT));
    try {
      const res = await postMsg(srv, '/api/chat/thread/1/message', undefined);
      expect(res.status).toBe(200);
    } finally { srv.close(); }
  });
});
