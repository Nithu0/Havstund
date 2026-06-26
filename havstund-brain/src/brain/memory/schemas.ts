/**
 * Havstund Brain — domene-schema for minne-laget (lessons).
 *
 * Hvert domene har EGNE lovlige lesson-typer og EGET payload-schema. Dette er
 * grunnlaget for maskinhåndhevet domene-separasjon (design §7): writeLesson
 * avviser en lesson hvis (a) typen ikke hører hjemme i domenet, eller (b)
 * payload ikke validerer mot domenets schema.
 *
 * VIKTIG: minne-laget bærer ERFARING, ALDRI fersk tilstand. assertNoHardState
 * (i write-lesson.ts) blokkerer felter som hører hjemme i Postgres (bookingStatus,
 * hoursLogged, ledige plasser, ...). Schemaene under inneholder bevisst INGEN
 * slike felter.
 */
import { z } from 'zod';
import type { LessonDomain } from '../store.js';

// Felles: en lesson beskriver en preferanse/korreksjon/mønster — ikke et faktum.
const baseFields = {
  note: z.string().min(1).max(2000),
};

// booking: preferanser rundt hvordan bookinger håndteres (ikke status på en konkret).
const bookingPayload = z.object({
  ...baseFields,
  preferred_followup_hours: z.number().int().min(0).max(168).optional(),
});

// timesheet: mønstre rundt timeføring (f.eks. "Per fører sjelden helg").
const timesheetPayload = z.object({
  ...baseFields,
  ansatt_id: z.number().int().positive().optional(),
});

// calendar: preferanser rundt åpningstid/slots ("vi stenger ofte tidlig i storm").
const calendarPayload = z.object({
  ...baseFields,
  weekday: z.number().int().min(0).max(6).optional(),
});

// customer: kundepreferanser/-profiler ("liker korte svar", "snakker engelsk").
const customerPayload = z.object({
  ...baseFields,
  language: z.string().min(2).max(20).optional(),
  tone: z.enum(['kort', 'utfyllende', 'formell', 'uformell']).optional(),
});

// global: tverrgående arbeidsregler.
const globalPayload = z.object({ ...baseFields });

export const DOMAIN_TYPES: Record<LessonDomain, readonly string[]> = {
  booking: ['preference', 'correction', 'pattern'],
  timesheet: ['preference', 'correction', 'pattern'],
  calendar: ['preference', 'correction', 'pattern'],
  customer: ['preference', 'correction', 'profile'],
  global: ['preference', 'correction', 'pattern'],
};

export const DOMAIN_PAYLOAD: Record<LessonDomain, z.ZodTypeAny> = {
  booking: bookingPayload,
  timesheet: timesheetPayload,
  calendar: calendarPayload,
  customer: customerPayload,
  global: globalPayload,
};

/** Felter som ALDRI får bo i minnet — de er fersk tilstand (Postgres = sannhet). */
export const FORBIDDEN_HARD_STATE_KEYS = [
  'status',
  'bookingstatus',
  'booking_status',
  'belop',
  'pris',
  'kapasitet',
  'ledig',
  'opptatt',
  'antall',
  'hourslogged',
  'hours_logged',
  'timer',
  'saldo',
  'balance',
  'betalt',
  'lest',
];
