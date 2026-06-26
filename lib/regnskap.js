/* Havstund — regnskaps-hjelpere.
   Ren MVA-splitt, trukket ut fra routes/bookings.js så pengelogikken er testbar.

   I dag er all booking-inntekt 25 % MVA (Fiken-kode 3). Funksjonen tar likevel
   imot en sats slik at en fremtidig per-aktivitet-MVA (se docs/VEIKART.md, Fase 3)
   kan gjenbruke den uten å endre kallstedet.

   Alle beløp er i ØRE (heltall), slik regnskap_poster lagrer dem. */

const GYLDIGE_SATSER = [0, 12, 15, 25];

/**
 * Splitt et bruttobeløp (i øre) i netto + mva (i øre) for en gitt MVA-sats (prosent).
 * Brutto bevares eksakt: netto = round(brutto / (1 + sats/100)), mva = brutto - netto.
 * @param {number} brutto_ore  Bruttobeløp i øre (heltall >= 0)
 * @param {number} sats        MVA-sats i prosent (0 | 12 | 15 | 25). Default 25.
 * @returns {{ netto_ore: number, mva_ore: number, brutto_ore: number, mva_sats: number }}
 */
function mvaSplitt(brutto_ore, sats = 25) {
  if (!Number.isFinite(brutto_ore) || brutto_ore < 0) {
    throw new Error('mvaSplitt: brutto_ore må være et tall >= 0');
  }
  if (!GYLDIGE_SATSER.includes(sats)) {
    throw new Error(`mvaSplitt: ugyldig MVA-sats ${sats} (gyldige: ${GYLDIGE_SATSER.join(', ')})`);
  }
  const brutto = Math.round(brutto_ore);
  const netto_ore = Math.round(brutto / (1 + sats / 100));
  const mva_ore = brutto - netto_ore;
  return { netto_ore, mva_ore, brutto_ore: brutto, mva_sats: sats };
}

module.exports = { mvaSplitt, GYLDIGE_SATSER };
