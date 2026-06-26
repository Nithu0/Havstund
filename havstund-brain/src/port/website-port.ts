/**
 * Havstund Brain — WebsitePort: den abstrakte kontrakten mot nettsiden.
 *
 * Agenten (`brain/agent.ts`) kjenner KUN dette grensesnittet — ikke Express,
 * ikke pg, ikke undici. To implementasjoner består SAMME kontrakt-test:
 *   - MockWebsiteAdapter (in-memory, for raske deterministiske tester)
 *   - HttpWebsiteAdapter (ekte REST mot nettsiden, service-token)
 *
 * LESE-metoder muterer ikke. SKRIVE-metoder kalles KUN av /confirm etter
 * re-validering — agenten kaller dem aldri direkte i lese-loopen.
 */
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
  WebsiteHealth,
} from './types.js';

export interface ListBookingsFilter {
  dato_fra?: string;
  status?: BookingStatus;
}

export interface WebsitePort {
  // ---- LESE (muterer aldri) ----
  listBookings(filter?: ListBookingsFilter): Promise<Booking[]>;
  getBooking(id: number): Promise<Booking | null>;
  checkAvailability(activity_id: number, dato: string, tid?: string | null): Promise<AvailabilityCheck>;
  getOpeningHours(): Promise<OpeningHours>;
  listActivities(includeInactive?: boolean): Promise<Activity[]>;
  getActivity(id: number): Promise<Activity | null>;
  listMessages(bruker_id: number): Promise<CustomerMessage[]>;
  getMessageThread(bruker_id: number): Promise<MessageThread>;
  getContent(): Promise<ContentEntry[]>;
  listStaffHours(filter?: { ansatt_id?: number }): Promise<StaffHourEntry[]>;
  getAvailabilitySlots(activity_id: number, dato: string): Promise<AvailabilitySlot[]>;
  health(): Promise<WebsiteHealth>;

  // ---- SKRIVE (kun via /confirm, etter revalidering) ----
  createBooking(input: CreateBookingInput): Promise<Booking>;
  updateBooking(id: number, patch: Partial<Pick<Booking, 'tlf' | 'melding' | 'antall'>>): Promise<Booking>;
  setBookingStatus(id: number, status: BookingStatus): Promise<Booking>;
  setAvailability(input: SetAvailabilityInput): Promise<AvailabilitySlot[]>;
  setOpeningHours(input: SetOpeningHoursInput): Promise<{ ukedag: number; apner: string | null; stenger: string | null; stengt: boolean }>;
  upsertActivity(input: UpsertActivityInput): Promise<Activity>;
  setActivityStatus(input: SetActivityStatusInput): Promise<{ id: number; aktiv: boolean }>;
  replyToCustomer(input: ReplyToCustomerInput): Promise<CustomerMessage>;
  logStaffHours(input: LogStaffHoursInput): Promise<StaffHourEntry>;
  updateSiteContent(input: UpdateSiteContentInput): Promise<ContentEntry>;
}
