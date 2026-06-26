/**
 * Havstund Brain — HttpWebsiteAdapter: ekte REST mot nettsiden over undici.
 *
 * Mappet mot nettsidens FAKTISKE ruter (verifisert i repoet, ikke antatt):
 *   listBookings        GET  /api/bookings            (ansatt/admin: alle)
 *   getBooking          GET  /api/bookings            + klient-filter på id
 *   checkAvailability   GET  /api/availability + /api/hours + /api/bookings
 *                       (nettsiden har ingen samlet kapasitets-rute, så vi
 *                        beregner ledig adapter-side, samme regel som
 *                        routes/bookings.js: slot-kapasitet ellers aktivitet,
 *                        opptatt = SUM(antall) status in forespurt/bekreftet)
 *   getOpeningHours     GET  /api/hours
 *   listActivities      GET  /api/activities (/admin/all ved include_inactive)
 *   getActivity         GET  /api/activities/:id
 *   listMessages        GET  /api/meldinger?bruker_id=
 *   getMessageThread    GET  /api/meldinger?bruker_id=
 *   getContent          GET  /api/admin/content
 *   listStaffHours      GET  /api/regnskap/timer
 *   createBooking       POST /api/bookings
 *   updateBooking       (felt-patch — nettsiden har ingen generell PATCH; vi
 *                        gjør en målrettet best-effort: status via PATCH, øvrig
 *                        felt-endring støttes ikke i dagens API → ValidationError)
 *   setBookingStatus    PATCH /api/bookings/:id {status}
 *   setAvailability     PUT  /api/availability {activity_id,dato,slots}
 *   setOpeningHours     PUT  /api/hours/:ukedag
 *   upsertActivity      POST /api/activities | PUT /api/activities/:id
 *   setActivityStatus   DELETE /api/activities/:id (false) | PUT (true)
 *   replyToCustomer     POST /api/meldinger?bruker_id= {tekst,pris}
 *   logStaffHours       POST /api/regnskap/timer
 *   updateSiteContent   PUT  /api/admin/content/:nokkel {verdi}
 *   health              GET  /api/health
 *
 * Service-token sendes som Authorization: Bearer <token>. Nettsiden mapper den
 * til den smale 'agent'-rollen (Steg D / operator-oppgave). Adapteren oversetter
 * HTTP-feil til typede PortError så agent-loopen kan gi is_error i stedet for
 * å velte requesten.
 */
import { request } from 'undici';
import {
  CapacityError,
  ClosedDayError,
  NotFoundError,
  ValidationError,
  WebsiteApiError,
} from '../port/errors.js';
import type { WebsitePort, ListBookingsFilter } from '../port/website-port.js';
import type {
  Activity,
  AvailabilityCheck,
  AvailabilitySlot,
  Booking,
  BookingStatus,
  ContentEntry,
  CreateBookingInput,
  CustomerMessage,
  LogStaffHoursInput,
  MessageThread,
  OpeningHours,
  ReplyToCustomerInput,
  SetActivityStatusInput,
  SetAvailabilityInput,
  SetOpeningHoursInput,
  StaffHourEntry,
  UpdateSiteContentInput,
  UpsertActivityInput,
} from '../port/types.js';

function ukedagFraDato(dato: string): number | null {
  const d = new Date(`${dato}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  return (d.getUTCDay() + 6) % 7;
}

export interface HttpAdapterOptions {
  baseUrl: string;
  serviceToken: string;
  timeoutMs?: number;
}

export class HttpWebsiteAdapter implements WebsitePort {
  private base: string;
  private token: string;
  private timeoutMs: number;

  constructor(opts: HttpAdapterOptions) {
    this.base = opts.baseUrl.replace(/\/+$/, '');
    this.token = opts.serviceToken;
    this.timeoutMs = opts.timeoutMs ?? 10000;
  }

  private async call<T>(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    path: string,
    body?: unknown,
  ): Promise<{ status: number; data: T }> {
    let res;
    try {
      res = await request(`${this.base}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.token}`,
          'content-type': 'application/json',
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        headersTimeout: this.timeoutMs,
        bodyTimeout: this.timeoutMs,
      });
    } catch (e) {
      throw new WebsiteApiError(`Nettverksfeil mot ${method} ${path}: ${(e as Error).message}`);
    }
    const text = await res.body.text();
    let data: unknown = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }
    return { status: res.statusCode, data: data as T };
  }

  /** Mapper HTTP-status + body til typede feil. */
  private fail(status: number, data: unknown, ctx: string): never {
    const msg =
      (data && typeof data === 'object' && ((data as Record<string, unknown>).error || (data as Record<string, unknown>).feil)) ||
      `HTTP ${status}`;
    const feil = (data as Record<string, unknown> | null)?.feil;
    if (status === 404) throw new NotFoundError(String(msg));
    if (status === 409 && feil === 'fullt') throw new CapacityError();
    if (status === 409 && feil === 'stengt') throw new ClosedDayError();
    if (status === 400) throw new ValidationError(String(msg), data);
    throw new WebsiteApiError(`${ctx}: ${String(msg)}`, status, data);
  }

  // ---- LESE ----
  async listBookings(filter?: ListBookingsFilter): Promise<Booking[]> {
    const { status, data } = await this.call<Booking[]>('GET', '/api/bookings');
    if (status >= 400) this.fail(status, data, 'listBookings');
    let rows = (data ?? []).map((b) => ({ ...b, aktivitet_navn: (b as { aktivitet_navn?: string | null }).aktivitet_navn ?? null }));
    if (filter?.dato_fra) rows = rows.filter((b) => b.dato >= filter.dato_fra!);
    if (filter?.status) rows = rows.filter((b) => b.status === filter.status);
    return rows;
  }

  async getBooking(id: number): Promise<Booking | null> {
    const all = await this.listBookings();
    return all.find((b) => b.id === id) ?? null;
  }

  async getAvailabilitySlots(activity_id: number, dato: string): Promise<AvailabilitySlot[]> {
    const { status, data } = await this.call<AvailabilitySlot[]>(
      'GET',
      `/api/availability?activity_id=${activity_id}&dato=${encodeURIComponent(dato)}`,
    );
    if (status >= 400) this.fail(status, data, 'getAvailabilitySlots');
    return data ?? [];
  }

  async checkAvailability(activity_id: number, dato: string, tid: string | null = null): Promise<AvailabilityCheck> {
    // 1) stengt? closed_dates eller business_hours[ukedag].stengt (via /api/hours)
    const hours = await this.getOpeningHours();
    let stengt = hours.closed.some((c) => c.dato === dato);
    if (!stengt) {
      const uk = ukedagFraDato(dato);
      const bh = uk == null ? undefined : hours.hours.find((h) => h.ukedag === uk);
      if (bh && bh.stengt) stengt = true;
    }
    // 2) slot-kapasitet ellers aktivitetens kapasitet
    const slots = await this.getAvailabilitySlots(activity_id, dato);
    const slot = slots.find((s) => (tid == null ? true : s.tid === tid));
    let kapasitet: number;
    if (slot) {
      kapasitet = slot.kapasitet;
    } else {
      const akt = await this.getActivity(activity_id);
      kapasitet = akt ? akt.kapasitet : 0;
    }
    // 3) opptatt = SUM(antall) status in forespurt/bekreftet for (akt,dato,tid)
    const bookings = await this.listBookings({ dato_fra: dato });
    const opptatt = bookings
      .filter(
        (b) =>
          b.activity_id === activity_id &&
          b.dato === dato &&
          (tid == null ? true : (b.tid ?? null) === tid) &&
          (b.status === 'forespurt' || b.status === 'bekreftet'),
      )
      .reduce((s, b) => s + b.antall, 0);
    const ledig = Math.max(0, kapasitet - opptatt);
    return { activity_id, dato, tid: tid ?? null, kapasitet, opptatt, ledig, stengt };
  }

  async getOpeningHours(): Promise<OpeningHours> {
    const { status, data } = await this.call<OpeningHours>('GET', '/api/hours');
    if (status >= 400) this.fail(status, data, 'getOpeningHours');
    return {
      hours: (data?.hours ?? []).map((h) => ({ ...h, stengt: !!h.stengt })),
      closed: data?.closed ?? [],
    };
  }

  async listActivities(includeInactive = false): Promise<Activity[]> {
    const path = includeInactive ? '/api/activities/admin/all' : '/api/activities';
    const { status, data } = await this.call<Activity[]>('GET', path);
    if (status >= 400) this.fail(status, data, 'listActivities');
    return data ?? [];
  }

  async getActivity(id: number): Promise<Activity | null> {
    const { status, data } = await this.call<Activity>('GET', `/api/activities/${id}`);
    if (status === 404) return null;
    if (status >= 400) this.fail(status, data, 'getActivity');
    return data ?? null;
  }

  async listMessages(bruker_id: number): Promise<CustomerMessage[]> {
    const { status, data } = await this.call<{ meldinger: CustomerMessage[] }>(
      'GET',
      `/api/meldinger?bruker_id=${bruker_id}`,
    );
    if (status >= 400) this.fail(status, data, 'listMessages');
    return data?.meldinger ?? [];
  }

  async getMessageThread(bruker_id: number): Promise<MessageThread> {
    const { status, data } = await this.call<{ kunde?: MessageThread['kunde']; meldinger: CustomerMessage[] }>(
      'GET',
      `/api/meldinger?bruker_id=${bruker_id}`,
    );
    if (status >= 400) this.fail(status, data, 'getMessageThread');
    return { bruker_id, kunde: data?.kunde ?? null, meldinger: data?.meldinger ?? [] };
  }

  async getContent(): Promise<ContentEntry[]> {
    const { status, data } = await this.call<ContentEntry[]>('GET', '/api/admin/content');
    if (status >= 400) this.fail(status, data, 'getContent');
    return data ?? [];
  }

  async listStaffHours(filter?: { ansatt_id?: number }): Promise<StaffHourEntry[]> {
    const q = filter?.ansatt_id != null ? `?ansatt_id=${filter.ansatt_id}` : '';
    const { status, data } = await this.call<StaffHourEntry[]>('GET', `/api/regnskap/timer${q}`);
    if (status >= 400) this.fail(status, data, 'listStaffHours');
    return data ?? [];
  }

  async health(): Promise<{ ok: boolean; db: string }> {
    const { status, data } = await this.call<{ ok: boolean; db: string }>('GET', '/api/health');
    if (status >= 400 && status !== 503) this.fail(status, data, 'health');
    return data ?? { ok: false, db: 'down' };
  }

  // ---- SKRIVE ----
  async createBooking(input: CreateBookingInput): Promise<Booking> {
    const { status, data } = await this.call<{ booking: Booking }>('POST', '/api/bookings', {
      activity_id: input.activity_id,
      navn: input.navn,
      epost: input.epost,
      tlf: input.tlf ?? undefined,
      dato: input.dato,
      tid: input.tid ?? undefined,
      antall: input.antall,
      melding: input.melding ?? undefined,
    });
    if (status >= 400) this.fail(status, data, 'createBooking');
    return data.booking;
  }

  async updateBooking(_id: number, _patch: Partial<Pick<Booking, 'tlf' | 'melding' | 'antall'>>): Promise<Booking> {
    // Nettsiden har ingen generell felt-PATCH på bookings (kun status + refusjon).
    // Vi nekter heller enn å late som — agenten skal bruke set_booking_status.
    throw new ValidationError('Felt-endring av booking støttes ikke av nettsidens API. Bruk set_booking_status.');
  }

  async setBookingStatus(id: number, status: BookingStatus): Promise<Booking> {
    const { status: code, data } = await this.call<{ booking: Booking }>('PATCH', `/api/bookings/${id}`, { status });
    if (code >= 400) this.fail(code, data, 'setBookingStatus');
    return data.booking;
  }

  async setAvailability(input: SetAvailabilityInput): Promise<AvailabilitySlot[]> {
    const { status, data } = await this.call<AvailabilitySlot[]>('PUT', '/api/availability', {
      activity_id: input.activity_id,
      dato: input.dato,
      slots: input.slots,
    });
    if (status >= 400) this.fail(status, data, 'setAvailability');
    return data ?? [];
  }

  async setOpeningHours(input: SetOpeningHoursInput) {
    const { status, data } = await this.call<{ ukedag: number; apner: string | null; stenger: string | null; stengt: boolean }>(
      'PUT',
      `/api/hours/${input.ukedag}`,
      { apner: input.apner ?? undefined, stenger: input.stenger ?? undefined, stengt: input.stengt ?? false },
    );
    if (status >= 400) this.fail(status, data, 'setOpeningHours');
    return data;
  }

  async upsertActivity(input: UpsertActivityInput): Promise<Activity> {
    const payload = {
      slug: input.slug ?? undefined,
      navn: input.navn,
      beskrivelse: input.beskrivelse ?? undefined,
      varighet: input.varighet ?? undefined,
      pris: input.pris,
      kapasitet: input.kapasitet,
      bilde: input.bilde ?? undefined,
    };
    if (input.id != null) {
      const { status, data } = await this.call<Activity>('PUT', `/api/activities/${input.id}`, payload);
      if (status >= 400) this.fail(status, data, 'upsertActivity');
      return data;
    }
    const { status, data } = await this.call<Activity>('POST', '/api/activities', payload);
    if (status >= 400) this.fail(status, data, 'upsertActivity');
    return data;
  }

  async setActivityStatus(input: SetActivityStatusInput): Promise<{ id: number; aktiv: boolean }> {
    if (input.aktiv) {
      // Re-aktivering: nettsidens DELETE soft-deleter; aktivering går via PUT
      // (aktiv settes ikke direkte av PUT i dagens API). Hent + PUT samme felt.
      const akt = await this.getActivity(input.id);
      if (!akt) throw new NotFoundError('Aktivitet ikke funnet');
      // PUT bevarer ikke aktiv-flagget; nettsiden har ingen aktiver-rute.
      throw new ValidationError('Re-aktivering av aktivitet støttes ikke av nettsidens API ennå.');
    }
    const { status, data } = await this.call<{ ok: boolean; id: number }>('DELETE', `/api/activities/${input.id}`);
    if (status >= 400) this.fail(status, data, 'setActivityStatus');
    return { id: data.id, aktiv: false };
  }

  async replyToCustomer(input: ReplyToCustomerInput): Promise<CustomerMessage> {
    const { status, data } = await this.call<{ melding: CustomerMessage }>(
      'POST',
      `/api/meldinger?bruker_id=${input.bruker_id}`,
      { tekst: input.tekst, pris: input.pris ?? undefined },
    );
    if (status >= 400) this.fail(status, data, 'replyToCustomer');
    return data.melding;
  }

  async logStaffHours(input: LogStaffHoursInput): Promise<StaffHourEntry> {
    const { status, data } = await this.call<{ timeforing: StaffHourEntry }>('POST', '/api/regnskap/timer', {
      ansatt_id: input.ansatt_id,
      dato: input.dato,
      timer: input.timer,
      aktivitet: input.aktivitet ?? undefined,
      notat: input.notat ?? undefined,
    });
    if (status >= 400) this.fail(status, data, 'logStaffHours');
    return data.timeforing;
  }

  async updateSiteContent(input: UpdateSiteContentInput): Promise<ContentEntry> {
    const { status, data } = await this.call<ContentEntry>(
      'PUT',
      `/api/admin/content/${encodeURIComponent(input.nokkel)}`,
      { verdi: input.verdi },
    );
    if (status >= 400) this.fail(status, data, 'updateSiteContent');
    return data;
  }
}
