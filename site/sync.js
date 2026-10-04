// Synchronisation des plans avec un Gist secret du compte GitHub de l'élève.
//
// Chaque plan porte une révision (rev) renouvelée à chaque modification. On retient, pour chaque
// plan, la révision vue à la dernière synchro réussie (base). À la synchro suivante :
//   - un côté qui n'a pas bougé depuis la base prend la version de l'autre côté (modification ou suppression) ;
//   - si les deux côtés ont bougé, c'est un conflit, et l'élève choisit.

import * as store from './store.js';

const KEY = 'planificateur-cnam:sync';
const FILE = 'planificateur-cnam.json';
const API = 'https://api.github.com';

let cfg = loadConfig(); // { token, login, gist_id, base: { planId: rev }, last_sync }
let status = cfg ? 'idle' : 'off';
let detail = '';
let timer = null;
let running = false;
let rerun = false;
let pending = null; // { conflicts, merged } en attente d'un choix
const listeners = new Set();

function loadConfig() {
  try { return JSON.parse(localStorage.getItem(KEY)) || null; } catch { return null; }
}

function saveConfig() {
  try {
    if (cfg) localStorage.setItem(KEY, JSON.stringify(cfg));
    else localStorage.removeItem(KEY);
  } catch { /* la synchro reste active pour cette session */ }
}

function setStatus(next, message = '') {
  status = next;
  detail = message;
  for (const fn of listeners) fn(info());
}

export const info = () => ({
  status, detail, login: cfg?.login, gistId: cfg?.gist_id, lastSync: cfg?.last_sync, conflicts: pending?.conflicts ?? null,
});

export function onStatus(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

class SyncError extends Error {
  constructor(message, kind = 'error') { super(message); this.kind = kind; }
}

async function gh(path, { method = 'GET', body } = {}) {
  let res;
  try {
    res = await fetch(API + path, {
      method,
      cache: 'no-store',
      headers: {
        Authorization: `Bearer ${cfg.token}`,
        Accept: 'application/vnd.github+json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new SyncError('GitHub est injoignable. Les modifications restent sur cet appareil.', 'offline');
  }
  if (res.status === 401) throw new SyncError('GitHub refuse le jeton : il a expiré ou a été révoqué. Reconnecte-toi avec un nouveau jeton.', 'auth');
  if (res.status === 404) throw new SyncError('Introuvable sur GitHub.', 'missing');
  if (res.status === 403 || res.status === 422) {
    throw new SyncError('Le jeton n’a pas le droit d’écrire des Gists. Crée-le avec la permission « gist ».', 'auth');
  }
  if (!res.ok) throw new SyncError(`GitHub a répondu ${res.status}. Nouvel essai à la prochaine modification.`);
  return res.json();
}

const serialize = (plans) => JSON.stringify({ format: 'planificateur-cnam', version: 1, updated_at: new Date().toISOString(), plans }, null, 1);

async function findOrCreateGist() {
  for (let page = 1; page <= 10; page += 1) {
    const list = await gh(`/gists?per_page=100&page=${page}`);
    const hit = list.find((g) => g.files?.[FILE]);
    if (hit) return hit.id;
    if (list.length < 100) break;
  }
  try {
    const created = await gh('/gists', {
      method: 'POST',
      body: { description: 'Planificateur Cnam : mes plans de diplôme', public: false, files: { [FILE]: { content: serialize({}) } } },
    });
    return created.id;
  } catch (e) {
    // GitHub répond 404 quand le jeton n'a pas la permission « gist ».
    if (e.kind === 'missing') throw new SyncError('Le jeton n’a pas le droit de créer des Gists. Crée-le avec la permission « gist ».', 'auth');
    throw e;
  }
}

async function readRemote() {
  let gist;
  try {
    gist = await gh(`/gists/${cfg.gist_id}`);
  } catch (e) {
    if (e.kind !== 'missing') throw e;
    cfg.gist_id = await findOrCreateGist(); // Gist supprimé à la main : on en recrée un
    cfg.base = {};
    saveConfig();
    gist = await gh(`/gists/${cfg.gist_id}`);
  }
  const file = gist.files?.[FILE];
  if (!file) return {};
  let text = file.content;
  if (file.truncated) text = await (await fetch(file.raw_url, { cache: 'no-store' })).text();
  try {
    const doc = JSON.parse(text || '{}');
    return doc.plans && typeof doc.plans === 'object' ? doc.plans : {};
  } catch {
    throw new SyncError('Le fichier de synchronisation sur GitHub est illisible. Corrige-le ou supprime le Gist pour repartir de cet appareil.');
  }
}

/** Fusion à trois voies par plan. Exportée pour les tests. */
export function merge(local, remote, base) {
  const merged = {};
  const conflicts = [];
  const ids = new Set([...Object.keys(local), ...Object.keys(remote), ...Object.keys(base)]);
  for (const id of ids) {
    const l = local[id] ?? null;
    const r = remote[id] ?? null;
    const b = base[id] ?? null;
    if (l && r && l.rev === r.rev) { merged[id] = l; continue; }
    const localMoved = (l?.rev ?? null) !== b;
    const remoteMoved = (r?.rev ?? null) !== b;
    if (!localMoved) { if (r) merged[id] = r; continue; }
    if (!remoteMoved) { if (l) merged[id] = l; continue; }
    if (!l && !r) continue;
    conflicts.push({ id, local: l, remote: r });
  }
  return { merged, conflicts };
}

const revs = (plans) => Object.values(plans).map((p) => `${p.id}:${p.rev}`).sort().join();

async function finish(merged, remote) {
  if (revs(merged) !== revs(store.allPlans())) store.replaceAll(merged);
  if (revs(merged) !== revs(remote)) {
    await gh(`/gists/${cfg.gist_id}`, { method: 'PATCH', body: { files: { [FILE]: { content: serialize(merged) } } } });
  }
  cfg.base = Object.fromEntries(Object.values(merged).map((p) => [p.id, p.rev]));
  cfg.last_sync = new Date().toISOString();
  saveConfig();
  setStatus('idle');
}

export async function syncNow() {
  clearTimeout(timer);
  if (!cfg || pending) return;
  if (running) { rerun = true; return; }
  if (!navigator.onLine) { setStatus('offline', 'Pas de connexion : les modifications restent sur cet appareil.'); return; }
  running = true;
  setStatus('syncing');
  try {
    const remote = await readRemote();
    const { merged, conflicts } = merge(store.allPlans(), remote, cfg.base || {});
    if (conflicts.length) {
      pending = { conflicts, merged, remote };
      setStatus('conflict', `${conflicts.length} plan(s) modifié(s) sur deux appareils.`);
      return;
    }
    await finish(merged, remote);
  } catch (e) {
    setStatus(e.kind === 'offline' ? 'offline' : 'error', e.message);
  } finally {
    running = false;
    if (rerun) { rerun = false; schedule(); }
  }
}

export function schedule(delay = 2500) {
  if (!cfg) return;
  clearTimeout(timer);
  if (status !== 'conflict') setStatus('pending');
  timer = setTimeout(syncNow, delay);
}

/** choices : { planId: 'local' | 'remote' | 'both' } */
export async function resolve(choices) {
  if (!pending) return;
  const { conflicts, merged, remote } = pending;
  for (const c of conflicts) {
    const pick = choices[c.id] || 'both';
    if (pick === 'local' && c.local) merged[c.id] = c.local;
    else if (pick === 'remote' && c.remote) merged[c.id] = c.remote;
    else if (pick === 'both') {
      if (c.remote) merged[c.id] = c.remote;
      if (c.local) {
        const copy = { ...c.local, id: store.newId(), rev: store.newId(), name: `${c.local.name} (cet appareil)` };
        if (c.remote) merged[copy.id] = copy;
        else merged[c.id] = c.local;
      }
    } else {
      delete merged[c.id]; // le côté retenu avait supprimé le plan
    }
  }
  pending = null;
  setStatus('syncing');
  try {
    await finish(merged, remote);
  } catch (e) {
    setStatus(e.kind === 'offline' ? 'offline' : 'error', e.message);
  }
  schedule(500); // l'autre appareil a pu écrire entre-temps
}

export async function connect(token) {
  const previous = cfg;
  cfg = { token: token.trim(), base: {} };
  setStatus('syncing');
  try {
    const user = await gh('/user');
    cfg.login = user.login;
    cfg.gist_id = await findOrCreateGist();
    saveConfig();
  } catch (e) {
    cfg = previous;
    setStatus(cfg ? 'error' : 'off', e.message);
    throw e;
  }
  await syncNow();
}

export function disconnect() {
  clearTimeout(timer);
  cfg = null;
  pending = null;
  saveConfig();
  setStatus('off');
}

export const isConnected = () => Boolean(cfg);

// Synchro automatique : après chaque modification locale, au retour sur l'onglet, au retour du réseau.
store.onChange((source) => { if (source === 'local') schedule(); });
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !cfg) return;
  const age = cfg.last_sync ? Date.now() - Date.parse(cfg.last_sync) : Infinity;
  if (age > 15000) syncNow();
});
window.addEventListener('online', () => { if (cfg) syncNow(); });
