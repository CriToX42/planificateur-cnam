// Report d'un plan sur une nouvelle maquette du même diplôme.
// Les identifiants internes (i12, g3, y2) changent d'une maquette à l'autre : on fait la
// correspondance par code d'UE, puis par libellé d'année et de parcours.

const uid = () => 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

function yearMapping(oldData, newData) {
  const map = new Map();
  oldData.years.forEach((y, i) => {
    const byLabel = newData.years.find((n) => n.label === y.label);
    const target = byLabel || newData.years[i];
    if (target) map.set(y.id, target.id);
  });
  return map;
}

function itemMapping(oldData, newData, years) {
  const byCode = new Map();
  for (const it of newData.items) {
    if (!it.code) continue;
    if (!byCode.has(it.code)) byCode.set(it.code, []);
    byCode.get(it.code).push(it);
  }
  const groupLabel = (data, gid) => data.groups.find((g) => g.id === gid)?.label;
  const map = new Map();
  for (const it of oldData.items) {
    const candidates = byCode.get(it.code) || [];
    const sameYear = candidates.filter((c) => c.year === years.get(it.year));
    const pool = sameYear.length ? sameYear : candidates;
    const sameGroup = pool.find((c) => groupLabel(newData, c.group) === groupLabel(oldData, it.group));
    const target = sameGroup || pool[0];
    if (target) map.set(it.id, target.id);
  }
  return map;
}

/** Retourne le nouvel état et la liste des codes d'UE utilisés qui n'existent plus. */
export function migrateState(state, oldData, newData, fromVersion) {
  const years = yearMapping(oldData, newData);
  const items = itemMapping(oldData, newData, years);
  const branches = new Map();
  for (const g of oldData.groups.filter((x) => x.kind === 'branch')) {
    const target = newData.groups.find((n) => n.kind === 'branch' && n.label === g.label);
    if (target) branches.set(g.id, target.id);
  }

  const missing = new Set();
  const code = (id) => oldData.items.find((i) => i.id === id)?.code || id;
  const mapItem = (id) => {
    if (items.has(id)) return items.get(id);
    missing.add(code(id));
    return null;
  };
  const mapList = (list) => [...new Set(list.map(mapItem).filter(Boolean))];
  const mapKeys = (obj) => Object.fromEntries(Object.entries(obj).map(([k, v]) => [mapItem(k), v]).filter(([k]) => k));

  const oldMods = new Set(oldData.modalities);
  const st = state.settings;
  const mappedYears = [...new Set(st.years.map((y) => years.get(y)).filter(Boolean))];
  const settings = {
    ...st,
    years: mappedYears.length ? mappedYears : newData.years.map((y) => y.id),
    // modalités écartées par l'élève : écartées aussi dans la nouvelle maquette ; nouvelles modalités : acceptées
    modalities: newData.modalities.filter((m) => st.modalities.includes(m) || !oldMods.has(m)),
  };

  const next = {
    settings,
    selected: mapList(state.selected || []),
    branches: (state.branches || []).map((b) => branches.get(b)).filter(Boolean),
    placements: (state.placements || []).flatMap((p) => {
      const item = mapItem(p.item);
      return item ? [{ ...p, id: uid(), item }] : [];
    }),
    other: mapKeys(state.other || {}),
    overrides: mapKeys(state.overrides || {}),
    prior: mapList(state.prior || []),
  };
  next.migration = { from: fromVersion, missing: [...missing].sort(), dismissed: false };
  return next;
}
