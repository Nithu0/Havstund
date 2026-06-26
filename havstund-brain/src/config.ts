/**
 * Havstund Brain — konfig med zod fail-fast.
 *
 * loadConfig() leser process.env og kaster med en lesbar feilmelding hvis noe
 * påkrevd mangler/er feil — ved oppstart, ikke midt i en request. Tester kan
 * sende inn et eksplisitt env-objekt for å unngå avhengighet av prosess-env.
 */
import { z } from 'zod';

const schema = z.object({
  ANTHROPIC_API_KEY: z.string().min(8, 'ANTHROPIC_API_KEY må være satt'),
  ANTHROPIC_MODEL: z.string().default('claude-opus-4-8'),

  WEBSITE_BASE_URL: z.string().url('WEBSITE_BASE_URL må være en gyldig URL'),
  WEBSITE_SERVICE_TOKEN: z.string().min(16, 'WEBSITE_SERVICE_TOKEN må være minst 16 tegn'),

  BRAIN_OPERATOR_TOKEN: z.string().min(16, 'BRAIN_OPERATOR_TOKEN må være minst 16 tegn'),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL må være satt'),

  PORT: z.coerce.number().int().positive().default(4000),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'silent']).default('info'),

  CONFIRM_TTL_MIN: z.coerce.number().int().positive().default(15),
  BRAIN_ALLOW_WRITES: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Ugyldig konfig (sjekk .env mot .env.example):\n${issues}`);
  }
  return parsed.data;
}
