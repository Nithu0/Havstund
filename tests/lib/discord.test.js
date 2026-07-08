// describe/it/expect er globale (vitest.config.js -> globals: true).
// Tester lib/discord: bookingVarsel trunkerer lange felt-verdier saa Discord
// (embed field value maks 1024 tegn) ikke svarer 400 og taper hele varselet.
// Vi mocker global fetch for aa fange payloaden webhooken sender.
// MERK: lib/discord bygger WEBHOOKS som modul-niva const ved require-tid, saa
// env MAA settes FOR modulen lastes. Vi setter env + vi.resetModules() og
// re-require-er inne i beforeEach slik at WEBHOOKS.general faktisk peker paa
// test-webhooken (ellers returnerer postWebhook tidlig og fetch kalles aldri).
let discord;

describe('lib/discord - bookingVarsel felt-trunkering', () => {
  const ekteFetch = global.fetch;
  let sistePayload;

  beforeEach(() => {
    sistePayload = null;
    process.env.DISCORD_WEBHOOK_GENERAL = 'https://discord.test/webhook';
    global.fetch = async (_url, opts) => {
      sistePayload = JSON.parse(opts.body);
      return { ok: true, status: 204 };
    };
    vi.resetModules();
    discord = require('../../lib/discord');
  });
  afterEach(() => {
    global.fetch = ekteFetch;
    delete process.env.DISCORD_WEBHOOK_GENERAL;
  });

  it('trunkerer melding til <=1024 tegn (Discord field value-grense)', async () => {
    const langMelding = 'x'.repeat(5000);
    await discord.bookingVarsel(
      {
        id: 1, navn: 'Ola', tlf: '123', epost: 'ola@test.no',
        dato: '2026-07-01', antall: 2, melding: langMelding,
      },
      'Fisketur',
    );
    expect(sistePayload).not.toBeNull();
    const felter = sistePayload.embeds[0].fields;
    // INGEN felt-verdi over grensen.
    for (const f of felter) {
      expect(f.value.length).toBeLessThanOrEqual(1024);
    }
    const meldingFelt = felter.find((f) => /Melding/.test(f.name));
    expect(meldingFelt.value.length).toBe(1024); // 1021 + '...'
    expect(meldingFelt.value.endsWith('...')).toBe(true);
  });

  it('korte verdier sendes uendret, tom verdi blir "-"', async () => {
    await discord.bookingVarsel(
      {
        id: 2, navn: 'Kari', tlf: '', epost: 'kari@test.no',
        dato: '2026-07-02', antall: 1, melding: 'Kort melding',
      },
      'Keramikk',
    );
    const felter = sistePayload.embeds[0].fields;
    const meldingFelt = felter.find((f) => /Melding/.test(f.name));
    expect(meldingFelt.value).toBe('Kort melding');
    const tlfFelt = felter.find((f) => /Telefon/.test(f.name));
    expect(tlfFelt.value).toBe('-'); // tom -> '-'
  });
});
