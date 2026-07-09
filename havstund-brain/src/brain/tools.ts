/**
 * Havstund Brain — verktøykatalog (agentens "fulle tilgang = allowlisten").
 *
 * Ingen shell/fs/git/MCP. Kun katalogiserte verktøy som mapper 1:1 mot
 * WebsitePort-metoder, som igjen mapper mot nettsidens FAKTISKE ruter:
 *
 *  LESE (auto-kjør, muterer aldri):
 *    list_bookings        GET  /api/bookings(/agenda)
 *    get_booking          GET  /api/bookings/:id  (klient-side filtrering)
 *    check_availability   GET  /api/availability + /api/hours (kapasitet+stengt)
 *    get_opening_hours    GET  /api/hours
 *    list_activities      GET  /api/activities(/admin/all)
 *    get_activity         GET  /api/activities/:id
 *    list_messages        GET  /api/meldinger?bruker_id=
 *    get_message_thread   GET  /api/meldinger?bruker_id=
 *    get_content          GET  /api/admin/content
 *    list_staff_hours     GET  /api/regnskap/timer
 *
 *  SKRIVE (krever bekreftelse; strict:true + additionalProperties:false):
 *    create_booking       POST   /api/bookings           (idempotency_key)
 *    update_booking       (felt-patch på booking)        (expected_updated_at)
 *    set_booking_status   PATCH  /api/bookings/:id        (expected_status)
 *    set_availability     PUT    /api/availability        (idempotent slett-og-sett)
 *    set_opening_hours    PUT    /api/hours/:ukedag
 *    upsert_activity      POST/PUT /api/activities        (idempotency_key|expected_updated_at)
 *    set_activity_status  DELETE/PUT /api/activities/:id
 *    reply_to_customer    POST   /api/meldinger?bruker_id= (idempotency_key)
 *    log_staff_hours      POST   /api/regnskap/timer      (idempotency_key)
 *    opprett_regnskapspost POST  /api/regnskap/poster     (idempotency_key)
 *    update_site_content  PUT    /api/admin/content/:nokkel (expected_version)
 *
 * MERK: strict:true garanterer kun at JSON-Schema følges (type/required/enum).
 * Harde grenser (antall<=kapasitet, pris>=0, timer<=24, gyldig statusovergang,
 * stale-write) håndheves i confirm-revalideringen — ikke her. (Design §6.)
 */

export type ToolKind = 'read' | 'write';
export type ToolDomain = 'booking' | 'timesheet' | 'calendar' | 'customer' | 'content' | 'finance';

export interface BrainToolDef {
  name: string;
  kind: ToolKind;
  domain: ToolDomain;
  description: string;
  input_schema: Record<string, unknown>;
  /** Bare på skrive-verktøy: hvilken nøkkel idempotens/stale-vakt bruker. */
  guard?: 'idempotency_key' | 'expected_updated_at' | 'expected_version' | 'expected_status';
}

const DATE = '^\\d{4}-\\d{2}-\\d{2}$'; // YYYY-MM-DD

// ---------- LESE-verktøy ----------
const READ_TOOLS: BrainToolDef[] = [
  {
    name: 'list_bookings',
    kind: 'read',
    domain: 'booking',
    description:
      'List bookinger. Valgfritt filter på dato (fra og med) og status. Bruk dette før du foreslår noe rundt en booking.',
    input_schema: {
      type: 'object',
      properties: {
        dato_fra: { type: 'string', description: 'YYYY-MM-DD — kun bookinger fra og med denne datoen' },
        status: { type: 'string', enum: ['forespurt', 'bekreftet', 'avlyst', 'fullfort'] },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'get_booking',
    kind: 'read',
    domain: 'booking',
    description: 'Hent én booking på id.',
    input_schema: {
      type: 'object',
      properties: { id: { type: 'integer' } },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'check_availability',
    kind: 'read',
    domain: 'calendar',
    description:
      'Sjekk ledig kapasitet for en aktivitet på en dato/tid. KALL ALLTID dette før du foreslår create_booking. Rapporterer kapasitet, opptatt, ledig og om dagen er stengt.',
    input_schema: {
      type: 'object',
      properties: {
        activity_id: { type: 'integer' },
        dato: { type: 'string', pattern: DATE },
        tid: { type: 'string', description: 'F.eks. "10:00". Utelat for hele dagen.' },
      },
      required: ['activity_id', 'dato'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_opening_hours',
    kind: 'read',
    domain: 'calendar',
    description: 'Hent faste åpningstider (per ukedag) og kommende stengte datoer.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'list_activities',
    kind: 'read',
    domain: 'content',
    description: 'List aktiviteter. include_inactive=true tar med soft-deletede.',
    input_schema: {
      type: 'object',
      properties: { include_inactive: { type: 'boolean' } },
      additionalProperties: false,
    },
  },
  {
    name: 'get_activity',
    kind: 'read',
    domain: 'content',
    description: 'Hent én aktivitet på id (pris, kapasitet, beskrivelse).',
    input_schema: {
      type: 'object',
      properties: { id: { type: 'integer' } },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_messages',
    kind: 'read',
    domain: 'customer',
    description: 'List meldingene i en kundes tråd (bruker_id).',
    input_schema: {
      type: 'object',
      properties: { bruker_id: { type: 'integer' } },
      required: ['bruker_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_message_thread',
    kind: 'read',
    domain: 'customer',
    description: 'Hent hele meldingstråden + kundeinfo for en bruker_id.',
    input_schema: {
      type: 'object',
      properties: { bruker_id: { type: 'integer' } },
      required: ['bruker_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_content',
    kind: 'read',
    domain: 'content',
    description: 'Hent alle CMS-innholdsnøkler og verdier.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'list_staff_hours',
    kind: 'read',
    domain: 'timesheet',
    description: 'List registrerte timeføringer. Valgfritt filter på ansatt_id.',
    input_schema: {
      type: 'object',
      properties: { ansatt_id: { type: 'integer' } },
      additionalProperties: false,
    },
  },
];

// ---------- SKRIVE-verktøy (strict + additionalProperties:false) ----------
const WRITE_TOOLS: BrainToolDef[] = [
  {
    name: 'create_booking',
    kind: 'write',
    domain: 'booking',
    guard: 'idempotency_key',
    description:
      'Opprett en ny booking (status blir alltid "forespurt"). Sjekk check_availability først. Krever idempotency_key så bekreftelse 2× ikke gir 2 bookinger.',
    input_schema: {
      type: 'object',
      strict: true,
      properties: {
        activity_id: { type: 'integer' },
        navn: { type: 'string' },
        epost: { type: 'string' },
        tlf: { type: ['string', 'null'] },
        dato: { type: 'string', pattern: DATE },
        tid: { type: ['string', 'null'] },
        antall: { type: 'integer' },
        melding: { type: ['string', 'null'] },
        idempotency_key: { type: 'string' },
      },
      required: ['activity_id', 'navn', 'epost', 'dato', 'antall', 'idempotency_key'],
      additionalProperties: false,
    },
  },
  {
    name: 'update_booking',
    kind: 'write',
    domain: 'booking',
    guard: 'expected_updated_at',
    description:
      'Oppdater redigerbare felt på en booking (tlf, melding, antall). Status endres med set_booking_status. expected_updated_at vokter mot stale-write.',
    input_schema: {
      type: 'object',
      strict: true,
      properties: {
        id: { type: 'integer' },
        tlf: { type: ['string', 'null'] },
        melding: { type: ['string', 'null'] },
        antall: { type: 'integer' },
        expected_updated_at: { type: 'string' },
      },
      required: ['id', 'expected_updated_at'],
      additionalProperties: false,
    },
  },
  {
    name: 'set_booking_status',
    kind: 'write',
    domain: 'booking',
    guard: 'expected_status',
    description:
      'Sett ny status på en booking. expected_status er statusen du leste — confirm avviser hvis den er endret (stale-write/gyldig overgang).',
    input_schema: {
      type: 'object',
      strict: true,
      properties: {
        id: { type: 'integer' },
        status: { type: 'string', enum: ['forespurt', 'bekreftet', 'avlyst', 'fullfort'] },
        expected_status: { type: 'string', enum: ['forespurt', 'bekreftet', 'avlyst', 'fullfort'] },
      },
      required: ['id', 'status', 'expected_status'],
      additionalProperties: false,
    },
  },
  {
    name: 'set_availability',
    kind: 'write',
    domain: 'calendar',
    guard: 'idempotency_key',
    description:
      'Erstatt alle slots for (activity_id, dato) — slett-og-sett, idempotent. idempotency_key kreves.',
    input_schema: {
      type: 'object',
      strict: true,
      properties: {
        activity_id: { type: 'integer' },
        dato: { type: 'string', pattern: DATE },
        slots: {
          type: 'array',
          items: {
            type: 'object',
            properties: { tid: { type: 'string' }, kapasitet: { type: 'integer' } },
            required: ['tid', 'kapasitet'],
            additionalProperties: false,
          },
        },
        idempotency_key: { type: 'string' },
      },
      required: ['activity_id', 'dato', 'slots', 'idempotency_key'],
      additionalProperties: false,
    },
  },
  {
    name: 'set_opening_hours',
    kind: 'write',
    domain: 'calendar',
    guard: 'idempotency_key',
    description: 'Sett åpner/stenger/stengt for én ukedag (0=mandag .. 6=søndag).',
    input_schema: {
      type: 'object',
      strict: true,
      properties: {
        ukedag: { type: 'integer' },
        apner: { type: ['string', 'null'] },
        stenger: { type: ['string', 'null'] },
        stengt: { type: 'boolean' },
        idempotency_key: { type: 'string' },
      },
      required: ['ukedag', 'idempotency_key'],
      additionalProperties: false,
    },
  },
  {
    name: 'upsert_activity',
    kind: 'write',
    domain: 'content',
    guard: 'idempotency_key',
    description:
      'Opprett (uten id, krever slug) eller oppdater (med id) en aktivitet. pris og kapasitet er heltall >= 0 (håndheves i confirm).',
    input_schema: {
      type: 'object',
      strict: true,
      properties: {
        id: { type: ['integer', 'null'] },
        slug: { type: ['string', 'null'] },
        navn: { type: 'string' },
        beskrivelse: { type: ['string', 'null'] },
        varighet: { type: ['string', 'null'] },
        pris: { type: 'integer' },
        kapasitet: { type: 'integer' },
        bilde: { type: ['string', 'null'] },
        idempotency_key: { type: 'string' },
      },
      required: ['navn', 'pris', 'kapasitet', 'idempotency_key'],
      additionalProperties: false,
    },
  },
  {
    name: 'set_activity_status',
    kind: 'write',
    domain: 'content',
    guard: 'idempotency_key',
    description: 'Aktiver (aktiv=true) eller soft-delete (aktiv=false) en aktivitet.',
    input_schema: {
      type: 'object',
      strict: true,
      properties: {
        id: { type: 'integer' },
        aktiv: { type: 'boolean' },
        idempotency_key: { type: 'string' },
      },
      required: ['id', 'aktiv', 'idempotency_key'],
      additionalProperties: false,
    },
  },
  {
    name: 'reply_to_customer',
    kind: 'write',
    domain: 'customer',
    guard: 'idempotency_key',
    description:
      'Send et svar til en kunde i meldingstråden. Valgfri pris (tilbud). idempotency_key hindrer dobbel sending.',
    input_schema: {
      type: 'object',
      strict: true,
      properties: {
        bruker_id: { type: 'integer' },
        tekst: { type: 'string' },
        pris: { type: ['integer', 'null'] },
        idempotency_key: { type: 'string' },
      },
      required: ['bruker_id', 'tekst', 'idempotency_key'],
      additionalProperties: false,
    },
  },
  {
    name: 'log_staff_hours',
    kind: 'write',
    domain: 'timesheet',
    guard: 'idempotency_key',
    description:
      'Registrer timer for en ansatt (0 < timer <= 24, håndheves i confirm). idempotency_key kreves.',
    input_schema: {
      type: 'object',
      strict: true,
      properties: {
        ansatt_id: { type: 'integer' },
        dato: { type: 'string', pattern: DATE },
        timer: { type: 'number' },
        aktivitet: { type: ['string', 'null'] },
        notat: { type: ['string', 'null'] },
        idempotency_key: { type: 'string' },
      },
      required: ['ansatt_id', 'dato', 'timer', 'idempotency_key'],
      additionalProperties: false,
    },
  },
  {
    name: 'opprett_regnskapspost',
    kind: 'write',
    domain: 'finance',
    guard: 'idempotency_key',
    description:
      'Opprett en regnskapspost (utgift) fra et kvitteringsbilde. Du LESER beløp, dato og ' +
      'leverandør ut av bildet og FORESLÅR konto + mva-sats — men du beregner ALDRI mva eller ' +
      'totaler selv. Oppgi brutto (det bekreftede beløpet som står på kvitteringen) i øre; ' +
      'systemet regner ut netto og mva fra brutto og valgt sats. idempotency_key hindrer at ' +
      'en dobbel bekreftelse posterer bilaget to ganger.',
    input_schema: {
      type: 'object',
      strict: true,
      properties: {
        type: { type: 'string', enum: ['utgift'] },
        dato: { type: 'string', pattern: DATE },
        beskrivelse: { type: 'string' },
        konto: { type: 'integer' },
        mva_sats: { type: 'integer', enum: [0, 12, 15, 25] },
        brutto_ore: { type: 'integer' },
        betalingsmetode: { type: 'string', enum: ['bank', 'kort', 'kontant'] },
        idempotency_key: { type: 'string' },
      },
      required: ['dato', 'beskrivelse', 'konto', 'mva_sats', 'brutto_ore', 'idempotency_key'],
      additionalProperties: false,
    },
  },
  {
    name: 'update_site_content',
    kind: 'write',
    domain: 'content',
    guard: 'expected_version',
    description:
      'Sett en CMS-innholdsnøkkel. expected_version er "oppdatert"-tidsstempelet du leste — confirm avviser ved stale-write.',
    input_schema: {
      type: 'object',
      strict: true,
      properties: {
        nokkel: { type: 'string' },
        verdi: { type: 'string' },
        expected_version: { type: ['string', 'null'] },
      },
      required: ['nokkel', 'verdi'],
      additionalProperties: false,
    },
  },
];

export const ALL_TOOLS: BrainToolDef[] = [...READ_TOOLS, ...WRITE_TOOLS];

const BY_NAME = new Map(ALL_TOOLS.map((t) => [t.name, t]));

export function getTool(name: string): BrainToolDef | undefined {
  return BY_NAME.get(name);
}

export function isWriteTool(name: string): boolean {
  return BY_NAME.get(name)?.kind === 'write';
}

export function isReadTool(name: string): boolean {
  return BY_NAME.get(name)?.kind === 'read';
}

export const READ_TOOL_NAMES = READ_TOOLS.map((t) => t.name);
export const WRITE_TOOL_NAMES = WRITE_TOOLS.map((t) => t.name);

/** Verktøy-definisjoner i Anthropic-format (name/description/input_schema). */
export function toolsForApi(): Array<{ name: string; description: string; input_schema: Record<string, unknown> }> {
  return ALL_TOOLS.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema }));
}
