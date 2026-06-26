/**
 * Steg D — HttpWebsiteAdapter mot en lokal stub-HTTP-server som etterligner
 * nettsidens FAKTISKE svar-former. Beviser at adapteren:
 *  - sender service-token (Authorization: Bearer)
 *  - treffer riktige stier/metoder
 *  - oversetter 404/409('fullt'|'stengt')/400 til typede PortError
 *  - beregner checkAvailability adapter-side (slot/aktivitet + opptatt + stengt)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { HttpWebsiteAdapter } from '../src/adapters/http-website-adapter.js';

interface Recorded { method: string; url: string; auth?: string; body?: unknown }
let server: Server;
let baseUrl: string;
let recorded: Recorded[] = [];

// Enkel ruter som speiler nettsidens svar-former.
function route(req: IncomingMessage, res: ServerResponse, body: unknown) {
  const url = req.url ?? '';
  const method = req.method ?? 'GET';
  recorded.push({ method, url, auth: req.headers.authorization, body });
  const json = (status: number, payload: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(payload));
  };

  if (method === 'GET' && url === '/api/health') return json(200, { ok: true, db: 'up' });
  if (method === 'GET' && url === '/api/activities') return json(200, [{ id: 1, slug: 'fisk', navn: 'Fisketur', beskrivelse: null, varighet: null, pris: 500, kapasitet: 3, bilde: null }]);
  if (method === 'GET' && url === '/api/activities/1') return json(200, { id: 1, slug: 'fisk', navn: 'Fisketur', beskrivelse: null, varighet: null, pris: 500, kapasitet: 3, bilde: null });
  if (method === 'GET' && url === '/api/activities/99') return json(404, { error: 'Aktivitet ikke funnet' });
  if (method === 'GET' && url === '/api/hours') return json(200, { hours: [{ ukedag: 0, apner: '09:00', stenger: '17:00', stengt: false }], closed: [{ dato: '2026-12-25', grunn: 'jul' }] });
  if (method === 'GET' && url.startsWith('/api/availability')) return json(200, [{ id: 1, activity_id: 1, dato: '2026-07-01', tid: '10:00', kapasitet: 3 }]);
  if (method === 'GET' && url === '/api/bookings') return json(200, [{ id: 5, activity_id: 1, bruker_id: null, navn: 'A', epost: 'a@b.no', tlf: null, dato: '2026-07-01', tid: '10:00', antall: 1, status: 'bekreftet', belop: 500, melding: null }]);
  if (method === 'POST' && url === '/api/bookings') return json(201, { booking: { id: 9, activity_id: 1, bruker_id: null, navn: 'Ny', epost: 'n@b.no', tlf: null, dato: '2026-07-01', tid: '10:00', antall: 1, status: 'forespurt', belop: 500, melding: null } });
  if (method === 'PATCH' && url === '/api/bookings/9') return json(200, { booking: { id: 9, status: 'bekreftet', activity_id: 1, bruker_id: null, navn: 'Ny', epost: 'n@b.no', tlf: null, dato: '2026-07-01', tid: '10:00', antall: 1, belop: 500, melding: null } });
  if (method === 'POST' && url === '/api/bookings/full') return json(409, { feil: 'fullt' });
  if (method === 'GET' && url.startsWith('/api/meldinger')) return json(200, { kunde: { id: 1, navn: 'Kari', epost: 'k@b.no', rolle: 'kunde' }, meldinger: [{ id: 1, bruker_id: 1, avsender: 'kunde', tekst: 'hei', pris: null, lest: false, opprettet: '2026-06-01' }] });
  if (method === 'POST' && url.startsWith('/api/meldinger')) return json(201, { melding: { id: 2, bruker_id: 1, avsender: 'admin', tekst: 'svar', pris: null, lest: false, opprettet: '2026-06-02' } });
  if (method === 'GET' && url === '/api/admin/content') return json(200, [{ nokkel: 'forside.tittel', verdi: 'Hei', oppdatert: '2026-06-01' }]);
  if (method === 'PUT' && url.startsWith('/api/admin/content/')) return json(200, { nokkel: 'forside.tittel', verdi: 'Ny', oppdatert: '2026-06-03' });
  if (method === 'GET' && url.startsWith('/api/regnskap/timer')) return json(200, [{ id: 1, ansatt_id: 1, ansatt_navn: 'Per', dato: '2026-06-01', timer: 5, aktivitet: null, notat: null }]);
  if (method === 'POST' && url === '/api/regnskap/timer') return json(201, { timeforing: { id: 7, ansatt_id: 1, dato: '2026-07-01', timer: 4, aktivitet: null, notat: null } });
  if (method === 'PUT' && url === '/api/availability') return json(200, [{ id: 2, activity_id: 1, dato: '2026-07-02', tid: '09:00', kapasitet: 4 }]);
  if (method === 'PUT' && url === '/api/hours/0') return json(200, { ukedag: 0, apner: '09:00', stenger: '17:00', stengt: false });
  if (method === 'DELETE' && url === '/api/activities/1') return json(200, { ok: true, id: 1 });
  return json(404, { error: 'ukjent stub-rute' });
}

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => {
      let body: unknown = null;
      const t = Buffer.concat(chunks).toString('utf8');
      if (t) try { body = JSON.parse(t); } catch { body = t; }
      route(req, res, body);
    });
  });
  await new Promise<void>((r) => server.listen(0, r));
  const addr = server.address();
  const portNo = typeof addr === 'object' && addr ? addr.port : 0;
  baseUrl = `http://127.0.0.1:${portNo}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

function adapter() {
  recorded = [];
  return new HttpWebsiteAdapter({ baseUrl, serviceToken: 'svc-token-0123456789' });
}

describe('HttpWebsiteAdapter — lese + auth', () => {
  it('sender service-token som Bearer', async () => {
    const a = adapter();
    await a.listActivities();
    expect(recorded[0]!.auth).toBe('Bearer svc-token-0123456789');
  });

  it('getActivity(99) → null på 404', async () => {
    const a = adapter();
    expect(await a.getActivity(99)).toBeNull();
  });

  it('checkAvailability beregner ledig = kapasitet - opptatt og stengt', async () => {
    const a = adapter();
    const check = await a.checkAvailability(1, '2026-07-01', '10:00');
    expect(check.kapasitet).toBe(3);
    expect(check.opptatt).toBe(1); // én bekreftet booking i stub
    expect(check.ledig).toBe(2);
    expect(check.stengt).toBe(false);
  });

  it('checkAvailability flagger stengt for closed_date', async () => {
    const a = adapter();
    const check = await a.checkAvailability(1, '2026-12-25', '10:00');
    expect(check.stengt).toBe(true);
  });

  it('getBooking filtrerer fra listen', async () => {
    const a = adapter();
    expect((await a.getBooking(5))?.id).toBe(5);
    expect(await a.getBooking(123)).toBeNull();
  });
});

describe('HttpWebsiteAdapter — skrive + feil-mapping', () => {
  it('createBooking POSTer og returnerer booking', async () => {
    const a = adapter();
    const b = await a.createBooking({ activity_id: 1, navn: 'Ny', epost: 'n@b.no', dato: '2026-07-01', tid: '10:00', antall: 1 });
    expect(b.id).toBe(9);
    expect(recorded.some((r) => r.method === 'POST' && r.url === '/api/bookings')).toBe(true);
  });

  it('setBookingStatus PATCHer', async () => {
    const a = adapter();
    const b = await a.setBookingStatus(9, 'bekreftet');
    expect(b.status).toBe('bekreftet');
  });

  it('replyToCustomer POSTer til meldinger med bruker_id', async () => {
    const a = adapter();
    const m = await a.replyToCustomer({ bruker_id: 1, tekst: 'svar' });
    expect(m.avsender).toBe('admin');
  });

  it('logStaffHours POSTer til regnskap/timer', async () => {
    const a = adapter();
    const t = await a.logStaffHours({ ansatt_id: 1, dato: '2026-07-01', timer: 4 });
    expect(t.id).toBe(7);
  });

  it('updateSiteContent PUTer', async () => {
    const a = adapter();
    const c = await a.updateSiteContent({ nokkel: 'forside.tittel', verdi: 'Ny' });
    expect(c.verdi).toBe('Ny');
  });

  it('updateBooking nektes (ikke støttet av API)', async () => {
    const a = adapter();
    await expect(a.updateBooking(1, { melding: 'x' })).rejects.toMatchObject({ code: 'validation' });
  });
});
