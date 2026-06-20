/* ============================================================
   Havstund — plattform-server (Railway-klar)
   - Serverer offentlig nettside + intern dashboard fra /public
   - Auto-laster REST-ruter fra /routes  -> /api/<filnavn>
   - Auto-laster Socket.IO-handlere fra /realtime
   - Lytter på process.env.PORT
   ============================================================ */
require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const cookieParser = require('cookie-parser');
const { Server } = require('socket.io');

const db = require('./db');
const { authOptional } = require('./lib/auth');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.set('io', io);

const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(cookieParser());
app.use(authOptional); // setter req.user hvis innlogget (valgfritt)

// Helsesjekk for Railway
app.get('/api/health', (_req, res) => res.json({ ok: true, db: db.isConfigured() }));

// ---- Auto-last REST-ruter: routes/foo.js -> /api/foo ----
const routesDir = path.join(__dirname, 'routes');
if (fs.existsSync(routesDir)) {
  for (const f of fs.readdirSync(routesDir).filter((f) => f.endsWith('.js'))) {
    const name = f.replace(/\.js$/, '');
    try {
      app.use('/api/' + name, require(path.join(routesDir, f)));
      console.log('  ✓ rute  /api/' + name);
    } catch (e) {
      console.error('  ✗ kunne ikke laste rute ' + f + ':', e.message);
    }
  }
}

// ---- Auto-last Socket.IO-handlere: realtime/*.js (exporterer function(io)) ----
const rtDir = path.join(__dirname, 'realtime');
if (fs.existsSync(rtDir)) {
  for (const f of fs.readdirSync(rtDir).filter((f) => f.endsWith('.js'))) {
    try {
      require(path.join(rtDir, f))(io);
      console.log('  ✓ realtime ' + f);
    } catch (e) {
      console.error('  ✗ kunne ikke laste realtime ' + f + ':', e.message);
    }
  }
}

// ---- Statiske filer (offentlig side + intern shell) ----
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

// Fallback: alle ikke-API GET-ruter -> forsiden
app.get(/^\/(?!api).*/, (_req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'index.html'))
);

// ---- Oppstart: init DB (skjema + seed) deretter lytt ----
db.init().finally(() =>
  server.listen(PORT, () => console.log(`\nHavstund kjører på port ${PORT}\n`))
);
