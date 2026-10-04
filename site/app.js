// Planificateur Cnam : site statique. Les plans vivent dans le navigateur (store.js), avec une
// synchro optionnelle vers un Gist (sync.js). Rendu par reconstruction du DOM à chaque changement.

import * as store from './store.js';
import * as sync from './sync.js';
import { migrateState } from './migrate.js';
import { search, normalize } from './search.js';
import './theme.js';

const app = document.getElementById('app');
const dialog = document.getElementById('ue-dialog');
const syncDialog = document.getElementById('sync-dialog');
const syncButton = document.getElementById('sync-state');

// ---------------------------------------------------------------- utilitaires

function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  let value;
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v;
    else if (k === 'value') value = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (typeof v === 'boolean') el[k] = v;
    else el.setAttribute(k, String(v));
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : String(kid));
  }
  if (value !== undefined) el.value = value;
  return el;
}

let toastTimer;
function toast(msg, kind = 'info') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.dataset.kind = kind;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 4200);
}

const uid = () => 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const fmt = (n) => (Number.isInteger(n) ? String(n) : n.toFixed(1).replace('.', ','));
const shortModality = (m) => {
  const s = m.replace(/^Formation\s+(en\s+)?/i, '');
  return s.charAt(0).toUpperCase() + s.slice(1);
};
const plural = (n, one, many) => `${n} ${n > 1 ? many : one}`;
const dateFr = (iso) => new Date(iso).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
const dateTimeFr = (iso) => new Date(iso).toLocaleString('fr-FR', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });

function currentAcademicYear() {
  const d = new Date();
  return d.getMonth() >= 6 ? d.getFullYear() : d.getFullYear() - 1;
}

// Rend en conservant le focus clavier et le défilement horizontal du planning.
function paint(build) {
  const focusKey = document.activeElement?.dataset?.key;
  const caret = document.activeElement?.selectionStart;
  const scrolls = [...document.querySelectorAll('[data-scroll]')].map((el) => [el.dataset.scroll, el.scrollLeft, el.scrollTop]);
  app.replaceChildren(build());
  for (const [key, left, top] of scrolls) {
    const el = document.querySelector(`[data-scroll="${key}"]`);
    if (el) { el.scrollLeft = left; el.scrollTop = top; }
  }
  if (focusKey) {
    const el = document.querySelector(`[data-key="${CSS.escape(focusKey)}"]`);
    el?.focus();
    if (caret != null && el?.setSelectionRange) try { el.setSelectionRange(caret, caret); } catch { /* champ sans curseur */ }
  }
}

// Adresse d'une fiche Cnam : même règle que le scraper (domaines Cnam, identifiant numérique de la page).
function parseCnamUrl(text) {
  let u;
  try { u = new URL(text.trim()); } catch { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  const ok = ['cnam-paris.fr', 'cnam.fr'].some((s) => u.hostname === s || u.hostname.endsWith(`.${s}`));
  const m = u.pathname.match(/-(\d+)\.kjsp$/);
  return { href: u.href.split('#')[0], ok, key: m ? `${u.hostname}:${m[1]}` : `${u.hostname}:${u.pathname}` };
}

function repoSlug(catalog) {
  if (catalog?.repo) return catalog.repo;
  const host = location.hostname.match(/^([\w-]+)\.github\.io$/);
  const first = location.pathname.split('/').filter(Boolean)[0];
  return host && first ? `${host[1]}/${first}` : null;
}

// ---------------------------------------------------------------- routage

window.addEventListener('hashchange', route);

async function route() {
  if (dialog.open) dialog.close();
  const plan = location.hash.match(/^#\/plan\/([\w-]+)/);
  const nouveau = location.hash.match(/^#\/nouveau\/([\w-]+)/);
  if (plan) await openPlan(plan[1]);
  else await openHome({ preselect: nouveau?.[1], focusSync: location.hash === '#/sync' });
}

// ---------------------------------------------------------------- synchro : état et conflits

const SYNC_LABEL = {
  off: 'Enregistré sur cet appareil',
  pending: 'Synchronisation…',
  syncing: 'Synchronisation…',
  idle: 'Synchronisé',
  offline: 'Hors ligne, gardé sur cet appareil',
  error: 'Synchro en échec',
  conflict: 'Conflit à résoudre',
};

const SYNC_SHORT = {
  off: 'Local', pending: 'Synchro…', syncing: 'Synchro…', idle: 'Synchronisé', offline: 'Hors ligne', error: 'Synchro en échec', conflict: 'Conflit',
};

function renderSyncState(info = sync.info()) {
  syncButton.replaceChildren(
    h('span', { class: 'label-long' }, SYNC_LABEL[info.status]),
    h('span', { class: 'label-short', 'aria-hidden': 'true' }, SYNC_SHORT[info.status]),
  );
  syncButton.dataset.kind = info.status;
  syncButton.title = info.detail || (info.status === 'idle' && info.lastSync
    ? `Gist de @${info.login}, dernière synchro le ${dateTimeFr(info.lastSync)}`
    : info.status === 'off' ? 'Synchroniser avec GitHub' : '');
}

syncButton.addEventListener('click', () => {
  if (sync.info().status === 'conflict') openConflicts();
  else location.hash = '#/sync';
});

sync.onStatus((info) => {
  renderSyncState(info);
  if (home.open) paint(renderHome);
  if (info.status === 'conflict' && !syncDialog.open) openConflicts();
});

// Un plan modifié ou supprimé depuis un autre appareil arrive par la synchro.
store.onChange((source) => {
  if (source !== 'sync') return;
  if (P) {
    const fresh = store.getPlan(P.plan.id);
    if (!fresh) {
      toast('Ce plan a été supprimé depuis un autre appareil.');
      location.hash = '#/';
    } else if (fresh.rev !== P.plan.rev) {
      P.plan = fresh;
      normalizeState(P.plan.state);
      paint(renderPlan);
      if (dialog.open && dialog.dataset.item) renderDialog(dialog.dataset.item);
      toast('Plan mis à jour depuis un autre appareil.');
    }
  } else if (home.open) {
    paint(renderHome);
  }
});

function openConflicts() {
  const { conflicts } = sync.info();
  if (!conflicts?.length) return;
  const choices = Object.fromEntries(conflicts.map((c) => [c.id, c.local && c.remote ? 'both' : 'keep']));
  const option = (c, value, label) => h('label', { class: 'conflict-option' },
    h('input', { type: 'radio', name: `cf-${c.id}`, checked: choices[c.id] === value, onchange: () => { choices[c.id] = value; } }),
    h('span', {}, label));
  syncDialog.replaceChildren(h('div', { class: 'dlg' },
    h('header', { class: 'dlg-head' }, h('div', {},
      h('h2', {}, 'Plans modifiés sur deux appareils'),
      h('p', { class: 'muted' }, 'Ces plans ont changé ici et ailleurs depuis la dernière synchronisation. Choisis quelle version garder.'))),
    conflicts.map((c) => {
      const name = (c.local || c.remote).name;
      let options;
      if (c.local && c.remote) {
        options = [
          option(c, 'both', 'Garder les deux (la version de cet appareil devient une copie)'),
          option(c, 'local', `Garder celle de cet appareil, modifiée le ${dateTimeFr(c.local.updated_at)}`),
          option(c, 'remote', `Garder celle de l’autre appareil, modifiée le ${dateTimeFr(c.remote.updated_at)}`),
        ];
      } else {
        const alive = c.local || c.remote;
        options = [
          option(c, 'keep', `Garder le plan, modifié le ${dateTimeFr(alive.updated_at)}`),
          option(c, 'drop', c.local ? 'Le supprimer, comme sur l’autre appareil' : 'Le supprimer, comme sur cet appareil'),
        ];
      }
      return h('fieldset', { class: 'conflict' }, h('legend', {}, name), options);
    }),
    h('div', { class: 'actions dlg-actions' },
      h('button', {
        class: 'btn btn-primary', onclick: async () => {
          const resolved = Object.fromEntries(conflicts.map((c) => {
            const v = choices[c.id];
            if (v === 'keep') return [c.id, c.local ? 'local' : 'remote'];
            if (v === 'drop') return [c.id, c.local ? 'remote' : 'local'];
            return [c.id, v];
          }));
          syncDialog.close();
          await sync.resolve(resolved);
        },
      }, 'Appliquer et synchroniser'),
      h('button', { class: 'btn btn-ghost', onclick: () => syncDialog.close() }, 'Plus tard'),
    ),
  ));
  syncDialog.showModal();
}

// ================================================================= ACCUEIL

// Taille d'une page de résultats : plus courte au doigt, où chaque fiche occupe plus de hauteur.
const PAGE = matchMedia('(max-width: 900px)').matches ? 10 : 25;
const home = { open: false, catalog: null, error: null, query: '', type: '', level: '', limit: PAGE, draft: null, tokenBusy: false };

// Un diplôme est identifié par son code ; ses anciens identifiants restent valables (alias).
const findDiploma = (catalog, id) => catalog?.diplomas.find((d) => d.id === id || d.aliases?.includes(id)) ?? null;

function canonicalizePlans(catalog) {
  for (const plan of store.listPlans()) {
    const d = findDiploma(catalog, plan.diploma);
    if (d && d.id !== plan.diploma) {
      plan.diploma = d.id;
      store.savePlan(plan);
    }
  }
}

async function openHome({ preselect, focusSync } = {}) {
  P = null;
  home.open = true;
  document.title = 'Planificateur Cnam';
  try {
    home.catalog = await store.loadCatalog({ refresh: true });
    home.error = null;
    canonicalizePlans(home.catalog);
  } catch (e) {
    home.error = `${e.message} Recharge la page dans un instant.`;
  }
  const target = preselect && findDiploma(home.catalog, preselect);
  if (target) await startDraft(target);
  else if (preselect && home.catalog) toast('Ce diplôme n’est pas encore publié : la mise en ligne prend une à deux minutes. Recharge la page.', 'error');
  paint(renderHome);
  if (focusSync) document.getElementById('sync')?.scrollIntoView({ block: 'start' });
  else if (target) document.querySelector('.draft')?.scrollIntoView({ block: 'start' });
}

async function startDraft(diploma, version = diploma.versions[0].version) {
  try {
    const data = await store.loadMaquette(diploma.id, version);
    const years = data.years.map((y) => y.id);
    const keep = home.draft?.diploma.id === diploma.id ? home.draft : null;
    home.draft = {
      diploma, version, data,
      name: keep?.nameTouched ? keep.name : `Plan en ${years.length * 2} semestres`,
      nameTouched: keep?.nameTouched ?? false,
      years,
      start_year: keep?.start_year ?? currentAcademicYear(),
      start_sem: keep?.start_sem ?? 1,
      n_sem: keep?.n_sem ?? years.length * 2,
    };
  } catch (e) {
    toast(e.message, 'error');
  }
}

function createPlan() {
  const d = home.draft;
  if (!d.years.length) return toast('Choisis au moins une année du programme.', 'error');
  const plan = store.createPlan({
    name: d.name.trim() || 'Mon plan',
    diploma: d.diploma.id,
    version: d.version,
    diploma_title: d.diploma.title,
    state: {
      settings: { years: d.years, start_year: d.start_year, start_sem: d.start_sem, n_sem: d.n_sem, modalities: [...d.data.modalities] },
      selected: [], branches: [], placements: [], other: {}, overrides: {}, prior: [],
    },
  });
  home.draft = null;
  location.hash = `#/plan/${plan.id}`;
}

function renderHome() {
  return h('div', { class: 'home' },
    h('section', { class: 'intake' },
      h('h1', { class: 'intake-title' }, 'Planifier un diplôme du Cnam Paris'),
      h('p', { class: 'intake-lede' },
        'Choisis ton diplôme, répartis ses UE sur tes semestres et suis ce que tu as validé. Tes plans restent dans ce navigateur, et peuvent se synchroniser avec ton compte GitHub.'),
      h('label', { class: 'sr-only', for: 'find' }, 'Rechercher un diplôme ou coller l’adresse de sa fiche'),
      h('input', {
        id: 'find', type: 'search', value: home.query, 'data-key': 'find', autocomplete: 'off',
        placeholder: 'Rechercher un diplôme, ou coller l’adresse de sa fiche',
        oninput: (ev) => { home.query = ev.target.value; home.limit = PAGE; paint(renderHome); },
      }),
      renderFilters(),
      renderResults(),
    ),
    home.draft && renderDraft(),
    renderPlanList(),
    renderSyncPanel(),
  );
}

const LEVEL_ORDER = (label) => {
  const m = label.match(/Niveau (\d+)/);
  return m ? Number(m[1]) : 99;
};

function renderFilters() {
  if (!home.catalog?.diplomas.length || /^https?:\/\//i.test(home.query.trim())) return null;
  const count = (key) => {
    const c = new Map();
    for (const d of home.catalog.diplomas) if (d[key]) c.set(d[key], (c.get(d[key]) || 0) + 1);
    return c;
  };
  const types = [...count('type')].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const levels = [...count('level_out')].sort((a, b) => LEVEL_ORDER(a[0]) - LEVEL_ORDER(b[0]) || a[0].localeCompare(b[0]));
  const select = (key, label, entries, all) => h('label', { class: 'filter' },
    h('span', {}, label),
    h('select', { value: home[key], 'data-key': `f-${key}`, onchange: (ev) => { home[key] = ev.target.value; home.limit = PAGE; paint(renderHome); } },
      h('option', { value: '' }, all),
      entries.map(([v, n]) => h('option', { value: v }, `${v} (${n})`))));
  return h('div', { class: 'filters' },
    select('type', 'Type', types, 'Tous les types'),
    select('level', 'Niveau de sortie', levels, 'Tous les niveaux'),
  );
}

function renderResults() {
  if (home.error) return h('p', { class: 'form-error', role: 'alert' }, home.error);
  if (!home.catalog) return h('p', { class: 'muted results-note' }, 'Chargement des diplômes…');
  const diplomas = home.catalog.diplomas;
  const q = home.query.trim();

  if (/^https?:\/\//i.test(q)) {
    const parsed = parseCnamUrl(q);
    if (!parsed?.ok) {
      return h('p', { class: 'form-error' }, 'Seules les fiches diplôme du Cnam (cnam-paris.fr, cnam.fr) peuvent être ajoutées.');
    }
    const hit = diplomas.find((d) => d.key === parsed.key);
    return hit ? diplomaList([{ diploma: hit, hits: new Set() }]) : requestBlock(parsed.href);
  }

  const pool = diplomas
    .filter((d) => !home.type || d.type === home.type)
    .filter((d) => !home.level || d.level_out === home.level);
  // Avec une recherche : du plus pertinent au moins pertinent ; sinon par ordre alphabétique.
  const ranked = q ? search(pool, q) : pool.map((diploma) => ({ diploma, score: 0, hits: new Set() }));
  const list = ranked
    .map((r, i) => ({ ...r, i }))
    .sort((a, b) => Number(Boolean(a.diploma.retired)) - Number(Boolean(b.diploma.retired))
      || (q ? a.i - b.i : a.diploma.title.localeCompare(b.diploma.title, 'fr')));
  const filtered = q || home.type || home.level;
  return [
    h('p', { class: 'muted results-count' }, filtered ? `${plural(list.length, 'diplôme correspond', 'diplômes correspondent')} sur ${diplomas.length}` : `${plural(diplomas.length, 'diplôme', 'diplômes')} du Cnam Paris`),
    list.length ? diplomaList(list.slice(0, home.limit)) : h('p', { class: 'muted results-note' }, 'Aucun diplôme ne correspond à cette recherche.'),
    list.length > home.limit ? h('button', {
      class: 'btn btn-quiet more-btn', 'data-key': 'more',
      onclick: () => { home.limit += PAGE; paint(renderHome); },
    }, `Afficher ${Math.min(PAGE, list.length - home.limit)} de plus (${list.length - home.limit} restants)`) : null,
    h('p', { class: 'muted results-note' }, 'Ton diplôme n’est pas dans la liste ? Colle l’adresse de sa fiche sur cnam-paris.fr dans le champ ci-dessus pour demander son ajout.'),
  ];
}

// Titre avec les mots trouvés par la recherche surlignés.
function highlighted(title, hits) {
  if (!hits.size) return title;
  return title.split(/([A-Za-zÀ-ÖØ-öø-ÿ0-9+]+)/).map((part) => (hits.has(normalize(part)) ? h('mark', {}, part) : part));
}

async function chooseDiploma(d) {
  await startDraft(d);
  paint(renderHome);
  document.querySelector('.draft')?.scrollIntoView({ block: 'start', behavior: 'smooth' });
}

function diplomaList(list) {
  // Toute la ligne est cliquable (pratique au doigt) ; le bouton reste pour le clavier.
  return h('ul', { class: 'dip-list', 'data-scroll': 'diplomas' }, list.map(({ diploma: d, hits }) => h('li', {
    class: `dip-row ${d.retired ? 'dip-retired' : ''}`,
    onclick: (ev) => { if (!ev.target.closest('button')) chooseDiploma(d); },
  },
    h('div', { class: 'dip-text' },
      h('span', { class: 'dip-title' }, highlighted(d.title, hits)),
      h('span', { class: 'muted' }, [d.type, d.level_out, d.total_credits && `${d.total_credits} ECTS`, d.code].filter(Boolean).join(', ')),
      (d.retired || d.has_semesters === false) ? h('span', { class: 'dip-flags' },
        d.retired ? h('span', { class: 'tag tag-warn' }, 'plus proposée') : null,
        d.has_semesters === false ? h('span', { class: 'tag tag-nosem' }, 'semestres non indiqués par le Cnam') : null,
      ) : null,
    ),
    h('button', {
      class: 'btn btn-quiet', 'data-key': `dip-${d.id}`,
      onclick: () => chooseDiploma(d),
    }, 'Créer un plan'),
  )));
}

function requestBlock(url) {
  const repo = repoSlug(home.catalog);
  const href = repo && `https://github.com/${repo}/issues/new?template=ajouter-diplome.yml&title=${encodeURIComponent('Ajouter un diplôme')}&url=${encodeURIComponent(url)}`;
  return h('div', { class: 'request' },
    h('h2', {}, 'Ce diplôme n’est pas encore sur le site'),
    h('p', {}, 'Demande son ajout : une issue est ouverte sur GitHub (il faut un compte), puis le programme est lu et publié automatiquement. Compte deux à trois minutes, puis recharge cette page.'),
    href
      ? h('a', { class: 'btn btn-primary', href, target: '_blank', rel: 'noopener' }, 'Demander l’ajout sur GitHub')
      : h('p', { class: 'form-error' }, 'Le dépôt GitHub du site est inconnu : la demande ne peut pas être préparée.'),
  );
}

function renderDraft() {
  const d = home.draft;
  const set = (k) => (ev) => {
    const v = k === 'name' ? ev.target.value : Number(ev.target.value);
    d[k] = v;
    if (k === 'n_sem' && !d.nameTouched) d.name = `Plan en ${v} semestres`;
    paint(renderHome);
  };
  const toggleYear = (id) => {
    d.years = d.years.includes(id) ? d.years.filter((y) => y !== id) : d.data.years.map((y) => y.id).filter((y) => y === id || d.years.includes(y));
    if (!d.nameTouched) { d.n_sem = Math.max(1, d.years.length * 2); d.name = `Plan en ${d.n_sem} semestres`; }
    paint(renderHome);
  };
  const pickVersion = async (version) => { await startDraft(d.diploma, version); paint(renderHome); };
  const cy = currentAcademicYear();
  return h('section', { class: 'draft', 'aria-labelledby': 'draft-title' },
    h('div', { class: 'draft-head' },
      h('h2', { id: 'draft-title' }, d.diploma.title),
      h('p', { class: 'muted' }, [d.diploma.code, d.data.total_credits && `${d.data.total_credits} ECTS`].filter(Boolean).join(', ')),
    ),
    d.diploma.retired ? h('p', { class: 'notice' }, `Cette formation n’est plus proposée par le Cnam Paris${d.diploma.retired_at ? ` depuis le ${dateFr(d.diploma.retired_at)}` : ''}. Tu peux quand même planifier sa dernière maquette.`) : null,
    d.diploma.has_semesters === false ? h('p', { class: 'notice' }, 'La fiche du Cnam n’indique aucun semestre pour ce diplôme : ses UE iront dans « Autre ». Dans le plan, ouvre une UE pour cocher ses semestres réels.') : null,
    d.diploma.versions.length > 1
      ? h('label', { class: 'field field-version' }, h('span', {}, 'Version du programme'),
        h('select', { value: d.version, 'data-key': 'ver', onchange: (ev) => pickVersion(ev.target.value) },
          d.diploma.versions.map((v, i) => h('option', { value: v.version },
            i === 0 ? `${v.version}, la plus récente` : `${v.version}, du ${dateFr(v.fetched_at)}`))))
      : h('p', { class: 'draft-note' }, `Programme du ${dateFr(d.diploma.versions[0].fetched_at)} (version ${d.version}).`),
    h('fieldset', { class: 'field' },
      h('legend', {}, 'Années du programme à inclure'),
      h('div', { class: 'chips' },
        d.data.years.map((y) => h('label', { class: 'check-chip' },
          h('input', { type: 'checkbox', checked: d.years.includes(y.id), onchange: () => toggleYear(y.id), 'data-key': `y${y.id}` }),
          h('span', {}, y.label),
        )),
      ),
    ),
    h('div', { class: 'field-row' },
      h('label', { class: 'field' }, h('span', {}, 'Rentrée'),
        h('select', { onchange: set('start_year'), value: String(d.start_year), 'data-key': 'sy' },
          Array.from({ length: 9 }, (_, k) => cy - 4 + k).map((y) => h('option', { value: String(y) }, `${y}-${y + 1}`)))),
      h('label', { class: 'field' }, h('span', {}, 'Premier semestre'),
        h('select', { onchange: set('start_sem'), value: String(d.start_sem), 'data-key': 'ss' },
          h('option', { value: '1' }, '1er semestre (septembre)'),
          h('option', { value: '2' }, '2nd semestre (février)'))),
      h('label', { class: 'field' }, h('span', {}, 'Durée en semestres'),
        h('input', { type: 'number', min: '1', max: '24', value: String(d.n_sem), onchange: set('n_sem'), 'data-key': 'ns' })),
    ),
    h('label', { class: 'field' }, h('span', {}, 'Nom du plan'),
      h('input', { type: 'text', value: d.name, oninput: (ev) => { d.name = ev.target.value; d.nameTouched = true; }, 'data-key': 'pn' })),
    h('div', { class: 'actions' },
      h('button', { class: 'btn btn-primary', onclick: createPlan }, 'Créer le plan'),
      h('button', { class: 'btn btn-ghost', onclick: () => { home.draft = null; paint(renderHome); } }, 'Annuler'),
    ),
  );
}

function exportPlans() {
  const a = h('a', { href: URL.createObjectURL(store.exportBlob()), download: `planificateur-cnam-${new Date().toISOString().slice(0, 10)}.json` });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

async function importPlans(ev) {
  const file = ev.target.files?.[0];
  ev.target.value = '';
  if (!file) return;
  try {
    const r = store.importText(await file.text());
    const parts = [
      r.added && plural(r.added, 'plan ajouté', 'plans ajoutés'),
      r.copies && plural(r.copies, 'plan ajouté en copie (il existait déjà)', 'plans ajoutés en copie (ils existaient déjà)'),
      r.same && plural(r.same, 'plan déjà à jour', 'plans déjà à jour'),
    ].filter(Boolean);
    toast(parts.length ? `${parts.join(', ')}.` : 'Aucun plan dans ce fichier.');
    paint(renderHome);
  } catch (e) {
    toast(e.message, 'error');
  }
}

function renderPlanList() {
  const plans = store.listPlans();
  const byDiploma = new Map();
  for (const p of plans) {
    if (!byDiploma.has(p.diploma)) byDiploma.set(p.diploma, []);
    byDiploma.get(p.diploma).push(p);
  }
  const catalogEntry = (id) => findDiploma(home.catalog, id);
  return h('section', { class: `plans ${plans.length ? 'plans-has' : ''}`, 'aria-labelledby': 'plans-title' },
    h('header', { class: 'plans-head' },
      h('h2', { id: 'plans-title' }, 'Mes plans'),
      h('div', { class: 'actions' },
        h('button', { class: 'btn btn-quiet', disabled: !plans.length, onclick: exportPlans }, 'Exporter'),
        h('label', { class: 'btn btn-quiet file-btn' }, 'Importer un fichier',
          h('input', { type: 'file', accept: 'application/json,.json', class: 'sr-only', onchange: importPlans })),
      ),
    ),
    store.isPersistent() ? null : h('p', { class: 'form-error' },
      'Ce navigateur bloque l’enregistrement local (navigation privée ?). Tes plans seront perdus à la fermeture : exporte-les ou active la synchronisation.'),
    plans.length
      ? [...byDiploma].map(([id, list]) => {
        const entry = catalogEntry(id);
        const latest = entry?.versions[0]?.version;
        return h('article', { class: 'diploma' },
          h('h3', {}, entry?.title || list[0].diploma_title || 'Diplôme'),
          h('ul', { class: 'plan-rows' }, list.map((p) => h('li', {},
            h('a', { href: `#/plan/${p.id}`, class: 'plan-row' },
              h('span', { class: 'plan-name' }, p.name),
              h('span', { class: 'muted' }, `maquette ${p.version}`, latest && latest !== p.version ? h('span', { class: 'tag tag-new' }, 'nouvelle maquette') : null),
              h('span', { class: 'muted' }, `modifié le ${dateFr(p.updated_at)}`),
            )))),
        );
      })
      : h('p', { class: 'muted' }, 'Aucun plan sur cet appareil. Choisis un diplôme ci-dessus pour en créer un, ou importe un fichier exporté.'),
  );
}

function renderSyncPanel() {
  const info = sync.info();
  const tokenUrl = 'https://github.com/settings/tokens/new?scopes=gist&description=Planificateur%20Cnam';
  if (!sync.isConnected()) {
    const onSubmit = async (ev) => {
      ev.preventDefault();
      const token = new FormData(ev.target).get('token').trim();
      if (!token) return;
      home.tokenBusy = true;
      paint(renderHome);
      try {
        await sync.connect(token);
        toast(`Synchronisation activée avec le compte @${sync.info().login}.`);
      } catch (e) {
        toast(e.message, 'error');
      } finally {
        home.tokenBusy = false;
        paint(renderHome);
      }
    };
    return h('section', { class: 'syncbox', id: 'sync', 'aria-labelledby': 'sync-title' },
      h('h2', { id: 'sync-title' }, 'Retrouver tes plans sur tous tes appareils'),
      h('p', {}, 'Tes plans sont enregistrés dans ce navigateur. Pour les synchroniser, relie ton compte GitHub : ils seront rangés dans un Gist secret de ton compte et mis à jour à chaque modification.'),
      h('ol', { class: 'steps' },
        h('li', {}, 'Crée un jeton GitHub avec la seule permission « gist » : ',
          h('a', { href: tokenUrl, target: '_blank', rel: 'noopener' }, 'créer le jeton'),
          '. Choisis une expiration longue, puis copie le jeton affiché.'),
        h('li', {}, 'Colle-le ci-dessous, puis connecte.'),
      ),
      h('form', { class: 'token-form', onsubmit: onSubmit },
        h('label', { class: 'sr-only', for: 'token' }, 'Jeton GitHub'),
        h('input', { id: 'token', name: 'token', type: 'password', autocomplete: 'off', spellcheck: 'false', placeholder: 'ghp_…', 'data-key': 'token' }),
        h('button', { class: 'btn btn-primary', type: 'submit', disabled: home.tokenBusy }, home.tokenBusy ? 'Connexion…' : 'Connecter'),
      ),
      h('p', { class: 'muted small' }, 'Le jeton reste dans ce navigateur et n’est envoyé qu’à GitHub. Il ne donne accès qu’à tes Gists ; tu peux le révoquer à tout moment dans les réglages de ton compte GitHub.'),
    );
  }
  return h('section', { class: 'syncbox', id: 'sync', 'aria-labelledby': 'sync-title' },
    h('h2', { id: 'sync-title' }, 'Synchronisation'),
    h('p', {}, `Connecté au compte GitHub @${info.login}. `,
      info.lastSync ? `Dernière synchronisation le ${dateTimeFr(info.lastSync)}.` : 'Première synchronisation en cours.'),
    info.detail && info.status !== 'idle' ? h('p', { class: info.status === 'conflict' ? 'notice' : 'form-error' }, info.detail) : null,
    h('div', { class: 'actions' },
      info.status === 'conflict'
        ? h('button', { class: 'btn btn-primary', onclick: openConflicts }, 'Résoudre le conflit')
        : h('button', { class: 'btn btn-quiet', onclick: () => sync.syncNow() }, 'Synchroniser maintenant'),
      h('a', { class: 'btn btn-ghost', href: `https://gist.github.com/${info.gistId}`, target: '_blank', rel: 'noopener' }, 'Voir le Gist'),
      h('button', {
        class: 'btn btn-ghost btn-danger', onclick: () => {
          if (!confirm('Déconnecter GitHub sur cet appareil ? Tes plans restent ici et dans le Gist.')) return;
          sync.disconnect();
          paint(renderHome);
        },
      }, 'Déconnecter'),
    ),
  );
}

// ================================================================= PLAN

let P = null; // { plan, data, diploma, maquette, items, groups, tab }
const openGroups = new Map(); // état ouvert/fermé des groupes dans l'onglet Programme

const S = () => P.plan.state;
const I = (id) => P.items.get(id);
const G = (id) => P.groups.get(id);

function normalizeState(st) {
  st.selected ??= []; st.branches ??= []; st.placements ??= []; st.other ??= {}; st.overrides ??= {}; st.prior ??= [];
  // « Autre » avait ses propres statuts (À faire / En cours / Validé) : mêmes statuts que les UE désormais.
  for (const [id, v] of Object.entries(st.other)) if (v === 'todo') st.other[id] = 'planned';
}

async function openPlan(id) {
  home.open = false;
  const plan = store.getPlan(id);
  if (!plan) {
    P = null;
    app.replaceChildren(h('div', { class: 'home' },
      h('p', { class: 'form-error' }, 'Ce plan n’existe pas sur cet appareil.'),
      sync.isConnected() ? h('p', { class: 'muted' }, 'S’il vient d’être créé sur un autre appareil, attends la fin de la synchronisation puis recharge la page.') : null,
      h('a', { href: '#/' }, 'Revenir à l’accueil')));
    return;
  }
  try {
    const catalog = await store.loadCatalog().catch(() => null);
    const diploma = findDiploma(catalog, plan.diploma);
    if (diploma && diploma.id !== plan.diploma) {
      plan.diploma = diploma.id; // ancien identifiant (numéro de page) : on passe au code du diplôme
      store.savePlan(plan);
    }
    const data = await store.loadMaquette(plan.diploma, plan.version);
    normalizeState(plan.state);
    P = {
      plan, data, diploma,
      maquette: diploma?.versions.find((v) => v.version === plan.version) ?? { version: plan.version, fetched_at: null },
      items: new Map(data.items.map((i) => [i.id, i])),
      groups: new Map(data.groups.map((g) => [g.id, g])),
      tab: null,
    };
    let saved = null;
    try { saved = localStorage.getItem(`cnam-tab-${id}`); } catch { /* stockage indisponible */ }
    P.tab = saved || (pendingChoices().length ? 'programme' : 'planning');
    document.title = `${plan.name} | Planificateur Cnam`;
    paint(renderPlan);
  } catch (e) {
    P = null;
    app.replaceChildren(h('div', { class: 'home' }, h('p', { class: 'form-error' }, e.message), h('a', { href: '#/' }, 'Revenir à l’accueil')));
  }
}

// Chaque modification est écrite aussitôt dans le navigateur ; la synchro suit d'elle-même.
function commit() {
  store.savePlan(P.plan);
  paint(renderPlan);
  if (dialog.open && dialog.dataset.item) renderDialog(dialog.dataset.item);
}

async function migrateToLatest(latest) {
  try {
    const next = await store.loadMaquette(P.plan.diploma, latest.version);
    const copy = store.createPlan({
      name: `${P.plan.name} (maquette ${latest.version})`,
      diploma: P.plan.diploma,
      version: latest.version,
      diploma_title: P.plan.diploma_title,
      state: migrateState(S(), P.data, next, P.plan.version),
    });
    location.hash = `#/plan/${copy.id}`;
  } catch (e) {
    toast(e.message, 'error');
  }
}

function renderPlanNotices() {
  const notices = [];
  if (P.diploma?.retired) {
    notices.push(h('div', { class: 'notice' }, h('span', {}, 'Cette formation n’est plus proposée par le Cnam Paris. Ton plan reste utilisable.')));
  }
  const latest = P.diploma?.versions[0];
  if (latest && latest.version !== P.plan.version) {
    notices.push(h('div', { class: 'notice' },
      h('span', {}, `Une maquette plus récente est disponible (version ${latest.version}, du ${dateFr(latest.fetched_at)}). Ce plan reste sur la version ${P.plan.version}.`),
      h('button', { class: 'btn btn-link', onclick: () => migrateToLatest(latest) }, 'Créer une copie sur la nouvelle maquette')));
  }
  const m = S().migration;
  if (m && !m.dismissed) {
    notices.push(h('div', { class: 'notice notice-info' },
      h('span', {}, `Copie créée depuis la maquette ${m.from}. `,
        m.missing.length
          ? `UE absentes de la nouvelle maquette, non reportées : ${m.missing.join(', ')}. `
          : 'Toutes les UE ont été reportées. ',
        'Vérifie les cartes signalées dans le planning.'),
      h('button', { class: 'btn btn-link', onclick: () => { m.dismissed = true; commit(); } }, 'Masquer')));
  }
  return notices;
}

// ---------------------------------------------------------------- modèle

const MANUAL = 'Ajouté à la main';
const SEM_KEYS = [['S1', '1er semestre'], ['S2', '2nd semestre'], ['A', 'Annuel']];
const SEM_SHORT = { S1: 'S1', S2: 'S2', A: 'Annuel' };

// Semestres effectifs : ceux de la fiche, sauf correction manuelle enregistrée dans le plan.
function offerOf(it) {
  const keys = S().overrides[it.id];
  if (!keys) return it.offer;
  return Object.fromEntries(keys.map((k) => [k, it.offer[k]?.length ? it.offer[k] : [MANUAL]]));
}

const isOverridden = (it) => Boolean(S().overrides[it.id]);
const hasOffer = (it) => Object.keys(offerOf(it)).length > 0;
const siteKeys = (it) => SEM_KEYS.map(([k]) => k).filter((k) => it.offer[k]);

function toggleOfferKey(itemId, key) {
  const it = I(itemId);
  const current = Object.keys(offerOf(it));
  const wanted = current.includes(key) ? current.filter((k) => k !== key) : [...current, key];
  const next = SEM_KEYS.map(([k]) => k).filter((k) => wanted.includes(k));
  if (next.join() === siteKeys(it).join()) delete S().overrides[itemId];
  else S().overrides[itemId] = next;
  commit();
}

function resetOffer(itemId) {
  delete S().overrides[itemId];
  commit();
}
const yearOf = (id) => P.data.years.find((y) => y.id === id);
const yearTag = (id) => {
  const i = P.data.years.findIndex((y) => y.id === id);
  const label = P.data.years[i]?.label || '';
  return label.length <= 3 ? label : P.data.years.length > 1 ? `A${i + 1}` : '';
};

function branchesOk(groupId) {
  for (let g = groupId && G(groupId); g; g = g.parent && G(g.parent)) {
    if (g.kind === 'branch' && !S().branches.includes(g.id)) return false;
  }
  return true;
}

function isActive(it) {
  if (!S().settings.years.includes(it.year) || !branchesOk(it.group)) return false;
  if (!it.group) return true;
  return G(it.group).kind === 'branch' || S().selected.includes(it.id);
}

const activeItems = () => P.data.items.filter(isActive);
const otherItems = () => activeItems().filter((it) => !hasOffer(it));
const liveOf = (itemId) => S().placements.find((p) => p.item === itemId && p.status !== 'failed');
const visiblePlacements = () => S().placements.filter((p) => isActive(I(p.item)) && hasOffer(I(p.item)));
// UE validées avant le plan (VAE, équivalences, anciennes inscriptions) : hors semestres, comptées comme validées.
const isPrior = (itemId) => S().prior.includes(itemId);
const visiblePrior = () => S().prior.map(I).filter((it) => it && isActive(it) && hasOffer(it));
const toPlaceItems = () => activeItems().filter((it) => hasOffer(it) && !liveOf(it.id) && !isPrior(it.id));

function slotList() {
  const { start_year, start_sem, n_sem } = S().settings;
  const maxPlaced = Math.max(-1, ...visiblePlacements().map((p) => p.slot + (p.annual ? 1 : 0)));
  const count = Math.max(n_sem, maxPlaced + 1);
  return Array.from({ length: count }, (_, i) => slotInfo(i, start_year, start_sem, n_sem));
}

function slotInfo(i, startYear = S().settings.start_year, startSem = S().settings.start_sem, n = S().settings.n_sem) {
  const k = startSem - 1 + i;
  const y = startYear + Math.floor(k / 2);
  const sem = (k % 2) + 1;
  return { i, y, sem, out: i >= n, label: `${y}-${String((y + 1) % 100).padStart(2, '0')} S${sem}` };
}

const allowedMods = (mods = []) => mods.filter((m) => m === MANUAL || S().settings.modalities.includes(m));

// Options de placement d'une UE sur une colonne : semestrielle et/ou annuelle.
function slotOptions(it, i) {
  const n = S().settings.n_sem;
  if (i < 0 || i >= n) return { sem: null, annual: null };
  const sl = slotInfo(i);
  const offer = offerOf(it);
  const semMods = allowedMods(offer[`S${sl.sem}`]);
  let annual = null;
  if (offer.A) {
    const anchor = sl.sem === 1 ? i : i - 1;
    const mods = allowedMods(offer.A);
    if (anchor >= 0 && anchor + 1 < n && mods.length) annual = { anchor, mods };
  }
  return { sem: semMods.length ? semMods : null, annual };
}

const canDrop = (it, i) => { const o = slotOptions(it, i); return Boolean(o.sem || o.annual); };
const anySlot = (it) => Array.from({ length: S().settings.n_sem }, (_, i) => i).some((i) => canDrop(it, i));

function placementValid(p) {
  const it = I(p.item);
  if (p.annual) {
    const o = slotOptions(it, p.slot);
    return Boolean(o.annual && o.annual.anchor === p.slot);
  }
  return Boolean(slotOptions(it, p.slot).sem);
}

function placementMods(p) {
  const it = I(p.item);
  const offer = offerOf(it);
  if (p.annual) return offer.A || [];
  return offer[`S${slotInfo(p.slot).sem}`] || [];
}

function place(itemId, i, { annual: wantAnnual, placementId } = {}) {
  const it = I(itemId);
  const o = slotOptions(it, i);
  if (!o.sem && !o.annual) {
    toast(`${it.code} n’est pas proposée à ce semestre avec les modalités retenues.`, 'error');
    return false;
  }
  const annual = wantAnnual ?? !o.sem;
  if (annual ? !o.annual : !o.sem) {
    toast(annual ? `${it.code} ne peut pas démarrer sur l’année à cette position.` : `${it.code} n’est pas proposée seule à ce semestre.`, 'error');
    return false;
  }
  const slot = annual ? o.annual.anchor : i;
  S().prior = S().prior.filter((x) => x !== itemId);
  const p = placementId ? S().placements.find((x) => x.id === placementId) : liveOf(itemId);
  if (p) Object.assign(p, { slot, annual });
  else S().placements.push({ id: uid(), item: itemId, slot, annual, status: 'planned' });
  commit();
  return true;
}

function markPrior(itemId) {
  const live = liveOf(itemId);
  if (live) S().placements = S().placements.filter((x) => x !== live);
  if (!isPrior(itemId)) S().prior.push(itemId);
  commit();
}

function unmarkPrior(itemId) {
  S().prior = S().prior.filter((x) => x !== itemId);
  commit();
}

function unplace(pid) {
  const p = S().placements.find((x) => x.id === pid);
  if (!p) return;
  if ((p.status === 'enrolled' || p.status === 'validated')
    && !confirm(`Cette UE est marquée « ${STATUS[p.status].label.toLowerCase()} ». La retirer du planning ?`)) return;
  S().placements = S().placements.filter((x) => x.id !== pid);
  commit();
}

function setStatus(pid, status) {
  const p = S().placements.find((x) => x.id === pid);
  if (!p || p.status === status) return;
  if (p.status === 'failed' && liveOf(p.item)) {
    toast('Cette UE a déjà été replanifiée. Retire d’abord la nouvelle tentative du planning.', 'error');
    return;
  }
  p.status = status;
  commit();
  if (status === 'failed') toast(`${I(p.item).code} revient dans les UE à placer pour une nouvelle tentative.`);
}

const STATUS = {
  planned: { label: 'Planifiée', short: 'Planifiée' },
  enrolled: { label: 'Inscrite', short: 'Inscrite' },
  validated: { label: 'Validée', short: 'Validée' },
  failed: { label: 'Échouée', short: 'Échouée' },
};
const STATUS_CYCLE = { planned: 'enrolled', enrolled: 'validated', validated: 'planned' };
const STATUS_LABELS = Object.fromEntries(Object.entries(STATUS).map(([k, v]) => [k, v.label]));
const otherStatus = (itemId) => S().other[itemId] || 'planned';

function setOtherStatus(itemId, status) {
  S().other[itemId] = status;
  commit();
}

// Crédits par colonne, ventilés par statut. Une UE annuelle compte pour moitié sur chaque semestre.
function slotTotals(i) {
  const t = { planned: 0, enrolled: 0, validated: 0, failed: 0 };
  for (const p of visiblePlacements()) {
    const e = I(p.item).ects;
    if (p.slot === i) t[p.status] += p.annual ? e / 2 : e;
    else if (p.annual && p.slot + 1 === i) t[p.status] += e / 2;
  }
  t.total = t.planned + t.enrolled + t.validated;
  return t;
}

function progress() {
  const r = { validated: 0, enrolled: 0, planned: 0 };
  for (const p of visiblePlacements()) if (p.status !== 'failed') r[p.status] += I(p.item).ects;
  for (const it of visiblePrior()) r.validated += it.ects;
  for (const it of otherItems()) {
    const s = otherStatus(it.id);
    if (s !== 'failed') r[s] += it.ects;
  }
  return r;
}

// Objectif en ECTS : UE obligatoires + volume attendu de chaque groupe de choix.
function target() {
  let t = 0;
  for (const it of P.data.items) if (!it.group && S().settings.years.includes(it.year)) t += it.ects;
  for (const g of P.data.groups) if (!g.parent && S().settings.years.includes(g.year)) t += groupTarget(g);
  return t;
}

function groupTarget(g) {
  const sumSelected = () => g.items.filter((id) => S().selected.includes(id)).reduce((a, id) => a + I(id).ects, 0);
  switch (g.kind) {
    case 'choice': return g.rule.total_ects ?? g.rule.credits ?? sumSelected();
    case 'parent': return g.rule.total_ects ?? g.children.reduce((a, c) => a + groupTarget(G(c)), 0);
    case 'alternative': {
      const chosen = g.children.find((c) => S().branches.includes(c));
      if (chosen) return groupTarget(G(chosen));
      return Math.min(...g.children.map((c) => groupTarget(G(c))));
    }
    case 'branch':
      return g.items.reduce((a, id) => a + I(id).ects, 0)
        + g.children.reduce((a, c) => a + groupTarget(G(c)), 0);
    default: return 0;
  }
}

// État d'un groupe de choix : ok, todo (incomplet), over (dépassé), info (contrôlé par le parent).
function groupState(g) {
  const selectedIn = (grp) => grp.items.filter((id) => S().selected.includes(id));
  if (g.kind === 'alternative') {
    const n = g.children.filter((c) => S().branches.includes(c)).length;
    return { state: n === 1 ? 'ok' : n ? 'over' : 'todo', notes: [n ? 'Parcours choisi' : 'Choisis un parcours'] };
  }
  if (g.kind === 'branch') return { state: 'info', notes: [] };
  const r = g.rule;
  if (g.kind === 'parent') {
    const kids = g.children.map(G);
    const count = kids.reduce((a, k) => a + selectedIn(k).length, 0);
    const ects = kids.reduce((a, k) => a + selectedIn(k).reduce((s, id) => s + I(id).ects, 0), 0);
    const domains = kids.filter((k) => selectedIn(k).length).length;
    const checks = [];
    if (r.ue_count) checks.push({ ok: count === r.ue_count, over: count > r.ue_count, note: `${count} UE sur ${r.ue_count}` });
    if (r.min_domains) checks.push({ ok: domains >= r.min_domains, note: `${plural(domains, 'domaine', 'domaines')}, ${r.min_domains} minimum` });
    const need = r.credits ?? r.total_ects;
    if (need && !r.ue_count) checks.push({ ok: ects >= need, note: `${fmt(ects)} ECTS sur ${need}` });
    const kidsOver = kids.some((k) => groupState(k).state === 'over');
    const state = checks.some((c) => c.over) || kidsOver ? 'over' : checks.every((c) => c.ok) ? 'ok' : 'todo';
    return { state, notes: checks.map((c) => c.note) };
  }
  const sel = selectedIn(g);
  const count = sel.length;
  const ects = sel.reduce((a, id) => a + I(id).ects, 0);
  const underParent = g.parent && G(g.parent).kind === 'parent';
  if (underParent) {
    if (r.ue_count && count > r.ue_count) return { state: 'over', notes: [`${count} UE, ${r.ue_count} maximum`] };
    return { state: 'info', notes: [count ? plural(count, 'UE choisie', 'UE choisies') : 'Aucune UE choisie'] };
  }
  if (r.ue_count) return { state: count === r.ue_count ? 'ok' : count > r.ue_count ? 'over' : 'todo', notes: [`${count} UE sur ${r.ue_count}`] };
  const need = r.credits ?? r.total_ects;
  if (need) return { state: ects >= need ? 'ok' : 'todo', notes: [`${fmt(ects)} ECTS sur ${need}`] };
  return { state: count ? 'ok' : 'todo', notes: [plural(count, 'UE choisie', 'UE choisies')] };
}

// Groupes de premier niveau qui demandent encore une décision.
function pendingChoices() {
  return P.data.groups.filter((g) => {
    if (!S().settings.years.includes(g.year) || !branchesOk(g.parent)) return false;
    if (g.kind === 'branch' || g.kind === 'choice' && g.parent && G(g.parent).kind === 'parent') return groupState(g).state === 'over';
    return groupState(g).state !== 'ok';
  });
}

function toggleSelected(itemId) {
  const sel = S().selected;
  S().selected = sel.includes(itemId) ? sel.filter((x) => x !== itemId) : [...sel, itemId];
  commit();
}

function chooseBranch(altId, branchId) {
  const alt = G(altId);
  S().branches = [...S().branches.filter((b) => !alt.children.includes(b)), branchId];
  commit();
}

// ---------------------------------------------------------------- rendu du plan

function renderPlan() {
  const setTab = (tab) => {
    P.tab = tab;
    try { localStorage.setItem(`cnam-tab-${P.plan.id}`, tab); } catch { /* stockage indisponible */ }
    paint(renderPlan);
    const panel = document.querySelector('.tab-body');
    if (panel && panel.getBoundingClientRect().top < 0) panel.scrollIntoView({ block: 'start' });
  };
  const pending = pendingChoices().length;
  const toPlace = toPlaceItems().length;
  const tabs = [
    ['programme', 'Programme', pending],
    ['planning', 'Planning', toPlace],
    ['recap', 'Récapitulatif', 0, 'Récap'],
    ['reglages', 'Réglages', 0],
  ];
  const body = { programme: renderProgramme, planning: renderPlanning, recap: renderRecap, reglages: renderSettings }[P.tab] || renderPlanning;
  return h('div', { class: 'plan' },
    renderCartouche(),
    renderPlanNotices(),
    h('nav', { class: 'tabs', role: 'tablist', 'aria-label': 'Sections du plan' },
      tabs.map(([id, label, badge, short]) => h('button', {
        role: 'tab', class: 'tab', 'aria-selected': String(P.tab === id), 'data-key': `tab-${id}`, 'aria-label': label,
        onclick: () => setTab(id),
      },
        short ? [h('span', { class: 'label-long' }, label), h('span', { class: 'label-short' }, short)] : label,
        badge ? h('span', { class: 'tab-badge', 'aria-label': `${badge} en attente` }, badge) : null)),
    ),
    h('div', { class: `tab-body tab-${P.tab}`, role: 'tabpanel' }, body()),
  );
}

function renderCartouche() {
  const st = S().settings;
  const first = slotInfo(0);
  const last = slotInfo(st.n_sem - 1);
  const goal = target();
  const pr = progress();
  const pct = (v) => `${goal ? Math.min(100, (v / goal) * 100) : 0}%`;
  return h('section', { class: 'cartouche', 'aria-label': 'Cartouche du plan' },
    h('div', { class: 'cell cell-title' },
      h('span', { class: 'cell-label' }, 'Diplôme'),
      h('a', { class: 'cell-diploma', href: P.data.url, target: '_blank', rel: 'noopener' }, P.data.title),
    ),
    h('div', { class: 'cell cell-plan' },
      h('span', { class: 'cell-label' }, 'Plan'),
      h('span', { class: 'cell-value' }, P.plan.name),
    ),
    h('div', { class: 'cell' }, h('span', { class: 'cell-label' }, 'Code'), h('span', { class: 'cell-value num' }, P.data.code || '—')),
    h('div', { class: 'cell' }, h('span', { class: 'cell-label' }, 'Maquette'), h('span', { class: 'cell-value num' }, P.maquette.version)),
    h('div', { class: 'cell' }, h('span', { class: 'cell-label' }, 'Période'),
      h('span', { class: 'cell-value num' }, `${first.label} à ${last.label}`)),
    h('div', { class: 'cell cell-progress' },
      h('span', { class: 'cell-label' }, 'Crédits validés'),
      h('span', { class: 'cell-value num' }, h('strong', {}, fmt(pr.validated)), ` / ${fmt(goal)} ECTS`,
        P.data.total_credits && goal !== P.data.total_credits ? h('span', { class: 'muted' }, ` (diplôme : ${P.data.total_credits})`) : null),
      h('div', { class: 'bar', role: 'img', 'aria-label': `${fmt(pr.validated)} validés, ${fmt(pr.enrolled)} inscrits, ${fmt(pr.planned)} planifiés sur ${fmt(goal)} ECTS` },
        h('span', { class: 'bar-validated', style: `width:${pct(pr.validated)}` }),
        h('span', { class: 'bar-enrolled', style: `width:${pct(pr.enrolled)}` }),
        h('span', { class: 'bar-planned', style: `width:${pct(pr.planned)}` }),
      ),
      h('span', { class: 'bar-legend' },
        h('span', { class: 'lg lg-validated' }, `${fmt(pr.validated)} validés`),
        h('span', { class: 'lg lg-enrolled' }, `${fmt(pr.enrolled)} en cours`),
        h('span', { class: 'lg lg-planned' }, `${fmt(pr.planned)} planifiés`),
      ),
    ),
  );
}

// ---------------------------------------------------------------- onglet Programme

function renderProgramme() {
  return h('div', { class: 'programme' },
    P.data.years.map((y) => {
      const included = S().settings.years.includes(y.id);
      const rendered = new Set();
      const rows = [];
      for (const it of P.data.items.filter((x) => x.year === y.id)) {
        const top = topGroup(it.group);
        if (!top) rows.push(itemRow(it));
        else if (!rendered.has(top.id)) { rendered.add(top.id); rows.push(groupBlock(top)); }
      }
      return h('section', { class: `year ${included ? '' : 'year-excluded'}`, 'aria-labelledby': `year-${y.id}` },
        h('header', { class: 'year-head' },
          h('h2', { id: `year-${y.id}` }, y.label),
          included ? null : h('span', { class: 'muted' }, 'Non incluse dans ce plan. Modifiable dans Réglages.'),
        ),
        included ? h('div', { class: 'year-body' }, rows) : null,
      );
    }),
  );
}

function topGroup(gid) {
  let g = gid && G(gid);
  while (g?.parent) g = G(g.parent);
  return g || null;
}

function availabilityTags(it) {
  const edited = isOverridden(it) ? h('span', { class: 'avail-edit', title: 'Semestres corrigés à la main dans ce plan' }, 'corrigé') : null;
  if (!hasOffer(it)) return [h('span', { class: 'avail avail-other', title: 'Validée hors planning' }, 'Autre'), edited];
  const offer = offerOf(it);
  const tags = SEM_KEYS.filter(([k]) => offer[k])
    .map(([k]) => h('span', { class: `avail ${allowedMods(offer[k]).length ? '' : 'avail-off'}` }, SEM_SHORT[k]));
  return [...tags, edited];
}

function whereLabel(it) {
  if (!isActive(it)) return '';
  if (!hasOffer(it)) return STATUS[otherStatus(it.id)].label;
  if (isPrior(it.id)) return 'Déjà validée';
  const p = liveOf(it.id);
  if (!p) return 'À placer';
  return p.annual ? `${slotInfo(p.slot).label.slice(0, 7)} annuel` : slotInfo(p.slot).label;
}

function itemRow(it, { choice = false } = {}) {
  const active = isActive(it);
  const selected = S().selected.includes(it.id);
  return h('div', { class: `row ${choice ? 'row-choice' : ''} ${choice && selected ? 'row-selected' : ''}` },
    choice
      ? h('input', { type: 'checkbox', checked: selected, onchange: () => toggleSelected(it.id), 'aria-label': `Choisir ${it.code} ${it.title}`, 'data-key': `sel-${it.id}` })
      : h('span', { class: 'row-bullet', 'aria-hidden': 'true' }),
    h('button', { class: 'row-code', onclick: () => openDialog(it.id), 'data-key': `code-${it.id}` }, it.code || '—'),
    h('span', { class: 'row-title' }, it.title),
    h('span', { class: 'row-avail' }, availabilityTags(it)),
    h('span', { class: 'row-ects num' }, it.ects ? `${it.ects} ECTS` : '—'),
    h('span', { class: `row-where ${active && hasOffer(it) && !liveOf(it.id) && !isPrior(it.id) ? 'where-todo' : ''}` }, whereLabel(it)),
  );
}

function stateBadge(gs) {
  const label = { ok: 'Complet', todo: 'À compléter', over: 'Dépassé', info: '' }[gs.state];
  return h('span', { class: `gstate gstate-${gs.state}` },
    label && h('span', { class: 'gstate-label' }, label),
    gs.notes.length ? h('span', { class: 'gstate-notes' }, gs.notes.join(', ')) : null,
  );
}

function groupBlock(g) {
  const gs = groupState(g);
  const key = `grp-${g.id}`;
  const open = openGroups.has(g.id) ? openGroups.get(g.id) : gs.state !== 'ok';
  const onToggle = (ev) => openGroups.set(g.id, ev.target.open);

  if (g.kind === 'alternative') {
    return h('div', { class: 'group group-alt' },
      h('div', { class: 'group-head' }, h('span', { class: 'group-label' }, g.label), stateBadge(gs)),
      g.children.map(G).map((b) => {
        const chosen = S().branches.includes(b.id);
        return h('div', { class: `branch ${chosen ? 'branch-on' : ''}` },
          h('label', { class: 'branch-head' },
            h('input', { type: 'radio', name: `alt-${g.id}`, checked: chosen, onchange: () => chooseBranch(g.id, b.id), 'data-key': `br-${b.id}` }),
            h('span', { class: 'group-label' }, b.label),
            h('span', { class: 'muted num' }, `${fmt(groupTarget(b))} ECTS`),
          ),
          chosen ? h('div', { class: 'branch-body' }, branchRows(b)) : null,
        );
      }),
    );
  }

  const inner = g.kind === 'parent'
    ? g.children.map((c) => groupBlock(G(c)))
    : g.items.map(I).map((it) => itemRow(it, { choice: true }));
  return h('details', { class: `group group-${g.kind} gs-${gs.state}`, open, ontoggle: onToggle },
    h('summary', { class: 'group-head', 'data-key': key },
      h('span', { class: 'group-label' }, g.label),
      g.rule.total_ects ? h('span', { class: 'muted num' }, `${g.rule.total_ects} ECTS`) : null,
      stateBadge(gs),
    ),
    h('div', { class: 'group-body' }, inner),
  );
}

function branchRows(b) {
  const rendered = new Set();
  const rows = [];
  for (const it of P.data.items.filter((x) => {
    for (let g = x.group && G(x.group); g; g = g.parent && G(g.parent)) if (g.id === b.id) return true;
    return false;
  })) {
    if (it.group === b.id) { rows.push(itemRow(it)); continue; }
    let top = G(it.group);
    while (top.parent && top.parent !== b.id) top = G(top.parent);
    if (!rendered.has(top.id)) { rendered.add(top.id); rows.push(groupBlock(top)); }
  }
  return rows;
}

// ---------------------------------------------------------------- onglet Planning

let dragging = null; // { itemId, placementId, fromPrior }

function renderPlanning() {
  const slots = slotList();
  const pool = toPlaceItems();
  const pending = pendingChoices();
  const retries = new Set(S().placements.filter((p) => p.status === 'failed').map((p) => p.item));

  const poolByYear = P.data.years
    .map((y) => [y, pool.filter((it) => it.year === y.id)])
    .filter(([, list]) => list.length);

  return h('div', { class: 'planning' },
    pending.length
      ? h('p', { class: 'notice' },
        `${plural(pending.length, 'choix reste', 'choix restent')} à faire dans le programme. Les UE non choisies n’apparaissent pas ici.`,
        h('button', { class: 'btn btn-link', onclick: () => { P.tab = 'programme'; paint(renderPlan); } }, 'Faire les choix'))
      : null,
    h('div', { class: 'board-wrap' },
      h('aside', {
        class: `pool dropzone ${P.poolCollapsed ? 'pool-collapsed' : ''}`, 'aria-label': 'UE à placer', 'data-drop': 'pool',
        ondragover: (ev) => { if (dragging?.placementId || dragging?.fromPrior) { ev.preventDefault(); ev.currentTarget.classList.add('drop-hover'); } },
        ondragleave: (ev) => { if (!ev.currentTarget.contains(ev.relatedTarget)) ev.currentTarget.classList.remove('drop-hover'); },
        ondrop: (ev) => {
          ev.preventDefault();
          if (dragging?.placementId) unplace(dragging.placementId);
          else if (dragging?.fromPrior) unmarkPrior(dragging.itemId);
          endDrag();
        },
      },
        h('header', { class: 'col-head pool-head' },
          h('span', { class: 'col-title' }, 'À placer'),
          h('span', { class: 'col-sub num' }, `${pool.length} UE, ${fmt(pool.reduce((a, it) => a + it.ects, 0))} ECTS`),
          pool.length ? h('span', { class: 'col-sub touch-only' }, 'Touche une UE pour choisir son semestre.') : null,
          pool.length ? h('button', {
            class: 'btn btn-quiet pool-toggle', 'aria-expanded': String(!P.poolCollapsed), 'data-key': 'pool-toggle',
            onclick: () => { P.poolCollapsed = !P.poolCollapsed; paint(renderPlan); },
          }, P.poolCollapsed ? 'Afficher' : 'Replier') : null,
        ),
        h('div', { class: 'col-body', 'data-scroll': 'pool' },
          pool.length
            ? poolByYear.map(([y, list]) => [
              P.data.years.length > 1 ? h('h3', { class: 'pool-year' }, y.label) : null,
              list.map((it) => poolCard(it, retries.has(it.id))),
            ])
            : h('p', { class: 'muted pool-empty' }, 'Toutes les UE sont placées.'),
        ),
      ),
      h('div', { class: 'board', 'data-scroll': 'board', role: 'list', 'aria-label': 'Semestres' },
        priorColumn(),
        slots.map((sl) => column(sl)),
      ),
    ),
    renderOtherPanel(),
  );
}

function poolCard(it, retry) {
  const placeable = anySlot(it);
  return h('div', {
    class: `card card-pool ${placeable ? '' : 'card-blocked'}`, draggable: true, tabindex: 0, role: 'button',
    'data-key': `pool-${it.id}`, 'aria-label': `${it.code} ${it.title}, ${it.ects} ECTS, ouvrir pour placer`,
    ondragstart: (ev) => startDrag(ev, { itemId: it.id }),
    ondragend: endDrag,
    onclick: () => openDialog(it.id),
    onkeydown: (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); openDialog(it.id); } },
  },
    h('div', { class: 'card-top' },
      h('span', { class: 'card-code' }, it.code),
      h('span', { class: 'card-ects num' }, it.ects),
    ),
    h('div', { class: 'card-title' }, it.title),
    h('div', { class: 'card-meta' },
      availabilityTags(it),
      retry ? h('span', { class: 'tag tag-retry' }, 'À repasser') : null,
      placeable ? null : h('span', { class: 'tag tag-warn' }, 'Aucun semestre possible'),
    ),
  );
}

function column(sl) {
  const totals = slotTotals(sl.i);
  const cards = [];
  for (const p of visiblePlacements()) {
    if (p.slot === sl.i) cards.push(placedCard(p, false));
    else if (p.annual && p.slot + 1 === sl.i) cards.push(placedCard(p, true));
  }
  const order = { validated: 0, enrolled: 1, planned: 2, failed: 3 };
  cards.sort((a, b) => order[a.dataset.status] - order[b.dataset.status]);
  const newYear = sl.sem === 1 || sl.i === 0;
  return h('section', {
    class: `col ${sl.out ? 'col-out' : ''} ${newYear ? 'col-year-start' : ''}`, role: 'listitem',
    'data-slot': String(sl.i), 'aria-label': sl.label,
    ondragover: (ev) => {
      if (!dragging || !canDrop(I(dragging.itemId), sl.i)) return;
      ev.preventDefault();
      ev.currentTarget.classList.add('drop-hover');
    },
    ondragleave: (ev) => { if (!ev.currentTarget.contains(ev.relatedTarget)) ev.currentTarget.classList.remove('drop-hover'); },
    ondrop: (ev) => {
      ev.preventDefault();
      if (dragging) {
        // Un déplacement garde le mode annuel s'il reste possible, sinon passe en semestriel.
        const p = dragging.placementId && S().placements.find((x) => x.id === dragging.placementId);
        const o = slotOptions(I(dragging.itemId), sl.i);
        const annual = p ? (p.annual && Boolean(o.annual)) || !o.sem : undefined;
        place(dragging.itemId, sl.i, { placementId: dragging.placementId, annual });
      }
      endDrag();
    },
  },
    h('header', { class: 'col-head' },
      h('span', { class: 'col-year num' }, sl.out ? 'Hors période' : `${sl.y}-${sl.y + 1}`),
      h('span', { class: 'col-title' }, sl.sem === 1 ? '1er semestre' : '2nd semestre'),
    ),
    h('div', { class: 'col-body' }, cards.length ? cards : h('p', { class: 'col-empty' }, sl.out ? '' : [
      h('span', { class: 'mouse-only' }, 'Dépose une UE ici'), h('span', { class: 'touch-only' }, 'Aucune UE pour ce semestre'),
    ])),
    h('footer', { class: 'col-foot' },
      h('span', { class: 'col-sum num' }, h('strong', {}, fmt(totals.total)), ' ECTS'),
      totals.validated ? h('span', { class: 'col-sub num ok' }, `${fmt(totals.validated)} validés`) : null,
      totals.failed ? h('span', { class: 'col-sub num bad' }, `${fmt(totals.failed)} échoués`) : null,
    ),
  );
}

function priorColumn() {
  const list = visiblePrior();
  const total = list.reduce((a, it) => a + it.ects, 0);
  return h('section', {
    class: 'col col-prior', role: 'listitem', 'aria-label': 'Déjà validé',
    ondragover: (ev) => {
      if (!dragging || dragging.fromPrior) return;
      ev.preventDefault();
      ev.currentTarget.classList.add('drop-hover');
    },
    ondragleave: (ev) => { if (!ev.currentTarget.contains(ev.relatedTarget)) ev.currentTarget.classList.remove('drop-hover'); },
    ondrop: (ev) => {
      ev.preventDefault();
      if (dragging && !dragging.fromPrior) markPrior(dragging.itemId);
      endDrag();
    },
  },
    h('header', { class: 'col-head' },
      h('span', { class: 'col-year num' }, `Avant ${slotInfo(0).label}`),
      h('span', { class: 'col-title' }, 'Déjà validé'),
    ),
    h('div', { class: 'col-body' }, list.length
      ? list.map(priorCard)
      : h('p', { class: 'col-empty' },
        h('span', { class: 'mouse-only' }, 'Dépose ici les UE obtenues avant ce plan'),
        h('span', { class: 'touch-only' }, 'Pour y mettre une UE obtenue avant ce plan, touche-la puis « Marquer comme déjà validée ».'))),
    h('footer', { class: 'col-foot' },
      h('span', { class: 'col-sum num' }, h('strong', {}, fmt(total)), ' ECTS'),
      list.length ? h('span', { class: 'col-sub num ok' }, plural(list.length, 'UE', 'UE')) : null,
    ),
  );
}

function priorCard(it) {
  return h('div', {
    class: 'card s-validated card-prior', draggable: true, tabindex: 0, role: 'button',
    'data-key': `pr-${it.id}`, 'aria-label': `${it.code} ${it.title}, déjà validée, ouvrir le détail`,
    ondragstart: (ev) => startDrag(ev, { itemId: it.id, fromPrior: true }),
    ondragend: endDrag,
    onclick: () => openDialog(it.id),
    onkeydown: (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); openDialog(it.id); } },
  },
    h('div', { class: 'card-top' },
      h('span', { class: 'card-code' }, it.code),
      yearTag(it.year) ? h('span', { class: 'tag' }, yearTag(it.year)) : null,
      h('span', { class: 'card-ects num' }, it.ects),
    ),
    h('div', { class: 'card-title' }, it.title),
    h('div', { class: 'card-foot' },
      h('span', { class: 'card-mod' }, 'Avant le plan'),
      h('span', { class: 'status-chip s-validated' }, 'Validée'),
    ),
  );
}

function placedCard(p, continuation) {
  const it = I(p.item);
  const valid = placementValid(p);
  const mods = placementMods(p);
  const failed = p.status === 'failed';
  const draggable = !failed && !continuation;
  return h('div', {
    class: `card s-${p.status} ${continuation ? 'card-cont' : ''} ${valid ? '' : 'card-invalid'}`,
    'data-status': p.status, draggable, tabindex: 0, role: 'button',
    'data-key': `pl-${p.id}-${continuation ? 'c' : 'm'}`,
    'aria-label': `${it.code} ${it.title}, ${STATUS[p.status].label}, ouvrir le détail`,
    ondragstart: draggable ? (ev) => startDrag(ev, { itemId: it.id, placementId: p.id }) : null,
    ondragend: endDrag,
    onclick: (ev) => { if (!ev.target.closest('.status-chip')) openDialog(it.id); },
    onkeydown: (ev) => { if ((ev.key === 'Enter' || ev.key === ' ') && ev.target === ev.currentTarget) { ev.preventDefault(); openDialog(it.id); } },
  },
    h('div', { class: 'card-top' },
      h('span', { class: 'card-code' }, it.code),
      continuation ? null : [
        yearTag(it.year) ? h('span', { class: 'tag' }, yearTag(it.year)) : null,
        p.annual ? h('span', { class: 'tag' }, 'Annuel') : null,
      ],
      h('span', { class: 'card-ects num', title: p.annual ? `${fmt(it.ects / 2)} ECTS sur ce semestre, ${it.ects} sur l’année` : null },
        p.annual ? fmt(it.ects / 2) : it.ects),
    ),
    h('div', { class: 'card-title' }, continuation ? 'Suite de l’UE annuelle' : it.title),
    valid ? null : h('p', { class: 'card-warn' }, 'Plus proposée à ce semestre avec les réglages actuels'),
    continuation ? null : h('div', { class: 'card-foot' },
      h('span', { class: 'card-mod' }, mods.map(shortModality).join(' ou ')),
      failed
        ? h('span', { class: 'status-chip s-failed' }, 'Échouée')
        : h('button', {
          class: `status-chip s-${p.status}`, 'data-key': `st-${p.id}`,
          title: 'Changer le statut', 'aria-label': `Statut : ${STATUS[p.status].label}. Passer à ${STATUS[STATUS_CYCLE[p.status]].label}`,
          onclick: (ev) => { ev.stopPropagation(); setStatus(p.id, STATUS_CYCLE[p.status]); },
        }, STATUS[p.status].label),
    ),
  );
}

function startDrag(ev, info) {
  dragging = info;
  ev.dataTransfer.effectAllowed = 'move';
  ev.dataTransfer.setData('text/plain', info.itemId);
  const it = I(info.itemId);
  requestAnimationFrame(() => {
    document.body.classList.add('is-dragging');
    for (const col of document.querySelectorAll('.col[data-slot]')) {
      col.classList.toggle(canDrop(it, Number(col.dataset.slot)) ? 'drop-ok' : 'drop-no', true);
    }
    if (info.placementId || info.fromPrior) document.querySelector('.pool')?.classList.add('drop-ok');
    document.querySelector('.col-prior')?.classList.add(info.fromPrior ? 'drop-no' : 'drop-ok');
  });
}

function endDrag() {
  dragging = null;
  document.body.classList.remove('is-dragging');
  for (const el of document.querySelectorAll('.drop-ok, .drop-no, .drop-hover')) el.classList.remove('drop-ok', 'drop-no', 'drop-hover');
}

function renderOtherPanel() {
  const list = otherItems();
  if (!list.length) return null;
  return h('section', { class: 'other', 'aria-labelledby': 'other-title' },
    h('header', { class: 'other-head' },
      h('h2', { id: 'other-title' }, 'Autre'),
      h('p', { class: 'muted' }, 'Éléments sans semestre : ils se valident autrement et restent hors du planning. Leurs crédits comptent dans la progression.'),
    ),
    h('div', { class: 'other-list' }, list.map(otherRow)),
  );
}

function otherRow(it) {
  const cur = otherStatus(it.id);
  return h('div', { class: `other-row os-${cur}` },
    h('button', { class: 'row-code', onclick: () => openDialog(it.id), 'data-key': `oc-${it.id}` }, it.code || '—'),
    h('span', { class: 'row-title' }, it.title, yearTag(it.year) ? h('span', { class: 'tag' }, yearTag(it.year)) : null),
    h('span', { class: 'row-ects num' }, it.ects ? `${it.ects} ECTS` : '—'),
    segmented(`o-${it.id}`, STATUS_LABELS, cur, (v) => setOtherStatus(it.id, v)),
  );
}

function segmented(key, options, current, onPick, labelPrefix = 'Statut') {
  return h('div', { class: 'seg', role: 'radiogroup', 'aria-label': labelPrefix },
    Object.entries(options).map(([v, label]) => h('button', {
      class: `seg-btn seg-${v}`, role: 'radio', 'aria-checked': String(v === current), 'data-key': `${key}-${v}`,
      onclick: () => onPick(v),
    }, label)),
  );
}

// ---------------------------------------------------------------- détail d'une UE

function openDialog(itemId) {
  dialog.dataset.item = itemId;
  renderDialog(itemId);
  if (!dialog.open) dialog.showModal();
}

dialog.addEventListener('close', () => { delete dialog.dataset.item; });
dialog.addEventListener('click', (ev) => { if (ev.target === dialog) dialog.close(); });

function renderDialog(itemId) {
  const it = I(itemId);
  const active = isActive(it);
  const live = liveOf(it.id);
  const history = S().placements.filter((p) => p.item === it.id && p.status === 'failed');
  const group = it.group && G(it.group);
  const n = S().settings.n_sem;
  const focusKey = document.activeElement?.dataset?.key;

  const offer = offerOf(it);
  const offerRows = SEM_KEYS
    .filter(([k]) => offer[k])
    .map(([k, label]) => h('li', {}, h('span', { class: 'offer-sem' }, label),
      h('span', {}, offer[k].map((m) => h('span', { class: `mod ${allowedMods([m]).length ? '' : 'mod-off'}` }, shortModality(m))))));

  const siteText = siteKeys(it).map((k) => SEM_SHORT[k]).join(', ') || 'aucun semestre';
  const offerEditor = h('div', { class: 'dlg-section offer-edit' },
    h('h3', {}, 'Semestres possibles'),
    h('div', { class: 'chips' }, SEM_KEYS.map(([k, label]) => h('label', { class: 'check-chip' },
      h('input', { type: 'checkbox', checked: Boolean(offer[k]), onchange: () => toggleOfferKey(it.id, k), 'data-key': `ov-${k}` }),
      h('span', {}, label)))),
    isOverridden(it)
      ? h('p', { class: 'offer-edit-note' },
        `Corrigé à la main pour ce plan. Sur la fiche du Cnam : ${siteText}.`,
        h('button', { class: 'btn btn-link', 'data-key': 'ov-reset', onclick: () => resetOffer(it.id) }, 'Revenir à la fiche'))
      : h('p', { class: 'muted' }, 'Si la fiche du Cnam n’est pas à jour, coche les semestres réels. La correction ne vaut que pour ce plan.'),
  );

  let placement = null;
  if (active && hasOffer(it)) {
    const semButtons = Array.from({ length: n }, (_, i) => {
      const sl = slotInfo(i);
      const o = slotOptions(it, i);
      const current = live && !live.annual && live.slot === i;
      return h('button', {
        class: `slot-btn ${current ? 'slot-current' : ''}`, disabled: !o.sem, 'aria-pressed': String(Boolean(current)),
        'data-key': `sb-${i}`, onclick: () => place(it.id, i, { annual: false }),
      }, sl.label);
    });
    const annualButtons = offer.A
      ? Array.from({ length: n }, (_, i) => i).filter((i) => slotInfo(i).sem === 1 && i + 1 < n).map((i) => {
        const o = slotOptions(it, i);
        const current = live && live.annual && live.slot === i;
        const sl = slotInfo(i);
        return h('button', {
          class: `slot-btn ${current ? 'slot-current' : ''}`, disabled: !o.annual, 'aria-pressed': String(Boolean(current)),
          'data-key': `ab-${i}`, onclick: () => place(it.id, i, { annual: true }),
        }, `${sl.y}-${sl.y + 1}`);
      })
      : [];
    placement = h('div', { class: 'dlg-section' },
      h('h3', {}, live ? 'Déplacer vers' : 'Placer au semestre'),
      (offer.S1 || offer.S2) ? h('div', { class: 'slot-grid' }, semButtons) : null,
      annualButtons.length ? [h('h3', {}, 'Sur une année complète'), h('div', { class: 'slot-grid' }, annualButtons)] : null,
      live ? [
        h('h3', {}, 'Statut'),
        segmented(`dst-${live.id}`, STATUS_LABELS, live.status, (v) => setStatus(live.id, v)),
      ] : null,
      isPrior(it.id) ? [
        h('h3', {}, 'Statut'),
        h('p', { class: 'prior-note' }, 'Validée avant ce plan, dans la colonne « Déjà validé ». Ses crédits comptent comme validés.'),
      ] : null,
      h('div', { class: 'actions dlg-actions' },
        isPrior(it.id)
          ? h('button', { class: 'btn btn-quiet', 'data-key': 'unprior', onclick: () => unmarkPrior(it.id) }, 'Retirer de « Déjà validé »')
          : h('button', { class: 'btn btn-quiet', 'data-key': 'prior', onclick: () => markPrior(it.id) }, 'Marquer comme déjà validée'),
        live ? h('button', { class: 'btn btn-ghost btn-danger', 'data-key': 'unplace', onclick: () => unplace(live.id) }, 'Retirer du planning') : null,
      ),
      history.length ? [
        h('h3', {}, 'Tentatives échouées'),
        h('ul', { class: 'history' }, history.map((p) => h('li', {},
          h('span', {}, p.annual ? `${slotInfo(p.slot).y}-${slotInfo(p.slot).y + 1}, annuel` : slotInfo(p.slot).label),
          h('button', { class: 'btn btn-link', onclick: () => { S().placements = S().placements.filter((x) => x.id !== p.id); commit(); } }, 'Effacer'),
        ))),
      ] : null,
    );
  } else if (active) {
    placement = h('div', { class: 'dlg-section' },
      h('p', { class: 'muted' }, isOverridden(it)
        ? 'Aucun semestre retenu : cet élément se valide hors planning.'
        : 'Aucun semestre indiqué sur la fiche : cet élément se valide hors planning.'),
      segmented(`dos-${it.id}`, STATUS_LABELS, otherStatus(it.id), (v) => setOtherStatus(it.id, v)),
    );
  } else {
    placement = h('p', { class: 'muted dlg-section' }, group?.kind === 'choice'
      ? 'Cette UE n’est pas choisie dans son groupe. Coche-la dans l’onglet Programme pour la planifier.'
      : 'Cette UE ne fait pas partie des années ou du parcours retenus.');
  }

  dialog.replaceChildren(
    h('div', { class: 'dlg' },
      h('header', { class: 'dlg-head' },
        h('div', {},
          h('p', { class: 'dlg-code' }, it.code, h('span', { class: 'num' }, `${it.ects} ECTS`)),
          h('h2', { id: 'ue-dialog-title' }, it.title),
          h('p', { class: 'muted' }, [yearOf(it.year)?.label, group?.label].filter(Boolean).join(', ')),
        ),
        h('button', { class: 'btn btn-icon', 'aria-label': 'Fermer', onclick: () => dialog.close() }, '✕'),
      ),
      offerRows.length ? h('ul', { class: 'offer' }, offerRows) : null,
      it.offer_notes?.length ? h('p', { class: 'muted' }, it.offer_notes.join(' ')) : null,
      it.link ? h('p', {}, h('a', { href: it.link, target: '_blank', rel: 'noopener' }, 'Voir la fiche de l’UE sur le site du Cnam')) : null,
      placement,
      offerEditor,
    ),
  );
  if (focusKey) dialog.querySelector(`[data-key="${CSS.escape(focusKey)}"]`)?.focus();
}

// ---------------------------------------------------------------- onglet Récapitulatif

function renderRecap() {
  const slots = slotList();
  const all = visiblePlacements();
  const statusOptions = STATUS_LABELS;
  const grand = { planned: 0, enrolled: 0, validated: 0, failed: 0, total: 0 };

  const prior = visiblePrior();
  const priorEcts = prior.reduce((a, it) => a + it.ects, 0);
  grand.total += priorEcts;
  grand.validated += priorEcts;
  const priorBody = prior.length ? h('tbody', { class: 'prior' },
    h('tr', { class: 'sem-row' },
      h('th', { scope: 'rowgroup', colspan: '2' }, 'Déjà validé'),
      h('td', { class: 'num', 'data-label': 'ECTS validés avant le plan' }, fmt(priorEcts)),
      h('td', { class: 'num', 'data-label': 'inscrits' }, '—'),
      h('td', { class: 'num ok', 'data-label': 'validés' }, fmt(priorEcts)),
      h('td', { class: 'num bad', 'data-label': 'échoués' }, '—'),
    ),
    prior.map((it) => h('tr', { class: 'ue-row s-validated' },
      h('td', {}, h('button', { class: 'row-code', onclick: () => openDialog(it.id), 'data-key': `rp-${it.id}` }, it.code)),
      h('td', { class: 'ue-title' }, it.title),
      h('td', { class: 'num ue-ects', 'data-label': 'ECTS' }, fmt(it.ects)),
      h('td', { colspan: '3', class: 'ue-status' },
        h('span', { class: 'prior-label' }, 'Validée avant le plan'),
        h('button', { class: 'btn btn-link', 'data-key': `rpu-${it.id}`, onclick: () => unmarkPrior(it.id) }, 'Retirer')),
    )),
  ) : null;

  const bodies = slots.map((sl) => {
    const t = slotTotals(sl.i);
    for (const k of Object.keys(grand)) grand[k] += t[k];
    const rows = all.filter((p) => p.slot === sl.i || (p.annual && p.slot + 1 === sl.i));
    return h('tbody', { class: sl.out ? 'out' : '' },
      h('tr', { class: 'sem-row' },
        h('th', { scope: 'rowgroup', colspan: '2' }, sl.label, sl.out ? h('span', { class: 'tag tag-warn' }, 'Hors période') : null),
        h('td', { class: 'num', 'data-label': 'ECTS prévus' }, fmt(t.total)),
        h('td', { class: 'num', 'data-label': 'inscrits' }, fmt(t.enrolled)),
        h('td', { class: 'num ok', 'data-label': 'validés' }, fmt(t.validated)),
        h('td', { class: 'num bad', 'data-label': 'échoués' }, t.failed ? fmt(t.failed) : '—'),
      ),
      rows.length
        ? rows.map((p) => {
          const it = I(p.item);
          const cont = p.annual && p.slot + 1 === sl.i;
          return h('tr', { class: `ue-row s-${p.status}` },
            h('td', {}, h('button', { class: 'row-code', onclick: () => openDialog(it.id), 'data-key': `rc-${p.id}-${sl.i}` }, it.code)),
            h('td', { class: 'ue-title' }, it.title, p.annual ? h('span', { class: 'tag' }, cont ? 'Annuel, suite' : 'Annuel') : null),
            h('td', { class: 'num ue-ects', 'data-label': 'ECTS' }, fmt(p.annual ? it.ects / 2 : it.ects)),
            h('td', { colspan: '3', class: 'ue-status' }, cont
              ? h('span', { class: 'muted' }, STATUS[p.status].label)
              : segmented(`rs-${p.id}`, statusOptions, p.status, (v) => setStatus(p.id, v))),
          );
        })
        : h('tr', {}, h('td', { colspan: '6', class: 'muted empty-cell' }, 'Aucune UE planifiée')),
    );
  });

  const others = otherItems();
  return h('div', { class: 'recap' },
    h('div', { class: 'table-scroll' },
      h('table', { class: 'recap-table' },
        h('caption', {}, 'Crédits par semestre et suivi des UE'),
        h('thead', {}, h('tr', {},
          h('th', { scope: 'col', colspan: '2' }, 'Semestre et UE'),
          h('th', { scope: 'col', class: 'num' }, 'ECTS prévus'),
          h('th', { scope: 'col', class: 'num' }, 'Inscrits'),
          h('th', { scope: 'col', class: 'num' }, 'Validés'),
          h('th', { scope: 'col', class: 'num' }, 'Échoués'),
        )),
        priorBody,
        bodies,
        h('tfoot', {}, h('tr', {},
          h('th', { scope: 'row', colspan: '2' }, 'Total planning'),
          h('td', { class: 'num', 'data-label': 'ECTS prévus' }, fmt(grand.total)),
          h('td', { class: 'num', 'data-label': 'inscrits' }, fmt(grand.enrolled)),
          h('td', { class: 'num ok', 'data-label': 'validés' }, fmt(grand.validated)),
          h('td', { class: 'num bad', 'data-label': 'échoués' }, grand.failed ? fmt(grand.failed) : '—'),
        )),
      ),
    ),
    others.length ? h('section', { class: 'other' },
      h('header', { class: 'other-head' }, h('h2', {}, 'Autre'),
        h('p', { class: 'muted' }, `${fmt(others.filter((it) => otherStatus(it.id) === 'validated').reduce((a, it) => a + it.ects, 0))} ECTS validés sur ${fmt(others.reduce((a, it) => a + it.ects, 0))}`)),
      h('div', { class: 'other-list' }, others.map(otherRow)),
    ) : null,
  );
}

// ---------------------------------------------------------------- onglet Réglages

function renderSettings() {
  const st = S().settings;
  const cy = currentAcademicYear();
  const update = (patch) => { Object.assign(st, patch); commit(); };
  const toggleYear = (id) => {
    const years = st.years.includes(id) ? st.years.filter((y) => y !== id) : P.data.years.map((y) => y.id).filter((y) => y === id || st.years.includes(y));
    if (!years.length) return toast('Garde au moins une année du programme.', 'error');
    update({ years });
  };
  const toggleMod = (m) => {
    const mods = st.modalities.includes(m) ? st.modalities.filter((x) => x !== m) : [...st.modalities, m];
    update({ modalities: mods });
  };
  const outside = S().placements.filter((p) => p.slot + (p.annual ? 1 : 0) >= st.n_sem).length;

  return h('div', { class: 'settings' },
    h('label', { class: 'field' }, h('span', {}, 'Nom du plan'),
      h('input', {
        type: 'text', value: P.plan.name, 'data-key': 'set-name', maxlength: '120',
        onchange: (ev) => {
          const name = ev.target.value.trim();
          if (!name) { ev.target.value = P.plan.name; return; }
          P.plan.name = name;
          document.title = `${name} | Planificateur Cnam`;
          commit();
        },
      })),
    h('fieldset', { class: 'field' },
      h('legend', {}, 'Années du programme incluses'),
      h('div', { class: 'chips' }, P.data.years.map((y) => h('label', { class: 'check-chip' },
        h('input', { type: 'checkbox', checked: st.years.includes(y.id), onchange: () => toggleYear(y.id), 'data-key': `sy-${y.id}` }),
        h('span', {}, y.label)))),
    ),
    h('div', { class: 'field-row' },
      h('label', { class: 'field' }, h('span', {}, 'Rentrée'),
        h('select', { value: String(st.start_year), 'data-key': 'set-sy', onchange: (ev) => update({ start_year: Number(ev.target.value) }) },
          Array.from({ length: 11 }, (_, k) => Math.min(cy, st.start_year) - 5 + k).map((y) => h('option', { value: String(y) }, `${y}-${y + 1}`)))),
      h('label', { class: 'field' }, h('span', {}, 'Premier semestre'),
        h('select', { value: String(st.start_sem), 'data-key': 'set-ss', onchange: (ev) => update({ start_sem: Number(ev.target.value) }) },
          h('option', { value: '1' }, '1er semestre (septembre)'),
          h('option', { value: '2' }, '2nd semestre (février)'))),
      h('label', { class: 'field' }, h('span', {}, 'Durée en semestres'),
        h('input', {
          type: 'number', min: '1', max: '24', value: String(st.n_sem), 'data-key': 'set-ns',
          onchange: (ev) => { const v = Math.max(1, Math.min(24, Number(ev.target.value) || 1)); update({ n_sem: v }); },
        })),
    ),
    outside ? h('p', { class: 'notice' }, `${plural(outside, 'UE planifiée dépasse', 'UE planifiées dépassent')} la durée choisie. Elles restent visibles dans une colonne « Hors période ».`) : null,
    h('fieldset', { class: 'field' },
      h('legend', {}, 'Modalités acceptées'),
      h('p', { class: 'muted' }, 'Une UE ne peut être placée qu’aux semestres où l’une de ces modalités est proposée.'),
      h('div', { class: 'chips chips-col' }, P.data.modalities.map((m) => h('label', { class: 'check-chip' },
        h('input', { type: 'checkbox', checked: st.modalities.includes(m), onchange: () => toggleMod(m), 'data-key': `mod-${m}` }),
        h('span', {}, shortModality(m))))),
    ),
    renderOverrides(),
    h('div', { class: 'danger-zone' },
      h('h2', {}, 'Ce plan'),
      h('p', { class: 'muted' }, `Maquette ${P.maquette.version}${P.maquette.fetched_at ? `, récupérée le ${dateFr(P.maquette.fetched_at)}` : ''}. Un plan reste attaché à sa maquette : quand une version plus récente est publiée, un bandeau propose d’en faire une copie.`),
      h('div', { class: 'actions' },
        h('button', {
          class: 'btn btn-quiet', onclick: async () => {
            const name = prompt('Nom de la copie', `${P.plan.name} (copie)`);
            if (!name?.trim()) return;
            const { diploma, version, diploma_title, state } = P.plan;
            const copy = store.createPlan({ name: name.trim(), diploma, version, diploma_title, state });
            location.hash = `#/plan/${copy.id}`;
          },
        }, 'Dupliquer le plan'),
        h('button', {
          class: 'btn btn-ghost btn-danger', onclick: async () => {
            const where = sync.isConnected() ? ' sur tous tes appareils synchronisés' : '';
            if (!confirm(`Supprimer définitivement « ${P.plan.name} »${where} ?`)) return;
            store.deletePlan(P.plan.id);
            location.hash = '#/';
          },
        }, 'Supprimer le plan'),
      ),
    ),
  );
}

function renderOverrides() {
  const edited = Object.keys(S().overrides).map(I).filter(Boolean);
  const label = (keys) => keys.map((k) => SEM_SHORT[k]).join(', ') || 'aucun';
  return h('section', { class: 'overrides', 'aria-labelledby': 'overrides-title' },
    h('h2', { id: 'overrides-title' }, 'Semestres corrigés à la main'),
    edited.length
      ? h('ul', { class: 'override-list' }, edited.map((it) => h('li', {},
        h('button', { class: 'row-code', onclick: () => openDialog(it.id), 'data-key': `ovl-${it.id}` }, it.code),
        h('span', { class: 'row-title' }, it.title),
        h('span', { class: 'muted' }, `fiche : ${label(siteKeys(it))}, plan : ${label(S().overrides[it.id])}`),
        h('button', { class: 'btn btn-link', onclick: () => resetOffer(it.id) }, 'Revenir à la fiche'),
      )))
      : h('p', { class: 'muted' }, 'Aucune correction. Pour en faire une, ouvre une UE (clic sur son code ou sa carte) et coche ses semestres réels.'),
  );
}

renderSyncState();
route();
if (sync.isConnected()) sync.syncNow();
