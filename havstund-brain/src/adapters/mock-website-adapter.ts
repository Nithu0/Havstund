/**
 * Havstund Brain — MockWebsiteAdapter (in-memory).
 *
 * Speiler nettsidens FAKTISKE regler så agent-/kontrakt-tester er realistiske:
 *  - kapasitet: availability-rad hvis finnes, ellers activity.kapasitet;
 *    opptatt = SUM(antall) for status in ('forespurt','bekreftet').
 *  - stengt: closed_dates ELLER business_hours[ukedag].stengt (ukedag 0=man..6=søn).
 *  - booking opprettes alltid med status 'forespurt'.
 *  - setAvailability er slett-og-sett for (activity_id, dato).
 *
 * Brukes KUN i test og som referanse-implementasjon for kontrakt-testen.
 */
import {
  CapacityError,
  ClosedDayError,
  NotFoundError,
  ValidationError,
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
  BusinessHour,
  ClosedDate,
} from '../port/types.js';

const STATUSER: BookingStatus[] = ['forespurt', 'bekreftet', 'avlyst', 'fullfort'];

function ukedagFraDato(dato: string): number | null {
  const d = new Date(`${dato}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  return (d.getUTCDay() + 6) % 7; // 0=mandag..6=søndag
}

export interface MockSeed {
  activities?: Activity[];
  availability?: AvailabilitySlot[];
  bookings?: Booking[];
  businessHours?: BusinessHour[];
  closedDates?: ClosedDate[];
  messages?: CustomerMessage[];
  content?: ContentEntry[];
  staffHours?: StaffHourEntry[];
  users?: Array<{ id: number; navn: string; epost: string; rolle: string }>;
}

export class MockWebsiteAdapter implements WebsitePort {
  activities: Activity[];
  availability: AvailabilitySlot[];
  bookings: Booking[];
  businessHours: BusinessHour[];
  closedDates: ClosedDate[];
  messages: CustomerMessage[];
  content: ContentEntry[];
  staffHours: StaffHourEntry[];
  users: Array<{ id: number; navn: string; epost: string; rolle: string }>;

  private seq = { booking: 0, slot: 0, message: 0, activity: 0, staffHour: 0 };

  constructor(seed: MockSeed = {}) {
    this.activities = (seed.activities ?? []).map((a) => ({ ...a }));
    this.availability = (seed.availability ?? []).map((a) => ({ ...a }));
    this.bookings = (seed.bookings ?? []).map((b) => ({ ...b }));
    this.businessHours = (seed.businessHours ?? []).map((b) => ({ ...b }));
    this.closedDates = (seed.closedDates ?? []).map((c) => ({ ...c }));
    this.messages = (seed.messages ?? []).map((m) => ({ ...m }));
    this.content = (seed.content ?? []).map((c) => ({ ...c }));
    this.staffHours = (seed.staffHours ?? []).map((s) => ({ ...s }));
    this.users = (seed.users ?? []).map((u) => ({ ...u }));

    this.seq.booking = Math.max(0, ...this.bookings.map((b) => b.id));
    this.seq.slot = Math.max(0, ...this.availability.map((s) => s.id));
    this.seq.message = Math.max(0, ...this.messages.map((m) => m.id));
    this.seq.activity = Math.max(0, ...this.activities.map((a) => a.id));
    this.seq.staffHour = Math.max(0, ...this.staffHours.map((s) => s.id));
  }

  // ---- LESE ----
  async listBookings(filter?: ListBookingsFilter): Promise<Booking[]> {
    let rows = this.bookings.slice();
    if (filter?.dato_fra) rows = rows.filter((b) => b.dato >= filter.dato_fra!);
    if (filter?.status) rows = rows.filter((b) => b.status === filter.status);
    return rows
      .sort((a, b) => (a.dato < b.dato ? -1 : a.dato > b.dato ? 1 : a.id - b.id))
      .map((b) => ({ ...b, aktivitet_navn: this.activities.find((a) => a.id === b.activity_id)?.navn ?? null }));
  }

  async getBooking(id: number): Promise<Booking | null> {
    const b = this.bookings.find((x) => x.id === id);
    return b ? { ...b, aktivitet_navn: this.activities.find((a) => a.id === b.activity_id)?.navn ?? null } : null;
  }

  private kapasitetFor(activity_id: number, dato: string, tid: string | null): number | null {
    const slot = this.availability.find(
      (s) => s.activity_id === activity_id && s.dato === dato && s.tid === (tid ?? s.tid) && (tid == null || s.tid === tid),
    );
    if (slot) return slot.kapasitet;
    const akt = this.activities.find((a) => a.id === activity_id);
    return akt ? akt.kapasitet : null;
  }

  private erStengt(dato: string): boolean {
    if (this.closedDates.some((c) => c.dato === dato)) return true;
    const uk = ukedagFraDato(dato);
    if (uk == null) return false;
    const bh = this.businessHours.find((h) => h.ukedag === uk);
    return !!(bh && bh.stengt);
  }

  async checkAvailability(activity_id: number, dato: string, tid: string | null = null): Promise<AvailabilityCheck> {
    const stengt = this.erStengt(dato);
    const kap = this.kapasitetFor(activity_id, dato, tid);
    const opptatt = this.bookings
      .filter(
        (b) =>
          b.activity_id === activity_id &&
          b.dato === dato &&
          (b.tid ?? null) === (tid ?? null) &&
          (b.status === 'forespurt' || b.status === 'bekreftet'),
      )
      .reduce((s, b) => s + b.antall, 0);
    const kapasitet = kap ?? 0;
    const ledig = Math.max(0, kapasitet - opptatt);
    return { activity_id, dato, tid: tid ?? null, kapasitet, opptatt, ledig, stengt };
  }

  async getAvailabilitySlots(activity_id: number, dato: string): Promise<AvailabilitySlot[]> {
    return this.availability
      .filter((s) => s.activity_id === activity_id && s.dato === dato)
      .map((s) => ({ ...s }));
  }

  async getOpeningHours(): Promise<OpeningHours> {
    return {
      hours: this.businessHours.map((h) => ({ ...h })).sort((a, b) => a.ukedag - b.ukedag),
      closed: this.closedDates.map((c) => ({ ...c })).sort((a, b) => (a.dato < b.dato ? -1 : 1)),
    };
  }

  async listActivities(includeInactive = false): Promise<Activity[]> {
    return this.activities
      .filter((a) => includeInactive || a.aktiv !== false)
      .map((a) => ({ ...a }))
      .sort((a, b) => (a.sortering ?? 0) - (b.sortering ?? 0));
  }

  async getActivity(id: number): Promise<Activity | null> {
    const a = this.activities.find((x) => x.id === id);
    return a ? { ...a } : null;
  }

  async listMessages(bruker_id: number): Promise<CustomerMessage[]> {
    return this.messages
      .filter((m) => m.bruker_id === bruker_id)
      .map((m) => ({ ...m }))
      .sort((a, b) => a.id - b.id);
  }

  async getMessageThread(bruker_id: number): Promise<MessageThread> {
    const kunde = this.users.find((u) => u.id === bruker_id) ?? null;
    return { bruker_id, kunde, meldinger: await this.listMessages(bruker_id) };
  }

  async getContent(): Promise<ContentEntry[]> {
    return this.content.map((c) => ({ ...c })).sort((a, b) => (a.nokkel < b.nokkel ? -1 : 1));
  }

  async listStaffHours(filter?: { ansatt_id?: number }): Promise<StaffHourEntry[]> {
    let rows = this.staffHours.slice();
    if (filter?.ansatt_id != null) rows = rows.filter((s) => s.ansatt_id === filter.ansatt_id);
    return rows.map((s) => ({ ...s }));
  }

  async health(): Promise<{ ok: boolean; db: string }> {
    return { ok: true, db: 'up' };
  }

  // ---- SKRIVE ----
  async createBooking(input: CreateBookingInput): Promise<Booking> {
    const akt = this.activities.find((a) => a.id === input.activity_id && a.aktiv !== false);
    if (!akt) throw new NotFoundError('Aktivitet ikke funnet');
    if (this.erStengt(input.dato)) throw new ClosedDayError();
    const antall = input.antall;
    if (!Number.isInteger(antall) || antall < 1) throw new ValidationError('Antall må være minst 1');
    const check = await this.checkAvailability(input.activity_id, input.dato, input.tid ?? null);
    if (check.opptatt + antall > check.kapasitet) throw new CapacityError();

    const id = ++this.seq.booking;
    const booking: Booking = {
      id,
      activity_id: input.activity_id,
      bruker_id: null,
      navn: input.navn,
      epost: input.epost,
      tlf: input.tlf ?? null,
      dato: input.dato,
      tid: input.tid ?? null,
      antall,
      status: 'forespurt',
      belop: antall * akt.pris,
      melding: input.melding ?? null,
    };
    this.bookings.push(booking);
    return { ...booking };
  }

  async updateBooking(id: number, patch: Partial<Pick<Booking, 'tlf' | 'melding' | 'antall'>>): Promise<Booking> {
    const b = this.bookings.find((x) => x.id === id);
    if (!b) throw new NotFoundError('Booking ikke funnet');
    if (patch.tlf !== undefined) b.tlf = patch.tlf;
    if (patch.melding !== undefined) b.melding = patch.melding;
    if (patch.antall !== undefined) {
      if (!Number.isInteger(patch.antall) || patch.antall < 1) throw new ValidationError('Antall må være minst 1');
      b.antall = patch.antall;
    }
    return { ...b };
  }

  async setBookingStatus(id: number, status: BookingStatus): Promise<Booking> {
    if (!STATUSER.includes(status)) throw new ValidationError('Ugyldig status');
    const b = this.bookings.find((x) => x.id === id);
    if (!b) throw new NotFoundError('Booking ikke funnet');
    b.status = status;
    return { ...b };
  }

  async setAvailability(input: SetAvailabilityInput): Promise<AvailabilitySlot[]> {
    if (!this.activities.some((a) => a.id === input.activity_id)) throw new ValidationError('ukjent activity_id');
    this.availability = this.availability.filter(
      (s) => !(s.activity_id === input.activity_id && s.dato === input.dato),
    );
    const out: AvailabilitySlot[] = [];
    for (const s of input.slots) {
      const slot: AvailabilitySlot = {
        id: ++this.seq.slot,
        activity_id: input.activity_id,
        dato: input.dato,
        tid: s.tid,
        kapasitet: s.kapasitet,
      };
      this.availability.push(slot);
      out.push({ ...slot });
    }
    return out;
  }

  async setOpeningHours(input: SetOpeningHoursInput) {
    let bh = this.businessHours.find((h) => h.ukedag === input.ukedag);
    if (!bh) {
      bh = { ukedag: input.ukedag, apner: null, stenger: null, stengt: false };
      this.businessHours.push(bh);
    }
    if (input.apner !== undefined) bh.apner = input.apner;
    if (input.stenger !== undefined) bh.stenger = input.stenger;
    if (input.stengt !== undefined) bh.stengt = !!input.stengt;
    return { ukedag: bh.ukedag, apner: bh.apner, stenger: bh.stenger, stengt: bh.stengt };
  }

  async upsertActivity(input: UpsertActivityInput): Promise<Activity> {
    if (input.id != null) {
      const a = this.activities.find((x) => x.id === input.id);
      if (!a) throw new NotFoundError('Aktivitet ikke funnet');
      a.navn = input.navn;
      a.pris = input.pris;
      a.kapasitet = input.kapasitet;
      if (input.slug !== undefined) a.slug = input.slug ?? a.slug;
      if (input.beskrivelse !== undefined) a.beskrivelse = input.beskrivelse ?? null;
      if (input.varighet !== undefined) a.varighet = input.varighet ?? null;
      if (input.bilde !== undefined) a.bilde = input.bilde ?? null;
      return { ...a };
    }
    if (!input.slug) throw new ValidationError('slug er påkrevd ved oppretting');
    const a: Activity = {
      id: ++this.seq.activity,
      slug: input.slug,
      navn: input.navn,
      beskrivelse: input.beskrivelse ?? null,
      varighet: input.varighet ?? null,
      pris: input.pris,
      kapasitet: input.kapasitet,
      bilde: input.bilde ?? null,
      aktiv: true,
      sortering: 0,
    };
    this.activities.push(a);
    return { ...a };
  }

  async setActivityStatus(input: SetActivityStatusInput): Promise<{ id: number; aktiv: boolean }> {
    const a = this.activities.find((x) => x.id === input.id);
    if (!a) throw new NotFoundError('Aktivitet ikke funnet');
    a.aktiv = input.aktiv;
    return { id: a.id, aktiv: a.aktiv };
  }

  async replyToCustomer(input: ReplyToCustomerInput): Promise<CustomerMessage> {
    if (!this.users.some((u) => u.id === input.bruker_id)) throw new NotFoundError('Kunde ikke funnet');
    const tekst = String(input.tekst || '').trim();
    if (!tekst) throw new ValidationError('Melding kan ikke være tom');
    const msg: CustomerMessage = {
      id: ++this.seq.message,
      bruker_id: input.bruker_id,
      avsender: 'admin',
      tekst,
      pris: input.pris ?? null,
      lest: false,
      opprettet: new Date().toISOString(),
    };
    this.messages.push(msg);
    return { ...msg };
  }

  async logStaffHours(input: LogStaffHoursInput): Promise<StaffHourEntry> {
    if (!Number.isInteger(input.ansatt_id)) throw new ValidationError('Velg en ansatt');
    if (!(input.timer > 0 && input.timer <= 24)) throw new ValidationError('Ugyldig timetall');
    const e: StaffHourEntry = {
      id: ++this.seq.staffHour,
      ansatt_id: input.ansatt_id,
      dato: input.dato,
      timer: input.timer,
      aktivitet: input.aktivitet ?? null,
      notat: input.notat ?? null,
    };
    this.staffHours.push(e);
    return { ...e };
  }

  async updateSiteContent(input: UpdateSiteContentInput): Promise<ContentEntry> {
    let row = this.content.find((c) => c.nokkel === input.nokkel);
    if (!row) {
      row = { nokkel: input.nokkel, verdi: input.verdi, oppdatert: new Date().toISOString() };
      this.content.push(row);
    } else {
      row.verdi = input.verdi;
      row.oppdatert = new Date().toISOString();
    }
    return { ...row };
  }
}
