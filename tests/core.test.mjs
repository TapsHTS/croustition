import test from 'node:test';
import assert from 'node:assert/strict';
import { splitInput, parseQuantity, tokens, buildIndex, rank, confidence, totals, formatQty } from '../public/core.js';

// Catalogue factice : sert uniquement à tester la logique (valeurs nutritionnelles inventées pour les tests).
const products = [
  { id: 1, name: 'Pâtes sauce bolognaise', kcal: 400, prot: 20, carb: 50, fat: 12, allergens: ['Gluten'] },
  { id: 2, name: 'Pâtes', kcal: 200, prot: 7, carb: 40, fat: 1, allergens: ['Gluten'] },
  { id: 3, name: 'Pâtes sauce carbonara', kcal: 500, prot: 18, carb: 50, fat: 25, allergens: ['Gluten', 'Lait'] },
  { id: 4, name: 'Yaourt nature', kcal: 60, prot: 4, carb: 5, fat: 3, allergens: ['Lait'] },
  { id: 5, name: 'Yaourt aromatisé vanille', kcal: 90, prot: 4, carb: 14, fat: 2, allergens: ['Lait'] },
  { id: 6, name: 'Chausson bolognaise', kcal: 270, prot: 16, carb: 19, fat: 15, allergens: ['Gluten', 'Lait'] },
  { id: 7, name: 'Brocolis', kcal: 30, prot: 3, carb: 3, fat: 0.5, allergens: [] },
  { id: 8, name: 'Pizza margherita', kcal: 600, prot: 25, carb: 70, fat: 20, allergens: ['Gluten', 'Lait'] },
];
const index = buildIndex(products);
const top = (q) => rank(parseQuantity(q).text, index)[0];

test('découpage de la phrase', () => {
  assert.deepEqual(splitInput('pâtes bolo, 2 yaourts à la fraise'), ['pâtes bolo', '2 yaourts à la fraise']);
  assert.deepEqual(splitInput('chausson et brocolis + 2 yaourts nature'), ['chausson', 'brocolis', '2 yaourts nature']);
  assert.deepEqual(splitInput('  '), []);
});

test('quantités', () => {
  assert.deepEqual(parseQuantity('2 yaourts nature'), { qty: 2, text: 'yaourts nature' });
  assert.deepEqual(parseQuantity('2x yaourt'), { qty: 2, text: 'yaourt' });
  assert.deepEqual(parseQuantity('deux yaourts'), { qty: 2, text: 'yaourts' });
  assert.deepEqual(parseQuantity('une pizza'), { qty: 1, text: 'pizza' });
  assert.deepEqual(parseQuantity('une demi pizza'), { qty: 0.5, text: 'pizza' });
  assert.deepEqual(parseQuantity('1/2 pizza'), { qty: 0.5, text: 'pizza' });
  assert.deepEqual(parseQuantity('½ pizza'), { qty: 0.5, text: 'pizza' });
  assert.deepEqual(parseQuantity('pizza x3'), { qty: 3, text: 'pizza' });
  assert.deepEqual(parseQuantity('1,5 pizza'), { qty: 1.5, text: 'pizza' });
  assert.deepEqual(parseQuantity('brocolis'), { qty: 1, text: 'brocolis' });
  assert.equal(formatQty(1), ''); assert.equal(formatQty(0.5), '½'); assert.equal(formatQty(3), '3');
});

test('tokens : accents, pluriels, abréviations, mots vides', () => {
  assert.deepEqual(tokens('Pâtes bolo'), ['pate', 'bolognaise']);
  assert.deepEqual(tokens('2 yaourts à la fraise'.replace('2 ', '')), ['yaourt', 'fraise']);
  assert.deepEqual(tokens("sauce volaille à l'oseille"), ['sauce', 'volaille', 'oseille']);
});

test('"pâtes bolo" -> pâtes sauce bolognaise (pas la garniture seule)', () => {
  const t = top('pâtes bolo');
  assert.equal(products[t.i].id, 1);
  assert.equal(confidence(rank('pâtes bolo', index)), 'sure');
});

test('"pâtes" seul -> la garniture', () => {
  assert.equal(products[top('pâtes').i].id, 2);
});

test('"yaourts nature" -> yaourt nature', () => {
  assert.equal(products[top('yaourts nature').i].id, 4);
});

test('yaourt à la fraise absent du catalogue : proche mais à vérifier, jamais "sûr"', () => {
  const c = rank('yaourts à la fraise', index);
  assert.ok(['check', 'none'].includes(confidence(c)));
  assert.ok(['Yaourt nature', 'Yaourt aromatisé vanille'].includes(products[c[0].i].name));
});

test('chausson bolognaise vs pâtes bolognaise', () => {
  assert.equal(products[top('chausson bolo').i].id, 6);
});

test('faute de frappe légère', () => {
  assert.equal(products[top('brocoli').i].id, 7);
  assert.equal(products[top('margarita').i].id, 8);
});

test('rien de pertinent -> none', () => {
  assert.equal(confidence(rank('sushi', index)), 'none');
});

test('totaux avec quantités', () => {
  const t = totals([{ product: products[5], qty: 1 }, { product: products[3], qty: 2 }]);
  assert.equal(t.kcal, 390);
  assert.equal(t.prot, 24);
  assert.deepEqual(t.allergens, ['Gluten', 'Lait']);
});

test('embeddings : le score fusionné remonte le bon candidat', () => {
  // vecteurs jouets de dimension 2 : "pates bolo" proche du produit 1
  const dim = 2;
  const vectors = new Float32Array(products.length * dim);
  products.forEach((_, i) => { vectors[i * dim] = i === 0 ? 1 : 0; vectors[i * dim + 1] = i === 0 ? 0 : 1; });
  const withEmb = rank('spaghetti bolo', index, new Float32Array([1, 0]), vectors, dim);
  assert.equal(products[withEmb[0].i].id, 1);
});
