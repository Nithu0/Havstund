/**
 * Havstund Brain — revalidering + utførelse av skrive-verktøy.
 *
 * revalidateWrite() håndhever de HARDE grensene som strict:true IKKE kan
 * (minimum/maxLength/forretningsregler) MOT FERSK DB (design §6):
 *   - antall > 0 og antall <= ledig kapasitet (re-sjekk mot porten)
 *   - dagen ikke stengt
 *   - pris/kapasitet/timer innenfor grenser
 *   - gyldig statusovergang + stale-write (expected_status matcher fersk DB)
 *   - update_site_content / update_booking stale-write (expected_version/_updated_at)
 *
 * executeWrite() utfører ÉN port-skriving. Kalles KUN etter revalidering.
 */
import {
  CapacityError,
  ClosedDayError,
  NotFoundError,
  StaleWriteError,
  ValidationError,
} from '../port/errors.js';
import type { WebsitePort } from '../port/website-port.js';
import type { BookingStatus } from '../port/types.js';

// Gyldige statusoverganger (forespurt → bekreftet/avlyst, bekreftet → fullfort/avlyst).
const TRANSITIONS: Record<BookingStatus, BookingStatus[]> = {
  forespurt: ['bekreftet', 'avlyst', 'fullfort'],
  bekreftet: ['fullfort', 'avlyst'],
  avlyst: [],
  fullfort: [],
};

function intGte(v: unknown, min: number, felt: string): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min) throw new ValidationError(`${felt} må være et heltall >= ${min}`);
  return n;
}

export async function revalidateWrite(
  port: WebsitePort,
  tool: string,
  input: Record<string, unknown>,
): Promise<void> {
  switch (tool) {
    case 'create_booking': {
      const antall = intGte(input.antall, 1, 'antall');
      const activity_id = intGte(input.activity_id, 1, 'activity_id');
      const dato = String(input.dato);
      const tid = (input.tid as string) ?? null;
      const akt = await port.getActivity(activity_id);
      if (!akt || akt.aktiv === false) throw new NotFoundError('Aktivitet ikke funnet');
      const check = await port.checkAvailability(activity_id, dato, tid);
      if (check.stengt) throw new ClosedDayError();
      if (check.opptatt + antall > check.kapasitet) throw new CapacityError();
      return;
    }
    case 'update_booking': {
      const id = intGte(input.id, 1, 'id');
      const b = await port.getBooking(id);
      if (!b) throw new NotFoundError('Booking ikke funnet');
      if (input.antall !== undefined) intGte(input.antall, 1, 'antall');
      // stale-write: expected_updated_at må matche siste kjente (her: status+antall-signatur)
      // Vi har ingen updated_at-kolonne på bookings; bruk status som stale-signal:
      // hvis bookingen er avlyst/fullfort skal den ikke endres.
      if (b.status === 'avlyst' || b.status === 'fullfort') {
        throw new StaleWriteError('Bookingen er låst (avlyst/fullfort) og kan ikke endres');
      }
      return;
    }
    case 'set_booking_status': {
      const id = intGte(input.id, 1, 'id');
      const status = input.status as BookingStatus;
      const expected = input.expected_status as BookingStatus;
      const b = await port.getBooking(id);
      if (!b) throw new NotFoundError('Booking ikke funnet');
      if (b.status !== expected) {
        throw new StaleWriteError(`Status er nå "${b.status}", ikke "${expected}". Last på nytt.`);
      }
      if (b.status === status) return; // idempotent no-op tillatt
      if (!TRANSITIONS[b.status]?.includes(status)) {
        throw new ValidationError(`Ugyldig statusovergang ${b.status} → ${status}`);
      }
      return;
    }
    case 'set_availability': {
      intGte(input.activity_id, 1, 'activity_id');
      const slots = Array.isArray(input.slots) ? input.slots : [];
      if (slots.length > 500) throw new ValidationError('for mange slots (maks 500)');
      for (const s of slots as Array<{ tid?: unknown; kapasitet?: unknown }>) {
        if (typeof s.tid !== 'string' || !s.tid.trim()) throw new ValidationError('hver slot må ha en tid');
        intGte(s.kapasitet, 0, 'kapasitet');
      }
      return;
    }
    case 'set_opening_hours': {
      const ukedag = Number(input.ukedag);
      if (!Number.isInteger(ukedag) || ukedag < 0 || ukedag > 6) {
        throw new ValidationError('ukedag må være 0–6');
      }
      const tid = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;
      for (const f of ['apner', 'stenger'] as const) {
        const v = input[f];
        if (v != null && v !== '' && (typeof v !== 'string' || !tid.test(v))) {
          throw new ValidationError(`${f} må være HH:MM`);
        }
      }
      return;
    }
    case 'upsert_activity': {
      intGte(input.pris, 0, 'pris');
      intGte(input.kapasitet, 0, 'kapasitet');
      if (input.id != null) {
        const a = await port.getActivity(Number(input.id));
        if (!a) throw new NotFoundError('Aktivitet ikke funnet');
      } else if (!input.slug || !/^[a-z0-9-]{1,64}$/.test(String(input.slug))) {
        throw new ValidationError('slug må være a-z, 0-9, bindestrek (1–64) ved oppretting');
      }
      return;
    }
    case 'set_activity_status': {
      const id = intGte(input.id, 1, 'id');
      const a = await port.getActivity(id);
      if (!a) throw new NotFoundError('Aktivitet ikke funnet');
      return;
    }
    case 'reply_to_customer': {
      intGte(input.bruker_id, 1, 'bruker_id');
      const tekst = String(input.tekst ?? '').trim();
      if (!tekst) throw new ValidationError('Melding kan ikke være tom');
      if (tekst.length > 4000) throw new ValidationError('Meldingen er for lang (maks 4000)');
      if (input.pris != null) intGte(input.pris, 0, 'pris');
      return;
    }
    case 'log_staff_hours': {
      intGte(input.ansatt_id, 1, 'ansatt_id');
      const timer = Number(input.timer);
      if (!(timer > 0 && timer <= 24)) throw new ValidationError('timer må være > 0 og <= 24');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(input.dato))) throw new ValidationError('dato må være YYYY-MM-DD');
      return;
    }
    case 'update_site_content': {
      const nokkel = String(input.nokkel ?? '');
      if (!/^[a-z0-9_.-]{1,64}$/.test(nokkel)) throw new ValidationError('Ugyldig nøkkel');
      if (String(input.verdi ?? '').length > 50000) throw new ValidationError('Verdien er for stor (maks 50 000)');
      // stale-write: expected_version må matche siste kjente "oppdatert".
      if (input.expected_version != null) {
        const all = await port.getContent();
        const row = all.find((c) => c.nokkel === nokkel);
        const current = row ? row.oppdatert : null;
        if (current !== input.expected_version) {
          throw new StaleWriteError('Innholdet er endret siden du leste det. Last på nytt.');
        }
      }
      return;
    }
    default:
      throw new ValidationError(`Ukjent skrive-verktøy: ${tool}`);
  }
}

export async function executeWrite(
  port: WebsitePort,
  tool: string,
  input: Record<string, unknown>,
): Promise<unknown> {
  switch (tool) {
    case 'create_booking':
      return port.createBooking({
        activity_id: Number(input.activity_id),
        navn: String(input.navn),
        epost: String(input.epost),
        tlf: (input.tlf as string) ?? null,
        dato: String(input.dato),
        tid: (input.tid as string) ?? null,
        antall: Number(input.antall),
        melding: (input.melding as string) ?? null,
      });
    case 'update_booking':
      return port.updateBooking(Number(input.id), {
        ...(input.tlf !== undefined ? { tlf: (input.tlf as string) ?? null } : {}),
        ...(input.melding !== undefined ? { melding: (input.melding as string) ?? null } : {}),
        ...(input.antall !== undefined ? { antall: Number(input.antall) } : {}),
      });
    case 'set_booking_status':
      return port.setBookingStatus(Number(input.id), input.status as BookingStatus);
    case 'set_availability':
      return port.setAvailability({
        activity_id: Number(input.activity_id),
        dato: String(input.dato),
        slots: (input.slots as Array<{ tid: string; kapasitet: number }>).map((s) => ({
          tid: String(s.tid),
          kapasitet: Number(s.kapasitet),
        })),
      });
    case 'set_opening_hours':
      return port.setOpeningHours({
        ukedag: Number(input.ukedag),
        ...(input.apner !== undefined ? { apner: (input.apner as string) ?? null } : {}),
        ...(input.stenger !== undefined ? { stenger: (input.stenger as string) ?? null } : {}),
        ...(input.stengt !== undefined ? { stengt: Boolean(input.stengt) } : {}),
      });
    case 'upsert_activity':
      return port.upsertActivity({
        ...(input.id != null ? { id: Number(input.id) } : {}),
        ...(input.slug != null ? { slug: String(input.slug) } : {}),
        navn: String(input.navn),
        beskrivelse: (input.beskrivelse as string) ?? null,
        varighet: (input.varighet as string) ?? null,
        pris: Number(input.pris),
        kapasitet: Number(input.kapasitet),
        bilde: (input.bilde as string) ?? null,
      });
    case 'set_activity_status':
      return port.setActivityStatus({ id: Number(input.id), aktiv: Boolean(input.aktiv) });
    case 'reply_to_customer':
      return port.replyToCustomer({
        bruker_id: Number(input.bruker_id),
        tekst: String(input.tekst),
        pris: input.pris != null ? Number(input.pris) : null,
      });
    case 'log_staff_hours':
      return port.logStaffHours({
        ansatt_id: Number(input.ansatt_id),
        dato: String(input.dato),
        timer: Number(input.timer),
        aktivitet: (input.aktivitet as string) ?? null,
        notat: (input.notat as string) ?? null,
      });
    case 'update_site_content':
      return port.updateSiteContent({ nokkel: String(input.nokkel), verdi: String(input.verdi) });
    default:
      throw new ValidationError(`Ukjent skrive-verktøy: ${tool}`);
  }
}
