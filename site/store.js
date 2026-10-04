// Plans de l'élève, gardés dans ce navigateur, et données publiées (catalogue, maquettes).

const KEY = 'planificateur-cnam:plans';
const listeners = new Set();
let memory = {}; // repli si le stockage du navigateur est indisponible
let persistent = true;

export const newId = () => (crypto.randomUUID ? crypto.randomUUID().replace(/-/g, '').slice(0, 12) : Math.random().toString(36).slice(2, 14));
const now = () => new Date().toISOString();

function readAll() {
  try {
    const raw = localStorage.getItem(KEY);
    persistent = true;
    return raw ? JSON.parse(raw) : {};
  } catch {
    persistent = false;
    return structuredClone(memory);
  }
}

function writeAll(plans, source) {
  memory = structuredClone(plans);
  try {
    localStorage.setItem(KEY, JSON.stringify(plans));
    persistent = true;
  } catch {
    persistent = false;
  }
  for (const fn of listeners) fn(source);
}

/** Abonnement aux changements : source vaut 'local' (modification ici) ou 'sync' (venue d'un autre appareil). */
export function onChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export const isPersistent = () => { readAll(); return persistent; };
export const allPlans = () => readAll();
export const listPlans = () => Object.values(readAll()).sort((a, b) => b.updated_at.localeCompare(a.updated_at));
export const getPlan = (id) => readAll()[id] ?? null;

/** Enregistre le plan ; sa révision change, ce qui permet à la synchro de repérer la modification. */
export function savePlan(plan) {
  plan.rev = newId();
  plan.updated_at = now();
  const all = readAll();
  all[plan.id] = structuredClone(plan);
  writeAll(all, 'local');
  return plan;
}

export function createPlan(fields) {
  return savePlan({ id: newId(), created_at: now(), ...structuredClone(fields) });
}

export function deletePlan(id) {
  const all = readAll();
  delete all[id];
  writeAll(all, 'local');
}

export function replaceAll(plans) {
  writeAll(plans, 'sync');
}

// ---------------------------------------------------------------- export / import

export function exportBlob() {
  const doc = { format: 'planificateur-cnam', version: 1, exported_at: now(), plans: listPlans() };
  return new Blob([JSON.stringify(doc, null, 1)], { type: 'application/json' });
}

/** Ajoute les plans d'un fichier exporté sans jamais écraser un plan existant. */
export function importText(text) {
  let doc;
  try { doc = JSON.parse(text); } catch { throw new Error('Ce fichier n’est pas un export du planificateur (JSON illisible).'); }
  if (doc?.format !== 'planificateur-cnam' || !Array.isArray(doc.plans)) {
    throw new Error('Ce fichier n’est pas un export du planificateur.');
  }
  const all = readAll();
  const result = { added: 0, copies: 0, same: 0 };
  for (const plan of doc.plans) {
    if (!plan?.id || !plan.state || !plan.diploma || !plan.version) continue;
    const existing = all[plan.id];
    if (existing && existing.rev === plan.rev) { result.same += 1; continue; }
    const copy = existing
      ? { ...plan, id: newId(), name: `${plan.name} (importé)` }
      : { ...plan };
    copy.rev = newId();
    copy.updated_at = now();
    all[copy.id] = copy;
    result[existing ? 'copies' : 'added'] += 1;
  }
  writeAll(all, 'local');
  return result;
}

// ---------------------------------------------------------------- données publiées

let catalogPromise = null;

export function loadCatalog({ refresh = false } = {}) {
  if (!catalogPromise || refresh) {
    catalogPromise = fetch('data/catalog.json', { cache: 'no-cache' })
      .then((res) => {
        if (!res.ok) throw new Error(`Catalogue des diplômes introuvable (${res.status}).`);
        return res.json();
      })
      .catch((e) => { catalogPromise = null; throw e; });
  }
  return catalogPromise;
}

const maquettes = new Map();

export function loadMaquette(diploma, version) {
  const key = `${diploma}/${version}`;
  if (!maquettes.has(key)) {
    maquettes.set(key, fetch(`data/maquettes/${encodeURIComponent(diploma)}/${encodeURIComponent(version)}.json`)
      .then((res) => {
        if (!res.ok) throw new Error(`Maquette ${version} introuvable pour ce diplôme.`);
        return res.json();
      })
      .catch((e) => { maquettes.delete(key); throw e; }));
  }
  return maquettes.get(key);
}
