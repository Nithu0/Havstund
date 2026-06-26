/**
 * Havstund Brain — pino-logger. Stille i test (level 'silent') med mindre
 * LOG_LEVEL er satt eksplisitt.
 */
import { pino } from 'pino';

const inTest = process.env.VITEST === 'true' || process.env.NODE_ENV === 'test';
const level = process.env.LOG_LEVEL || (inTest ? 'silent' : 'info');

export const logger = pino({ level });

export type Logger = typeof logger;
