import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { search, words } from '../../site/search.js';

const { diplomas } = JSON.parse(readFileSync(new URL('../../site/data/catalog.json', import.meta.url)));
const top = (q, n = 3) => search(diplomas, q).slice(0, n).map((r) => r.diploma.title);

test('accents, casse et petits mots ignorés', () => {
  assert.deepEqual(words("Diplôme d'ingénieur en Cybersécurité"), ['diplome', 'ingenieur', 'cybersecurite']);
});

test('début de mots, dans le désordre', () => {
  assert.match(top('cyber ingenieur')[0], /Diplôme d'ingénieur Spécialité informatique Parcours Cybersécurité/);
});

test('fautes de frappe', () => {
  assert.match(top('informatiqe')[0], /informatique/i);
  assert.ok(search(diplomas, 'managment').length > 0);
  assert.ok(search(diplomas, 'cybresecurite').some((r) => /Cybersécurité/.test(r.diploma.title)));
});

test('code diplôme et type', () => {
  assert.equal(search(diplomas, 'CYC9106A')[0].diploma.code, 'CYC9106A-PAR');
  assert.ok(search(diplomas, 'master informatique').every((r) => /master|informatique/i.test(`${r.diploma.title} ${r.diploma.type}`)));
});

test('aucun résultat pour du charabia', () => {
  assert.equal(search(diplomas, 'zzqxw').length, 0);
});
