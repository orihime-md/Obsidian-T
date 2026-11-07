  import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const TOKEN_DIR = process.env.WPP_TOKEN_DIR || path.join(__dirname, 'tokens');

// (1) validated + clamped — a bad env value can never disable the limit
const MAX_SESSIONS = Math.min(5, Math.max(1, Math.trunc(Number(process.env.MAX_SESSIONS) || 2) || 2));

const OWNER_NUMBER = String(process.env.OWNER_NUMBER || '').replace(/\D/g, '');
const PREFIX = '.';
const VERSION = '1.0.2';
const BOOT_TIME = Date.now();

const PAIR_CODE_WAIT_MS = 25_000;
const GLOBAL_COOLDOWN_MS = 30_000;
const TARGET_COOLDOWN_MS = 12 * 60 * 60 * 1000;

const lastDanAt = { value: 0 };
const targetLastReport = new Map();

// sessionId -> { id, number, client, status, pairing, pairedAt, code, codeAt }
//   status: 'linking' | 'open' | 'down' | 'failed'  (all but linking/open free a slot)
const sessions = new Map();
let wppApiPromise = null;

// (2) strict FIFO pairing lock — only one Chromium handshake at a time
let lockChain = Promise.resolve();
function withLock(fn) {
  const run = lockChain.then(fn, fn);
  lockChain = run.catch(() => {});
  return run;
}

const normalize = (v) => {
  let d = String(v || '').replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  return d;
};

// (4) an ACTIVE session occupies a slot; down/failed do not
const activeCount = () =>
  [...sessions.values()].filter((s) => s.status === 'open' || s.status === 'linking').length;

function getWppApi() {
  if (!wppApiPromise) {
    wppApiPromise = import('@wppconnect-team/wppconnect').then((m) => {
      const api = m.default && typeof m.default.create === 'function' ? m.default : m;
      if (typeof api.create !== 'function') throw new Error('wppconnect create() not found');
      return api;
    });
  }
  return wppApiPromise;
}

function uptime() {
  const s = Math.floor((Date.now() - BOOT_TIME) / 1000);
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

const MENU_TEXT = () => `
╭━━━ ◈ 𝐎𝐁𝐒𝐈𝐃𝐈𝐀𝐍 𝐓 ◈ ━━━╮
      𝐒𝐲𝐬𝐭𝐞𝐦

👑 Owner : ${OWNER_NUMBER ? '+' + OWNER_NUMBER : '—'}
🤖 Bot   : OBSIDIAN T
⚡ Status : ONLINE
⌁ Prefix : .
◈ Version: ${VERSION}
☽ Uptime : ${uptime()}
🔗 Clan  : ${countOpen()}/${sessions.size} numbers

📋 𝐂𝐨𝐦𝐦𝐚𝐧𝐝𝐬

> .menu            — this card
> .status          — clan status (public)
> .numbers         — roster (owner only)
> .dan <number>    — strike from all numbers

example: .dan 234xxxxxxxxxx
╰━━━━━━━━━━━━━━━━━━╯`.trim();

const countOpen = () => [...sessions.values()].filter((s) => s.status === 'open').length;
const countActive = () => activeCount();

// (5) OWNER_NUMBER now authorizes commands, not just report targets
function isOwnerMsg(msg) {
  if (!OWNER_NUMBER) return false;
  const from = normalize(String(msg?.from || '').split('@')[0]);
  return from === OWNER_NUMBER;
}

// ── .dan fan-out ─────────────────────────────────────────────────────────
async function reportFromOneSession(session, phone) {
  return session.client.page.evaluate(async (phoneNumber) => {
    const c = window.WPP?.contact;
    if (typeof c?.reportContact !== 'function') {
      return { ok: false, error: 'reportContact unavailable' };
    }
    let wid = `${phoneNumber}@c.us`;
    if (typeof c.queryWidExists === 'function') {
      const resolved = await c.queryWidExists(wid);
      if (!resolved?.wid) return { ok: false, error: 'contact not found on WhatsApp' };
      wid = resolved.wid;
    }
    try {
      const resp = await c.reportContact(wid, 'ChatInfoReport');
      if (!resp || resp.errorCode || resp.errorText) {
        return { ok: false, error: resp?.errorText || 'report returned no result' };
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e?.message || e) };
    }
  }, phone);
}

export async function reportFromAllSessions(phone) {
  if (Date.now() - lastDanAt.value < GLOBAL_COOLDOWN_MS) {
    return `⏱️ Global cooldown. Try again in ${Math.ceil((GLOBAL_COOLDOWN_MS - (Date.now() - lastDanAt.value)) / 1000)}s.`;
  }
  if (OWNER_NUMBER && phone === OWNER_NUMBER) return '❌ You cannot report the owner number.';

  const last = targetLastReport.get(phone) || 0;
  if (Date.now() - last < TARGET_COOLDOWN_MS) {
    const hrs = Math.ceil((TARGET_COOLDOWN_MS - (Date.now() - last)) / 3600000);
    return `❄️ +${phone} was already reported. ~${hrs}h left.`;
  }

  const open = [...sessions.values()].filter((s) => s.status === 'open' && s.client);
  if (!open.length) return '⚠️ No linked numbers are connected right now.';

  lastDanAt.value = Date.now();
  let success = 0;
  const failLines = [];

  for (const s of open) {
    if (s.status !== 'open') break; // client died mid-fan-out
    try {
      const r = await reportFromOneSession(s, phone);
      if (r.ok) success++;
      else failLines.push(`+${s.number}: ${r.error}`);
    } catch (e) {
      failLines.push(`+${s.number}: ${e?.message || e}`);
    }
    await new Promise((r) => setTimeout(r, 1500));
  }

  if (success > 0) targetLastReport.set(phone, Date.now());
  return [
    `🚩 *OBSIDIAN T REPORT* — +${phone}`,
    `⚔️ Reported from ${success}/${open.length} linked number(s).`,
    ...(success === 0 ? ['❌ All reports failed:', ...failLines.slice(0, 3)] : [])
  ].join('\n');
}

// ── COMMANDS — attached to EVERY session (new + restored) ─────────────────
function attachCommands(session) {
  session.client.onMessage(async (msg) => {
    try {
      const text = String(msg?.body || '').trim();
      if (!text.startsWith(PREFIX)) return;

      const [rawCmd, ...args] = text.slice(1).trim().split(/\s+/);
      const cmd = rawCmd.toLowerCase();
      const reply = (t) => session.client.sendText(msg.from, t).catch(() => {});
      const target = normalize(args[0]);

      if (cmd === 'menu' || cmd === 'help') return reply(MENU_TEXT());

      // (5) .status is public but AGGREGATE only — no numbers leak
      if (cmd === 'status') {
        return reply(
          `◈ 𝐎𝐁𝐒𝐈𝐃𝐈𝐀𝐍 𝐓\n` +
          `⚡ Bot: ONLINE (${uptime()})\n` +
          `🔗 Clan: ${countOpen()} bound / ${countActive()} active / ${sessions.size} known`
        );
      }

      // (5) .numbers is owner-only
      if (cmd === 'numbers') {
        if (!isOwnerMsg(msg)) return reply('🔒 Owner only.');
        const lines = [...sessions.values()].map(
          (s) => `> +${s.number} — ${s.status === 'open' ? '🟢 connected' : '🔴 ' + s.status}`
        );
        return reply(`◈ 𝐂𝐋𝐀𝐍 𝐑𝐎𝐒𝐓𝐄𝐑 (${countOpen()}/${sessions.size})\n\n${lines.join('\n') || '> none yet'}`);
      }

      // (6) kept by design — this is the bot's purpose
      if (cmd === 'dan') {
        if (target.length < 10 || target.length > 15) {
          return reply('Use: .dan 234xxxxxxxxxx (full country code, digits only)');
        }
        await reply('⚔️ Reporting from all linked numbers… standby.');
        return reply(await reportFromAllSessions(target));
      }
      const compact = /^dan(\d{10,15})$/.exec(cmd);
      if (compact) {
        await reply('⚔️ Reporting from all linked numbers… standby.');
        return reply(await reportFromAllSessions(compact[1]));
      }
    } catch (e) {
      console.error(`💬 [${session.number}] command error:`, e?.message || e);
    }
  });
}

// ── CLIENT LIFECYCLE ─────────────────────────────────────────────────────
async function killSession(record, { wipeTokens = false } = {}) {
  if (!record) return;
  sessions.delete(record.number);
  try { await record.client?.close(); } catch {}
  if (wipeTokens) {
    await fs.rm(path.join(TOKEN_DIR, record.number), { recursive: true, force: true }).catch(() => {});
  }
}

function buildStatusFind(record) {
  return (status) => {
    if (sessions.get(record.number) !== record) return; // replaced already
    console.log(`🔌 [${record.number}] ${status}`);
    if (status === 'isLogged' || status === 'inChat') {
      record.status = 'open';
      record.pairing = false;
      record.pairedAt = record.pairedAt || Date.now();
    } else if (status === 'notLogged') {
      if (record.status !== 'open') {
        // saved credentials no longer authenticate — wipe the dead weight
        record.status = 'failed';
        void killSession(record, { wipeTokens: true }); // (4)
      }
    } else if (status === 'desconnectedMobile' || status === 'disconnectedMobile') {
      record.status = 'failed';
      void killSession(record, { wipeTokens: true }); // (4) free slot + kill Chromium
    }
  };
}

async function buildClient(record, { phoneNumber = null } = {}) {
  const api = await getWppApi();
  await fs.mkdir(TOKEN_DIR, { recursive: true });

  const options = {
    session: record.number,
    folderNameToken: TOKEN_DIR,
    headless: true,
    logQR: false,
    autoClose: 0,
    disableWelcome: true,
    updatesLog: false,
    puppeteerOptions: {
      headless: 'new',
      args: [
        '--no-sandbox', '--disable-setuid-sandbox',
        '--disable-dev-shm-usage', '--disable-gpu',
        '--js-flags=--max-old-space-size=180'
      ]
    },
    statusFind: buildStatusFind(record)
  };

  if (phoneNumber) {
    options.phoneNumber = phoneNumber;
    options.catchLinkCode = (raw) => {
      if (sessions.get(record.number) !== record) return;
      if (!record.code) {
        record.code = String(raw || '').trim().replace(/(.{4})/g, '$1-').replace(/-$/, '');
        record.codeAt = Date.now();
      }
    };
    options.catchQR = () => {
      if (sessions.get(record.number) !== record) return;
      if (record.status === 'linking') {
        record.status = 'failed';
        record.failure = 'WhatsApp returned a QR instead of a numeric code.';
        void killSession(record, { wipeTokens: true }); // (3) failed ≠ squatted slot
      }
    };
  }

  record.client = await api.create(options);
  return record.client;
}

// ── PAIRING — strict, serialized, self-cleaning ──────────────────────────
export async function startPairing(number) {
  // (5) server guarantees this, but never trust the caller
  if (!/^\d{10,15}$/.test(number)) {
    const e = new Error('Invalid number.'); e.statusCode = 400; throw e;
  }

  return withLock(async () => {
    // (2) RE-CHECK inside the lock — the pre-lock world may have changed
    const existing = sessions.get(number);
    if (existing?.status === 'open') {
      return { session: existing, existing: true };
    }
    if (existing?.status === 'linking' && existing.codeAt > Date.now() - 10 * 60_000) {
      const e = new Error('A pairing for this number is already in flight.');
      e.statusCode = 409; throw e;
    }
    if (existing) await killSession(existing, { wipeTokens: true }); // stale/failed → clean replace

    if (activeCount() >= MAX_SESSIONS) { // (2)(4) active slots only
      const e = new Error(`Linked-number limit reached (${MAX_SESSIONS}).`);
      e.statusCode = 429; throw e;
    }

    const record = {
      id: number, number,
      client: null,
      status: 'linking',
      pairing: true,
      pairedAt: null, code: null, codeAt: 0,
      failure: null,
      created: Date.now()
    };
    sessions.set(number, record);

    try {
      record.client = await buildClient(record, { phoneNumber: number });
    } catch (err) {
      await killSession(record, { wipeTokens: true }); // Chromium launch failure frees the slot
      const e = new Error(`Could not start the WhatsApp link session: ${err?.message || err}`);
      e.statusCode = 500; throw e;
    }

    attachCommands(record); // commands registered for NEW pairings too

    // (3) wait for the code; on timeout the request FAILS, never "ok with no code"
    const deadline = Date.now() + PAIR_CODE_WAIT_MS;
    while (Date.now() < deadline && !record.code && record.status === 'linking') {
      await new Promise((r) => setTimeout(r, 500));
    }

    if (record.status === 'open') return { session: record, existing: false };

    if (!record.code) {
      await killSession(record, { wipeTokens: true });
      const e = new Error('No pairing code was received in time. Try again.');
      e.statusCode = 504; throw e;
    }
    if (record.status === 'failed') {
      const e = new Error(record.failure || 'Pairing failed.'); e.statusCode = 500; throw e;
    }

    return { session: record, existing: false };
  });
}

export function getSession(id) { return sessions.get(normalize(id)); }

// (8) safe projection — no codes, no client objects, ever
export function allSessions() {
  return [...sessions.values()].map((s) => ({
    number: s.number,
    status: s.status,
    pairedAt: s.pairedAt
  }));
}

export async function getPairingState(number) {
  const s = sessions.get(normalize(number));
  if (!s) return null;
  return {
    number: s.number,
    status: s.status,
    code: s.pairing && s.status !== 'open' ? s.code : null
  };
}

// (9) validated restoration — malformed/stale/empty dirs are skipped or wiped
export async function restoreSavedSessions() {
  let entries = [];
  try { entries = await fs.readdir(TOKEN_DIR, { withFileTypes: true }); }
  catch { return; }

  for (const entry of entries) {
    const number = String(entry.name).replace(/\D/g, '');

    const looksValid = entry.isDirectory() && number.length >= 10 && number.length <= 15;
    if (!looksValid) {
      await fs.rm(path.join(TOKEN_DIR, entry.name), { recursive: true, force: true }).catch(() => {});
      continue;
    }

    // skip if it already woke up / is in flight
    if (sessions.has(number)) continue;

    await withLock(async () => {
      if (sessions.has(number) || activeCount() >= MAX_SESSIONS) return;

      // session dir with no token files = abandoned pairing → wipe
      let files = [];
      try { files = await fs.readdir(path.join(TOKEN_DIR, entry.name)); }
      catch {
        await fs.rm(path.join(TOKEN_DIR, entry.name), { recursive: true, force: true }).catch(() => {});
        return;
      }
      if (!files.some((f) => f.endsWith('.json'))) {
        await fs.rm(path.join(TOKEN_DIR, entry.name), { recursive: true, force: true }).catch(() => {});
        return;
      }

      const record = {
        id: number, number,
        client: null, status: 'linking', pairing: false,
        pairedAt: null, code: null, codeAt: 0, failure: null,
        created: Date.now()
      };
      sessions.set(number, record);
      try {
        record.client = await buildClient(record); // resume from saved tokens
        attachCommands(record);
        console.log(`♻️ Restored linked session +${number}`);
      } catch (err) {
        console.warn(`⚠️ restore +${number} failed:`, err?.message || err);
        await killSession(record, { wipeTokens: false }); // keep tokens; may have been transient
      }
    });
  }
}
