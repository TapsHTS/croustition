// Récupère le catalogue du Crous de Montpellier -> public/data/products.json
// Usage : npm run scrape            (incrémental : ne télécharge que les produits manquants)
//         npm run scrape -- --refresh   (tout re-télécharger)
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { parseMeal, parseSection } from './parse.mjs';

const BASE = 'https://infos-nutrition.crous-montpellier.fr';
const RESTAURANT = process.env.RESTAURANT ?? '1';
const MAX_TYPE = Number(process.env.MAX_TYPE ?? 30); // on balaie produit_type 1..MAX_TYPE
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 3);
const DELAY_MS = Number(process.env.DELAY_MS ?? 200);
const OUT = 'public/data/products.json';
const REFRESH = process.argv.includes('--refresh');

// Noms connus ; les autres sections trouvées seront nommées "Section N" (à renommer ici).
const SECTIONS = { 2: 'Plat', 4: 'Dessert', 10: 'Entrée', 16: 'Pizza et pâtes garnies', 17: 'Garniture' };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(url, tries = 4) {
  for (let i = 1; i <= tries; i++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'plateau-calories (projet étudiant)' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (e) {
      if (i === tries) throw e;
      await sleep(500 * i);
    }
  }
}

let existing = [];
if (!REFRESH) {
  try { existing = JSON.parse(await readFile(OUT, 'utf8')); } catch {}
}
const byId = new Map(existing.map((p) => [p.id, p]));

// 1) Lister les produits de chaque section
const listed = new Map(); // id -> {name, section}
for (let type = 1; type <= MAX_TYPE; type++) {
  const url = `${BASE}/ajax/search?restaurant=${RESTAURANT}&produit_type%5B%5D=${type}&allergy-global=0`;
  const items = parseSection(await get(url));
  if (items.length) {
    const label = SECTIONS[type] ?? `Section ${type}`;
    console.log(`type ${type} (${label}) : ${items.length} produits`);
    for (const it of items) if (!listed.has(it.id)) listed.set(it.id, { name: it.name, section: label });
  }
  await sleep(DELAY_MS);
}

// 2) Fiche nutritionnelle de chaque produit manquant
const todo = [...listed].filter(([id]) => REFRESH || !byId.has(id));
console.log(`${listed.size} produits au total, ${todo.length} à récupérer`);

let done = 0;
async function worker() {
  while (todo.length) {
    const [id, meta] = todo.shift();
    try {
      const info = parseMeal(await get(`${BASE}/ajax/meal?products=${id}`));
      if (info.kcal == null) {
        console.warn(`! ${id} ${meta.name} : kcal introuvables, ignoré`);
      } else {
        byId.set(id, { ...info, id, section: meta.section, name: info.name ?? meta.name });
      }
    } catch (e) {
      console.warn(`! ${id} ${meta.name} : ${e.message}`);
    }
    if (++done % 25 === 0) console.log(`  ${done} fiches...`);
    await sleep(DELAY_MS);
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));

// Les produits qui ne sont plus listés restent (pas de suppression silencieuse) ; on fusionne simplement.
const products = [...byId.values()].sort((a, b) => a.id - b.id);
await mkdir('public/data', { recursive: true });
await writeFile(OUT, JSON.stringify(products));
console.log(`OK : ${products.length} produits écrits dans ${OUT}`);
