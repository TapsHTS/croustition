import { splitInput, parseQuantity, formatQty, normKey, buildIndex, rank, confidence, totals } from './core.js';

const $ = (s) => document.querySelector(s);
const input = $('#meal');
const tray = $('#tray');

const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n) => Number(n).toLocaleString('fr-FR', { maximumFractionDigits: 1 });

// ---------- PWA : service worker, mises à jour, installation ----------
if ('serviceWorker' in navigator) {
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.register('sw.js').catch(() => {});
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (hadController) $('#update').hidden = false; // une nouvelle version vient de prendre la main
  });
  $('#reload').addEventListener('click', () => location.reload());
}

const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
function showInstall(text, label, onClick) {
  $('#install-text').textContent = text;
  const btn = $('#install-btn');
  btn.textContent = label;
  btn.onclick = onClick;
  $('#install').hidden = false;
}
if (!standalone && !store.get('plateau.installDismissed', false)) {
  if (isIos) {
    showInstall('Pour installer Plateau : touche Partager, puis « Sur l\'écran d\'accueil ».', 'Compris', () => {
      store.set('plateau.installDismissed', true);
      $('#install').hidden = true;
    });
  }
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    showInstall('Plateau peut s\'installer comme une application.', 'Installer', async () => {
      $('#install').hidden = true;
      e.prompt();
      await e.userChoice;
    });
  });
}
navigator.storage?.persist?.().catch(() => {}); // demande au navigateur de ne pas purger le cache (modèle, données)

let products = [], index = [], vectors = null, dim = 0;
let overrides = store.get('plateau.overrides', {}); // "pate bolognaise" -> id du produit choisi
let lines = [];
let openKey = null; // ligne dont la liste d'alternatives est ouverte
let run = 0;

// ---------- Données ----------
async function loadData() {
  products = await (await fetch('data/products.json')).json();
  index = buildIndex(products);
  try {
    const meta = await (await fetch('data/vectors.meta.json')).json();
    const v = new Float32Array(await (await fetch('data/vectors.bin')).arrayBuffer());
    if (meta.count === products.length && v.length === meta.count * meta.dim) { vectors = v; dim = meta.dim; }
  } catch { /* pas de vecteurs : recherche par mots uniquement */ }
  if (products.length < 20) {
    const n = $('#notice');
    n.hidden = false;
    n.textContent = `Base partielle (${products.length} produit${products.length > 1 ? 's' : ''}). Lance « npm run data » pour récupérer tout le catalogue du Crous.`;
  }
}

// ---------- Modèle d'embeddings (Web Worker) ----------
let worker = null, modelReady = false, nextId = 1;
const pending = new Map();
const cache = new Map();
const files = {};
const setIa = (html) => { $('#ia').innerHTML = html; };

function startModel() {
  if (worker || !vectors) return;
  worker = new Worker('worker.js', { type: 'module' });
  setIa('Chargement de la compréhension avancée…');
  worker.onmessage = ({ data }) => {
    if (data.type === 'progress') {
      const p = data.p;
      if (p?.file && p.total) files[p.file] = { loaded: p.loaded ?? 0, total: p.total };
      const all = Object.values(files);
      const total = all.reduce((s, f) => s + f.total, 0);
      if (total) setIa(`Chargement de la compréhension avancée… ${Math.round((all.reduce((s, f) => s + f.loaded, 0) / total) * 100)} %`);
    } else if (data.type === 'ready') {
      modelReady = true;
      setIa('Compréhension avancée prête.');
      analyze();
    } else if (data.type === 'vec') {
      pending.get(data.id)?.resolve(data.vec);
      pending.delete(data.id);
    } else if (data.type === 'error') {
      if (data.id && pending.has(data.id)) { pending.get(data.id).reject(new Error(data.message)); pending.delete(data.id); }
      else { modelReady = false; setIa('Compréhension avancée indisponible : recherche par mots-clés uniquement.'); }
    }
  };
  worker.postMessage({ type: 'init' });
}

function embed(text) {
  if (cache.has(text)) return Promise.resolve(cache.get(text));
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve: (v) => { cache.set(text, v); resolve(v); }, reject });
    worker.postMessage({ type: 'embed', id, text });
  });
}

// ---------- Analyse de la saisie ----------
let timer;
input.addEventListener('input', () => {
  store.set('plateau.draft', input.value);
  clearTimeout(timer);
  timer = setTimeout(analyze, 250);
});

async function analyze() {
  const my = ++run;
  const segs = splitInput(input.value)
    .map((raw) => ({ raw, ...parseQuantity(raw) }))
    .map((s) => ({ ...s, key: normKey(s.text) }))
    .filter((s) => s.key);
  const out = [];
  for (const s of segs) {
    let qVec = null;
    if (modelReady && vectors) {
      try { qVec = await embed(s.text); } catch { /* repli sur les mots-clés */ }
      if (my !== run) return;
    }
    const cands = rank(s.text, index, qVec, vectors, dim);
    const picked = overrides[s.key] != null ? index.findIndex((p) => p.id === overrides[s.key]) : -1;
    const conf = confidence(cands);
    out.push({
      ...s, cands,
      chosen: picked >= 0 ? picked : conf === 'none' ? null : cands[0].i,
      status: picked >= 0 ? 'sure' : conf,
    });
  }
  lines = out;
  render();
}

// ---------- Rendu ----------
function lineHtml(l, n) {
  const p = l.chosen !== null ? products[l.chosen] : null;
  const showAlts = openKey === l.key || l.status === 'none';
  const alts = [...l.cands.map((c) => c.i)];
  if (l.chosen !== null && !alts.includes(l.chosen)) alts.unshift(l.chosen);
  const badge = l.status === 'check' ? '<span class="badge">À vérifier</span>'
    : l.status === 'none' ? '<span class="badge none">Non compté : aucun produit proche</span>' : '';
  return `<article class="slot">
    <div class="slot-head">
      <div>
        <p class="said">${esc(l.raw)}</p>
        <p class="name">${p ? esc(p.name) : 'Introuvable'}${p?.section ? ` <span class="where">${esc(p.section)}</span>` : ''}</p>
        ${badge}
      </div>
      <div class="line-kcal">${p ? fmt(Math.round(p.kcal * l.qty)) : '–'}<small>${p && l.qty !== 1 ? `${formatQty(l.qty)} × ${fmt(p.kcal)} kcal` : 'kcal'}</small></div>
    </div>
    <div class="slot-actions">
      <span class="stepper" role="group" aria-label="Quantité">
        <button type="button" data-action="qty" data-line="${n}" data-delta="-1" aria-label="Moins">−</button>
        <output>${esc(formatQty(l.qty) || '1')}</output>
        <button type="button" data-action="qty" data-line="${n}" data-delta="1" aria-label="Plus">+</button>
      </span>
      <button type="button" data-action="toggle" data-line="${n}" aria-expanded="${showAlts}">Changer de produit</button>
      <button type="button" data-action="remove" data-line="${n}">Retirer</button>
    </div>
    ${showAlts ? `<ul class="alts">${alts.map((i) => `
      <li><button type="button" data-action="pick" data-line="${n}" data-idx="${i}" ${i === l.chosen ? 'aria-current="true"' : ''}>
        <span>${esc(products[i].name)}</span><span class="k">${fmt(products[i].kcal)} kcal</span></button></li>`).join('')}</ul>` : ''}
  </article>`;
}

function render() {
  tray.hidden = !lines.length;
  tray.innerHTML = lines.map(lineHtml).join('');

  const counted = lines.filter((l) => l.chosen !== null);
  const t = totals(counted.map((l) => ({ product: products[l.chosen], qty: l.qty })));
  const skipped = lines.length - counted.length;

  $('#kcal').textContent = fmt(Math.round(t.kcal));
  const pct = Math.round((t.kcal / 2000) * 100);
  $('#ring').style.setProperty('--p', Math.min(100, pct));
  $('#share').textContent = !lines.length ? 'Écris ton repas ci-dessus.'
    : `${pct} % des 2 000 kcal de la journée${skipped ? ` · ${skipped} ligne${skipped > 1 ? 's' : ''} non comptée${skipped > 1 ? 's' : ''}` : ''}`;

  const e = { prot: t.prot * 4, carb: t.carb * 4, fat: t.fat * 9 };
  const sum = e.prot + e.carb + e.fat;
  $('#macros').hidden = !(counted.length && sum > 0);
  if (sum > 0) {
    $('#macro-bar').innerHTML = ['prot', 'carb', 'fat'].map((k) => `<i style="width:${(e[k] / sum) * 100}%;background:var(--${k})"></i>`).join('');
    $('#macro-list').innerHTML = `
      <li><i style="background:var(--prot)"></i>Protéines ${fmt(t.prot)} g</li>
      <li><i style="background:var(--carb)"></i>Glucides ${fmt(t.carb)} g</li>
      <li><i style="background:var(--fat)"></i>Lipides ${fmt(t.fat)} g</li>
      <li>Sel ${fmt(t.salt)} g</li>`;
  }

  $('#allergens').hidden = !t.allergens.length;
  $('#allergen-list').innerHTML = t.allergens.map((a) => `<li>${esc(a)}</li>`).join('');
}

// ---------- Actions sur les lignes ----------
function rewrite(mapLine) { // la saisie reste la seule source de vérité
  input.value = lines.map(mapLine).filter(Boolean).join(', ');
  store.set('plateau.draft', input.value);
  return analyze();
}
const lineText = (l, qty = l.qty) => [formatQty(qty), l.text].filter(Boolean).join(' ');

tray.addEventListener('click', async (ev) => {
  const b = ev.target.closest('button[data-action]');
  if (!b) return;
  const n = Number(b.dataset.line);
  const l = lines[n];
  const refocus = (sel) => tray.querySelector(sel)?.focus();
  switch (b.dataset.action) {
    case 'toggle':
      openKey = openKey === l.key ? null : l.key;
      render();
      refocus(`[data-action="toggle"][data-line="${n}"]`);
      break;
    case 'pick':
      overrides[l.key] = products[Number(b.dataset.idx)].id;
      store.set('plateau.overrides', overrides);
      openKey = null;
      await analyze();
      refocus(`[data-action="toggle"][data-line="${n}"]`);
      break;
    case 'qty': {
      const d = Number(b.dataset.delta);
      const q = d > 0 ? (l.qty >= 1 ? l.qty + 1 : 1) : (l.qty > 1 ? l.qty - 1 : 0.5);
      await rewrite((x, i) => lineText(x, i === n ? q : x.qty));
      refocus(`[data-action="qty"][data-line="${n}"][data-delta="${d}"]`);
      break;
    }
    case 'remove':
      await rewrite((x, i) => (i === n ? '' : lineText(x)));
      input.focus();
      break;
  }
});

// ---------- Démarrage ----------
input.value = store.get('plateau.draft', '');
await loadData();
await analyze();
if (vectors) {
  if (navigator.connection?.saveData) {
    setIa('Compréhension avancée désactivée (économie de données). <button type="button" id="ia-on">Activer (≈ 110 Mo)</button>');
    $('#ia-on').addEventListener('click', startModel);
  } else {
    setTimeout(startModel, 800);
  }
}
