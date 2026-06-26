/**
 * Kjører WebsitePort-kontrakten mot MockWebsiteAdapter (alltid i CI).
 * HttpWebsiteAdapter kjøres mot samme kontrakt i test/contract-live.test.ts
 * (nightly, bak env-flagg) — bevis på fake↔ekte-paritet.
 */
import { runPortContract } from './port-contract.js';
import { MockWebsiteAdapter } from '../src/adapters/mock-website-adapter.js';
import type { MockSeed } from '../src/adapters/mock-website-adapter.js';

export const baseSeed: MockSeed = {
  activities: [
    { id: 1, slug: 'fisketur', navn: 'Fisketur', beskrivelse: null, varighet: '3t', pris: 500, kapasitet: 3, bilde: null, aktiv: true, sortering: 0 },
    { id: 2, slug: 'rorbu', navn: 'Rorbu-overnatting', beskrivelse: null, varighet: null, pris: 1500, kapasitet: 4, bilde: null, aktiv: true, sortering: 1 },
  ],
  availability: [
    { id: 1, activity_id: 1, dato: '2026-07-01', tid: '10:00', kapasitet: 3 },
  ],
  bookings: [],
  businessHours: [
    { ukedag: 0, apner: '09:00', stenger: '17:00', stengt: false },
    { ukedag: 1, apner: '09:00', stenger: '17:00', stengt: false },
    { ukedag: 2, apner: '09:00', stenger: '17:00', stengt: false },
  ],
  closedDates: [{ dato: '2026-12-25', grunn: '1. juledag' }],
  messages: [],
  content: [{ nokkel: 'forside.ingress', verdi: 'Opplev Lofoten', oppdatert: '2026-06-01T00:00:00Z' }],
  staffHours: [],
  users: [{ id: 1, navn: 'Kari Kunde', epost: 'kari@example.com', rolle: 'kunde' }],
};

runPortContract('MockWebsiteAdapter', {
  makePort: () => new MockWebsiteAdapter(baseSeed),
});
