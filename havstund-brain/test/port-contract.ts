/**
 * Gjenbrukbar kontrakt-suite for WebsitePort.
 *
 * Både MockWebsiteAdapter og HttpWebsiteAdapter skal bestå NØYAKTIG denne
 * suiten. Importeres av:
 *   - test/port-contract.test.ts  (mot mock, alltid i CI)
 *   - test/contract-live.test.ts  (mot ekte API, nightly, bak env-flagg)
 *
 * Invariant #1 (lese muterer ikke) håndheves her: vi tar en snapshot av all
 * lesbar tilstand før/etter en serie lese-kall og krever likhet.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { WebsitePort } from '../src/port/website-port.js';

export interface ContractHarness {
  /** Fersk port med et kjent grunn-sett (3 plasser i activity 1, slot kl 10). */
  makePort(): Promise<WebsitePort> | WebsitePort;
}

export function runPortContract(name: string, harness: ContractHarness): void {
  describe(`WebsitePort-kontrakt: ${name}`, () => {
    let port: WebsitePort;

    beforeEach(async () => {
      port = await harness.makePort();
    });

    it('list/get activities returnerer kjent aktivitet', async () => {
      const acts = await port.listActivities();
      expect(acts.length).toBeGreaterThan(0);
      const one = await port.getActivity(acts[0]!.id);
      expect(one?.id).toBe(acts[0]!.id);
    });

    it('getActivity på ukjent id gir null (ikke kast)', async () => {
      expect(await port.getActivity(999999)).toBeNull();
    });

    it('checkAvailability rapporterer ledig = kapasitet - opptatt', async () => {
      const check = await port.checkAvailability(1, '2026-07-01', '10:00');
      expect(check.kapasitet).toBeGreaterThan(0);
      expect(check.ledig).toBe(check.kapasitet - check.opptatt);
      expect(check.stengt).toBe(false);
    });

    it('LESE muterer ikke tilstand (invariant #1)', async () => {
      const snap = async () =>
        JSON.stringify({
          bookings: await port.listBookings(),
          activities: await port.listActivities(true),
          content: await port.getContent(),
          hours: await port.getOpeningHours(),
        });
      const before = await snap();
      await port.getBooking(1);
      await port.checkAvailability(1, '2026-07-01', '10:00');
      await port.listMessages(1);
      await port.getMessageThread(1);
      await port.listStaffHours();
      await port.getAvailabilitySlots(1, '2026-07-01');
      await port.health();
      const after = await snap();
      expect(after).toBe(before);
    });

    it('createBooking lykkes innenfor kapasitet og setter status forespurt', async () => {
      const b = await port.createBooking({
        activity_id: 1,
        navn: 'Kari',
        epost: 'kari@example.com',
        dato: '2026-07-01',
        tid: '10:00',
        antall: 1,
      });
      expect(b.status).toBe('forespurt');
      const check = await port.checkAvailability(1, '2026-07-01', '10:00');
      expect(check.opptatt).toBeGreaterThanOrEqual(1);
    });

    it('createBooking sprenger kapasitet -> CapacityError', async () => {
      await expect(
        port.createBooking({
          activity_id: 1,
          navn: 'For mange',
          epost: 'x@example.com',
          dato: '2026-07-01',
          tid: '10:00',
          antall: 999,
        }),
      ).rejects.toMatchObject({ code: 'capacity' });
    });

    it('createBooking på stengt dag -> ClosedDayError', async () => {
      await expect(
        port.createBooking({
          activity_id: 1,
          navn: 'Stengt',
          epost: 'x@example.com',
          dato: '2026-12-25',
          tid: '10:00',
          antall: 1,
        }),
      ).rejects.toMatchObject({ code: 'closed_day' });
    });

    it('setBookingStatus oppdaterer eksisterende booking', async () => {
      const b = await port.createBooking({
        activity_id: 1,
        navn: 'Per',
        epost: 'per@example.com',
        dato: '2026-07-01',
        tid: '10:00',
        antall: 1,
      });
      const u = await port.setBookingStatus(b.id, 'bekreftet');
      expect(u.status).toBe('bekreftet');
    });

    it('replyToCustomer lagrer admin-melding i kundens tråd', async () => {
      const m = await port.replyToCustomer({ bruker_id: 1, tekst: 'Hei!' });
      expect(m.avsender).toBe('admin');
      const thread = await port.getMessageThread(1);
      expect(thread.meldinger.some((x) => x.id === m.id)).toBe(true);
    });

    it('updateSiteContent upserter en innholdsnøkkel', async () => {
      const c = await port.updateSiteContent({ nokkel: 'forside.tittel', verdi: 'Velkommen' });
      expect(c.verdi).toBe('Velkommen');
      const all = await port.getContent();
      expect(all.some((x) => x.nokkel === 'forside.tittel')).toBe(true);
    });

    it('logStaffHours avviser timer > 24', async () => {
      await expect(
        port.logStaffHours({ ansatt_id: 1, dato: '2026-07-01', timer: 25 }),
      ).rejects.toMatchObject({ code: 'validation' });
    });

    it('setAvailability er slett-og-sett for (activity_id, dato)', async () => {
      const slots = await port.setAvailability({
        activity_id: 1,
        dato: '2026-07-02',
        slots: [{ tid: '09:00', kapasitet: 4 }],
      });
      expect(slots).toHaveLength(1);
      const after = await port.getAvailabilitySlots(1, '2026-07-02');
      expect(after).toHaveLength(1);
      expect(after[0]!.kapasitet).toBe(4);
    });
  });
}
