// Calcule un vecteur par produit -> public/data/vectors.bin (+ vectors.meta.json)
// Même modèle et même quantification que dans le navigateur (worker.js).
import { readFile, writeFile } from 'node:fs/promises';
import { pipeline } from '@huggingface/transformers';

const MODEL = 'Xenova/multilingual-e5-small';
const DTYPE = 'q8';

const products = JSON.parse(await readFile('public/data/products.json', 'utf8'));
console.log(`Chargement du modèle ${MODEL}...`);
const extractor = await pipeline('feature-extraction', MODEL, { dtype: DTYPE });

const BATCH = 32;
let dim = 0;
const chunks = [];
for (let i = 0; i < products.length; i += BATCH) {
  const texts = products.slice(i, i + BATCH).map((p) => `passage: ${p.name}`);
  const out = await extractor(texts, { pooling: 'mean', normalize: true });
  dim = out.dims[1];
  chunks.push(Float32Array.from(out.data));
  console.log(`  ${Math.min(i + BATCH, products.length)}/${products.length}`);
}

const all = new Float32Array(products.length * dim);
let off = 0;
for (const c of chunks) { all.set(c, off); off += c.length; }

await writeFile('public/data/vectors.bin', Buffer.from(all.buffer));
await writeFile('public/data/vectors.meta.json', JSON.stringify({ model: MODEL, dtype: DTYPE, dim, count: products.length }));
console.log(`OK : ${products.length} vecteurs de dimension ${dim}`);
