/**
 * Havstund Brain — port-typer.
 *
 * Disse typene speiler nettsidens FAKTISKE datamodell (db/schema.sql) og
 * REST-svar. De er bevisst smale: kun det agenten trenger for å lese tilstand
 * og foreslå skriving. Endres bare når nettsidens kontrakt endres.
 *
 * Domene-noter (norsk i DB):
 *  - booking.status: 'forespurt' | 'bekreftet' | 'avlyst' | 'fullfort'
 *  - business_hours.ukedag: 0=mandag .. 6=sondag
 */

export type BookingStatus = 'forespurt' | 'bekreftet' | 'avlyst' | 'fullfort';

export interface Booking {
  id: number;
  activity_id: number | null;
  bruker_id: number | null;
  navn: string;
  epost: string;
  tlf: string | null;
  dato: string; // YYYY-MM-DD
  tid: string | null;
  antall: number;
  status: BookingStatus;
  belop: number;
  melding: string | null;
  aktivitet_navn?: string | null;
}

export interface Activity {
  id: number;
  slug: string;
  navn: string;
  beskrivelse: string | null;
  varighet: string | null;
  pris: number;
  kapasitet: number;
  bilde: string | null;
  aktiv?: boolean;
  sortering?: number;
}

export interface AvailabilitySlot {
  id: number;
  activity_id: number;
  dato: string;
  tid: string;
  kapasitet: number;
}

/** Avledet kapasitet for en (activity_id, dato, tid). Brain bruker dette
 *  før booking. Hard sannhet — ALDRI fra minne-laget. */
export interface AvailabilityCheck {
  activity_id: number;
  dato: string;
  tid: string | null;
  kapasitet: number; // total plasser for slotten
  opptatt: number; // sum antall i forespurt+bekreftet
  ledig: number; // kapasitet - opptatt (kan ikke gå under 0)
  stengt: boolean; // closed_dates eller business_hours.stengt
}

export interface BusinessHour {
  ukedag: number; // 0=mandag .. 6=sondag
  apner: string | null;
  stenger: string | null;
  stengt: boolean;
}

export interface ClosedDate {
  dato: string;
  grunn: string | null;
}

export interface OpeningHours {
  hours: BusinessHour[];
  closed: ClosedDate[];
}

export interface CustomerMessage {
  id: number;
  bruker_id: number;
  avsender: 'kunde' | 'admin' | 'ai' | 'ansatt';
  tekst: string;
  pris: number | null;
  lest: boolean;
  opprettet: string;
}

export interface MessageThread {
  bruker_id: number;
  kunde?: { id: number; navn: string; epost: string; rolle: string } | null;
  meldinger: CustomerMessage[];
}

export interface ContentEntry {
  nokkel: string;
  verdi: string | null;
  oppdatert: string;
}

export interface StaffHourEntry {
  id: number;
  ansatt_id: number;
  ansatt_navn?: string;
  dato: string;
  timer: number;
  aktivitet: string | null;
  notat: string | null;
}

/** Sunnhetsstatus fra nettsidens /api/health (db.ping). */
export interface WebsiteHealth {
  ok: boolean;
  db: string;
}

// ---- Skrive-input (det /confirm sender til porten) ----

export interface CreateBookingInput {
  activity_id: number;
  navn: string;
  epost: string;
  tlf?: string | null;
  dato: string;
  tid?: string | null;
  antall: number;
  melding?: string | null;
}

export interface UpdateBookingStatusInput {
  id: number;
  status: BookingStatus;
}

export interface SetAvailabilityInput {
  activity_id: number;
  dato: string;
  slots: Array<{ tid: string; kapasitet: number }>;
}

export interface SetOpeningHoursInput {
  ukedag: number;
  apner?: string | null;
  stenger?: string | null;
  stengt?: boolean;
}

export interface UpsertActivityInput {
  id?: number; // satt => oppdater, ellers opprett
  slug?: string;
  navn: string;
  beskrivelse?: string | null;
  varighet?: string | null;
  pris: number;
  kapasitet: number;
  bilde?: string | null;
}

export interface SetActivityStatusInput {
  id: number;
  aktiv: boolean;
}

export interface ReplyToCustomerInput {
  bruker_id: number;
  tekst: string;
  pris?: number | null;
}

export interface LogStaffHoursInput {
  ansatt_id: number;
  dato: string;
  timer: number;
  aktivitet?: string | null;
  notat?: string | null;
}

export interface UpdateSiteContentInput {
  nokkel: string;
  verdi: string;
}
