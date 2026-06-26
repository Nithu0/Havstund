/* Havstund — CSV-eksport (/api/export).
   Kun ansatt/admin. Hand-rullet CSV (ingen ny dep).
   GET /bookings?format=csv   -> alle bookinger som CSV
   GET /omsetning?format=csv  -> omsetning per aktivitet (LEFT JOIN activities) som CSV */
const express = require('express');
const db = require('../db');
const { requireRole } = require('../lib/auth');

const router = express.Router();

// Escaper ett CSV-felt: pakk i doble fnutter om det inneholder komma, fnutt,
// linjeskift eller CR; doble fnutter inne i feltet dobles (RFC 4180).
function csvFelt(verdi) {
  if (verdi == null) return '';
  const s = String(verdi);
  if (/[",\r\n]/.test(s)) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

// Bygger en CSV-streng av en header-rad + datarader. Bruker CRLF (RFC 4180).
function csvSerialiser(headers, rader) {
  const linjer = [headers.map(csvFelt).join(',')];
  for (const rad of rader) {
    linjer.push(rad.map(csvFelt).join(','));
  }
  return linjer.join('\r\n');
}

// Setter CSV-headere + sender. BOM gjør at Excel leser UTF-8 (æøå) riktig.
function sendCsv(res, filnavn, csv) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filnavn}"`);
  res.send('﻿' + csv);
}

// ---- GET /bookings?format=csv : alle bookinger ----
router.get('/bookings', requireRole('ansatt', 'admin'), async (req, res) => {
  if (!db.isConfigured()) {
    return res.status(503).json({ error: 'Database ikke tilgjengelig' });
  }
  if ((req.query.format || 'csv') !== 'csv') {
    return res.status(400).json({ error: 'Kun format=csv støttes' });
  }

  try {
    const { rows } = await db.query(
      `SELECT b.id, b.dato, b.tid, a.navn AS aktivitet, b.navn, b.epost, b.tlf,
              b.antall, b.belop, b.status, b.opprettet
         FROM bookings b
         LEFT JOIN activities a ON a.id = b.activity_id
        ORDER BY b.opprettet DESC`,
      []
    );

    const headers = [
      'id', 'dato', 'tid', 'aktivitet', 'navn', 'epost', 'tlf',
      'antall', 'belop', 'status', 'opprettet',
    ];
    const data = rows.map((r) => [
      r.id, r.dato, r.tid, r.aktivitet, r.navn, r.epost, r.tlf,
      r.antall, r.belop, r.status, r.opprettet,
    ]);

    sendCsv(res, 'bookinger.csv', csvSerialiser(headers, data));
  } catch (e) {
    console.error('export GET /bookings feilet:', e.message);
    res.status(500).json({ error: 'Kunne ikke eksportere bookinger' });
  }
});

// ---- GET /omsetning?format=csv : omsetning per aktivitet ----
// LEFT JOIN activities slik at bookinger uten matchende aktivitet (NULL) tas med.
router.get('/omsetning', requireRole('ansatt', 'admin'), async (req, res) => {
  if (!db.isConfigured()) {
    return res.status(503).json({ error: 'Database ikke tilgjengelig' });
  }
  if ((req.query.format || 'csv') !== 'csv') {
    return res.status(400).json({ error: 'Kun format=csv støttes' });
  }

  try {
    const { rows } = await db.query(
      `SELECT a.navn AS aktivitet,
              COUNT(b.id)                  AS antall_bookinger,
              COALESCE(SUM(b.antall), 0)   AS antall_personer,
              COALESCE(SUM(b.belop), 0)    AS omsetning
         FROM bookings b
         LEFT JOIN activities a ON a.id = b.activity_id
        GROUP BY a.navn
        ORDER BY omsetning DESC`,
      []
    );

    const headers = ['aktivitet', 'antall_bookinger', 'antall_personer', 'omsetning'];
    const data = rows.map((r) => [
      r.aktivitet == null ? '(ukjent aktivitet)' : r.aktivitet,
      r.antall_bookinger,
      r.antall_personer,
      r.omsetning,
    ]);

    sendCsv(res, 'omsetning.csv', csvSerialiser(headers, data));
  } catch (e) {
    console.error('export GET /omsetning feilet:', e.message);
    res.status(500).json({ error: 'Kunne ikke eksportere omsetning' });
  }
});

module.exports = router;
