# Havstund Brain

Pluggbar AI-agent med lærings-hjerne for Havstund-plattformen. Egen prosess,
eget npm-package, snakker med nettsidens REST-API over en service-token.
**Av/på utenfor nettsidens hot path** — når den ikke kjører, finnes den ikke for
nettsiden.

Full arkitektur: `../docs/AI-BRAIN-DESIGN.md`. Bygge-ordre: `../docs/AI-BRAIN-BUILD-ORDER.md`.

## Hva den gjør

En utvalgt admin chatter med agenten inne i intranettet. Agenten:

1. **Leser** tilstand fra nettsiden (bookinger, kapasitet, åpningstider,
   aktiviteter, kunde-meldinger, innhold, timelister) — lese-verktøy kjøres
   automatisk, de muterer aldri.
2. **Foreslår** en skriving (opprett booking, svar kunde, endre innhold, …) og
   **stopper**. Ingenting skrives før admin trykker «Send».
3. På `/confirm`: re-validerer mot fersk DB (kapasitet, statusovergang,
   stale-write, idempotens) → utfører ÉN skriving → skriver audit.
4. **Lærer** fra admin-korreksjoner (egen `lessons`-tabell, 4 isolerte domener)
   uten å rote til kalender eller blande timeliste.

## Sikkerhet / skuddsikkerhet

- Ingen shell/fs/git/MCP. Kun katalogiserte verktøy (allowlisten = full tilgang).
- Skrive-verktøy krever et HMAC-bekreftelses-handshake; forfalsket token avvises.
- Idempotens-nøkkel hindrer at confirm 2× gir 2 bookinger.
- Minne-laget bærer aldri fersk tilstand (`assertNoHardState`) → kan ikke bli stale.
- Secrets (`ANTHROPIC_API_KEY`, service-token, operatør-token) kun server-side.

## Kommandoer

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # vitest run (ingen ekte Claude — scriptet stub)
npm run lint
npm run build       # tsc -> dist/
npm start           # node dist/index.js (krever ekte env)
```

## Miljø

Kopier `.env.example` → `.env`. `src/config.ts` feiler raskt (zod) hvis noe
påkrevd mangler. **Aldri commit `.env` eller en ekte API-nøkkel.**

## Modell

`claude-opus-4-8`, `thinking:{type:'adaptive'}`, `output_config:{effort:'high'}`,
`@anthropic-ai/sdk`. Manuell tool-loop (ikke auto tool_runner) — det er det som
gjør foreslå-før-skriv mulig.
