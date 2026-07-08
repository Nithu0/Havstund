// describe/it/expect er globale (vitest.config.js -> globals: true).
// Tester Socket.IO-autorisasjon i realtime/chat.js (IDOR-vern for live-PII):
// en usignert/forfalsket socket får IKKE joine 'thread:<id>' og mottar dermed
// ingen framtidige 'melding'-emits; en gyldig signert kunde-cookie eller en
// ansatt/admin-JWT slipper inn. Skrive-events (ansatt_svar/ansatt_overtar)
// krever ekte ansatt. Ingen socket.io-client: vi driver de registrerte
// handlerne direkte via en fake io/socket (deterministisk, ingen nettverk).
const db = require('../../db');
const { signChatToken } = require('../../lib/chat-token');
// signToken deler samme modul-singleton (samme SECRET) som userFromToken i
// realtime/chat.js -> et JWT signert her verifiseres i handleren.
const { signToken, COOKIE: AUTH_COOKIE } = require('../../lib/auth');
const setupRealtimeChat = require('../../realtime/chat');

// Ingen DB i denne testen — skrive-stiene skal uansett gates FØR DB røres.
db.isConfigured = () => false;

const CHAT_COOKIE = 'havstund_chat';

function lagIo() {
  let connFn = null;
  const roomEmits = [];
  const io = {
    on(event, fn) { if (event === 'connection') connFn = fn; },
    to() { return { emit: (event, payload) => roomEmits.push({ event, payload }) }; },
  };
  return { io, roomEmits, koble: (socket) => connFn && connFn(socket) };
}

function lagSocket(cookieHeader) {
  const handlers = {};
  const joined = [];
  const emits = [];
  const socket = {
    handshake: { headers: { cookie: cookieHeader || '' } },
    on(event, fn) { handlers[event] = fn; },
    join(r) { joined.push(r); },
    leave() {},
    emit(event, payload) { emits.push({ event, payload }); },
  };
  return { socket, handlers, joined, emits };
}

function koblePa(cookieHeader) {
  const { io, roomEmits, koble } = lagIo();
  setupRealtimeChat(io);
  const s = lagSocket(cookieHeader);
  koble(s.socket);
  return { handlers: s.handlers, joined: s.joined, emits: s.emits, roomEmits };
}

const ANSATT_COOKIE = AUTH_COOKIE + '=' + signToken({ id: 2, rolle: 'ansatt', navn: 'Ola' });

describe('realtime chat — Socket.IO IDOR-vern', () => {
  it('bli_med: manglende cookie -> ingen join, får nektet', () => {
    const { handlers, joined, emits } = koblePa('');
    handlers.bli_med(1);
    expect(joined).toEqual([]);
    expect(emits.some((e) => e.event === 'nektet')).toBe(true);
  });

  it('bli_med: forfalsket chat-cookie -> ingen join', () => {
    const { handlers, joined, emits } = koblePa(CHAT_COOKIE + '=1.deadbeefdeadbeef');
    handlers.bli_med(1);
    expect(joined).toEqual([]);
    expect(emits.some((e) => e.event === 'nektet')).toBe(true);
  });

  it('bli_med: gyldig signert kunde-cookie -> join KUN egen tråd', () => {
    const { handlers, joined } = koblePa(CHAT_COOKIE + '=' + signChatToken(1));
    handlers.bli_med(1);
    expect(joined).toEqual(['thread:1']);
    // samme cookie gir IKKE tilgang til en annen tråd
    handlers.bli_med(2);
    expect(joined).toEqual(['thread:1']);
  });

  it('bli_med: ansatt-JWT -> join hvilken som helst tråd', () => {
    const { handlers, joined } = koblePa(ANSATT_COOKIE);
    handlers.bli_med(99);
    expect(joined).toEqual(['thread:99']);
  });

  it('ansatt_svar: ikke-ansatt socket -> ingen melding kringkastes', async () => {
    const { handlers, roomEmits } = koblePa(CHAT_COOKIE + '=' + signChatToken(1));
    await handlers.ansatt_svar({ thread_id: 1, tekst: 'utgir meg for ansatt' });
    expect(roomEmits).toEqual([]);
  });

  it('ansatt_svar: ekte ansatt -> melding kringkastes til rommet', async () => {
    const { handlers, roomEmits } = koblePa(ANSATT_COOKIE);
    await handlers.ansatt_svar({ thread_id: 1, tekst: 'hei fra ansatt' });
    expect(roomEmits.some((e) => e.event === 'melding')).toBe(true);
  });

  it('ansatt_overtar: ikke-ansatt socket -> ingen status-emit', async () => {
    const { handlers, roomEmits } = koblePa('');
    await handlers.ansatt_overtar(1);
    expect(roomEmits).toEqual([]);
  });
});
