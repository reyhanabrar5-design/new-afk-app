// --- Java "modified UTF-8" fix --------------------------------------------------------------
// Minecraft 1.20.3+ sends chat/scoreboard text as NBT. Java encodes characters outside the BMP
// (custom badge glyphs, emoji) as two 3-byte surrogates (CESU-8). Node's utf8 decoder turns every
// one of those bytes into U+FFFD (six "?" per character). This shim re-decodes such buffers correctly.
// It only runs when a normal decode produced U+FFFD AND the bytes contain 0xED, so it costs nothing otherwise.
function decodeModifiedUtf8(buf) {
  const units = [];
  for (let i = 0; i < buf.length;) {
    const b = buf[i];
    if (b < 0x80) { units.push(b); i += 1; }
    else if ((b & 0xE0) === 0xC0 && i + 1 < buf.length) { units.push(((b & 0x1F) << 6) | (buf[i + 1] & 0x3F)); i += 2; }
    else if ((b & 0xF0) === 0xE0 && i + 2 < buf.length) { units.push(((b & 0x0F) << 12) | ((buf[i + 1] & 0x3F) << 6) | (buf[i + 2] & 0x3F)); i += 3; }
    else if ((b & 0xF8) === 0xF0 && i + 3 < buf.length) {
      const cp = ((b & 0x07) << 18) | ((buf[i + 1] & 0x3F) << 12) | ((buf[i + 2] & 0x3F) << 6) | (buf[i + 3] & 0x3F);
      const v = cp - 0x10000;
      units.push(0xD800 + (v >> 10), 0xDC00 + (v & 0x3FF));
      i += 4;
    } else { units.push(0xFFFD); i += 1; }
  }
  let out = '';
  for (let i = 0; i < units.length; i += 8192) out += String.fromCharCode.apply(null, units.slice(i, i + 8192));
  return out;
}
const originalBufferToString = Buffer.prototype.toString;
Buffer.prototype.toString = function (encoding, start, end) {
  const text = originalBufferToString.call(this, encoding, start, end);
  if ((encoding === undefined || encoding === 'utf8' || encoding === 'utf-8') && text.includes('\uFFFD')) {
    const slice = this.subarray(start || 0, end === undefined ? this.length : end);
    if (slice.includes(0xED)) return decodeModifiedUtf8(slice);
  }
  return text;
};
// ---------------------------------------------------------------------------------------------

require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mineflayer = require('mineflayer');
const { Vec3 } = require('vec3');
const { Authflow: MicrosoftAuthflow, Titles: MicrosoftTitles } = require('prismarine-auth');
const path = require('path');
const fs = require('fs');
const dns = require('dns').promises;

const msaAuthRequests = new Map();
let nextMicrosoftAuthFlowId = 1;

async function pollMicrosoftDeviceCode(tokenManager, deviceCodeCallback) {
  const acquiredAt = Date.now();
  const deviceResponse = await fetch('https://login.live.com/oauth20_connect.srf', {
    method: 'POST',
    body: new URLSearchParams({
      scope: tokenManager.scopes,
      client_id: tokenManager.clientId,
      response_type: 'device_code'
    }).toString(),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
  });
  const device = await deviceResponse.json();
  if (!deviceResponse.ok || device.error) {
    const error = new Error(`Microsoft device-code request failed (${device.error || deviceResponse.status}): ${device.error_description || deviceResponse.statusText}`);
    error.code = 'MSA_DEVICE_AUTH_FAILED';
    throw error;
  }
  if (deviceResponse.headers.get('set-cookie')) {
    const [cookie] = deviceResponse.headers.get('set-cookie').split(';');
    device.cookie = cookie;
  }
  device.message = `To sign in, use a web browser to open the page ${device.verification_uri} and use the code ${device.user_code} or visit http://microsoft.com/link?otc=${device.user_code}`;
  deviceCodeCallback(device);

  const expiresAt = acquiredAt + (device.expires_in * 1000) - 100;
  let intervalMs = device.interval * 1000;
  while (Date.now() < expiresAt) {
    await new Promise(resolve => setTimeout(resolve, intervalMs));
    const response = await fetch(`https://login.live.com/oauth20_token.srf?client_id=${encodeURIComponent(tokenManager.clientId)}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        ...(device.cookie ? { Cookie: device.cookie } : {})
      },
      body: new URLSearchParams({
        client_id: tokenManager.clientId,
        device_code: device.device_code,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code'
      }).toString()
    });
    const result = await response.json();
    if (result.error === 'authorization_pending') continue;
    if (result.error === 'slow_down') {
      intervalMs += 5000;
      continue;
    }
    if (!response.ok || result.error) {
      const error = new Error(`Microsoft device-code authorization failed (${result.error || response.status}): ${result.error_description || response.statusText}`);
      error.code = 'MSA_DEVICE_AUTH_FAILED';
      throw error;
    }
    await tokenManager.updateCache(result);
    return { accessToken: result.access_token };
  }

  const error = new Error('Microsoft device-code authorization expired before a token was returned.');
  error.code = 'MSA_DEVICE_AUTH_EXPIRED';
  throw error;
}

class BedrockMicrosoftAuthflow extends MicrosoftAuthflow {
  constructor(username, cache, options, codeCallback) {
    const flowId = nextMicrosoftAuthFlowId++;
    super(username, cache, options, (data) => {
      console.info(`[Microsoft auth #${flowId}] Device-code flow started (code hidden).`);
      if (codeCallback) codeCallback(data);
    });
    const normalizedUsername = String(username || '').trim().toLowerCase();
    this.msaAuthKey = normalizedUsername
      ? `username:${normalizedUsername}`
      : `cache:${typeof cache === 'string' ? path.resolve(cache) : flowId}`;
    this.msaAuthFlowId = flowId;
    this.msaTerminalError = null;
    this.msa.authDeviceCode = (callback) => pollMicrosoftDeviceCode(this.msa, callback);
  }

  getMsaToken() {
    if (this.msaTerminalError) return Promise.reject(this.msaTerminalError);

    const key = this.msaAuthKey;
    const existingRequest = msaAuthRequests.get(key);
    if (existingRequest) {
      console.info(`[Microsoft auth #${this.msaAuthFlowId}] MSA request joined active flow #${existingRequest.flowId}.`);
      return existingRequest.promise;
    }

    const request = super.getMsaToken().catch((error) => {
      if (error && String(error.code || '').startsWith('MSA_DEVICE_AUTH_')) {
        this.msaTerminalError = error;
      }
      throw error;
    });
    const requestEntry = { flowId: this.msaAuthFlowId, promise: request };
    msaAuthRequests.set(key, requestEntry);
    console.info(`[Microsoft auth #${this.msaAuthFlowId}] MSA request started; active account requests: ${msaAuthRequests.size}.`);
    return request.finally(() => {
      if (msaAuthRequests.get(key) === requestEntry) msaAuthRequests.delete(key);
    });
  }
}

let mineflayerViewer = null;
try {
  mineflayerViewer = require('prismarine-viewer').mineflayer;
} catch (e) { }

let bedrockProtocol = null;
try {
  bedrockProtocol = require('bedrock-protocol');
} catch (e) { }

const app = express();
app.get('/healthz', (req, res) => res.type('text/plain').send('ok')); // tiny response for UptimeRobot
const server = http.createServer(app);
// permessageDeflate compresses the repetitive JSON updates (saves a lot of outbound bandwidth)
const io = new Server(server, { perMessageDeflate: { threshold: 512 } });

const PORT = process.env.PORT || 3000;
const CONFIG_FILE = path.join(__dirname, 'bot_accounts.json');
const QUICK_FILE = path.join(__dirname, 'quick_commands.json');
const KICK_LOG_FILE = path.join(__dirname, 'kick_logs.json');
const BREAK_LOG_FILE = path.join(__dirname, 'break_logs.json');

function recordBreakIncident(entry) {
  try {
    let logs = [];
    if (fs.existsSync(BREAK_LOG_FILE)) {
      try {
        const raw = fs.readFileSync(BREAK_LOG_FILE, 'utf8');
        logs = JSON.parse(raw);
        if (!Array.isArray(logs)) logs = [];
      } catch (e) {
        logs = [];
      }
    }
    const record = {
      timestamp: new Date().toISOString(),
      ...entry
    };
    logs.unshift(record);
    if (logs.length > 500) logs = logs.slice(0, 500); // Simpan 500 catatan hancur terakhir
    fs.writeFileSync(BREAK_LOG_FILE, JSON.stringify(logs, null, 2), 'utf8');
  } catch (err) {
    console.error('Gagal mencatat break incident ke break_logs.json:', err.message);
  }
}

// Otomatis membersihkan (clear) break_logs.json setiap 30 detik
setInterval(() => {
  try {
    fs.writeFileSync(BREAK_LOG_FILE, '[]\n', 'utf8');
  } catch (err) {
    console.error('Gagal membersihkan break_logs.json otomatis:', err.message);
  }
}, 30 * 1000);

function recordKickIncident(entry) {
  try {
    let logs = [];
    if (fs.existsSync(KICK_LOG_FILE)) {
      try {
        const raw = fs.readFileSync(KICK_LOG_FILE, 'utf8');
        logs = JSON.parse(raw);
        if (!Array.isArray(logs)) logs = [];
      } catch (e) {
        logs = [];
      }
    }
    const record = {
      timestamp: new Date().toISOString(),
      ...entry
    };
    logs.unshift(record);
    if (logs.length > 200) logs = logs.slice(0, 200);
    fs.writeFileSync(KICK_LOG_FILE, JSON.stringify(logs, null, 2), 'utf8');
  } catch (err) {
    console.error('Gagal mencatat kick incident ke kick_logs.json:', err.message);
  }
}

// Custom quick buttons (shared by all accounts): [{ label, command }]
function sanitizeQuickCommands(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, 12).map((item) => {
    const command = String((item && item.command) || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 256);
    const label = String((item && item.label) || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 30) || command.slice(0, 30);
    return { label, command };
  }).filter(item => item.command);
}
function loadQuickCommands() {
  try {
    if (fs.existsSync(QUICK_FILE)) return sanitizeQuickCommands(JSON.parse(fs.readFileSync(QUICK_FILE, 'utf8')));
  } catch (err) {
    console.error('Gagal membaca quick_commands.json:', err.message);
  }
  return [];
}
let quickCommands = loadQuickCommands();

function getBot(botId) {
  return typeof botId === 'string' && Object.prototype.hasOwnProperty.call(botInstances, botId)
    ? botInstances[botId]
    : null;
}

// Mode AFK per akun: 'tycoon' atau 'oneblock'. Akun lama tanpa field mode ditebak dari skrip / config OneBlock.
const BOT_MODES = ['tycoon', 'oneblock'];
function resolveBotMode(cfg) {
  if (!cfg) return 'tycoon';
  if (BOT_MODES.includes(cfg.mode)) return cfg.mode;
  const cmds = Array.isArray(cfg.autoCmds) ? cfg.autoCmds.map(c => (c && c.cmd) || '').join(' ') : '';
  if (cfg.oneBlock || /oneblock/i.test(`${cmds} ${cfg.scriptText || ''}`)) return 'oneblock';
  return 'tycoon';
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
// Commands whose result can be checked. A command counts as done when the server confirms it in chat
// (pattern), the bot was moved (minMove blocks) or one of the listed events fired. Otherwise it is retried.
const VERIFY_TIME_SCALE = Number(process.env.VERIFY_TIME_SCALE) || 1; // only lowered by tests
const VERIFY_RULES = [
  {
    name: 'teleport ke island',
    match: /^\/(is|island)(\s+(go|home|tp))?$/i,
    pattern: /teleported to your island|teleport(ed)? to (your )?island/i,
    minMove: 8,
    timeoutMs: 10000,
    attempts: 3,
    retryDelayMs: 4000
  },
  {
    name: 'pindah server',
    match: /^\/server\s+\S+/i,
    pattern: /already connected|sudah terhubung/i,
    events: ['login', 'respawn', 'spawn'],
    timeoutMs: 15000,
    attempts: 2,
    retryDelayMs: 3000
  }
];
const SPATIAL_INTERVAL_MS = 2000; // how often position/inventory/scoreboard are checked for changes
const ITEM_GUI_MAX_WAIT_MS = 90000; // how long an item stays in hand while its menu is open
const BEDROCK_LOGIN_RESPONSE_TIMEOUT_MS = 30000;

const defaultAccounts = [];

let accounts = defaultAccounts;

if (fs.existsSync(CONFIG_FILE)) {
  try {
    const saved = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    if (Array.isArray(saved) && saved.length > 0) {
      accounts = saved.map(acc => {
        if (acc.scriptText) {
          acc.scriptText = acc.scriptText.split('\n').filter(l => !l.toLowerCase().includes('reco')).join('\n');
        }

        return acc;
      });
    }
  } catch (err) {
    console.error('Gagal membaca bot_accounts.json:', err.message);
  }
}

function saveAccounts() {
  try {
    const dataToSave = Object.values(botInstances).map(b => b.config);
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(dataToSave, null, 2), 'utf8');
  } catch (err) {
    console.error('Gagal menyimpan bot_accounts.json:', err.message);
  }
}

// Clean Minecraft text (ChatMessage objects, color § codes, JSON formatted strings)
function cleanMcText(raw) {
  if (!raw) return '';

  if (typeof raw === 'string') {
    let str = raw.trim();
    if (str.startsWith('{') || str.startsWith('[')) {
      try {
        const parsed = JSON.parse(str);
        return cleanMcText(parsed);
      } catch (e) { }
    }
    return str.replace(/§[0-9a-fk-or]/gi, '').trim();
  }

  if (typeof raw === 'object') {
    if (raw.text !== undefined && raw.text !== null) {
      let res = cleanMcText(raw.text);
      if (Array.isArray(raw.extra)) {
        res += ' ' + raw.extra.map(e => cleanMcText(e)).join(' ');
      }
      return res.replace(/§[0-9a-fk-or]/gi, '').trim();
    }
    if (raw.value !== undefined && raw.value !== null) {
      return cleanMcText(raw.value);
    }
    if (Array.isArray(raw.extra)) {
      return raw.extra.map(e => cleanMcText(e)).join(' ').replace(/§[0-9a-fk-or]/gi, '').trim();
    }
    if (Array.isArray(raw)) {
      return raw.map(e => cleanMcText(e)).join(' ').replace(/§[0-9a-fk-or]/gi, '').trim();
    }
    if (typeof raw.toString === 'function') {
      const s = raw.toString();
      if (s && s !== '[object Object]') {
        return s.replace(/§[0-9a-fk-or]/gi, '').trim();
      }
    }
    try {
      const jsonStr = JSON.stringify(raw);
      if (jsonStr) {
        return jsonStr.replace(/["{}]/g, '').replace(/§[0-9a-fk-or]/gi, '').trim();
      }
    } catch (e) { }
  }

  return String(raw).replace(/§[0-9a-fk-or]/gi, '').trim();
}

// Convert typed NBT (prismarine-nbt format) into plain JS values.
// Used for item custom names / lore on newer Minecraft versions (component format).
function simplifyNbt(n) {
  if (n === null || n === undefined) return n;
  if (Array.isArray(n)) return n.map(simplifyNbt);
  if (typeof n !== 'object') return n;
  if ('type' in n && 'value' in n) {
    if (n.type === 'compound') {
      const out = {};
      for (const k in n.value) out[k] = simplifyNbt(n.value[k]);
      return out;
    }
    if (n.type === 'list') {
      const inner = n.value || {};
      const arr = Array.isArray(inner.value) ? inner.value : [];
      return arr.map(el => (inner.type === 'compound' ? simplifyNbt({ type: 'compound', value: el }) : el));
    }
    return simplifyNbt(n.value);
  }
  return n;
}

// ---- Styled Minecraft text (colors / bold / italic ...) -> compact "runs" for the dashboard ----
const MC_COLORS = {
  black: '#000000', dark_blue: '#0000AA', dark_green: '#00AA00', dark_aqua: '#00AAAA',
  dark_red: '#AA0000', dark_purple: '#AA00AA', gold: '#FFAA00', gray: '#AAAAAA',
  dark_gray: '#555555', blue: '#5555FF', green: '#55FF55', aqua: '#55FFFF',
  red: '#FF5555', light_purple: '#FF55FF', yellow: '#FFFF55', white: '#FFFFFF'
};
const MC_LEGACY_CODES = {
  '0': 'black', '1': 'dark_blue', '2': 'dark_green', '3': 'dark_aqua', '4': 'dark_red',
  '5': 'dark_purple', '6': 'gold', '7': 'gray', '8': 'dark_gray', '9': 'blue',
  'a': 'green', 'b': 'aqua', 'c': 'red', 'd': 'light_purple', 'e': 'yellow', 'f': 'white'
};

function mcResolveColor(c) {
  if (!c) return undefined;
  const str = String(c);
  if (/^#[0-9a-f]{6}$/i.test(str)) return str.toUpperCase();
  return MC_COLORS[str.toLowerCase()];
}

function mcToBool(v) {
  if (v === true || v === 1 || v === '1' || v === 'true') return true;
  if (v === false || v === 0 || v === '0' || v === 'false') return false;
  return undefined;
}

function mcPushRun(runs, text, st) {
  if (!text) return;
  const run = { t: text };
  if (st.c) run.c = st.c;
  if (st.b) run.b = 1;
  if (st.i) run.i = 1;
  if (st.u) run.u = 1;
  if (st.s) run.s = 1;
  if (st.o) run.o = 1;
  runs.push(run);
}

// Legacy "§" formatting codes inside a plain string (also §x§R§R§G§G§B§B hex colors)
function mcLegacyRuns(str, base, runs) {
  let st = { ...base };
  let buf = '';
  const flush = () => { mcPushRun(runs, buf, st); buf = ''; };
  for (let k = 0; k < str.length; k++) {
    const ch = str[k];
    if (ch === '§' && k + 1 < str.length) {
      const code = str[k + 1].toLowerCase();
      if (code === 'x') {
        const chunk = str.substr(k, 14);
        if (/^§x(§[0-9a-f]){6}$/i.test(chunk)) {
          flush();
          st = { c: '#' + chunk.replace(/§/g, '').substring(1).toUpperCase() };
          k += 13;
          continue;
        }
      }
      flush();
      if (MC_LEGACY_CODES[code]) st = { c: MC_COLORS[MC_LEGACY_CODES[code]] };
      else if (code === 'l') st = { ...st, b: true };
      else if (code === 'o') st = { ...st, i: true };
      else if (code === 'n') st = { ...st, u: true };
      else if (code === 'm') st = { ...st, s: true };
      else if (code === 'k') st = { ...st, o: true };
      else if (code === 'r') st = {};
      k++;
      continue;
    }
    buf += ch;
  }
  flush();
}

function mcComponentRuns(node, parent, runs) {
  if (node === null || node === undefined) return;

  if (typeof node === 'string') {
    const t = node.trim();
    if (t.startsWith('{') || t.startsWith('[') || (t.startsWith('"') && t.endsWith('"'))) {
      try { mcComponentRuns(JSON.parse(t), parent, runs); return; } catch (e) { }
    }
    mcLegacyRuns(node, parent, runs);
    return;
  }
  if (typeof node === 'number' || typeof node === 'boolean') {
    mcLegacyRuns(String(node), parent, runs);
    return;
  }
  if (Array.isArray(node)) {
    // JSON array: later elements inherit the style of the first one
    let inherited = parent;
    node.forEach((el, idx) => {
      mcComponentRuns(el, idx === 0 ? parent : inherited, runs);
      if (idx === 0 && el && typeof el === 'object' && !Array.isArray(el)) inherited = mcMergeStyle(parent, el);
    });
    return;
  }
  if (typeof node === 'object') {
    const st = mcMergeStyle(parent, node);
    let text = node.text;
    if (text === undefined || text === null) text = node.fallback || node.translate || '';
    if (text !== '') mcLegacyRuns(String(text), st, runs);
    if (Array.isArray(node.extra)) node.extra.forEach(child => mcComponentRuns(child, st, runs));
  }
}

function mcMergeStyle(parent, node) {
  const st = { ...parent };
  const color = mcResolveColor(node.color);
  if (color) st.c = color;
  const flags = { b: node.bold, i: node.italic, u: node.underlined, s: node.strikethrough, o: node.obfuscated };
  for (const key in flags) {
    const v = mcToBool(flags[key]);
    if (v !== undefined) st[key] = v;
  }
  return st;
}

// raw (string JSON / legacy § string / typed NBT) -> [{t, c?, b?, i?, u?, s?, o?}]
function toStyledRuns(raw) {
  const runs = [];
  try { mcComponentRuns(simplifyNbt(raw), {}, runs); } catch (e) { return []; }
  const merged = [];
  runs.forEach(r => {
    const last = merged[merged.length - 1];
    if (last && last.c === r.c && last.b === r.b && last.i === r.i && last.u === r.u && last.s === r.s && last.o === r.o) {
      last.t += r.t;
    } else {
      merged.push({ ...r });
    }
  });
  return merged;
}

const runsToPlainText = (runs) => runs.map(r => r.t).join('').replace(/\s+/g, ' ').trim();

// Read the real (server-defined) item name and lore. item.displayName is only the vanilla name.
// Lore keeps blank lines (they are used as spacing in menus); trailing blank lines are dropped.
function getItemCustomText(item) {
  let customName = '';
  let nameRuns = [];
  let loreRuns = [];
  try {
    const rawName = item.customName;
    if (rawName !== null && rawName !== undefined) {
      nameRuns = toStyledRuns(rawName);
      customName = runsToPlainText(nameRuns);
    }
  } catch (e) { }
  try {
    const rawLore = item.customLore;
    if (rawLore !== null && rawLore !== undefined) {
      const simple = simplifyNbt(rawLore);
      const list = Array.isArray(simple) ? simple : [simple];
      loreRuns = list.map(l => toStyledRuns(l));
      while (loreRuns.length && runsToPlainText(loreRuns[loreRuns.length - 1]) === '') loreRuns.pop();
    }
  } catch (e) { }
  if (!customName) nameRuns = [];
  return { customName, nameRuns, loreRuns };
}

function isMultitool(item) {
  if (!item) return false;
  const custom = getItemCustomText(item);
  const nameStr = (custom.customName || item.displayName || item.name || '').toLowerCase();
  if (nameStr.includes('multitool')) return true;
  if (Array.isArray(custom.loreRuns)) {
    for (const runList of custom.loreRuns) {
      const line = runsToPlainText(runList).toLowerCase();
      if (line.includes('multitool') || line.includes('mines stone, ores, wood') || line.includes('soulbound tool')) {
        return true;
      }
    }
  }
  return false;
}

function getMultitoolDurability(item) {
  if (!item) return null;
  const custom = getItemCustomText(item);
  if (Array.isArray(custom.loreRuns)) {
    for (const runList of custom.loreRuns) {
      const line = runsToPlainText(runList);
      const match = line.match(/durability:\s*(\d+)\s*\/\s*(\d+)/i);
      if (match) {
        return {
          current: parseInt(match[1]),
          max: parseInt(match[2])
        };
      }
    }
  }
  if (typeof item.maxDurability === 'number' && item.maxDurability > 0) {
    const used = typeof item.durabilityUsed === 'number' ? item.durabilityUsed : 0;
    return {
      current: Math.max(0, item.maxDurability - used),
      max: item.maxDurability
    };
  }
  return null;
}

// Clickable parts of a chat message (e.g. "[Player's Inventory]" -> /command). Reads both the old
// "clickEvent" and the 1.21.5+ "click_event" naming, also inside "extra" and translate "with" lists.
function extractChatActions(msg) {
  const out = [];
  const root = msg && msg.json !== undefined ? msg.json : msg;
  const plain = (j) => {
    if (typeof j === 'string') return j;
    if (!j || typeof j !== 'object') return '';
    return String(j.text || '') + (Array.isArray(j.extra) ? j.extra.map(plain).join('') : '');
  };
  const walk = (j, depth) => {
    if (!j || typeof j !== 'object' || depth > 12 || out.length >= 5) return;
    const ce = j.clickEvent || j.click_event;
    if (ce && ce.action === 'run_command') {
      let cmd = String(ce.value !== undefined ? ce.value : (ce.command || '')).trim();
      if (cmd && cmd.length <= 200 && !/[\r\n]/.test(cmd)) {
        if (!cmd.startsWith('/')) cmd = '/' + cmd;
        out.push({ text: plain(j).trim(), command: cmd });
      }
    }
    if (Array.isArray(j.extra)) j.extra.forEach(e => walk(e, depth + 1));
    if (Array.isArray(j.with)) j.with.forEach(e => walk(e, depth + 1));
  };
  walk(root, 0);
  return out;
}

// Extract Scoreboard data from Mineflayer bot instance
const SCOREBOARD_DEFAULT_TITLE = 'Scoreboard';

// Objective that the server actually displays in the sidebar (display slot 1)
function findSidebarObjective(bot) {
  if (bot.scoreboard && bot.scoreboard.sidebar) return bot.scoreboard.sidebar;
  if (bot.scoreboards) {
    for (const key in bot.scoreboards) {
      if (/sidebar/i.test(key) && bot.scoreboards[key]) return bot.scoreboards[key];
    }
  }
  return null;
}

// Text of one sidebar line: custom line text (1.20.3+) > team prefix + name + suffix > plain name
function scoreboardLineText(bot, item) {
  if (item.lineNbt) {
    const custom = cleanMcText(item.lineNbt);
    if (custom && custom !== '[object Object]') return custom;
  }
  const team = (bot.teamMap && bot.teamMap[item.name]) || (bot.teams && bot.teams[item.name]);
  if (team) {
    const text = (cleanMcText(team.prefix || '') + item.name + cleanMcText(team.suffix || '')).replace(/TAB-[A-Za-z]+-\d+/gi, '').trim();
    if (text && !text.includes('[object Object]')) return text;
  }
  const plain = item.displayName ? cleanMcText(item.displayName) : cleanMcText(item.name);
  return plain === '[object Object]' ? '' : plain;
}

function extractScoreboard(bot) {
  if (!bot) return { title: SCOREBOARD_DEFAULT_TITLE, items: [], source: 'none' };

  const sidebar = findSidebarObjective(bot);

  // Title: real title from the server, otherwise the last real one we saw
  let titleStr = sidebar ? cleanMcText(sidebar.title) : '';
  if (titleStr && titleStr !== '[object Object]') {
    bot._lastScoreboardTitle = titleStr;
  } else {
    titleStr = bot._lastScoreboardTitle || SCOREBOARD_DEFAULT_TITLE;
  }

  // 1) Normal path: items of the objective shown in the sidebar
  if (sidebar && sidebar.itemsMap) {
    const rawItems = Object.values(sidebar.itemsMap)
      .map((item, idx) => ({ item, idx }))
      .filter(e => e.item)
      .sort((x, y) => ((y.item.value || 0) - (x.item.value || 0)) || (x.idx - y.idx)); // stable on ties

    const items = [];
    rawItems.forEach(({ item }) => {
      const lineText = scoreboardLineText(bot, item);
      if (lineText) {
        items.push({
          name: lineText,
          value: item.hideValue ? '' : (item.value !== undefined ? item.value : '')
        });
      }
    });
    if (items.length > 0) return { title: titleStr, items, source: `objective:${sidebar.name}` };
  }

  // 2) Backup: TAB plugin sidebar lines are teams named TAB-Sidebar-<n>. Only these teams are used,
  //    never the per-player sorting teams, otherwise players show up between the sidebar lines.
  if (bot.teams) {
    const tabLines = Object.values(bot.teams)
      .filter(t => t && /^TAB-Sidebar-\d+$/i.test(String(t.team || '')))
      .sort((x, y) => parseInt(String(x.team).split('-').pop(), 10) - parseInt(String(y.team).split('-').pop(), 10));

    const items = [];
    tabLines.forEach(t => {
      const text = (cleanMcText(t.prefix || '') + cleanMcText(t.suffix || '')).trim();
      if (text && !text.includes('[object Object]')) items.push({ name: text, value: '' });
    });
    if (items.length > 0) return { title: titleStr, items, source: 'tab-teams' };
  }

  return { title: titleStr, items: [], source: 'none' };
}

function formatBedrockConnectionError(error, auth) {
  const message = String(error && error.message ? error.message : error || 'Kesalahan koneksi tidak diketahui.');
  if (auth === 'microsoft' && error && error.code === 'MSA_DEVICE_AUTH_FAILED') {
    return `Microsoft menolak penerbitan token Device Code: ${message}`;
  }
  if (auth === 'microsoft' && error && error.code === 'MSA_DEVICE_AUTH_EXPIRED') {
    return 'Kode login Microsoft kedaluwarsa sebelum token diterima. Mulai satu percobaan login baru dan selesaikan persetujuan sebelum kode kedaluwarsa.';
  }
  if (auth === 'microsoft' && /Authentication failed, timed out|invalid_grant|device_code.*already been used/i.test(message)) {
    return 'Login Microsoft gagal karena kode perangkat sudah dipakai atau kedaluwarsa. Pastikan hanya satu proses aplikasi dan satu percobaan login yang aktif, lalu mulai ulang bot dengan Xbox dan setujui satu kode terbaru saja.';
  }
  if (auth === 'microsoft' && (/\b401\s+Unauthorized\b/i.test(message) || /\bUNAUTHORIZED\b/i.test(message))) {
    return 'Autentikasi Xbox/Microsoft ditolak oleh layanan Minecraft (401 Unauthorized). Pastikan akun ini dapat login ke Minecraft Bedrock dan memiliki akses/lisensi yang aktif; profil Xbox saja tidak cukup.';
  }
  return `Eror koneksi Bedrock: ${message}`;
}

function isTerminalMicrosoftAuthError(error) {
  return Boolean(error && typeof error.code === 'string' && error.code.startsWith('MSA_DEVICE_AUTH_'));
}

function formatRaknetDisconnect(reason) {
  if (reason === undefined || reason === null) {
    return 'Backend RakNet menutup koneksi tanpa memberikan detail alasan.';
  }
  if (typeof reason === 'string') return reason;
  if (reason instanceof Error) return `${reason.name}: ${reason.message}`;
  try {
    return JSON.stringify(reason);
  } catch (err) {
    return String(reason);
  }
}

// ---- Bedrock helpers (follow the bedrock-protocol docs: docs/API.md) ----
// Slash commands must be sent as "command_request" (not as chat text). Two fields depend on the version:
//   <= 1.21.124 : version is a varint, a "player" origin has no player_entity_id
//   >= 1.21.130 : version is a string ('latest'), player_entity_id (li64) is required
function bedrockUsesNewCommandFormat(versionStr) {
  const [major, minor, patch] = String(versionStr || '').split('.').map(Number);
  if (!major) return true; // unknown version: assume current format
  return major > 1 || minor > 21 || (minor === 21 && (patch || 0) >= 130);
}
function buildBedrockCommand(versionStr, command) {
  const origin = { type: 'player', uuid: require('crypto').randomUUID(), request_id: '' };
  if (bedrockUsesNewCommandFormat(versionStr)) {
    origin.player_entity_id = 0n;
    return { command, origin, internal: false, version: 'latest' };
  }
  return { command, origin, internal: false, version: 52 };
}
// Plain chat. "filtered_message" is required by the protocol on 1.21.0 - 1.21.124.
function buildBedrockChat(sourceName, message) {
  return { type: 'chat', needs_translation: false, source_name: sourceName, xuid: '', platform_chat_id: '', filtered_message: '', message };
}
const BEDROCK_TRANSLATIONS = {
  'multiplayer.player.joined': (p) => `${p[0]} joined the game`,
  'multiplayer.player.left': (p) => `${p[0]} left the game`,
  'chat.type.text': (p) => `${p[0]} » ${p[1] || ''}`,
  'chat.type.announcement': (p) => `[${p[0]}] ${p[1] || ''}`
};
// Text of a Bedrock "text" packet for the console: chat shows "Name » message", translations are expanded
function formatBedrockText(packet) {
  if (!packet) return '';
  if (packet.type === 'translation') {
    const key = String(packet.message || '').replace(/^%/, '');
    const params = Array.isArray(packet.parameters) ? packet.parameters.map(x => cleanMcText(String(x))) : [];
    return BEDROCK_TRANSLATIONS[key] ? BEDROCK_TRANSLATIONS[key](params) : [key, ...params].join(' ').trim();
  }
  const message = String(packet.message || '');
  const isChat = packet.type === 'chat' || packet.type === 'whisper';
  const name = String(packet.source_name || '');
  if (isChat && name && !message.toLowerCase().includes(name.toLowerCase())) return `${name} » ${message}`;
  return message || name;
}
// True when a move_player packet is about this bot (the packet is also sent for other players)
function isOwnMovePacket(client, packet) {
  try {
    const ownId = client.entityId;
    return ownId !== undefined && String(packet.runtime_id) === String(ownId);
  } catch (e) {
    return false;
  }
}

// Bot Instance Manager class
class BotManager {
  constructor(config) {
    this.config = config;
    this.sessionAuth = config.auth === 'microsoft' ? 'microsoft' : 'offline';
    this.bedrockAuthFailureMessage = null;
    this.bot = null;
    this.status = 'offline';
    this.health = { health: 20, food: 20 };
    this.position = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, dimension: 'overworld' };
    this.scoreboard = { title: SCOREBOARD_DEFAULT_TITLE, items: [], source: 'none' };
    this.inventory = [];
    this.savedRotation = config.savedRotation || null; // Simpan sudut pandang (yaw/pitch) pemain saat log off / pindah realm
    this.nearbyEntities = [];
    this.activeGuiWindow = null;
    this.reconnectTimer = null;
    this.scriptTimeouts = [];
    this.spatialInterval = null;
    this.logHistory = [];
    this.MAX_LOGS = 150;

    this.config.mode = resolveBotMode(config);

    const obCfg = config.oneBlock || {};
    this.oneBlockAfk = {
      enabled: !!obCfg.enabled && this.config.mode === 'oneblock',
      targetPos: obCfg.target || { x: -6749, y: 99, z: -6749 },
      autoTool: obCfg.autoTool !== false,
      autoEat: obCfg.autoEat !== false,
      ignoreObstacles: obCfg.ignoreObstacles !== false,
      durabilitySafe: obCfg.durabilitySafe !== false,
      // Jeda sebelum OneBlock AFK berjalan lagi setelah bot login kembali (reconnect)
      reconnectDelayEnabled: obCfg.reconnectDelayEnabled !== false,
      reconnectDelaySec: Number.isFinite(Number(obCfg.reconnectDelaySec)) ? Math.max(0, Math.min(600, Number(obCfg.reconnectDelaySec))) : 15,
      status: 'idle',
      statusMessage: '',
      brokenCount: 0
    };
    this._oneBlockLoopTimeout = null;
    this._oneBlockBusy = false;
  }

  addLog(message, type = 'info', actions = null) {
    const timestamp = new Date().toLocaleTimeString('id-ID', { hour12: false });
    const entry = { timestamp, message, type, botId: this.config.id };
    if (actions && actions.length > 0) entry.actions = actions;
    this.logHistory.push(entry);
    if (this.logHistory.length > this.MAX_LOGS) {
      this.logHistory.shift();
    }
    io.emit('bot-log', { botId: this.config.id, log: entry });
    console.log(`[${timestamp}] [${this.config.id}] [${type.toUpperCase()}] ${message}`);
  }

  updateStatus(newStatus, detail = '') {
    this.status = newStatus;
    io.emit('bot-status-update', {
      botId: this.config.id,
      status: this.status,
      detail,
      health: this.health,
      position: this.position,
      scoreboard: this.scoreboard,
      config: this.config,
      activeGui: this.activeGuiWindow
    });
  }

  stopScript() {
    this.scriptTimeouts.forEach(clearTimeout);
    this.scriptTimeouts = [];
    this._scriptRun = (this._scriptRun || 0) + 1; // invalidates a running script
  }

  // Waits (max ~30s) until the bot has spawned in the world, so commands are not sent too early
  async waitBotSpawned(runId) {
    for (let i = 0; i < 60; i++) {
      if (this._scriptRun !== runId || !this.bot || this.status !== 'online') return false;
      if (this.bot.entity) return true;
      await sleep(500);
    }
    return false;
  }

  // Sends `cmd` and resolves true once the server confirmed it (see VERIFY_RULES), false on timeout
  sendAndVerify(cmd, rule) {
    const bot = this.bot;
    if (typeof bot.on !== 'function') { // not a mineflayer bot: just send
      try { bot.chat(cmd); } catch (e) { return Promise.resolve(false); }
      return Promise.resolve(true);
    }
    const startPos = bot.entity ? bot.entity.position.clone() : null;
    return new Promise((resolve) => {
      let settled = false;
      const events = rule.events || [];
      const onMsg = (msg) => { if (rule.pattern && rule.pattern.test(String(msg))) done(true); };
      const onMove = () => {
        if (rule.minMove && startPos && bot.entity && bot.entity.position.distanceTo(startPos) >= rule.minMove) done(true);
      };
      const onEvent = () => done(true);
      const poll = setInterval(onMove, Math.max(10, 500 * VERIFY_TIME_SCALE));
      const timer = setTimeout(() => done(false), rule.timeoutMs * VERIFY_TIME_SCALE);
      function cleanup() {
        clearInterval(poll);
        clearTimeout(timer);
        bot.removeListener('messagestr', onMsg);
        bot.removeListener('forcedMove', onMove);
        events.forEach(e => bot.removeListener(e, onEvent));
      }
      function done(ok) {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(ok);
      }
      // Listen first, then send, so a very fast reply is not missed
      bot.on('messagestr', onMsg);
      bot.on('forcedMove', onMove);
      events.forEach(e => bot.on(e, onEvent));
      try {
        bot.chat(cmd);
      } catch (e) {
        done(false);
      }
    });
  }

  async runScript() {
    this.stopScript();
    if (!this.config.scriptEnabled) return;
    const runId = this._scriptRun;

    let items = [];
    if (Array.isArray(this.config.autoCmds) && this.config.autoCmds.length > 0) {
      items = this.config.autoCmds.map(item => {
        if (typeof item === 'string') {
          return { cmd: item.trim(), delaySec: 2 };
        } else if (typeof item === 'object' && item !== null) {
          return {
            cmd: (item.cmd || '').trim(),
            delaySec: typeof item.delaySec === 'number' ? item.delaySec : (parseInt(item.delaySec) || 2)
          };
        }
        return null;
      }).filter(i => i && i.cmd);
    } else if (this.config.scriptText) {
      const lines = this.config.scriptText
        .split('\n')
        .map(l => l.trim())
        .filter(l => l && !l.startsWith('#') && !l.toLowerCase().includes('reco'));

      let pendingDelaySec = 2;
      lines.forEach((line) => {
        const lower = line.toLowerCase();
        if (lower.startsWith('wait ')) {
          const valStr = line.split(' ')[1];
          const val = parseInt(valStr || '40');
          pendingDelaySec = Math.max(0, Math.round(val / 20));
        } else if (lower.startsWith('send ')) {
          let rawCmd = line.substring(5).trim();
          items.push({ cmd: rawCmd, delaySec: pendingDelaySec });
          pendingDelaySec = 2;
        }
      });
    }

    if (items.length === 0) return;

    this.addLog('Menjalankan Perintah Otomatis (Dengan Jeda Kustom)...', 'system');

    const alive = () => this._scriptRun === runId && this.bot && this.status === 'online';
    // Bedrock accounts have no mineflayer events to confirm against, so their commands are sent without verification
    const verify = this.config.verifyCommands !== false && this.config.platform !== 'bedrock';
    const mask = (text) => (this.config.password ? text.split(this.config.password).join('***') : text);

    // Commands run one after another: each delay starts when the previous command is finished/confirmed
    for (const item of items) {
      await sleep(Math.max(0, item.delaySec) * 1000 * VERIFY_TIME_SCALE);
      if (!alive()) return;
      if (!(await this.waitBotSpawned(runId))) {
        if (alive()) this.addLog('Bot belum selesai masuk ke dunia, perintah otomatis dihentikan.', 'warning');
        return;
      }

      let cmd = item.cmd;
      if (!cmd.startsWith('/') && !cmd.toLowerCase().startsWith('send ')) cmd = '/' + cmd;
      if (cmd.toLowerCase().startsWith('send ')) cmd = cmd.substring(5).trim();
      if (this.config.password) cmd = cmd.split('{password}').join(this.config.password);

      const rule = verify ? VERIFY_RULES.find(r => r.match.test(cmd)) : null;
      const attempts = rule ? rule.attempts : 1;

      for (let attempt = 1; attempt <= attempts; attempt++) {
        if (!alive()) return;
        this.addLog(`[PERINTAH DILAKSANAKAN] ${mask(cmd)}${attempts > 1 ? ` (percobaan ${attempt}/${attempts})` : ''}`, 'mychat');

        let ok = true;
        try {
          if (rule) ok = await this.sendAndVerify(cmd, rule);
          else this.bot.chat(cmd);
        } catch (e) {
          this.addLog(`Gagal menjalankan perintah (${mask(cmd)}): ${e.message}`, 'error');
          break;
        }
        if (!rule) break;
        if (!alive()) return;

        if (ok) {
          this.addLog(`✓ ${rule.name} terkonfirmasi (${mask(cmd)})`, 'success');
          break;
        }
        if (attempt < attempts) {
          this.addLog(`${rule.name} belum terkonfirmasi, mengulang dalam ${rule.retryDelayMs / 1000} detik...`, 'warning');
          await sleep(rule.retryDelayMs * VERIFY_TIME_SCALE);
        } else {
          this.addLog(`✗ ${rule.name} gagal terkonfirmasi setelah ${attempts} percobaan. Lanjut ke perintah berikutnya.`, 'error');
        }
      }
    }

    if (alive()) {
      this.addLog('Perintah otomatis selesai dijalankan.', 'success');
      if (this.oneBlockAfk && this.oneBlockAfk.enabled) {
        setTimeout(() => {
          if (alive() && this.oneBlockAfk && this.oneBlockAfk.enabled) {
            this.runOneBlockLoop();
          }
        }, 2500);
      }
    }
  }

  startSpatialBroadcast() {
    if (this.spatialInterval) clearInterval(this.spatialInterval);

    this.spatialInterval = setInterval(() => {
      if (!this.bot || this.status !== 'online') return;

      try {
        if (this.bot.entity) {
          this.position = {
            x: Math.round(this.bot.entity.position.x * 10) / 10,
            y: Math.round(this.bot.entity.position.y * 10) / 10,
            z: Math.round(this.bot.entity.position.z * 10) / 10,
            yaw: Math.round((this.bot.entity.yaw * 180 / Math.PI) % 360),
            pitch: Math.round(this.bot.entity.pitch * 180 / Math.PI),
            dimension: (this.bot.game && this.bot.game.dimension) ? this.bot.game.dimension : 'overworld'
          };
        }

        this.refreshScoreboard();

        if (this.bot.inventory) {
          this.inventory = this.bot.inventory.items().map(item => {
            // Same custom name / lore handling as the chest GUI, so tooltips show the server's item names
            const custom = getItemCustomText(item);
            const entry = {
              slot: item.slot,
              name: item.name,
              displayName: cleanMcText(item.displayName || item.name || ''),
              customName: custom.customName,
              count: item.count
            };
            if (custom.nameRuns.length) entry.nameRuns = custom.nameRuns;
            if (custom.loreRuns.length) entry.loreRuns = custom.loreRuns;
            return entry;
          });
        }

        // Strict Local Barrier Entity & Player Detection + Cross-Bot Distance Calculator
        const botPos = this.bot.entity ? this.bot.entity.position : null;
        const detected = [];

        if (this.bot.entities && botPos) {
          for (const id in this.bot.entities) {
            const e = this.bot.entities[id];
            if (!e || e === this.bot.entity || !e.position) continue;

            const dist = Math.round(botPos.distanceTo(e.position) * 10) / 10;

            if (dist <= 100) {
              // Players only: mobs, items, armor stands and other entities are ignored
              if (!(e.username || e.type === 'player')) continue;
              const entType = 'player';

              let entName = e.username || cleanMcText(e.displayName) || e.name || e.mobType || '';

              if (entName && entName !== 'air' && entName !== 'unknown' && !entName.startsWith('Armor Stand')) {
                detected.push({
                  id: e.id || id,
                  name: entName,
                  type: entType,
                  distance: dist
                });
              }
            }
          }
        }

        // Calculate exact 3D distance for other connected bots
        for (const accId in botInstances) {
          if (accId === this.config.id) continue;
          const otherBot = botInstances[accId];
          if (otherBot && otherBot.status === 'online' && otherBot.position) {
            const p1 = this.position;
            const p2 = otherBot.position;
            if (p1 && p2 && (p1.x !== 0 || p1.y !== 0 || p1.z !== 0) && (p2.x !== 0 || p2.y !== 0 || p2.z !== 0)) {
              const dx = p2.x - p1.x;
              const dy = p2.y - p1.y;
              const dz = p2.z - p1.z;
              const distCalc = Math.round(Math.sqrt(dx * dx + dy * dy + dz * dz) * 10) / 10;

              if (distCalc <= 100) {
                const idx = detected.findIndex(d => d.name.toLowerCase() === otherBot.config.username.toLowerCase());
                if (idx !== -1) {
                  detected[idx].distance = distCalc;
                } else {
                  detected.push({
                    id: otherBot.config.username,
                    name: otherBot.config.username,
                    type: 'player',
                    distance: distCalc
                  });
                }
              }
            }
          }
        }

        detected.sort((a, b) => a.distance - b.distance);
        this.nearbyEntities = detected.slice(0, 15);

        // Nobody is watching: send nothing (a browser that connects later gets the full state from init-multi)
        const liveRoom = io.sockets.adapter.rooms.get('live');
        if (!liveRoom || liveRoom.size === 0) {
          this._lastSent = {};
          return;
        }

        // Send only the sections that changed since the last update
        const sections = {
          position: this.position,
          scoreboard: this.scoreboard,
          inventory: this.inventory,
          entities: (this.nearbyEntities || []).map(e => ({ ...e, distance: Math.round(e.distance) }))
        };
        this._lastSent = this._lastSent || {};
        const payload = { botId: this.config.id };
        let changed = false;
        for (const key in sections) {
          const json = JSON.stringify(sections[key]);
          if (json !== this._lastSent[key]) {
            this._lastSent[key] = json;
            payload[key] = sections[key];
            changed = true;
          }
        }
        if (changed) io.to('live').emit('bot-spatial-update', payload);
      } catch (err) { }
    }, SPATIAL_INTERVAL_MS);
  }

  stopSpatialBroadcast() {
    if (this.spatialInterval) {
      clearInterval(this.spatialInterval);
      this.spatialInterval = null;
    }
  }

  start(authOverride) {
    if (this.status === 'connecting' || this.status === 'online') {
      this.addLog('Bot sudah berjalan atau sedang terhubung.', 'warning');
      return;
    }

    this.sessionAuth = authOverride === 'microsoft' || authOverride === 'offline'
      ? authOverride
      : (this.config.auth === 'microsoft' ? 'microsoft' : 'offline');
    this.bedrockAuthFailureMessage = null;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    this.updateStatus('connecting', 'Menghubungkan ke server...');
    this.addLog(`Menghubungkan bot (${this.config.username}) ke ${this.config.host}:${this.config.port}...`, 'system');

    if (this.config.platform === 'bedrock') {
      this.addLog(`Metode login Bedrock untuk sesi ini: ${this.sessionAuth === 'microsoft' ? 'Xbox/Microsoft' : 'Offline'}.`, 'system');
      this.startBedrockBot().catch((err) => {
        this.addLog(`Gagal menyiapkan koneksi Bedrock: ${err.message}`, 'error');
        this.updateStatus('error', err.message);
        this.scheduleReconnect();
      });
      return;
    }

    const AUTH_CACHE_DIR = path.join(__dirname, 'auth_cache');
    if (!fs.existsSync(AUTH_CACHE_DIR)) {
      try { fs.mkdirSync(AUTH_CACHE_DIR, { recursive: true }); } catch (e) { }
    }

    const options = {
      host: this.config.host,
      port: this.config.port,
      username: this.config.username,
      auth: this.config.auth === 'microsoft' ? 'microsoft' : 'offline',
    };

    if (this.config.auth === 'microsoft') {
      options.profilesFolder = path.join(AUTH_CACHE_DIR, this.config.id);
      options.onMsaCode = (data) => {
        pendingMsaCodes.set(this.config.id, {
          userCode: data.user_code,
          verificationUri: data.verification_uri
        });
        const msg = `🔐 KODE LOGIN MICROSOFT: Buka ${data.verification_uri} dan masukkan kode: ${data.user_code}`;
        this.addLog(msg, 'warning');
        io.emit('bot-msa-code', {
          botId: this.config.id,
          userCode: data.user_code,
          verificationUri: data.verification_uri,
          message: data.message
        });
      };
    }

    if (this.config.version && this.config.version !== 'auto') {
      options.version = this.config.version;
    }

    try {
      this.bot = mineflayer.createBot(options);
    } catch (err) {
      this.addLog(`Gagal membangkitkan bot: ${err.message}`, 'error');
      this.updateStatus('error', err.message);
      this.scheduleReconnect();
      return;
    }

    // Safety guard: Protect Mineflayer from NaN pitch/yaw corruption (Paper's invalid_player_movement kick)
    const rawLook = this.bot.look;
    this.bot.look = async (yaw, pitch, force) => {
      if (!Number.isFinite(yaw) || !Number.isFinite(pitch)) return;
      return rawLook.call(this.bot, yaw, pitch, force);
    };

    // Packet-level movement guard + diagnostics (see kick_logs.json)
    this.installMovementGuard();

    // Minecraft 1.20.3+ changed the score packets (no "action" field, separate reset_score packet).
    // Mineflayer ignores them, which leaves every scoreboard empty, so they are handled here.
    const botRef = this.bot;
    if (botRef._client) {
      botRef._client.on('scoreboard_score', (packet) => {
        if (this.bot !== botRef || packet.action !== undefined) return; // old protocol: mineflayer handles it
        const board = botRef.scoreboards && botRef.scoreboards[packet.scoreName];
        if (!board) return;
        const item = board.add(packet.itemName, packet.value);
        if (item) {
          item.lineNbt = packet.display_name || null;
          item.hideValue = packet.number_format === 0; // 0 = score number hidden
        }
        this.refreshScoreboard();
      });
      botRef._client.on('reset_score', (packet) => {
        if (this.bot !== botRef) return;
        const boards = packet.objective_name
          ? [botRef.scoreboards && botRef.scoreboards[packet.objective_name]]
          : Object.values(botRef.scoreboards || {});
        boards.forEach(board => { if (board) board.remove(packet.entity_name); });
        this.refreshScoreboard();
      });
    }

    this.bot.once('login', () => {
      pendingMsaCodes.delete(this.config.id);
      this.addLog(`Berhasil Login ke server ${this.config.host}!`, 'success');
    });

    this.bot.once('spawn', () => {
      this.updateStatus('online', 'Bot Online & Spawning');
      this.addLog(`Bot (${this.config.username}) berhasil masuk ke game world!`, 'success');
      this.startSpatialBroadcast();
      this.setupOneBlockListeners();
      this.armOneBlockResumeDelay();
      this.runScript();

      if (mineflayerViewer && this.config.viewerPort && this.config.autoViewer) {
        this.startViewer();
      }
    });

    // Handle Chest GUI Windows (Fix Your Generators, Menus, Warps)
    this.bot.on('windowOpen', (window) => {
      if (!window) return;
      const titleClean = cleanMcText(window.title);
      this.addLog(`GUI Terbuka: "${titleClean}"`, 'system');

      let hasAutoClicked = false;
      let debugLogged = false;
      let lastGuiSignature = '';

      const processWindow = () => {
        if (!this.bot || !this.bot.currentWindow) return;
        const currentWin = this.bot.currentWindow;
        const rawSlots = currentWin.slots || [];
        const rawCount = rawSlots.length;

        let containerSize = 54;
        if (typeof currentWin.inventoryStart === 'number' && currentWin.inventoryStart > 0) {
          containerSize = currentWin.inventoryStart;
        } else if (rawCount === 63) {
          containerSize = 27;
        } else if (rawCount >= 90 || /market|night|fix|generator|reward|shop|menu/i.test(titleClean)) {
          containerSize = 54;
        } else if (rawCount > 36) {
          containerSize = rawCount - 36;
        }

        const totalExpected = containerSize + 36;
        const loopMax = Math.max(rawCount, totalExpected);

        const slotsData = [];
        for (let i = 0; i < loopMax; i++) {
          const item = rawSlots[i];
          if (item) {
            const custom = getItemCustomText(item);
            const slotEntry = {
              slot: i,
              name: item.name || 'air',
              displayName: cleanMcText(item.displayName || item.name || ''),
              customName: custom.customName,
              count: item.count || 1
            };
            if (custom.nameRuns.length) slotEntry.nameRuns = custom.nameRuns;
            if (custom.loreRuns.length) slotEntry.loreRuns = custom.loreRuns;
            slotsData.push(slotEntry);
            if (process.env.DEBUG_GUI && !debugLogged && (custom.customName || custom.loreRuns.length)) {
              debugLogged = true;
              try {
                this.addLog(`[DEBUG_GUI] slot ${i} customName(raw)=${JSON.stringify(item.customName).slice(0, 300)} lore(raw)=${JSON.stringify(item.customLore).slice(0, 300)}`, 'system');
              } catch (e) { }
            }
          } else {
            slotsData.push({ slot: i, name: 'air', displayName: '', customName: '', count: 0 });
          }
        }

        this.activeGuiWindow = {
          id: currentWin.id,
          title: titleClean,
          inventoryStart: containerSize,
          slots: slotsData
        };

        // Only emit when the content actually changed (the window fires many update events while loading)
        const signature = JSON.stringify(this.activeGuiWindow);
        if (signature === lastGuiSignature) return;
        lastGuiSignature = signature;
        io.emit('bot-gui-open', { botId: this.config.id, gui: this.activeGuiWindow });
      };

      processWindow();
      [50, 150, 350, 700, 1200].forEach(delay => setTimeout(processWindow, delay));

      // Slot update events arrive in bursts: coalesce them into one trailing refresh
      let pendingRefresh = null;
      const debouncedProcess = () => {
        if (pendingRefresh) return;
        pendingRefresh = setTimeout(() => { pendingRefresh = null; processWindow(); }, 80);
      };

      try {
        window.on('updateSlot', debouncedProcess);
        window.on('windowItems', debouncedProcess);
      } catch (e) { }
    });

    this.bot.on('windowClose', () => {
      this.activeGuiWindow = null;
      io.emit('bot-gui-close', { botId: this.config.id });
    });

    this.bot.on('scoreboardPosition', () => {
      this.refreshScoreboard();
    });
    this.bot.on('scoreboardScoreUpdated', () => {
      this.refreshScoreboard();
    });
    this.bot.on('scoreboardTitleChanged', () => {
      this.refreshScoreboard();
    });

    this.bot.on('health', () => {
      if (!this.bot) return;
      this.health = {
        health: Math.round(this.bot.health || 0),
        food: Math.round(this.bot.food || 0)
      };
      io.emit('bot-health-update', { botId: this.config.id, health: this.health });
    });

    this.bot.on('death', async () => {
      if (this._isHandlingDeath) return;
      this._isHandlingDeath = true;

      this.addLog(`💀 [DEATH] Bot (${this.config.username}) mati!`, 'error');

      // 1. Matikan OneBlock AFK sementara dan simpan status sebelumnya
      const wasAfkActive = !!(this.oneBlockAfk && this.oneBlockAfk.enabled);
      if (wasAfkActive) {
        this.addLog('🛑 [ONEBLOCK] Mematikan sementara AFK OneBlock karena bot mati.', 'warning');
        this._oneBlockLoopRunning = false;
        this._oneBlockRunId = (this._oneBlockRunId || 0) + 1;
        this.oneBlockAfk.enabled = false;
        this.oneBlockAfk.status = 'idle';
        this.oneBlockAfk.statusMessage = 'Mati, menunggu respawn & kembali...';
        this.broadcastOneBlockState();
      }

      // 2. Jeda sejenak lalu kirim sinyal respawn
      await sleep(1000);
      if (!this.bot || this.status !== 'online') {
        this._isHandlingDeath = false;
        return;
      }

      this.addLog('✨ [RESPAWN] Mengirim paket respawn ke server...', 'system');
      try {
        if (typeof this.bot.respawn === 'function') {
          this.bot.respawn();
        } else if (this.bot._client) {
          this.bot._client.write('client_command', { actionId: 0 });
        }
      } catch (err) {
        this.addLog(`⚠️ Gagal mengirim respawn: ${err.message || err}`, 'warning');
      }

      // 3. Callback saat bot telah respawn kembali di game world
      const onRespawnComplete = async () => {
        try {
          this.addLog('✨ [RESPAWN] Bot berhasil hidup kembali di world.', 'success');
          await sleep(2000); // Tunggu posisi dan world stabil
          if (!this.bot || this.status !== 'online') return;

          // 4. Kirim command /back
          this.addLog('📍 [AUTO-BACK] Mengirimkan command "/back" ke chat...', 'system');
          this.bot.chat('/back');

          // 5. Aktifkan kembali OneBlock AFK jika sebelumnya aktif
          if (wasAfkActive) {
            await sleep(2500); // Tunggu perpindahan posisi (/back) selesai
            if (!this.bot || this.status !== 'online') return;
            this.addLog('🚀 [ONEBLOCK] Mengaktifkan kembali OneBlock AFK Auto-Breaker...', 'success');
            this.startOneBlockAfk();
          }
        } finally {
          this._isHandlingDeath = false;
        }
      };

      this.bot.once('spawn', onRespawnComplete);

      // Fallback: jika event spawn tidak terpanggil dalam 10 detik tapi bot sudah hidup
      setTimeout(() => {
        if (this._isHandlingDeath && this.bot && this.bot.isAlive && this.bot.health > 0) {
          try { this.bot.removeListener('spawn', onRespawnComplete); } catch (e) { }
          onRespawnComplete();
        }
      }, 10000);
    });

    let lastLoggedMsgText = '';

    this.bot.on('messagestr', (message, messagePosition, jsonMsg) => {
      if (!message || message.trim() === '') return;
      if (messagePosition === 'game_info' || messagePosition === 'actionbar') return;
      if (/❤|\bmana\b|\bstamina\b|\bhealth\b/i.test(message) && /\d+\/\d+/.test(message)) return;

      const trimmed = message.trim();
      if (trimmed === lastLoggedMsgText) return;
      lastLoggedMsgText = trimmed;

      if (/moved to lobby|kicked from theoneblock|invalid_player_movement|invalid move player/i.test(trimmed)) {
        if (this.oneBlockAfk && this.oneBlockAfk.enabled) {
          this.stopOneBlockAfk('Terlempar ke lobby oleh server (invalid_player_movement)');
        }
        if (this.bot && typeof this.bot.stopDigging === 'function') {
          try { this.bot.stopDigging(); } catch (e) { }
        }
        if (/kicked from|invalid_player_movement|invalid move player/i.test(trimmed)) {
          this.queueSubserverKick(trimmed);
        }
      }

      let actions = null;
      try { actions = extractChatActions(jsonMsg); } catch (e) { }
      this.addLog(trimmed, 'server', actions);
    });

    this.bot.on('kicked', (reason) => {
      let clean = reason;
      try { if (typeof reason === 'object') clean = JSON.stringify(reason); } catch (e) { }
      const isMoveKick = /invalid_player_movement|invalid move player/i.test(clean);
      recordKickIncident({
        botId: this.config.id,
        username: this.config.username,
        realm: this.config.host || 'theoneblock',
        type: 'proxy_kicked',
        reasons: [String(clean)],
        oneBlockAfkActive: !!(this.oneBlockAfk && this.oneBlockAfk.enabled),
        diagnostics: this.getMoveDiagSnapshot()
      });
      if (isMoveKick) {
        this.addLog(`⚠️ [KICKED - ILLEGAL MOVEMENT] Bot dikeluarkan server: ${clean}`, 'error');
        this.addLog('🛡️ [TINDAKAN OTOMATIS] Membatalkan seluruh loop & paket fisik. Bot dimatikan dan masuk antrean reconnect bersih.', 'system');
      } else {
        this.addLog(`Bot dikeluarkan (Kicked): ${clean}`, 'error');
      }
      this.cleanup();
      this.updateStatus('offline', isMoveKick ? 'Kicked (Illegal Movement)' : 'Kicked');
      this.scheduleReconnect();
    });

    this.bot.on('error', (err) => {
      this.addLog(`Error Koneksi: ${err.message || err}`, 'error');
      this.cleanup();
      this.updateStatus('error', err.message || 'Error Koneksi');
      this.scheduleReconnect();
    });

    this.bot.on('end', (reason) => {
      this.addLog(`Koneksi terputus: ${reason || 'Disconnected'}`, 'warning');
      this.cleanup();
      this.updateStatus('offline', 'Disconnected');
      this.scheduleReconnect();
    });
  }

  // Wraps the protocol client so every outgoing movement packet is checked before it reaches the server.
  // Vanilla/Paper kick with invalid_player_movement when x/y/z/yaw/pitch is NaN/Infinity or out of world bounds.
  installMovementGuard() {
    const bot = this.bot;
    const client = bot && bot._client;
    if (!client || typeof client.write !== 'function') return;

    const diag = {
      recentOutgoing: [],
      lastServerPosition: null,
      lastWorldChange: null,
      blockedCount: 0,
      repairedCount: 0,
      lastBlocked: null,
      lastGoodRotation: null,
      lastWarnAt: 0
    };
    this._moveDiag = diag;

    const MOVE_PACKETS = new Set(['position', 'position_look', 'look', 'vehicle_move']);
    const isBad = (key, v) => {
      if (typeof v !== 'number' || !Number.isFinite(v)) return true;
      if ((key === 'x' || key === 'z') && Math.abs(v) > 3.0e7) return true;
      if (key === 'y' && Math.abs(v) > 2.0e7) return true;
      return false;
    };
    const safeJson = (obj) => {
      try {
        return JSON.stringify(obj, (k, v) => (typeof v === 'bigint' ? v.toString() : v)).slice(0, 600);
      } catch (e) { return null; }
    };

    const rawWrite = client.write.bind(client);
    client.write = (name, params) => {
      if (MOVE_PACKETS.has(name) && params && typeof params === 'object') {
        const entry = { t: new Date().toISOString(), packet: name };
        const badFields = [];
        for (const key of ['x', 'y', 'z', 'yaw', 'pitch']) {
          if (params[key] === undefined) continue;
          entry[key] = params[key];
          if (isBad(key, params[key])) badFields.push(key);
        }
        if (params.onGround !== undefined) entry.onGround = params.onGround;

        if (badFields.length) {
          const posBad = badFields.some(k => k === 'x' || k === 'y' || k === 'z');
          const rotOnly = !posBad && diag.lastGoodRotation;
          const record = { ...entry, invalidFields: badFields, action: rotOnly ? 'repaired' : 'blocked' };
          // JSON cannot hold NaN/Infinity: store the raw values as text
          badFields.forEach(k => { record[k] = String(params[k]); });
          diag.lastBlocked = record;

          if (Date.now() - diag.lastWarnAt > 10000) {
            diag.lastWarnAt = Date.now();
            this.addLog(`🛡️ [MOVEMENT GUARD] Paket "${name}" berisi nilai tidak valid (${badFields.join(', ')}) → ${rotOnly ? 'diperbaiki dengan rotasi terakhir yang valid' : 'tidak dikirim'} agar tidak di-kick.`, 'warning');
            recordKickIncident({
              botId: this.config.id,
              username: this.config.username,
              type: 'invalid_packet_intercepted',
              packet: record,
              diagnostics: this.getMoveDiagSnapshot()
            });
          }

          if (rotOnly) {
            diag.repairedCount++;
            const fixed = { ...params, yaw: diag.lastGoodRotation.yaw, pitch: diag.lastGoodRotation.pitch };
            return rawWrite(name, fixed);
          }
          diag.blockedCount++;
          return; // drop the packet
        }

        if (params.yaw !== undefined && params.pitch !== undefined) {
          diag.lastGoodRotation = { yaw: params.yaw, pitch: params.pitch };
          if (this.bot && this.bot.entity) {
            this.savedRotation = {
              yaw: this.bot.entity.yaw,
              pitch: this.bot.entity.pitch
            };
          }
        }
        diag.recentOutgoing.push(entry);
        if (diag.recentOutgoing.length > 10) diag.recentOutgoing.shift();
      }
      return rawWrite(name, params);
    };

    client.on('position', (p) => {
      diag.lastServerPosition = {
        t: new Date().toISOString(),
        x: p.x, y: p.y, z: p.z, yaw: p.yaw, pitch: p.pitch,
        flags: safeJson(p.flags), teleportId: p.teleportId
      };
    });
    const onWorldChange = (packetName) => (p) => {
      diag.lastWorldChange = { t: new Date().toISOString(), packet: packetName, data: safeJson(p) };
      diag.recentOutgoing = [];
      diag.playerLoadedPending = true;
    };
    client.on('login', onWorldChange('login'));
    client.on('respawn', onWorldChange('respawn'));

    // Vanilla 1.21.2+ clients end every client tick with a "tick_end" packet, and 1.21.4+ clients send
    // "player_loaded" once the world is loaded after joining/respawning. Mineflayer 4.37 sends neither,
    // and servers/anti-cheats that track movement per client tick reject the bot's movement packets.
    let supportsTickEnd = false;
    let supportsPlayerLoaded = false;
    diag.tickEndSent = 0;
    diag.playerLoadedSent = 0;
    diag.playerLoadedPending = false;
    const detectSupport = () => {
      try {
        const types = require('minecraft-data')(bot.version).protocol.play.toServer.types;
        supportsTickEnd = !!types.packet_tick_end;
        supportsPlayerLoaded = !!types.packet_player_loaded;
      } catch (e) { supportsTickEnd = false; supportsPlayerLoaded = false; }
    };
    bot.once('login', detectSupport);

    client.on('position', () => {
      // Restore pandangan yang tersimpan (sebelum log off / pindah server) agar tidak menunduk ke bawah
      if (this.savedRotation && Number.isFinite(this.savedRotation.yaw) && Number.isFinite(this.savedRotation.pitch)) {
        setTimeout(() => {
          if (this.bot && this.bot._client && this.bot._client.state === 'play' && this.savedRotation) {
            try {
              this.bot.look(this.savedRotation.yaw, this.savedRotation.pitch, true);
            } catch (e) { }
          }
        }, 350);
      }

      // The first teleport after login/respawn means the world is ready: report it like a vanilla client
      if (!diag.playerLoadedPending || !supportsPlayerLoaded) return;
      diag.playerLoadedPending = false;
      setTimeout(() => {
        if (this.bot !== bot || client.state !== 'play') return;
        try { client.write('player_loaded', {}); diag.playerLoadedSent++; } catch (e) { }
      }, 100);
    });

    bot.on('physicsTick', () => {
      if (!supportsTickEnd || client.state !== 'play') return;
      try { client.write('tick_end', {}); diag.tickEndSent++; } catch (e) { }
    });
  }

  getMoveDiagSnapshot() {
    const diag = this._moveDiag || {};
    const ent = this.bot && this.bot.entity;
    const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 1000) / 1000 : String(v));
    return {
      negotiatedVersion: (this.bot && this.bot.version) || null,
      configVersion: this.config.version || 'auto',
      dimension: (this.bot && this.bot.game && this.bot.game.dimension) || null,
      entity: ent ? {
        x: num(ent.position && ent.position.x),
        y: num(ent.position && ent.position.y),
        z: num(ent.position && ent.position.z),
        yaw: num(ent.yaw),
        pitch: num(ent.pitch),
        onGround: ent.onGround,
        vehicle: ent.vehicle ? (ent.vehicle.name || 'unknown') : null
      } : null,
      lastServerPosition: diag.lastServerPosition || null,
      lastWorldChange: diag.lastWorldChange || null,
      recentOutgoingMovement: (diag.recentOutgoing || []).slice(-5),
      blockedPackets: diag.blockedCount || 0,
      repairedPackets: diag.repairedCount || 0,
      tickEndSent: diag.tickEndSent || 0,
      playerLoadedSent: diag.playerLoadedSent || 0,
      lastBlockedPacket: diag.lastBlocked || null
    };
  }

  // The proxy sends several chat lines for one subserver kick; collect them into a single record.
  queueSubserverKick(line) {
    if (this._pendingSubKick) {
      if (!this._pendingSubKick.reasons.includes(line)) this._pendingSubKick.reasons.push(line);
      return;
    }
    this._pendingSubKick = {
      botId: this.config.id,
      username: this.config.username,
      realm: 'theoneblock',
      type: 'subserver_moved_to_lobby',
      reasons: [line],
      oneBlockAfkActive: !!(this.oneBlockAfk && this.oneBlockAfk.enabled),
      diagnostics: this.getMoveDiagSnapshot() // captured immediately, before anything else changes
    };
    setTimeout(() => {
      const rec = this._pendingSubKick;
      this._pendingSubKick = null;
      if (!rec) return;
      recordKickIncident(rec);
      if (rec.reasons.some(r => /invalid_player_movement|invalid move player/i.test(r))) {
        this.addLog('🛡️ [SAFETY SHIELD] Kick illegal movement dari subserver terdeteksi. Aktivitas OneBlock dihentikan, detail diagnostik dicatat di kick_logs.json.', 'warning');
      }
    }, 1500);
  }

  cleanup() {
    this._bedrockAttempt = (this._bedrockAttempt || 0) + 1;
    this._isHandlingDeath = false;
    this.clearOneBlockResumeDelay();
    this.stopScript();
    this.stopSpatialBroadcast();
    if (this._oneBlockLoopTimeout) {
      clearTimeout(this._oneBlockLoopTimeout);
      this._oneBlockLoopTimeout = null;
    }
    this._oneBlockBusy = false;
    this.activeGuiWindow = null;
    if (this.bedrockClient) {
      try {
        this.bedrockClient.removeAllListeners();
        this.bedrockClient.disconnect();
      } catch (e) { }
      this.bedrockClient = null;
    }
    if (this.bot) {
      const targetBot = this.bot;
      this.bot = null;
      try {
        if (targetBot.viewer) {
          targetBot.viewer.close();
          targetBot.viewer = null;
        }
      } catch (e) { }
      this.viewerActive = false;
      try {
        if (typeof targetBot.removeAllListeners === 'function') {
          targetBot.removeAllListeners();
          targetBot.on('error', () => { });
        }
        if (targetBot._client && typeof targetBot._client.removeAllListeners === 'function') {
          targetBot._client.removeAllListeners();
          targetBot._client.on('error', () => { });
        }
        if (typeof targetBot.end === 'function') targetBot.end();
      } catch (e) { }
    }
  }

  async startBedrockBot() {
    if (!bedrockProtocol) {
      this.addLog('Modul bedrock-protocol tidak tersedia.', 'error');
      this.updateStatus('error', 'bedrock-protocol missing');
      return;
    }

    const attemptId = (this._bedrockAttempt || 0) + 1;
    this._bedrockAttempt = attemptId;
    this.updateStatus('connecting', 'Menghubungkan ke server Bedrock...');
    const bedrockPort = parseInt(this.config.port) || 19132;
    this.addLog(`Menghubungkan bot Bedrock (${this.config.username}) ke ${this.config.host}:${bedrockPort}...`, 'system');

    let bedrockHost;
    try {
      const resolved = await dns.lookup(this.config.host, { family: 4 });
      bedrockHost = resolved.address;
      this.addLog(`[Bedrock] Host ${this.config.host} di-resolve ke IPv4 ${bedrockHost} untuk transport RakNet.`, 'system');
    } catch (err) {
      if (this._bedrockAttempt !== attemptId) return;
      const message = `Gagal mencari alamat IPv4 server Bedrock (${this.config.host}): ${err.message}`;
      this.addLog(message, 'error');
      this.updateStatus('error', message);
      this.scheduleReconnect();
      return;
    }
    if (this._bedrockAttempt !== attemptId || this.status !== 'connecting') return;

    const AUTH_CACHE_DIR = path.join(__dirname, 'auth_cache');
    if (!fs.existsSync(AUTH_CACHE_DIR)) {
      try { fs.mkdirSync(AUTH_CACHE_DIR, { recursive: true }); } catch (e) { }
    }

    const options = {
      host: bedrockHost,
      port: bedrockPort,
      username: this.config.username,
      offline: this.sessionAuth !== 'microsoft',
      raknetBackend: 'raknet-node',
      connectTimeout: 20000,
      // connection steps (server found, version, port, refused/closed) are shown in the dashboard log
      conLog: (msg) => this.addLog(`[Bedrock] ${msg}`, 'system'),
      profilesFolder: path.join(AUTH_CACHE_DIR, this.config.id),
      onMsaCode: (data) => {
        pendingMsaCodes.set(this.config.id, {
          userCode: data.user_code,
          verificationUri: data.verification_uri
        });
        const msg = `🔐 KODE LOGIN MICROSOFT BEDROCK: Buka ${data.verification_uri} dan masukkan kode: ${data.user_code}`;
        this.addLog(msg, 'warning');
        io.emit('bot-msa-code', {
          botId: this.config.id,
          userCode: data.user_code,
          verificationUri: data.verification_uri,
          message: data.message
        });
      }
    };

    if (this.sessionAuth === 'microsoft') {
      options.authflow = new BedrockMicrosoftAuthflow(
        this.config.username,
        options.profilesFolder,
        {
          flow: 'live',
          authTitle: MicrosoftTitles.MinecraftNintendoSwitch,
          deviceType: 'Nintendo'
        },
        options.onMsaCode
      );
      this.addLog('[Bedrock] Perlindungan polling autentikasi Microsoft aktif untuk mencegah permintaan device-code ganda pada akun yang sama.', 'system');
    }

    try {
      this.bedrockClient = bedrockProtocol.createClient(options);
      this.bot = {
        username: this.config.username,
        entity: { position: new Vec3(0, 0, 0) },
        game: { dimension: 'overworld' },
        chat: (msg) => this.sendChat(msg)
      };
    } catch (err) {
      this.addLog(`Gagal membangkitkan bot Bedrock: ${err.message}`, 'error');
      this.updateStatus('error', err.message);
      this.scheduleReconnect();
      return;
    }

    const client = this.bedrockClient;
    const connectionStartedAt = Date.now();
    let connectionPhase = 'menyiapkan sesi';
    let clientStatus = 'belum mulai';
    let lastServerPacket = 'belum ada';
    let raknetDisconnectLogged = false;
    let loginResponseTimer = null;

    client.on('session', () => {
      if (this.bedrockClient !== client || this.sessionAuth !== 'microsoft') return;
      pendingMsaCodes.delete(this.config.id);
      io.emit('bot-msa-authenticated', { botId: this.config.id });
    });

    client.once('connect_allowed', () => {
      if (this.bedrockClient !== client) return;
      this.addLog('[Bedrock] Server ditemukan; menyiapkan sesi autentikasi. Handshake RakNet dimulai setelah sesi siap.', 'system');
      const raknet = client.connection && client.connection.raknet;
      if (raknet && typeof raknet.once === 'function') {
        raknet.once('connect', (info) => {
          if (this.bedrockClient !== client) return;
          connectionPhase = 'menunggu paket jaringan server';
          this.addLog(`[Bedrock] Transport RakNet terhubung${info && info.address ? ` ke ${info.address}` : ''}.`, 'system');
        });
        raknet.once('disconnect', (reason) => {
          if (this.bedrockClient !== client) return;
          raknetDisconnectLogged = true;
          this.addLog(`[Bedrock] Detail disconnect dari backend RakNet: ${formatRaknetDisconnect(reason)}`, 'warning');
        });
        raknet.once('error', (err) => {
          if (this.bedrockClient !== client) return;
          this.addLog(`[Bedrock] Error dari backend RakNet: ${formatRaknetDisconnect(err)}`, 'error');
        });
      }
    });

    client.on('status', (status) => {
      if (this.bedrockClient !== client) return;
      const statusNames = ['terputus', 'menghubungkan transport', 'autentikasi/login', 'inisialisasi dunia', 'sudah masuk dunia'];
      clientStatus = statusNames[status] || `status ${status}`;
      if (status === 2) {
        connectionPhase = 'menunggu respons login server';
        if (!loginResponseTimer) {
          loginResponseTimer = setTimeout(() => {
            loginResponseTimer = null;
            if (this.bedrockClient !== client || client.status !== 2) return;
            const message = `Server tidak membalas login Bedrock dalam ${BEDROCK_LOGIN_RESPONSE_TIMEOUT_MS / 1000} detik setelah network_settings. Periksa kecocokan protokol dan apakah server mengizinkan jenis autentikasi akun ini.`;
            this.addLog(message, 'error');
            this.updateStatus('error', message);
            client.close();
          }, BEDROCK_LOGIN_RESPONSE_TIMEOUT_MS);
        }
      }
      else if (status === 1) connectionPhase = 'handshake RakNet';
      else if (status === 3) connectionPhase = 'inisialisasi dunia';
      else if (status === 4) connectionPhase = 'sudah masuk dunia';
      this.addLog(`[Bedrock] Status protokol: ${clientStatus}.`, 'system');
    });

    client.on('packet', (packet) => {
      if (this.bedrockClient !== client) return;
      const packetName = packet && packet.data && packet.data.name;
      if (!packetName) return;
      lastServerPacket = packetName;
      if (['network_settings', 'play_status', 'server_to_client_handshake', 'disconnect', 'resource_packs_info', 'start_game'].includes(packetName)) {
        this.addLog(`[Bedrock] Paket server diterima: ${packetName}.`, packetName === 'disconnect' ? 'warning' : 'system');
      }
    });

    client.once('join', () => {
      if (this.bedrockClient !== client) return;
      clearTimeout(loginResponseTimer);
      loginResponseTimer = null;
      connectionPhase = 'login ke server';
      this.addLog(`Berhasil Login ke server Bedrock ${this.config.host}!`, 'success');
      this.updateStatus('online', 'Online di Bedrock World');
      this.startSpatialBroadcast();
      this.runScript();
    });

    client.once('spawn', () => {
      if (this.bedrockClient !== client) return;
      connectionPhase = 'memuat dunia';
      this.updateStatus('online', 'Bot Online & Spawning');
      this.addLog(`Bot Bedrock (${this.config.username}) berhasil masuk ke game world!`, 'success');
    });

    client.on('set_health', (packet) => {
      if (packet && packet.health !== undefined) {
        this.health = {
          health: Math.round(packet.health),
          food: 20
        };
        io.emit('bot-health-update', { botId: this.config.id, health: this.health });
      }
    });

    // Own start position and dimension
    client.on('start_game', (packet) => {
      if (!packet || !packet.player_position) return;
      const pos = packet.player_position;
      this.position = {
        x: Math.round(pos.x * 10) / 10,
        y: Math.round(pos.y * 10) / 10,
        z: Math.round(pos.z * 10) / 10,
        yaw: 0,
        pitch: 0,
        dimension: typeof packet.dimension === 'string' ? packet.dimension : 'overworld'
      };
      if (this.bot && this.bot.entity) this.bot.entity.position = new Vec3(pos.x, pos.y, pos.z);
    });

    client.on('move_player', (packet) => {
      if (!packet || !packet.position || !isOwnMovePacket(client, packet)) return;
      const yaw = packet.yaw !== undefined ? packet.yaw : (packet.rotation && packet.rotation.z) || 0;
      const pitch = packet.pitch !== undefined ? packet.pitch : (packet.rotation && packet.rotation.x) || 0;
      this.position = {
        x: Math.round(packet.position.x * 10) / 10,
        y: Math.round(packet.position.y * 10) / 10,
        z: Math.round(packet.position.z * 10) / 10,
        yaw: Math.round(yaw),
        pitch: Math.round(pitch),
        dimension: (this.position && this.position.dimension) || 'overworld'
      };
      if (this.bot && this.bot.entity) {
        this.bot.entity.position = new Vec3(packet.position.x, packet.position.y, packet.position.z);
      }
    });

    client.on('text', (packet) => {
      const cleaned = cleanMcText(formatBedrockText(packet));
      if (cleaned) {
        const isChat = packet.type === 'chat' || packet.type === 'whisper';
        this.addLog(cleaned, isChat ? 'chat' : 'info');
      }
    });

    client.on('kick', (reason) => {
      if (this.bedrockClient !== client) return;
      const rawReason = reason && typeof reason === 'object' ? (reason.message || reason.reason || JSON.stringify(reason)) : String(reason);
      const cleanReason = cleanMcText(rawReason);
      this.addLog(`Dikeluarkan dari server Bedrock: ${cleanReason}`, 'warning');
      this.updateStatus('offline', 'Dikeluarkan');
    });

    client.on('error', (err) => {
      if (this.bedrockClient !== client) return;
      const message = formatBedrockConnectionError(err, this.sessionAuth);
      if (this.sessionAuth === 'microsoft' && isTerminalMicrosoftAuthError(err)) {
        this.bedrockAuthFailureMessage = message;
      }
      this.addLog(message, 'error');
      this.updateStatus('error', message);
    });

    client.once('close', () => {
      if (this.bedrockClient !== client) return;
      clearTimeout(loginResponseTimer);
      loginResponseTimer = null;
      const closeDetail = raknetDisconnectLogged
        ? 'Detail disconnect backend tercatat di atas.'
        : 'Tidak ada event disconnect RakNet yang memberikan detail tambahan.';
      const elapsedSeconds = ((Date.now() - connectionStartedAt) / 1000).toFixed(1);
      this.addLog(`Koneksi Bedrock ditutup setelah ${elapsedSeconds} dtk pada tahap ${connectionPhase} (status protokol: ${clientStatus}; paket server terakhir: ${lastServerPacket}). ${closeDetail}`, 'warning');
      this.cleanup();
      if (this.bedrockAuthFailureMessage) {
        this.updateStatus('error', this.bedrockAuthFailureMessage);
        this.addLog('Auto-reconnect dihentikan karena login Microsoft gagal. Klik "Mulai dengan Xbox" untuk mendapatkan kode baru.', 'warning');
        return;
      }
      this.updateStatus('offline', 'Terputus');
      this.scheduleReconnect();
    });
  }

  stop() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.addLog('Menghentikan bot secara manual...', 'system');
    this.cleanup();
    this.updateStatus('offline', 'Dihentikan oleh pengguna');
  }

  scheduleReconnect() {
    if (!this.config.autoReconnect) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);

    const delayMs = (this.config.reconnectDelay || 10) * 1000;
    this.addLog(`Auto-reconnect aktif. Mencoba menghubungkan kembali dalam ${this.config.reconnectDelay} detik...`, 'system');

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.status === 'offline' || this.status === 'error') {
        this.start(this.sessionAuth);
      }
    }, delayMs);
  }

  sendChat(message) {
    if (this.status !== 'online') {
      this.addLog(`Gagal mengirim: Bot (${this.config.username}) sedang offline!`, 'error');
      return;
    }
    try {
      if (this.config.platform === 'bedrock' && this.bedrockClient) {
        const c = this.bedrockClient;
        if (message.startsWith('/')) {
          c.queue('command_request', buildBedrockCommand(c.options && c.options.version, message));
        } else {
          c.queue('text', buildBedrockChat((c.profile && c.profile.name) || this.config.username, message));
        }
      } else if (this.bot) {
        this.bot.chat(message);
      }
      this.addLog(`[DIKIRIM] ${message}`, 'mychat');
    } catch (err) {
      this.addLog(`Gagal mengirim chat: ${err.message}`, 'error');
    }
  }

  clickGuiSlot(slotIndex) {
    if (!this.bot || !this.bot.currentWindow) return;
    try {
      this.bot.clickWindow(slotIndex, 0, 0);
      this.addLog(`Klik slot GUI #${slotIndex}`, 'system');
    } catch (e) {
      this.addLog(`Gagal klik GUI slot: ${e.message}`, 'error');
    }
  }

  // Full spatial data (used for the snapshot a browser gets when it switches live data on)
  getSpatialPayload() {
    return {
      botId: this.config.id,
      position: this.position,
      scoreboard: this.scoreboard,
      inventory: this.inventory,
      entities: this.nearbyEntities
    };
  }

  // Runs a command taken from a clickable chat message (same as clicking it in the game)
  runChatCommand(command) {
    if (this.config.platform === 'bedrock') {
      this.addLog('Klik pesan chat belum didukung untuk akun Bedrock.', 'warning');
      return;
    }
    if (this.status !== 'online' || !this.bot) {
      this.addLog(`Gagal menjalankan perintah: Bot (${this.config.username}) sedang offline!`, 'error');
      return;
    }
    const cmd = typeof command === 'string' ? command.trim() : '';
    if (!cmd.startsWith('/') || cmd.length > 200 || /[\r\n]/.test(cmd)) return;
    try {
      this.bot.chat(cmd);
      this.addLog(`[KLIK CHAT] ${cmd}`, 'mychat');
    } catch (err) {
      this.addLog(`Gagal menjalankan ${cmd}: ${err.message}`, 'error');
    }
  }

  // Re-read the scoreboard and log (once per change) where the data comes from, to help debugging
  refreshScoreboard() {
    if (!this.bot) return;
    const sb = extractScoreboard(this.bot);
    this.scoreboard = sb;
    const sig = `${sb.source}|${sb.title}|${sb.items.length > 0}`;
    if (sig !== this._scoreboardSig) {
      this._scoreboardSig = sig;
      const objectives = Object.keys(this.bot.scoreboards || {}).join(', ') || '-';
      const sidebar = findSidebarObjective(this.bot);
      this.addLog(`[SCOREBOARD] sumber=${sb.source} | judul="${sb.title}" | ${sb.items.length} baris | sidebar=${sidebar ? sidebar.name : '-'} | objective: ${objectives}`, 'system');
    }
  }

  // Resolves true when the bot emits `eventName`, or false after `ms` milliseconds.
  waitBotEvent(bot, eventName, ms) {
    return new Promise((resolve) => {
      let timer = null;
      const onEvent = () => { clearTimeout(timer); resolve(true); };
      timer = setTimeout(() => { bot.removeListener(eventName, onEvent); resolve(false); }, Math.max(0, ms));
      bot.once(eventName, onEvent);
    });
  }

  // Right-click an item from the inventory panel (e.g. a speed booster).
  // The item is moved/selected into the held slot, used with a right click, then everything
  // is put back so tools the bot relies on (pickaxe, rod, ...) stay where they were.
  async useInventoryItem(slot) {
    if (this.config.platform === 'bedrock') {
      this.addLog('Klik kanan item belum didukung untuk akun Bedrock.', 'warning');
      return;
    }
    if (this.status !== 'online' || !this.bot) {
      this.addLog(`Gagal klik kanan: Bot (${this.config.username}) sedang offline!`, 'error');
      return;
    }
    if (this.itemUseBusy) return;
    if (this.bot.currentWindow) {
      this.addLog('Gagal klik kanan: tutup GUI/container yang sedang terbuka dulu.', 'warning');
      return;
    }
    // 9-35 = inventory utama, 36-44 = hotbar
    if (!Number.isInteger(slot) || slot < 9 || slot > 44) return;

    const bot = this.bot;
    const item = bot.inventory.slots[slot];
    if (!item) {
      this.addLog(`Slot #${slot} kosong.`, 'warning');
      return;
    }

    this.itemUseBusy = true;
    const label = cleanMcText(item.displayName || item.name) || item.name;
    const prevQuick = bot.quickBarSlot;
    const heldSlot = 36 + prevQuick;
    let swapped = false;

    try {
      if (slot >= 36) {
        bot.setQuickBarSlot(slot - 36);
      } else {
        await bot.moveSlotItem(slot, heldSlot);
        swapped = true;
      }
      await sleep(250);

      // Register the listener first so a fast server response is not missed
      const guiOpening = this.waitBotEvent(bot, 'windowOpen', 1500);
      bot.activateItem();
      this.addLog(`[KLIK KANAN] ${label} (slot #${slot})`, 'mychat');

      // Some items (e.g. pet food) open a menu. The item must stay in hand while that menu is
      // open, because the server reads the held item when a slot in the menu is clicked.
      // Everything is put back only after the menu has been closed.
      let guiOpened = await guiOpening;
      if (guiOpened) {
        this.addLog(`GUI terbuka. ${label} tetap dipegang sampai GUI ditutup (pilih slot di GUI dengan klik kiri).`, 'system');
        const deadline = Date.now() + ITEM_GUI_MAX_WAIT_MS;
        while (guiOpened && Date.now() < deadline) {
          if (bot.currentWindow) await this.waitBotEvent(bot, 'windowClose', deadline - Date.now());
          // some menus close and immediately open a follow-up menu
          guiOpened = await this.waitBotEvent(bot, 'windowOpen', 800);
        }
        if (bot.currentWindow) {
          try { bot.closeWindow(bot.currentWindow); } catch (e) { }
          this.addLog('GUI ditutup otomatis karena terlalu lama tidak dipakai.', 'warning');
        }
        await sleep(400);
      } else {
        await sleep(400);
      }
    } catch (err) {
      this.addLog(`Gagal klik kanan ${label}: ${err.message}`, 'error');
    } finally {
      try {
        if (swapped) await bot.moveSlotItem(slot, heldSlot);
        if (bot.quickBarSlot !== prevQuick) bot.setQuickBarSlot(prevQuick);
      } catch (err) {
        this.addLog(`Gagal mengembalikan item ke slot semula: ${err.message}`, 'error');
      }
      this.itemUseBusy = false;
    }
  }

  closeGui() {
    if (!this.bot || !this.bot.currentWindow) return;
    try {
      this.bot.closeWindow(this.bot.currentWindow);
      this.activeGuiWindow = null;
      this.addLog(`GUI Window ditutup oleh pengguna.`, 'system');
      io.emit('bot-gui-close', { botId: this.config.id });
    } catch (e) {
      this.addLog(`Gagal menutup GUI Window: ${e.message}`, 'error');
    }
  }

  // --- OneBlock AFK Breaker Engine ---
  getOneBlockPayload() {
    const ob = this.oneBlockAfk || {};
    let targetBlockName = null;
    if (this.bot && ob.targetPos) {
      try {
        const blk = this.bot.blockAt(this.getOneBlockTargetInfo(ob.targetPos).block);
        if (blk && blk.name !== 'air' && blk.name !== 'cave_air') targetBlockName = blk.name;
      } catch (e) { }
    }
    const multi = this.findMultitool();
    return {
      enabled: !!ob.enabled,
      targetPos: ob.targetPos || { x: -6749, y: 99, z: -6749 },
      targetBlockName,
      status: ob.status || 'idle',
      statusMessage: ob.statusMessage || '',
      brokenCount: ob.brokenCount || 0,
      autoEat: ob.autoEat !== false,
      ignoreObstacles: ob.ignoreObstacles !== false,
      reconnectDelayEnabled: ob.reconnectDelayEnabled !== false,
      reconnectDelaySec: Number.isFinite(ob.reconnectDelaySec) ? ob.reconnectDelaySec : 15,
      resumeInMs: this._oneBlockResumeAt ? Math.max(0, this._oneBlockResumeAt - Date.now()) : 0,
      multitoolFound: !!multi,
      multitoolDurability: multi && multi.durability ? `${multi.durability.current}/${multi.durability.max}` : (ob.toolDurability || null)
    };
  }

  broadcastOneBlockState() {
    io.emit('bot-oneblock-update', {
      botId: this.config.id,
      oneBlockAfk: this.getOneBlockPayload()
    });
  }

  // Target coordinates may have 1 decimal. The block is the one containing the point (floor).
  // A whole number keeps the default aim inside that block (X/Z center, Y+0.3); a decimal is used as the exact aim point.
  getOneBlockTargetInfo(t = (this.oneBlockAfk && this.oneBlockAfk.targetPos) || { x: -6749, y: 99, z: -6749 }) {
    const block = new Vec3(Math.floor(t.x), Math.floor(t.y), Math.floor(t.z));
    const aimAxis = (v, base, def) => (Number.isInteger(v) ? base + def : v);
    const aim = new Vec3(aimAxis(t.x, block.x, 0.5), aimAxis(t.y, block.y, 0.3), aimAxis(t.z, block.z, 0.5));
    return { block, aim };
  }

  setOneBlockTarget(coords) {
    if (!coords || !Number.isFinite(coords.x) || !Number.isFinite(coords.y) || !Number.isFinite(coords.z)) return;
    if (!this.oneBlockAfk) this.oneBlockAfk = {};
    const r1 = (v) => Math.round(v * 10) / 10; // 1 decimal
    this.oneBlockAfk.targetPos = {
      x: r1(coords.x),
      y: r1(coords.y),
      z: r1(coords.z)
    };
    if (this.config.oneBlock) {
      this.config.oneBlock.target = { ...this.oneBlockAfk.targetPos };
      saveAccounts();
    }
    const { block, aim } = this.getOneBlockTargetInfo();
    this.addLog(`🎯 [ONEBLOCK] Target koordinat diatur ke: X:${this.oneBlockAfk.targetPos.x}, Y:${this.oneBlockAfk.targetPos.y}, Z:${this.oneBlockAfk.targetPos.z} → blok (${block.x}, ${block.y}, ${block.z}), titik bidik (${aim.x}, ${aim.y}, ${aim.z})`, 'system');
    this.broadcastOneBlockState();
    if (this.oneBlockAfk.enabled) {
      // Restart the loop so it uses the new target right away
      this._oneBlockRunId = (this._oneBlockRunId || 0) + 1;
      this._oneBlockLoopRunning = false;
      setTimeout(() => this.runOneBlockLoop(), 200);
    }
  }

  lockOneBlockTarget() {
    if (!this.bot || this.status !== 'online') {
      this.addLog('Gagal mengunci blok: Bot sedang offline.', 'warning');
      return false;
    }
    if (typeof this.bot.blockAtCursor === 'function') {
      try {
        const cursorBlock = this.bot.blockAtCursor(4.5);
        if (cursorBlock && cursorBlock.name !== 'air' && cursorBlock.name !== 'cave_air') {
          this.setOneBlockTarget(cursorBlock.position);
          this.addLog(`🎯 [ONEBLOCK] Mengunci blok di kursor: "${cursorBlock.name}" di (X:${cursorBlock.position.x}, Y:${cursorBlock.position.y}, Z:${cursorBlock.position.z})`, 'success');
          return true;
        }
      } catch (e) { }
    }
    if (this.bot.entity) {
      try {
        const eye = this.bot.entity.position.offset(0, 1.62, 0);
        const yaw = this.bot.entity.yaw;
        const pitch = this.bot.entity.pitch;
        const dx = -Math.sin(yaw) * Math.cos(pitch);
        const dy = -Math.sin(pitch);
        const dz = -Math.cos(yaw) * Math.cos(pitch);
        for (let d = 1; d <= 4; d += 0.5) {
          const pt = eye.offset(dx * d, dy * d, dz * d).floored();
          const blk = this.bot.blockAt(pt);
          if (blk && blk.name !== 'air' && blk.name !== 'cave_air' && blk.name !== 'water' && blk.name !== 'lava') {
            this.setOneBlockTarget(blk.position);
            this.addLog(`🎯 [ONEBLOCK] Mengunci blok di depan mata: "${blk.name}" di (X:${blk.position.x}, Y:${blk.position.y}, Z:${blk.position.z})`, 'success');
            return true;
          }
        }
      } catch (e) { }
    }
    // Fallback: use default coordinates -6749, 99, -6749
    this.setOneBlockTarget({ x: -6749, y: 99, z: -6749 });
    return true;
  }

  findMultitool() {
    if (!this.bot || !this.bot.inventory) return null;
    const items = this.bot.inventory.items();
    for (const item of items) {
      if (isMultitool(item)) {
        return { item, durability: getMultitoolDurability(item) };
      }
    }
    return null;
  }

  async equipMultitoolOrBestTool(block) {
    if (!this.bot || !this.bot.inventory) return;

    // 1. Detect & hold Multitool (Universal tool for stone, wood, dirt, ores, sand)
    const multi = this.findMultitool();
    if (multi) {
      const held = this.bot.heldItem;
      if (!held || held.slot !== multi.item.slot) {
        try {
          await this.bot.equip(multi.item, 'hand');
          const duraStr = multi.durability ? `[Durability: ${multi.durability.current}/${multi.durability.max}]` : '';
          this.addLog(`🛠️ [ONEBLOCK] Memegang Multitool ${duraStr}`, 'system');
        } catch (e) { }
      }
      return;
    }

    // 2. Fallback to standard pickaxe/axe if Multitool is not found
    const blockName = (block && block.name) || '';
    let preferredPattern = /_pickaxe$/i;
    if (/log|wood|planks|fence|slab_wood|sign|door|bookshelf|stem|hyphae/i.test(blockName)) {
      preferredPattern = /_axe$/i;
    } else if (/dirt|grass|sand|gravel|clay|soul_sand|soul_soil|mud|snow/i.test(blockName)) {
      preferredPattern = /_shovel$/i;
    }
    const candidates = this.bot.inventory.items().filter(i => preferredPattern.test(i.name));
    if (candidates.length > 0) {
      const held = this.bot.heldItem;
      if (!held || held.slot !== candidates[0].slot) {
        try { await this.bot.equip(candidates[0], 'hand'); } catch (e) { }
      }
    }
  }

  async handleAutoEat() {
    if (!this.bot || !this.bot.inventory) return;
    const foods = this.bot.inventory.items().filter(item => {
      const n = item.name.toLowerCase();
      return /cooked_|bread|apple|carrot|steak|potato|beef|porkchop|mutton|salmon|cod|golden_apple/i.test(n)
        && !/rotten_flesh|spider_eye|poisonous_potato|chorus_fruit/i.test(n);
    });
    if (foods.length === 0) return;
    const food = foods[0];
    const prevHeld = this.bot.heldItem;
    try {
      this.addLog(`🍖 [ONEBLOCK] Mengonsumsi makanan: ${food.name} (Lapar: ${this.bot.food})...`, 'system');
      await this.bot.equip(food, 'hand');
      await this.bot.consume();
      this.addLog(`✓ [ONEBLOCK] Selesai makan. Sisa food: ${this.bot.food}`, 'success');
    } catch (e) { }
    finally {
      if (prevHeld) {
        try { await this.bot.equip(prevHeld, 'hand'); } catch (e) { }
      }
    }
  }

  setupOneBlockListeners() {
    if (!this.bot) return;
    this.bot.on('blockUpdate', (oldBlock, newBlock) => {
      if (!this.oneBlockAfk || !this.oneBlockAfk.enabled) return;
      if (!this.bot || !this.bot.entity || !this.bot.entity.position) return;
      const target = this.getOneBlockTargetInfo().block;
      // Safety distance check: only trigger if bot is actually near target
      if (this.bot.entity.position.distanceTo(target) > 10) return;
      if (newBlock.position.x === target.x && newBlock.position.y === target.y && newBlock.position.z === target.z) {
        if (newBlock.name !== 'air' && newBlock.name !== 'cave_air' && newBlock.name !== 'void_air') {
          if (!this._oneBlockLoopRunning) {
            this.runOneBlockLoop();
          }
        }
      }
    });
  }

  // Called on every (re)login. When OneBlock AFK was running, it is held back for `reconnectDelaySec`
  // seconds so the server/realm can finish loading before the bot starts breaking again.
  armOneBlockResumeDelay() {
    this.clearOneBlockResumeDelay();
    const ob = this.oneBlockAfk;
    if (!ob || !ob.enabled || this.config.mode !== 'oneblock') return;
    if (!ob.reconnectDelayEnabled || !(ob.reconnectDelaySec > 0)) return;

    const delayMs = ob.reconnectDelaySec * 1000;
    this._oneBlockResumeAt = Date.now() + delayMs;
    ob.statusMessage = `Login kembali. Menunggu ${ob.reconnectDelaySec} detik sebelum melanjutkan AFK OneBlock...`;
    this.addLog(`⏳ [ONEBLOCK] Bot login kembali. AFK OneBlock dilanjutkan dalam ${ob.reconnectDelaySec} detik.`, 'system');
    this.broadcastOneBlockState();

    this._oneBlockResumeTimer = setTimeout(() => {
      this._oneBlockResumeTimer = null;
      this._oneBlockResumeAt = 0;
      if (!this.oneBlockAfk || !this.oneBlockAfk.enabled || this.status !== 'online') return;
      this.addLog(`▶️ [ONEBLOCK] Jeda ${ob.reconnectDelaySec} detik setelah login selesai. Melanjutkan AFK OneBlock.`, 'success');
      this.oneBlockAfk.statusMessage = 'Menambang OneBlock...';
      this.broadcastOneBlockState();
      this.runOneBlockLoop();
    }, delayMs);
  }

  clearOneBlockResumeDelay() {
    if (this._oneBlockResumeTimer) {
      clearTimeout(this._oneBlockResumeTimer);
      this._oneBlockResumeTimer = null;
    }
    this._oneBlockResumeAt = 0;
  }

  setOneBlockReconnectDelay(opts = {}) {
    if (!this.oneBlockAfk) return;
    if (opts.enabled !== undefined) this.oneBlockAfk.reconnectDelayEnabled = !!opts.enabled;
    if (opts.seconds !== undefined) {
      const sec = Math.round(Number(opts.seconds));
      if (Number.isFinite(sec)) this.oneBlockAfk.reconnectDelaySec = Math.max(0, Math.min(600, sec));
    }
    if (!this.config.oneBlock) this.config.oneBlock = {};
    this.config.oneBlock.reconnectDelayEnabled = this.oneBlockAfk.reconnectDelayEnabled;
    this.config.oneBlock.reconnectDelaySec = this.oneBlockAfk.reconnectDelaySec;
    saveAccounts();
    this.addLog(`⚙️ [ONEBLOCK] Jeda setelah reconnect: ${this.oneBlockAfk.reconnectDelayEnabled ? `${this.oneBlockAfk.reconnectDelaySec} detik` : 'nonaktif'}.`, 'system');
    this.broadcastOneBlockState();
  }

  startOneBlockAfk(options = {}) {
    if (this.config.platform === 'bedrock') {
      this.addLog('Fitur OneBlock AFK saat ini didesain untuk akun Java (Mineflayer).', 'warning');
      return;
    }
    if (this.status !== 'online' || !this.bot) {
      this.addLog('Gagal memulai OneBlock AFK: Bot sedang offline.', 'error');
      return;
    }
    if (this.config.mode !== 'oneblock') {
      this.addLog('Gagal memulai OneBlock AFK: akun ini memakai mode Tycoon. Ubah Mode AFK ke OneBlock di Pengaturan Bot.', 'warning');
      return;
    }

    if (options.targetPos && Number.isFinite(Number(options.targetPos.x)) && Number.isFinite(Number(options.targetPos.y)) && Number.isFinite(Number(options.targetPos.z))) {
      const r1 = (v) => Math.round(Number(v) * 10) / 10; // 1 decimal
      this.oneBlockAfk.targetPos = {
        x: r1(options.targetPos.x),
        y: r1(options.targetPos.y),
        z: r1(options.targetPos.z)
      };
    }
    if (options.autoEat !== undefined) this.oneBlockAfk.autoEat = !!options.autoEat;
    if (options.ignoreObstacles !== undefined) this.oneBlockAfk.ignoreObstacles = !!options.ignoreObstacles;

    this.oneBlockAfk.enabled = true;
    this.oneBlockAfk.status = 'active';
    this.oneBlockAfk.statusMessage = 'Menambang OneBlock...';

    if (!this.config.oneBlock) this.config.oneBlock = {};
    this.config.oneBlock.enabled = true;
    this.config.oneBlock.target = this.oneBlockAfk.targetPos;
    this.config.oneBlock.autoEat = this.oneBlockAfk.autoEat;
    this.config.oneBlock.ignoreObstacles = this.oneBlockAfk.ignoreObstacles;
    saveAccounts();

    const t = this.oneBlockAfk.targetPos;
    const multi = this.findMultitool();
    const multiStatus = multi ? `Multitool terdeteksi (${multi.durability ? `${multi.durability.current}/${multi.durability.max}` : 'Aktif'})` : 'Multitool tidak ditemukan (menggunakan tool biasa)';
    this.addLog(`🚀 [ONEBLOCK] AFK Auto-Break DIAKTIFKAN! Target: X:${t ? t.x : '-'}, Y:${t ? t.y : '-'}, Z:${t ? t.z : '-'}. ${multiStatus}`, 'success');
    this.broadcastOneBlockState();

    this.clearOneBlockResumeDelay(); // a manual start does not wait for the reconnect delay
    this.runOneBlockLoop();
  }

  stopOneBlockAfk(reason = 'Dihentikan pengguna') {
    if (!this.oneBlockAfk) return;
    this.clearOneBlockResumeDelay();
    this.oneBlockAfk.enabled = false;
    this.oneBlockAfk.status = 'idle';
    this.oneBlockAfk.statusMessage = reason;

    if (this.config.oneBlock) {
      this.config.oneBlock.enabled = false;
      saveAccounts();
    }

    this._oneBlockLoopRunning = false;
    this._oneBlockRunId = (this._oneBlockRunId || 0) + 1; // makes any running loop exit

    if (this.bot && typeof this.bot.stopDigging === 'function') {
      try { this.bot.stopDigging(); } catch (e) { }
    }

    this.addLog(`🛑 [ONEBLOCK] AFK Auto-Break DIMATIKAN: ${reason}`, 'warning');
    this.broadcastOneBlockState();
  }

  async safeLookAt(targetVec) {
    if (!this.bot || !this.bot.entity || !this.bot.entity.position) return false;
    const pos = this.bot.entity.position;
    if (!Number.isFinite(pos.x) || !Number.isFinite(pos.y) || !Number.isFinite(pos.z)) return false;
    if (!targetVec || !Number.isFinite(targetVec.x) || !Number.isFinite(targetVec.y) || !Number.isFinite(targetVec.z)) return false;

    const eyeHeight = (Number.isFinite(this.bot.entity.eyeHeight) && this.bot.entity.eyeHeight > 0)
      ? this.bot.entity.eyeHeight
      : 1.62;
    const eyePos = pos.offset(0, eyeHeight, 0);

    const dx = targetVec.x - eyePos.x;
    const dy = targetVec.y - eyePos.y;
    const dz = targetVec.z - eyePos.z;

    const groundDist = Math.sqrt(dx * dx + dz * dz);
    let yaw = Math.atan2(-dx, -dz);
    let pitch = Math.atan2(dy, groundDist);

    if (!Number.isFinite(yaw) || !Number.isFinite(pitch)) return false;

    const maxPitch = (89.5 * Math.PI) / 180;
    pitch = Math.max(-maxPitch, Math.min(maxPitch, pitch));

    try {
      await this.bot.look(yaw, pitch, true);
      return true;
    } catch (e) {
      return false;
    }
  }

  // Log helper for the OneBlock loop: the same message is shown at most once every `everyMs`
  obLog(key, message, type = 'warning', everyMs = 15000) {
    if (!this._obLogTimes) this._obLogTimes = {};
    const now = Date.now();
    if (this._obLogTimes[key] && now - this._obLogTimes[key] < everyMs) return;
    this._obLogTimes[key] = now;
    this.addLog(message, type);
  }

  // Which face of the target block the crosshair hits (0 bottom, 1 top, 2 north, 3 south, 4 west, 5 east).
  // Returns { face, obstructedBy } — obstructedBy is set when another block is in the way.
  getOneBlockDigFace(eyePos, aimPoint, blockPos) {
    try {
      if (this.bot.world && typeof this.bot.world.raycast === 'function') {
        const dir = aimPoint.minus(eyePos).normalize();
        const hit = this.bot.world.raycast(eyePos, dir, 6);
        if (hit && hit.position) {
          if (hit.position.equals(blockPos)) return { face: hit.face, obstructedBy: null };
          return { face: null, obstructedBy: hit };
        }
      }
    } catch (e) { }
    // Fallback: the face pointing most towards the eyes
    const dx = eyePos.x - (blockPos.x + 0.5);
    const dy = eyePos.y - (blockPos.y + 0.5);
    const dz = eyePos.z - (blockPos.z + 0.5);
    const ax = Math.abs(dx), ay = Math.abs(dy), az = Math.abs(dz);
    if (ay >= ax && ay >= az) return { face: dy > 0 ? 1 : 0, obstructedBy: null };
    if (ax >= az) return { face: dx > 0 ? 5 : 4, obstructedBy: null };
    return { face: dz > 0 ? 3 : 2, obstructedBy: null };
  }

  // Simulates holding left click on one block, like the vanilla client:
  // Simulasi murni F3+T: Kirim START digging -> ayunkan tangan setiap tick -> kirim FINISH digging
  // tanpa menunggu konfirmasi perubahan blok dari server (non-blocking continuous loop).
  async holdMineBlock(block, face, isAlive) {
    const bot = this.bot;
    const client = bot._client;
    const pos = block.position;

    // Estimasi waktu pukul cepat untuk Multitool dengan Efficiency 5 (+26 mining efficiency)
    let mfTime = 1200;
    try {
      if (typeof bot.digTime === 'function') {
        const calculated = bot.digTime(block);
        if (Number.isFinite(calculated) && calculated > 0) mfTime = calculated;
      }
    } catch (e) {
      mfTime = 1200;
    }

    if (!Number.isFinite(this._digFactor)) this._digFactor = 0.25;
    const finishAfter = Math.max(40, Math.round(mfTime * this._digFactor));

    const nextSeq = () => { this._digSeq = (this._digSeq || 0) + 1; return this._digSeq; };
    const t0 = Date.now();

    // 1. Kirim sinyal mulai menggali (Status 0: Start Digging)
    client.write('block_dig', { status: 0, location: pos, face, sequence: nextSeq() });
    bot.swingArm();

    // 2. Tahan pukulan dan ayunkan tangan setiap tick sampai durasi terpenuhi
    while (isAlive()) {
      const elapsed = Date.now() - t0;
      if (elapsed >= finishAfter) break;
      await sleep(50);
      bot.swingArm();
    }

    // 3. Kirim sinyal selesai menggali (Status 2: Finish Digging)
    client.write('block_dig', { status: 2, location: pos, face, sequence: nextSeq() });
    bot.swingArm();

    const ms = Date.now() - t0;
    return { result: 'broken', ms, finishAfter };
  }

  // Mencari blok apa pun yang sedang berada tepat di crosshair / pandangan mata bot (seperti F3+T)
  getBlockInCrosshair(maxDistance = 4.5) {
    if (!this.bot || !this.bot.entity || !this.bot.world) return null;
    try {
      if (typeof this.bot.blockAtEntityCursor === 'function') {
        const hit = this.bot.blockAtEntityCursor(this.bot.entity, maxDistance);
        if (hit && hit.position) {
          const blk = this.bot.blockAt(hit.position);
          if (blk && blk.name !== 'air' && blk.name !== 'cave_air' && blk.name !== 'void_air') {
            return { block: blk, face: hit.face !== undefined ? hit.face : 1 };
          }
        }
      }
    } catch (e) { }

    // Fallback raycast manual sepanjang vektor pandangan yaw/pitch bot
    try {
      const pos = this.bot.entity.position;
      const eyeHeight = Number.isFinite(this.bot.entity.eyeHeight) && this.bot.entity.eyeHeight > 0 ? this.bot.entity.eyeHeight : 1.62;
      const eye = pos.offset(0, eyeHeight, 0);
      const yaw = this.bot.entity.yaw;
      const pitch = this.bot.entity.pitch;
      const dir = new Vec3(-Math.sin(yaw) * Math.cos(pitch), -Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch));

      if (this.bot.world && typeof this.bot.world.raycast === 'function') {
        const hit = this.bot.world.raycast(eye, dir.normalize(), maxDistance);
        if (hit && hit.position) {
          const blk = this.bot.blockAt(hit.position);
          if (blk && blk.name !== 'air' && blk.name !== 'cave_air' && blk.name !== 'void_air') {
            return { block: blk, face: hit.face !== undefined ? hit.face : 1 };
          }
        }
      }

      // Stepping sampling
      for (let d = 0.5; d <= maxDistance; d += 0.25) {
        const pt = eye.offset(dir.x * d, dir.y * d, dir.z * d).floored();
        const blk = this.bot.blockAt(pt);
        if (blk && blk.name !== 'air' && blk.name !== 'cave_air' && blk.name !== 'void_air') {
          return { block: blk, face: 1 };
        }
      }
    } catch (e) { }
    return null;
  }

  // Melakukan perbaikan (repair) Multitool:
  // 1. Memegang multitool di tangan utama
  // 2. Shift + Klik Kanan (Sneak + activateItem)
  // 3. Menunggu GUI 'TOOL MODULES' terbuka
  // 4. Klik kiri pada ikon Anvil (Repair)
  // 5. Menutup GUI dan konfirmasi durability baru
  async repairMultitool() {
    if (!this.bot || this.status !== 'online') {
      this.addLog('Gagal repair: Bot sedang offline.', 'error');
      return false;
    }
    if (this._isRepairing) return false;
    this._isRepairing = true;

    try {
      const multi = this.findMultitool();
      if (!multi || !multi.item) {
        this.addLog('⚠️ Gagal repair: Multitool tidak ditemukan di inventory.', 'warning');
        return false;
      }

      this.addLog(`🔧 [REPAIR] Memulai perbaikan Multitool (Durability: ${multi.durability ? `${multi.durability.current}/${multi.durability.max}` : 'unknown'})...`, 'system');

      // 1. Pastikan memegang Multitool di main hand
      try {
        await this.bot.equip(multi.item, 'hand');
      } catch (e) { }
      await sleep(250);

      // 2. Shift + Klik Kanan (Sneak + activateItem)
      this.bot.setControlState('sneak', true);
      await sleep(150);

      const windowPromise = this.waitBotEvent(this.bot, 'windowOpen', 4000);
      try {
        this.bot.activateItem();
      } catch (e) {
        this.addLog(`⚠️ Gagal activateItem: ${e.message}`, 'warning');
      }
      await sleep(200);
      try {
        if (typeof this.bot.deactivateItem === 'function') this.bot.deactivateItem();
      } catch (e) { }
      this.bot.setControlState('sneak', false);

      // 3. Tunggu GUI "TOOL MODULES" terbuka
      await windowPromise;
      let currentWin = this.bot.currentWindow;
      if (!currentWin) {
        await sleep(500);
        currentWin = this.bot.currentWindow;
      }

      if (!currentWin) {
        this.addLog('⚠️ Gagal repair: Menu GUI "TOOL MODULES" tidak terbuka.', 'warning');
        return false;
      }

      const winTitle = cleanMcText(currentWin.title || '');
      this.addLog(`🖥️ [REPAIR] GUI "${winTitle}" terbuka. Memindai ikon Anvil (Repair)...`, 'system');
      await sleep(500);

      // 4. Cari ikon Anvil / Repair
      const slots = currentWin.slots || [];
      const searchLimit = (typeof currentWin.inventoryStart === 'number' && currentWin.inventoryStart > 0)
        ? currentWin.inventoryStart
        : Math.min(slots.length, 54);

      let anvilSlot = -1;
      for (let i = 0; i < searchLimit; i++) {
        const it = slots[i];
        if (!it) continue;
        const itName = (it.name || '').toLowerCase();
        const custom = getItemCustomText(it);
        const disp = (custom.customName || it.displayName || itName).toLowerCase();
        let loreStr = '';
        if (Array.isArray(custom.loreRuns)) {
          loreStr = custom.loreRuns.map(r => runsToPlainText(r)).join(' ').toLowerCase();
        }

        if (disp.includes('repair') || itName.includes('anvil') || loreStr.includes('restore your tool') || loreStr.includes('click to repair')) {
          anvilSlot = i;
          break;
        }
      }

      // Fallback slot 11 jika nama belum terbaca (posisi anvil pada menu TOOL MODULES)
      if (anvilSlot === -1 && slots[11]) {
        anvilSlot = 11;
      }

      if (anvilSlot === -1) {
        this.addLog('⚠️ Gagal repair: Ikon Anvil (Repair) tidak ditemukan di GUI.', 'warning');
        try { this.bot.closeWindow(currentWin); } catch (e) { }
        return false;
      }

      this.addLog(`🖱️ [REPAIR] Mengklik ikon Repair pada slot #${anvilSlot}...`, 'system');
      try {
        await this.bot.clickWindow(anvilSlot, 0, 0);
      } catch (err) {
        this.addLog(`⚠️ Gagal klik slot repair: ${err.message}`, 'warning');
      }

      // Tunggu server memproses repair & pemotongan balance
      await sleep(800);

      // Tutup GUI
      if (this.bot.currentWindow) {
        try {
          this.bot.closeWindow(this.bot.currentWindow);
        } catch (e) { }
        this.activeGuiWindow = null;
      }
      await sleep(350);

      // Kembalikan pandangan kamera bot ke OneBlock jika tersimpan
      if (this.savedRotation && Number.isFinite(this.savedRotation.yaw) && Number.isFinite(this.savedRotation.pitch)) {
        try { this.bot.look(this.savedRotation.yaw, this.savedRotation.pitch, true); } catch (e) { }
      }

      // 5. Cek durability terbaru
      const updatedMulti = this.findMultitool();
      if (updatedMulti && updatedMulti.durability) {
        this.addLog(`✨ [REPAIR SELESAI] Multitool berhasil diperbaiki! Durability sekarang: ${updatedMulti.durability.current}/${updatedMulti.durability.max}`, 'success');
      } else {
        this.addLog('✓ [REPAIR SELESAI] Permintaan perbaikan selesai dijalankan.', 'success');
      }
      this.broadcastOneBlockState();
      return true;
    } catch (err) {
      this.addLog(`❌ [REPAIR ERROR] ${err.message || err}`, 'error');
      return false;
    } finally {
      if (this.bot) this.bot.setControlState('sneak', false);
      this._isRepairing = false;
    }
  }

  async runOneBlockLoop() {
    if (!this.oneBlockAfk || !this.oneBlockAfk.enabled) return;
    // Still inside the wait-after-relogin window: the resume timer starts the loop later
    if (this._oneBlockResumeAt && Date.now() < this._oneBlockResumeAt) return;
    if (this.status !== 'online' || !this.bot || !this.bot.entity) {
      setTimeout(() => {
        if (this.oneBlockAfk && this.oneBlockAfk.enabled) this.runOneBlockLoop();
      }, 1000);
      return;
    }
    if (this._oneBlockLoopRunning) return;
    this._oneBlockLoopRunning = true;
    const runId = this._oneBlockRunId = (this._oneBlockRunId || 0) + 1;
    const bot = this.bot;
    const isAlive = () => this._oneBlockRunId === runId && this.oneBlockAfk && this.oneBlockAfk.enabled
      && this.status === 'online' && this.bot === bot && !!bot.entity;

    const { block: targetVec, aim: lookTarget } = this.getOneBlockTargetInfo();
    const setStatus = (msg) => {
      if (this.oneBlockAfk.statusMessage === msg) return;
      this.oneBlockAfk.statusMessage = msg;
      this.broadcastOneBlockState();
    };

    this.addLog(`⛏️ [ONEBLOCK] Mode klik-kiri-tahan (F3+T) AKTIF. Menambang blok di arah pandangan kursor bot.`, 'system');
    let lastBlockName = null;

    while (isAlive()) {
      try {
        // 1. Auto-Eat
        if (this.oneBlockAfk.autoEat && bot.food !== undefined && bot.food <= 14) {
          await this.handleAutoEat();
        }

        // 2. Position / distance
        const pos = bot.entity.position;
        if (!pos || !Number.isFinite(pos.x)) { await sleep(500); continue; }

        // 3. Auto-Repair Multitool jika Durability < 100
        const multiCheck = this.findMultitool();
        if (multiCheck && multiCheck.durability && Number.isFinite(multiCheck.durability.current)) {
          if (multiCheck.durability.current < 100) {
            this.addLog(`⚠️ [ONEBLOCK] Durability Multitool menipis (${multiCheck.durability.current}/${multiCheck.durability.max} < 100). Memulai perbaikan otomatis...`, 'warning');
            setStatus(`Memperbaiki Multitool (Durability: ${multiCheck.durability.current})...`);
            const repOk = await this.repairMultitool();
            if (repOk) {
              this.addLog('✅ [ONEBLOCK] Multitool berhasil diperbaiki! Melanjutkan penambangan OneBlock...', 'success');
              setStatus('Melanjutkan penambangan OneBlock...');
            } else {
              this.addLog('⚠️ [ONEBLOCK] Auto-repair belum berhasil. Menunggu 5 detik sebelum mencoba lagi...', 'warning');
              await sleep(5000);
            }
            continue;
          }
        }

        // 4. Hold the Multitool
        await this.equipMultitoolOrBestTool();

        // 4. Deteksi blok: Prioritas utama blok tepat di crosshair arah pandangan bot (seperti F3+T)
        let activeTargetBlock = null;
        let activeFace = 1;

        const crosshairHit = this.getBlockInCrosshair(4.5);
        if (crosshairHit && crosshairHit.block) {
          activeTargetBlock = crosshairHit.block;
          activeFace = crosshairHit.face !== undefined ? crosshairHit.face : 1;
        } else {
          // Jika crosshair mendeteksi air (sedang respawn) atau terhalang slab dengan opsi tembus penghalang
          const fallbackBlk = bot.blockAt(targetVec);
          if (fallbackBlk && fallbackBlk.name !== 'air' && fallbackBlk.name !== 'cave_air' && fallbackBlk.name !== 'void_air') {
            activeTargetBlock = fallbackBlk;
            activeFace = 1;
          }
        }

        // Jika blok sedang pecah / belum muncul kembali (air)
        if (!activeTargetBlock || activeTargetBlock.name === 'air' || activeTargetBlock.name === 'cave_air' || activeTargetBlock.name === 'void_air') {
          setStatus('Menahan klik kiri (menunggu blok muncul)...');
          bot.swingArm();
          await sleep(50);
          continue;
        }

        if (activeTargetBlock.name !== lastBlockName) {
          lastBlockName = activeTargetBlock.name;
          setStatus(`Menambang ${activeTargetBlock.name} (X:${activeTargetBlock.position.x}, Y:${activeTargetBlock.position.y}, Z:${activeTargetBlock.position.z})...`);
        }

        // 5. Hold left click sampai blok pecah
        const res = await this.holdMineBlock(activeTargetBlock, activeFace, isAlive);
        if (res.result === 'broken') {
          this.oneBlockAfk.brokenCount = (this.oneBlockAfk.brokenCount || 0) + 1;
          recordBreakIncident({
            botId: this.config.id,
            username: this.config.username,
            blockName: activeTargetBlock.name,
            coordinates: {
              x: activeTargetBlock.position.x,
              y: activeTargetBlock.position.y,
              z: activeTargetBlock.position.z
            },
            timeMs: res.ms,
            totalBroken: this.oneBlockAfk.brokenCount
          });
          if (this.oneBlockAfk.brokenCount === 1) {
            this.addLog(`✅ [ONEBLOCK] Blok pertama berhasil dipecah (${activeTargetBlock.name}, ${res.ms} ms). Penambangan berjalan.`, 'success');
          }
          if (this.oneBlockAfk.brokenCount % 10 === 0) this.broadcastOneBlockState();
          // Jeda antar blok 0 ms (langsung lanjut tanpa jeda)
        } else if (res.result === 'rejected') {
          this.obLog('rejected', `⚠️ [ONEBLOCK] Server belum menerima pecahnya ${activeTargetBlock.name} setelah ${res.finishAfter} ms. Waktu tahan diperpanjang otomatis.`, 'warning', 5000);
        } else if (res.result === 'unbreakable') {
          setStatus(`${activeTargetBlock.name} tidak bisa dipecah`);
          this.obLog('unbreakable', `⚠️ [ONEBLOCK] "${activeTargetBlock.name}" tidak bisa dipecah.`);
          await sleep(1000);
        }
      } catch (err) {
        this.obLog('error', `❌ [ONEBLOCK] Error di loop penambangan: ${err && err.message ? err.message : err}`, 'error', 10000);
        await sleep(300);
      }
    }

    if (this._oneBlockRunId === runId) this._oneBlockLoopRunning = false;
  }

  startViewer() {
    if (!this.bot || this.status !== 'online') {
      this.addLog('Gagal menyalakan kamera POV: Bot sedang offline.', 'warning');
      return false;
    }
    if (!mineflayerViewer || !this.config.viewerPort) {
      this.addLog('prismarine-viewer tidak tersedia atau port kamera belum diatur.', 'error');
      return false;
    }
    if (this.bot.viewer) {
      this.viewerActive = true;
      io.emit('bot-viewer-status', { botId: this.config.id, active: true, port: this.config.viewerPort });
      return true;
    }
    try {
      mineflayerViewer(this.bot, { port: this.config.viewerPort, firstPerson: true });
      this.viewerActive = true;
      this.addLog(`📹 [POV CAMERA] Kamera 3D WebGL POV aktif di port ${this.config.viewerPort}`, 'success');
      io.emit('bot-viewer-status', { botId: this.config.id, active: true, port: this.config.viewerPort });
      return true;
    } catch (e) {
      this.addLog(`Gagal menyalakan kamera 3D POV: ${e.message}`, 'error');
      return false;
    }
  }

  stopViewer() {
    if (this.bot && this.bot.viewer) {
      try {
        this.bot.viewer.close();
      } catch (e) { }
      this.bot.viewer = null;
    }
    this.viewerActive = false;
    this.addLog('📹 [POV CAMERA] Kamera 3D POV dinonaktifkan (hemat resource).', 'system');
    io.emit('bot-viewer-status', { botId: this.config.id, active: false, port: this.config.viewerPort });
  }

  getState() {
    return {
      config: this.config,
      status: this.status,
      health: this.health,
      position: this.position,
      scoreboard: this.scoreboard,
      inventory: this.inventory,
      entities: this.nearbyEntities,
      activeGui: this.activeGuiWindow,
      logs: this.logHistory,
      oneBlockAfk: this.getOneBlockPayload(),
      viewerActive: !!(this.bot && this.bot.viewer),
      viewerPort: this.config.viewerPort
    };
  }
}

// Map of Bot Instances
const botInstances = {};
accounts.forEach(acc => {
  botInstances[acc.id] = new BotManager(acc);
});

// Security Configuration Management
const SECURITY_FILE = path.join(__dirname, 'security_config.json');
let securityConfig = {
  enabled: true,
  password: process.env.DASHBOARD_PASSWORD || 'admin123'
};

function loadSecurityConfig() {
  try {
    if (fs.existsSync(SECURITY_FILE)) {
      const data = JSON.parse(fs.readFileSync(SECURITY_FILE, 'utf8'));
      securityConfig = { ...securityConfig, ...data };
    }
  } catch (err) {
    console.error('Gagal membaca security_config.json:', err.message);
  }
}

function saveSecurityConfig() {
  try {
    fs.writeFileSync(SECURITY_FILE, JSON.stringify(securityConfig, null, 2), 'utf8');
  } catch (err) {
    console.error('Gagal menyimpan security_config.json:', err.message);
  }
}
loadSecurityConfig();

const activeTokens = new Set();
const pendingMsaCodes = new Map();

// Middleware & Static Files
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

app.get('/api/accounts', (req, res) => {
  const summary = Object.values(botInstances).map(b => b.getState());
  res.json(summary);
});

app.post('/api/cli/auth', (req, res) => {
  const password = req.body && typeof req.body.password === 'string' ? req.body.password : '';
  if (securityConfig.enabled && password !== securityConfig.password) {
    return res.status(401).json({ error: 'Kata sandi dashboard salah.' });
  }
  const token = `cli_${Math.random().toString(36).substring(2)}${Date.now().toString(36)}`;
  activeTokens.add(token);
  return res.json({ token, securityEnabled: securityConfig.enabled });
});

app.use('/api/cli', (req, res, next) => {
  const authorization = req.get('authorization') || '';
  const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
  if (!activeTokens.has(token)) return res.status(401).json({ error: 'Sesi CLI tidak valid atau sudah dikunci. Login kembali.' });
  next();
});

app.post('/api/cli/lock', (req, res) => {
  const authorization = req.get('authorization') || '';
  const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
  activeTokens.delete(token);
  res.json({ ok: true });
});

app.get('/api/cli/state', (req, res) => {
  const bots = Object.values(botInstances).map(getCliBotState);
  res.json({
    security: { enabled: securityConfig.enabled },
    quickCommands,
    bots
  });
});

app.post('/api/cli/action', (req, res) => {
  const payload = req.body && typeof req.body === 'object' ? req.body : {};
  const bot = payload.botId ? getBot(payload.botId) : null;
  const requireBot = () => {
    if (bot) return true;
    res.status(404).json({ error: `Akun bot '${payload.botId || ''}' tidak ditemukan.` });
    return false;
  };

  switch (payload.action) {
    case 'start-bot':
      if (!requireBot()) return;
      bot.start(payload.auth);
      return res.json({ ok: true });
    case 'stop-bot':
      if (!requireBot()) return;
      bot.stop();
      return res.json({ ok: true });
    case 'start-all':
      Object.values(botInstances).forEach(instance => instance.start());
      return res.json({ ok: true });
    case 'stop-all':
      Object.values(botInstances).forEach(instance => instance.stop());
      return res.json({ ok: true });
    case 'send-chat':
      if (!requireBot()) return;
      if (typeof payload.message !== 'string' || !payload.message.trim()) return res.status(400).json({ error: 'Pesan tidak boleh kosong.' });
      bot.sendChat(payload.message);
      return res.json({ ok: true });
    case 'run-chat-command':
      if (!requireBot()) return;
      if (typeof payload.command !== 'string' || !payload.command.trim()) return res.status(400).json({ error: 'Command tidak boleh kosong.' });
      bot.runChatCommand(payload.command);
      return res.json({ ok: true });
    case 'use-item':
    case 'click-gui-slot':
      if (!requireBot()) return;
      if (!Number.isInteger(payload.slot) || payload.slot < 0) return res.status(400).json({ error: 'Slot harus berupa bilangan bulat nol atau lebih.' });
      if (payload.action === 'use-item') bot.useInventoryItem(payload.slot);
      else bot.clickGuiSlot(payload.slot);
      return res.json({ ok: true });
    case 'close-gui':
      if (!requireBot()) return;
      bot.closeGui();
      return res.json({ ok: true });
    case 'update-bot-config':
      if (!requireBot()) return;
      if (!payload.config || typeof payload.config !== 'object' || Array.isArray(payload.config)) return res.status(400).json({ error: 'Konfigurasi harus berupa object.' });
      applyBotConfigUpdate(bot, payload.config);
      return res.json({ ok: true });
    case 'add-account':
      try {
        const created = addAccount(payload.account);
        return res.json({ ok: true, bot: getCliBotState(getBot(created.config.id)) });
      } catch (err) {
        return res.status(400).json({ error: `Gagal menambah akun: ${err.message}` });
      }
    case 'remove-account':
      if (!requireBot()) return;
      bot.stop();
      delete botInstances[payload.botId];
      saveAccounts();
      io.emit('account-removed', { botId: payload.botId });
      return res.json({ ok: true });
    case 'update-quick-commands':
      quickCommands = sanitizeQuickCommands(payload.commands);
      try {
        fs.writeFileSync(QUICK_FILE, JSON.stringify(quickCommands, null, 2));
      } catch (err) {
        console.error('Gagal menyimpan quick_commands.json:', err.message);
        return res.status(500).json({ error: `Gagal menyimpan quick commands: ${err.message}` });
      }
      io.emit('quick-commands', quickCommands);
      return res.json({ ok: true, quickCommands });
    case 'update-security-config':
      if (!payload.config || typeof payload.config.enabled !== 'boolean') return res.status(400).json({ error: 'Pengaturan keamanan memerlukan enabled true/false.' });
      securityConfig.enabled = payload.config.enabled;
      if (typeof payload.config.password === 'string' && payload.config.password.trim()) securityConfig.password = payload.config.password.trim();
      saveSecurityConfig();
      io.emit('security-config-updated', { enabled: securityConfig.enabled });
      return res.json({ ok: true, security: { enabled: securityConfig.enabled } });
    case 'snapshot':
      return res.json(Object.values(botInstances).map(instance => instance.getSpatialPayload()));
    default:
      return res.status(400).json({ error: `Aksi CLI tidak dikenal: ${payload.action || ''}` });
  }
});

// Merges a config update into an account. An unknown mode is ignored; switching an account
// to Tycoon stops a running OneBlock AFK so the two scripts never run on the same account.
function applyBotConfigUpdate(bot, newConfig) {
  const update = { ...newConfig };
  if (update.mode !== undefined && !BOT_MODES.includes(update.mode)) delete update.mode;
  const prevMode = bot.config.mode;
  bot.config = { ...bot.config, ...update };
  if (prevMode !== bot.config.mode) {
    bot.addLog(`🔀 Mode AFK akun diubah ke ${bot.config.mode === 'oneblock' ? 'OneBlock' : 'Tycoon'}.`, 'system');
    if (bot.config.mode !== 'oneblock' && bot.oneBlockAfk && bot.oneBlockAfk.enabled) {
      bot.stopOneBlockAfk('Mode akun diubah ke Tycoon');
    }
  }
  saveAccounts();
  io.emit('bot-config-updated', { botId: bot.config.id, config: bot.config });
}

function getCliBotState(bot) {
  const state = bot.getState();
  const { password, scriptText, ...config } = state.config;
  return {
    ...state,
    config,
    pendingMsaCode: pendingMsaCodes.get(config.id) || null
  };
}

function addAccount(newAccData) {
  if (!newAccData || typeof newAccData !== 'object') throw new Error('Data akun tidak valid.');

  const platform = String(newAccData.platform || 'java').toLowerCase();
  const type = String(newAccData.type || 'cracked').toLowerCase();
  const rawUsername = String(newAccData.username || '').trim();
  const password = String(newAccData.password || '').trim();
  const host = String(newAccData.host || 'alwination.id').trim();
  const defaultPort = platform === 'bedrock' ? 19132 : 25565;
  const port = parseInt(newAccData.port || defaultPort);
  const version = String(newAccData.version || 'auto');

  if (!rawUsername) throw new Error('Username / Email tidak boleh kosong!');
  if (!/^[a-zA-Z0-9.-]{1,253}$/.test(host)) throw new Error('Host server tidak valid!');
  if (isNaN(port) || port < 1 || port > 65535) throw new Error('Port harus berupa angka 1-65535!');

  const safeId = rawUsername.toLowerCase().replace(/[^a-z0-9_]/g, '_');
  let botId = safeId;
  if (botInstances[botId]) botId = `${safeId}_${Date.now().toString(36)}`;

  const existingPorts = Object.values(botInstances).map(b => b.config.viewerPort || 3000);
  let nextViewerPort = 3001;
  while (existingPorts.includes(nextViewerPort)) nextViewerPort++;

  const mode = BOT_MODES.includes(newAccData.mode) ? newAccData.mode : 'tycoon';
  const targetServer = String(newAccData.targetServer || '').trim();
  const nextCmdRaw = String(newAccData.nextCmd || '').trim();
  const autoCmdsList = [];
  if (type === 'cracked') autoCmdsList.push({ cmd: `/login ${password || '{password}'}`, delaySec: 2 });
  if (targetServer) {
    const cleanServer = targetServer.replace(/^\/server\s+/, '').replace(/^\//, '');
    autoCmdsList.push({ cmd: `/server ${cleanServer}`, delaySec: 2 });
  }
  if (nextCmdRaw) {
    const cleanNext = nextCmdRaw.startsWith('/') ? nextCmdRaw : `/${nextCmdRaw}`;
    autoCmdsList.push({ cmd: cleanNext, delaySec: 2 });
  }
  if (autoCmdsList.length === 0) {
    if (type === 'cracked') autoCmdsList.push({ cmd: `/login ${password || '{password}'}`, delaySec: 2 });
    if (mode === 'oneblock') {
      autoCmdsList.push({ cmd: '/server theoneblock', delaySec: 2 });
    } else {
      autoCmdsList.push({ cmd: '/server tycoon', delaySec: 2 });
      autoCmdsList.push({ cmd: '/is', delaySec: 2 });
    }
  }

  const scriptLines = [];
  autoCmdsList.forEach((row, idx) => {
    if (idx > 0) scriptLines.push(`wait ${(row.delaySec || 2) * 20}`);
    let command = row.cmd;
    if (!command.toLowerCase().startsWith('send ')) {
      if (!command.startsWith('/')) command = `/${command}`;
      command = `send ${command}`;
    }
    scriptLines.push(command);
  });

  const newConfig = {
    id: botId,
    username: rawUsername,
    password,
    platform,
    type,
    auth: type === 'premium' ? 'microsoft' : 'offline',
    host: host || 'alwination.id',
    port: isNaN(port) ? defaultPort : port,
    viewerPort: nextViewerPort,
    version,
    mode,
    autoReconnect: true,
    reconnectDelay: 10,
    scriptEnabled: true,
    autoCmds: autoCmdsList,
    scriptText: scriptLines.join('\n')
  };

  const newBot = new BotManager(newConfig);
  botInstances[botId] = newBot;
  saveAccounts();
  io.emit('account-added', newBot.getState());
  return newBot.getState();
}

// WebSocket Handlers
io.on('connection', (socket) => {
  socket.emit('quick-commands', quickCommands);
  socket.on('update-quick-commands', (list) => {
    quickCommands = sanitizeQuickCommands(list);
    try {
      fs.writeFileSync(QUICK_FILE, JSON.stringify(quickCommands, null, 2));
    } catch (err) {
      console.error('Gagal menyimpan quick_commands.json:', err.message);
    }
    io.emit('quick-commands', quickCommands);
  });
  // If security is disabled, send init-multi directly once
  if (!securityConfig.enabled) {
    socket.emit('auth-status', { authenticated: true, securityEnabled: false });
    socket.emit('init-multi', Object.values(botInstances).map(b => b.getState()));
  } else {
    socket.emit('auth-status', { authenticated: false, securityEnabled: true });
  }

  socket.on('check-auth', (token) => {
    if (!securityConfig.enabled || (token && activeTokens.has(token))) {
      socket.emit('auth-status', { authenticated: true, securityEnabled: securityConfig.enabled });
      socket.emit('init-multi', Object.values(botInstances).map(b => b.getState()));
    } else {
      socket.emit('auth-status', { authenticated: false, securityEnabled: true });
    }
  });

  socket.on('verify-password', (payload) => {
    const pwd = payload ? payload.password : '';
    if (!securityConfig.enabled || pwd === securityConfig.password) {
      const token = 'tok_' + Math.random().toString(36).substring(2) + Date.now().toString(36);
      activeTokens.add(token);
      socket.emit('auth-success', { token, securityEnabled: securityConfig.enabled });
      socket.emit('init-multi', Object.values(botInstances).map(b => b.getState()));
    } else {
      socket.emit('auth-failed', { message: 'Kata sandi dashboard salah!' });
    }
  });

  socket.on('lock-session', (token) => {
    if (token) activeTokens.delete(token);
    socket.emit('auth-status', { authenticated: false, securityEnabled: securityConfig.enabled });
  });

  socket.on('update-security-config', (payload) => {
    if (!payload || typeof payload !== 'object') return;
    if (typeof payload.enabled === 'boolean') {
      securityConfig.enabled = payload.enabled;
    }
    if (typeof payload.password === 'string' && payload.password.trim().length > 0) {
      securityConfig.password = payload.password.trim();
    }
    saveSecurityConfig();
    io.emit('security-config-updated', { enabled: securityConfig.enabled });
  });

  // Bot control handlers
  socket.on('start-bot', (payload) => {
    const botId = typeof payload === 'string' ? payload : payload && payload.botId;
    const auth = payload && typeof payload === 'object' ? payload.auth : undefined;
    const bot = getBot(botId);
    if (bot) bot.start(auth);
  });

  socket.on('stop-bot', (botId) => {
    const bot = getBot(botId);
    if (bot) bot.stop();
  });

  socket.on('start-all-bots', () => {
    Object.values(botInstances).forEach(b => b.start());
  });

  socket.on('stop-all-bots', () => {
    Object.values(botInstances).forEach(b => b.stop());
  });

  socket.on('send-chat', (payload) => {
    const { botId, message } = payload || {};
    const bot = getBot(botId);
    if (bot && typeof message === 'string' && message.trim()) bot.sendChat(message);
  });

  socket.on('click-gui-slot', (payload) => {
    const { botId, slot } = payload || {};
    const bot = getBot(botId);
    if (bot && Number.isInteger(slot) && slot >= 0) bot.clickGuiSlot(slot);
  });

  // Live data switch: only browsers in the "live" room receive position/inventory/scoreboard updates
  const sendSnapshot = () => {
    Object.values(botInstances).forEach(b => socket.emit('bot-spatial-update', b.getSpatialPayload()));
  };
  socket.on('set-live', (enabled) => {
    if (enabled) {
      socket.join('live');
      sendSnapshot();
    } else {
      socket.leave('live');
    }
  });
  socket.on('request-snapshot', sendSnapshot);

  socket.on('run-chat-command', (payload) => {
    const { botId, command } = payload || {};
    const bot = getBot(botId);
    if (bot) bot.runChatCommand(command);
  });

  socket.on('use-item', (payload) => {
    const { botId, slot } = payload || {};
    const bot = getBot(botId);
    if (bot && Number.isInteger(slot)) bot.useInventoryItem(slot);
  });

  socket.on('close-gui-modal', (botId) => {
    const bot = getBot(botId);
    if (bot) bot.closeGui();
  });

  // OneBlock AFK breaker handlers
  socket.on('toggle-oneblock-afk', (payload) => {
    const { botId, enabled, options } = payload || {};
    const bot = getBot(botId);
    if (!bot) return;
    if (enabled) {
      bot.startOneBlockAfk(options);
    } else {
      bot.stopOneBlockAfk('Dimatikan via Web Dashboard');
    }
  });

  socket.on('set-oneblock-target', (payload) => {
    const { botId, coords } = payload || {};
    const bot = getBot(botId);
    if (bot && coords) bot.setOneBlockTarget(coords);
  });

  socket.on('lock-oneblock-target', (botId) => {
    const bot = getBot(botId);
    if (bot) bot.lockOneBlockTarget();
  });

  socket.on('repair-multitool', async (botId) => {
    const bot = getBot(botId);
    if (bot) await bot.repairMultitool();
  });

  socket.on('set-oneblock-reconnect-delay', (payload) => {
    const { botId, enabled, seconds } = payload || {};
    const bot = getBot(botId);
    if (bot) bot.setOneBlockReconnectDelay({ enabled, seconds });
  });

  socket.on('toggle-bot-viewer', (payload) => {
    const { botId, enabled } = payload || {};
    const bot = getBot(botId);
    if (!bot) return;
    if (enabled) {
      bot.startViewer();
    } else {
      bot.stopViewer();
    }
  });

  socket.on('update-bot-config', (payload) => {
    const { botId, newConfig } = payload || {};
    const bot = getBot(botId);
    if (bot && newConfig && typeof newConfig === 'object' && !Array.isArray(newConfig)) {
      applyBotConfigUpdate(bot, newConfig);
    }
  });

  socket.on('add-account', (newAccData) => {
    try {
      addAccount(newAccData);
    } catch (err) {
      console.error('Error adding account:', err);
      socket.emit('account-error', { message: `Gagal menambah akun: ${err.message}` });
    }
  });

  socket.on('remove-account', (botId) => {
    const bot = getBot(botId);
    if (bot) {
      bot.stop();
      delete botInstances[botId];
      saveAccounts();
      io.emit('account-removed', { botId });
    }
  });
});

// Auto Proxy Reset Schedule (Pagi 05:55 WIB Stop -> 06:15 WIB Start)
let lastProxyResetAction = null;

setInterval(() => {
  // Compute current WIB time (UTC+7)
  const now = new Date();
  const utc = now.getTime() + (now.getTimezoneOffset() * 60000);
  const wibTime = new Date(utc + (3600000 * 7));

  const hours = wibTime.getHours();
  const minutes = wibTime.getMinutes();
  const dateStr = wibTime.toISOString().split('T')[0];

  // At 05:58 WIB -> Disconnect all bots for proxy reset (7 min pause)
  if (hours === 5 && minutes === 58) {
    const actionKey = `STOP_${dateStr}`;
    if (lastProxyResetAction !== actionKey) {
      lastProxyResetAction = actionKey;
      console.log(`[SCHEDULE PROXY RESET] Jam 05:58 WIB: Mematikan seluruh bot (Jeda 7 Menit Reset Proxy Server Alwi)...`);
      Object.values(botInstances).forEach(bot => {
        bot.addLog('===========================================================', 'warning');
        bot.addLog('[SCHEDULE RESET PROXY] Mematikan bot jam 05:58 WIB (Reset Proxy Server Alwi)...', 'warning');
        bot.addLog('[SCHEDULE RESET PROXY] Bot akan otomatis login kembali jam 06:05 WIB (Jeda 7 menit).', 'info');
        bot.addLog('===========================================================', 'warning');
        bot.stop();
      });
      io.emit('schedule-notify', { message: '⚡ [05:58 WIB] Seluruh bot dimatikan otomatis untuk jeda Reset Proxy Server Alwi (7 menit).' });
    }
  }

  // At 06:05 WIB -> Reconnect all bots automatically
  if (hours === 6 && minutes === 5) {
    const actionKey = `START_${dateStr}`;
    if (lastProxyResetAction !== actionKey) {
      lastProxyResetAction = actionKey;
      console.log(`[SCHEDULE PROXY RESET] Jam 06:05 WIB: Reset proxy selesai, menyalakan kembali seluruh bot...`);
      Object.values(botInstances).forEach(bot => {
        bot.addLog('===========================================================', 'success');
        bot.addLog('[SCHEDULE RESET PROXY] Jam 06:05 WIB: Reset proxy selesai! Menyalakan kembali bot...', 'success');
        bot.addLog('===========================================================', 'success');
        bot.start();
      });
      io.emit('schedule-notify', { message: '🚀 [06:05 WIB] Reset proxy selesai. Seluruh bot otomatis dinyalakan kembali!' });
    }
  }
}, 20000);

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[STARTUP] Port ${PORT} sudah digunakan. Hentikan instance AFK App yang lama sebelum menjalankan instance baru.`);
  } else {
    console.error(`[STARTUP] Gagal membuka server pada port ${PORT}: ${err.message}`);
  }
  process.exit(1);
});

server.listen(PORT, () => {
  console.log(`====================================================`);
  console.log(` Minecraft Multi-AFK Server + Scoreboard & 3D Viewer`);
  console.log(` Port: ${PORT} | Total Akun: ${Object.keys(botInstances).length}`);
  console.log(` Akses Dashboard Web: http://localhost:${PORT}`);
  console.log(`====================================================`);
});

// Global Anti-Crash Protection for Uncaught Socket Errors
process.on('uncaughtException', (err) => {
  console.error('[ANTI-CRASH] Uncaught Exception ditangkap aman:', err.message || err);
});

process.on('unhandledRejection', (reason) => {
  console.error('[ANTI-CRASH] Unhandled Rejection ditangkap aman:', reason);
});
