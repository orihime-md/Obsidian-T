  import express from 'express';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  startPairing, getPairingState, allSessions, restoreSavedSessions
} from './wpp-manager.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

// (7) FAIL CLOSED: /api/* is 503 unless AUTH_TOKEN is set.
// ALLOW_OPEN_API=true is the explicit local-dev opt-out.
const AUTH_TOKEN = () => String(process.env.AUTH_TOKEN || '');
const OPEN_ALLOWED = () => String(process.env.ALLOW_OPEN_API || '').toLowerCase() === 'true';

function tokenMatches(supplied) {
  const expected = AUTH_TOKEN();
  const a = Buffer.from(String(supplied || ''), 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// pairing rate limit (per IP)
const PAIR_WINDOW_MS = 60_000;
const PAIR_MAX = 5;
const pairHits = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [ip, hits] of pairHits) {
    const fresh = hits.filter((t) => now - t < PAIR_WINDOW_MS);
    if (fresh.length) pairHits.set(ip, fresh); else pairHits.delete(ip);
  }
}, 60_000).unref?.();

app.use(express.json());

// (4) explicit deny BEFORE static — tokens & server source are unreachable
const DENY_RE = /(?:^|\/)(?:tokens|node_modules)(?:\/|$)|(?:^|\/)(?:server|wpp-manager)\.(?:js|mjs)$|\.env$/i;
app.use((req, res, next) => {
  let p = String(req.path || '').replace(/\\/g, '/');
  try { p = decodeURIComponent(p); } catch {}
  if (DENY_RE.test(p)) return res.status(404).end();
  next();
});

app.use(express.static(__dirname));

// (7) auth gate — /health and static stay open; everything under /api is gated
app.use('/api', (req, res, next) => {
  if (req.method === 'OPTIONS') return next();
  if (!AUTH_TOKEN() && !OPEN_ALLOWED()) {
    return res.status(503).json({ ok: false, error: 'Server authentication is not configured (AUTH_TOKEN missing).' });
  }
  if (!AUTH_TOKEN()) return next(); // explicit dev opt-out
  if (tokenMatches(req.get('x-obsidian-token'))) return next();
  return res.status(401).json({ ok: false, error: 'Invalid or missing access token.' });
});

const normalize = (v) => String(v || '').replace(/\D/g, '');

app.get('/health', (req, res) => {
  const list = allSessions();
  res.set('Cache-Control', 'no-store');
  res.json({
    ok: true,
    linked: list.filter((s) => s.status === 'open').length,
    total: list.length
  });
});

app.post('/api/pair', async (req, res) => {
  res.set('Cache-Control', 'no-store');

  const ip = req.ip || 'unknown';
  const now = Date.now();
  const hits = (pairHits.get(ip) || []).filter((t) => now - t < PAIR_WINDOW_MS);
  hits.push(now);
  pairHits.set(ip, hits);
  if (hits.length > PAIR_MAX) {
    return res.status(429).json({ ok: false, error: 'Too many pairing requests. Wait a minute.' });
  }

  const number = normalize(req.body?.number);
  if (!/^\d{10,15}$/.test(number)) {
    return res.status(400).json({ ok: false, error: 'Enter a valid number with country code.' });
  }

  try {
    const { session } = await startPairing(number);
    // (3) a 200 from here ALWAYS means a real code (or already open)
    return res.json({ ok: true, number, code: session.code, status: session.status });
  } catch (e) {
    return res.status(e.statusCode || 500).json({ ok: false, error: e.message || 'Pairing failed.' });
  }
});

// (8) auth-gated (middleware above) — the only endpoint that may carry a code
app.get('/api/pair/status', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const s = await getPairingState(normalize(req.query.number));
  if (!s) return res.status(404).json({ ok: false, error: 'Pairing session not found (expired — request a new code).' });
  return res.json({ ok: true, ...s });
});

// (8) auth-gated, safe projection only: number / status / pairedAt
app.get('/api/sessions', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ ok: true, sessions: allSessions() });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🌑 OBSIDIAN T online on port ${PORT}`);
  if (!AUTH_TOKEN() && !OPEN_ALLOWED()) {
    console.warn('⚠️ AUTH_TOKEN not set — /api/* is returning 503. Set AUTH_TOKEN in Render.');
  } else if (!AUTH_TOKEN()) {
    console.warn('⚠️ ALLOW_OPEN_API=true — API is open (local dev mode). Never use this in production.');
  }
  restoreSavedSessions().catch((e) => console.warn('restore failed:', e?.message || e));
  keepAlive();
});

function keepAlive() {
  const base = process.env.RENDER_EXTERNAL_URL;
  if (!base) return;
  setInterval(async () => {
    try {
      const r = await fetch(`${base.replace(/\/$/, '')}/health?k=${Date.now()}`, { cache: 'no-store' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      console.log('🫀 heartbeat ok');
    } catch (e) {
      console.warn('⚠️ heartbeat failed:', e?.message || e);
    }
  }, 5 * 60 * 1000).unref?.();
}
