import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMeal, parseSection } from '../scripts/parse.mjs';

// Fragment reconstruit d'après la fiche réelle du produit 2149 (chausson bolognaise).
const meal = `
<ul><li><a href="https://infos-nutrition.crous-montpellier.fr/produit/2149" title="Chausson bolognaise">Chausson bolognaise</a><a href="#">#</a></li></ul>
<h4>Allergènes</h4><p>Céleri, Gluten, Lait, Oeuf</p>
<h4>Valeurs nutritionnelles du repas*</h4>
<ul>
<li>Valeur nutritionnelle moyenne Pour une portion Apports journaliers</li>
<li><strong>Energie (Kj)</strong> <strong>1129 kj</strong> <strong>13%</strong></li>
<li><strong>Energie (Kcal)</strong> <strong>270 kcal</strong> <strong>14%</strong></li>
<li><strong>Lipides</strong> <strong>15 g</strong> <strong>21%</strong></li>
<li>dont Acides gras saturés 3.4 g 17%</li>
<li><strong>Glucides</strong> <strong>18.8 g</strong> <strong>7%</strong></li>
<li>dont Sucres simples 3.8 g 4%</li>
<li><strong>Fibres</strong> <strong>1.3 g</strong> <strong>-</strong></li>
<li><strong>Protéines</strong> <strong>16.3 g</strong> <strong>33%</strong></li>
<li><strong>Sel</strong> <strong>1.8 g</strong> <strong>29%</strong></li>
</ul><p>*AR = Apport de Référence pour un adulte-type (8400 kJ / 2000 kcal)</p>`;

test('fiche produit 2149', () => {
  assert.deepEqual(parseMeal(meal), {
    name: 'Chausson bolognaise',
    allergens: ['Céleri', 'Gluten', 'Lait', 'Oeuf'],
    kj: 1129, kcal: 270, fat: 15, sat: 3.4, carb: 18.8, sugar: 3.8, fiber: 1.3, prot: 16.3, salt: 1.8,
  });
});

test('liste de section : ids, noms, doublons, entités HTML', () => {
  const html = `<ul>
  <li><a href="https://infos-nutrition.crous-montpellier.fr/produit/1731" title="Mac &amp; Cheese">x</a><h3><a href="https://infos-nutrition.crous-montpellier.fr/produit/1731" title="Mac &amp; Cheese">Mac &amp; Cheese</a></h3></li>
  <li><a href="/produit/354" title="Pâtes sauce bolognaise">Pâtes sauce bolognaise</a></li></ul>`;
  assert.deepEqual(parseSection(html), [
    { id: 1731, name: 'Mac & Cheese' },
    { id: 354, name: 'Pâtes sauce bolognaise' },
  ]);
});
