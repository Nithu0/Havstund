/**
 * Havstund Brain — typede port-feil.
 *
 * Porten kaster disse i stedet for rå HTTP-feil, slik at agent-loopen kan
 * mappe dem til `tool_result { is_error: true }` (jf. design §8) i stedet for
 * å la en exception velte hele requesten. Re-valideringen i /confirm bruker
 * de samme klassene for harde grenser.
 */

export class PortError extends Error {
  readonly code: string;
  readonly status?: number;
  readonly details?: unknown;
  constructor(code: string, message: string, opts?: { status?: number; details?: unknown }) {
    super(message);
    this.name = 'PortError';
    this.code = code;
    if (opts?.status !== undefined) this.status = opts.status;
    if (opts?.details !== undefined) this.details = opts.details;
  }
}

/** Nettsiden svarte 4xx/5xx, eller nettverksfeil mot REST-API. */
export class WebsiteApiError extends PortError {
  constructor(message: string, status?: number, details?: unknown) {
    super('website_api_error', message, { status, details });
    this.name = 'WebsiteApiError';
  }
}

/** Ressurs ikke funnet (404 fra nettsiden). */
export class NotFoundError extends PortError {
  constructor(message = 'Ikke funnet') {
    super('not_found', message, { status: 404 });
    this.name = 'NotFoundError';
  }
}

/** Kapasitet sprengt / overbooking (409 'fullt'). */
export class CapacityError extends PortError {
  constructor(message = 'Ingen ledige plasser') {
    super('capacity', message, { status: 409 });
    this.name = 'CapacityError';
  }
}

/** Stengt dag (409 'stengt'). */
export class ClosedDayError extends PortError {
  constructor(message = 'Stengt den datoen') {
    super('closed_day', message, { status: 409 });
    this.name = 'ClosedDayError';
  }
}

/** Ugyldig input fanget i revalidering (harde grenser strict ikke dekker). */
export class ValidationError extends PortError {
  constructor(message: string, details?: unknown) {
    super('validation', message, { status: 400, details });
    this.name = 'ValidationError';
  }
}

/** Stale-write: forventet versjon/tidsstempel matcher ikke fersk DB. */
export class StaleWriteError extends PortError {
  constructor(message = 'Raden er endret siden forslaget ble laget') {
    super('stale_write', message, { status: 409 });
    this.name = 'StaleWriteError';
  }
}
