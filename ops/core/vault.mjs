// Encrypted credential + session vault. AES-256-GCM with OPS_VAULT_KEY (base64, 32 bytes).
// Files: <opsDir>/vault.enc (all creds) and <opsDir>/sessions/<vendor>.enc (one storageState each).
// Creds can also be bootstrapped from env OPS_CREDS_<VENDOR_ID_UPPER_UNDERSCORE>='{"username":...}';
// env wins over the vault file. Nothing here ever logs a secret.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { opsDir } from './store.mjs';

const MAGIC = 'opsv1';

export function vaultKey() {
  const raw = process.env.OPS_VAULT_KEY;
  if (!raw) throw Error('OPS_VAULT_KEY is not set (generate one with: openssl rand -base64 32)');
  const key = Buffer.from(raw.trim(), 'base64');
  if (key.length !== 32) throw Error(`OPS_VAULT_KEY must be base64 of exactly 32 bytes (got ${key.length})`);
  return key;
}

export function encrypt(obj, key = vaultKey()) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return [MAGIC, iv.toString('base64'), c.getAuthTag().toString('base64'), body.toString('base64')].join('.');
}

export function decrypt(text, key = vaultKey()) {
  const [magic, iv, tag, body] = String(text).trim().split('.');
  if (magic !== MAGIC || !iv || !tag || body === undefined) throw Error('Vault file is not in the expected format');
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
    d.setAuthTag(Buffer.from(tag, 'base64'));
    return JSON.parse(Buffer.concat([d.update(Buffer.from(body, 'base64')), d.final()]).toString('utf8'));
  } catch {
    throw Error('Vault decrypt failed — OPS_VAULT_KEY does not match the key the vault was written with');
  }
}

function atomicWrite(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

const vaultFile = () => path.join(opsDir(), 'vault.enc');
const sessionFile = id => path.join(opsDir(), 'sessions', `${safeId(id)}.enc`);
function safeId(id) {
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(String(id || ''))) throw Error(`Invalid vendor id: ${id}`);
  return String(id);
}
export const envVarFor = id => `OPS_CREDS_${safeId(id).toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;

function readVault() {
  const f = vaultFile();
  if (!fs.existsSync(f)) return {};
  return decrypt(fs.readFileSync(f, 'utf8'));
}
function writeVault(v) { atomicWrite(vaultFile(), encrypt(v)); }

function envCreds(id) {
  const raw = process.env[envVarFor(id)];
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw 0;
    return v;
  } catch { throw Error(`${envVarFor(id)} is not a JSON object`); }
}

export function getCreds(vendorId) {
  const env = envCreds(vendorId);
  if (env) return env;
  if (!fs.existsSync(vaultFile())) return null;
  return readVault()[vendorId] ?? null;
}

export function setCreds(vendorId, obj) {
  safeId(vendorId);
  if (!obj || typeof obj !== 'object') throw Error('setCreds needs an object');
  const v = readVault();
  v[vendorId] = obj;
  writeVault(v);
}

export function deleteCreds(vendorId) {
  const v = readVault();
  if (!(vendorId in v)) return false;
  delete v[vendorId];
  writeVault(v);
  return true;
}

export function saveSession(vendorId, storageState, { source = 'unknown' } = {}) {
  if (!storageState || typeof storageState !== 'object') throw Error('saveSession needs a storageState object');
  const savedAt = new Date().toISOString();
  atomicWrite(sessionFile(vendorId), encrypt({ storageState, savedAt, source }));
  return { savedAt, source };
}

export function loadSession(vendorId) {
  const f = sessionFile(vendorId);
  if (!fs.existsSync(f)) return null;
  return decrypt(fs.readFileSync(f, 'utf8'));
}

export function clearSession(vendorId) {
  const f = sessionFile(vendorId);
  if (!fs.existsSync(f)) return false;
  fs.unlinkSync(f);
  return true;
}

// Inventory with no secrets. Includes vendors known by env, vault, or session file.
export function listVault() {
  const ids = new Set();
  for (const k of Object.keys(process.env)) if (k.startsWith('OPS_CREDS_') && process.env[k]) ids.add(k.slice(10).toLowerCase().replace(/_/g, '-'));
  if (fs.existsSync(vaultFile())) for (const k of Object.keys(readVault())) ids.add(k);
  const sd = path.join(opsDir(), 'sessions');
  if (fs.existsSync(sd)) for (const f of fs.readdirSync(sd)) if (f.endsWith('.enc')) ids.add(f.slice(0, -4));
  return [...ids].sort().map(vendor => {
    let s = null;
    try { s = loadSession(vendor); } catch { s = null; }
    let hasCreds = false;
    try { hasCreds = !!getCreds(vendor); } catch { hasCreds = false; }
    return { vendor, hasCreds, hasSession: !!s, sessionSavedAt: s?.savedAt ?? null, sessionSource: s?.source ?? null };
  });
}
