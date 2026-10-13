import { splitInput, parseQuantity, formatQty, normKey, buildIndex, rank, confidence, totals } from './core.js';

const $ = (s) => document.querySelector(s);
const input = $('#meal');

const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n) => Number(n).toLocaleString('fr-FR', { maximumFractionDigits: 1 });
const round = (n) => fmt(Math.round(n));
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const qtyText = (q) => (q === 0.5 ? '½' : fmt(q));
const qtyLabel = (q) => `${qtyText(q)} portion${q > 1 ? 's' : ''}`;
const pictoFor = (p) => (p && /yaourt|yogourt|lait|fromage blanc|faisselle|skyr|petit suisse/i.test(p.name) ? 'milk' : 'utensils');

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

// ---------- État ----------
let products = [], index = [], vectors = null, dim = 0;
let overrides = store.get('plateau.overrides', {}); // "pate bolognaise" -> id du produit choisi
let lines = [];
let run = 0;
let timer;

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
      if (lines.length) analyze();
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
function autosize() {
  input.style.height = 'auto';
  input.style.height = `${Math.max(22, input.scrollHeight)}px`;
}
const updateGo = () => { $('#go').disabled = !input.value.trim(); };

input.addEventListener('input', () => {
  store.set('plateau.draft', input.value);
  autosize();
  updateGo();
  clearTimeout(timer);
  timer = setTimeout(analyze, 250);
});
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#go').click(); }
});
$('#go').addEventListener('click', async () => {
  clearTimeout(timer);
  input.blur();
  await analyze();
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
  renderMain();
}

// ---------- Écran « Saisir un repas / Résumé du repas » ----------
function foodHtml(l, n) {
  const p = l.chosen !== null ? products[l.chosen] : null;
  const flag = l.status === 'check'
    ? '<div class="flag"><span class="alert">À vérifier</span><span>Produit proposé par défaut</span></div>'
    : l.status === 'none'
      ? '<div class="flag"><span class="alert none">Non compté</span><span>Choisis un produit pour l’ajouter</span></div>' : '';
  return `<article class="food">
    <div class="row-product">
      <span class="picto" aria-hidden="true"><i class="ic ic-${pictoFor(p)}" style="--s:21px"></i></span>
      <div class="designation">
        <p class="n">${esc(p ? p.name : cap(l.text))}</p>
        <p class="s">${p ? `${qtyLabel(l.qty)} · ${fmt(p.kcal)} kcal / portion` : 'Aucun produit proche trouvé'}</p>
      </div>
      <div class="energy"><b>${p ? round(p.kcal * l.qty) : '—'}</b><span>kcal</span></div>
    </div>
    ${flag}
    ${p ? `<p class="pgl">P ${round(p.prot * l.qty)} g  ·  G ${round(p.carb * l.qty)} g  ·  L ${round(p.fat * l.qty)} g</p>` : ''}
    <div class="row-actions">
      <div class="stepper" role="group" aria-label="Quantité">
        <button type="button" data-action="qty" data-line="${n}" data-delta="-1" aria-label="Moins"><i class="ic ic-minus" style="--s:14px"></i></button>
        <output>${qtyText(l.qty)}</output>
        <button type="button" data-action="qty" data-line="${n}" data-delta="1" aria-label="Plus"><i class="ic ic-plus" style="--s:14px"></i></button>
      </div>
      <button type="button" class="remove" data-action="remove" data-line="${n}">Retirer</button>
    </div>
    <button type="button" class="row-change" data-action="change" data-line="${n}">
      <span>${p ? 'Changer de produit' : 'Choisir un produit'}</span><i class="ic ic-arrow-right" style="--s:16px"></i>
    </button>
  </article>`;
}

function renderMain() {
  const has = lines.length > 0;
  $('#empty').hidden = has;
  $('#tray').hidden = !has;
  $('#foods').innerHTML = lines.map(foodHtml).join('');
  $('#hint').textContent = has ? 'Quantités et produits ajustables ci-dessous' : 'Ajoute les quantités si tu les connais.';
  $('#go-label').textContent = has ? 'Actualiser mon repas' : 'Estimer mon repas';
  $('#go-icon').className = `ic ${has ? 'ic-refresh' : 'ic-arrow-right'}`;
  updateGo();

  const counted = lines.filter((l) => l.chosen !== null);
  const t = totals(counted.map((l) => ({ product: products[l.chosen], qty: l.qty })));
  const value = counted.length > 0;
  const portions = counted.reduce((s, l) => s + l.qty, 0);
  $('#tray-count').textContent = `${counted.length} produit${counted.length > 1 ? 's' : ''} · ${fmt(portions)} portion${portions > 1 ? 's' : ''}`;

  $('#kcal').textContent = value ? round(t.kcal) : '—';
  const pct = Math.round((t.kcal / 2000) * 100);
  $('#pct').textContent = value ? `${pct} %` : '—';
  const fg = $('#ring-fg');
  fg.setAttribute('stroke-dasharray', `${Math.min(100, value ? pct : 0)} 100`);
  fg.style.opacity = value && pct > 0 ? 1 : 0;

  const e = { prot: t.prot * 4, carb: t.carb * 4, fat: t.fat * 9 };
  const sum = e.prot + e.carb + e.fat;
  [...$('#macro-bar').children].forEach((seg, i) => {
    const k = ['prot', 'carb', 'fat'][i];
    if (value && sum > 0) { seg.style.setProperty('--f', e[k]); seg.style.background = `var(--${k})`; }
    else { seg.style.removeProperty('--f'); seg.style.background = ''; }
  });
  $('#m-prot').textContent = value ? `${round(t.prot)} g` : '— g';
  $('#m-carb').textContent = value ? `${round(t.carb)} g` : '— g';
  $('#m-fat').textContent = value ? `${round(t.fat)} g` : '— g';

  $('#allergens').hidden = !t.allergens.length;
  $('#allergen-list').innerHTML = t.allergens.map((a) => `<li>${esc(a)}</li>`).join('');
}

// La saisie reste la seule source de vérité : +/− et « Retirer » la réécrivent.
function rewrite(mapLine) {
  input.value = lines.map(mapLine).filter(Boolean).join(', ');
  store.set('plateau.draft', input.value);
  autosize();
  return analyze();
}
const lineText = (l, qty = l.qty) => [formatQty(qty), l.text].filter(Boolean).join(' ');

$('#foods').addEventListener('click', async (ev) => {
  const b = ev.target.closest('button[data-action]');
  if (!b) return;
  const n = Number(b.dataset.line);
  const l = lines[n];
  if (!l) return;
  switch (b.dataset.action) {
    case 'qty': {
      const d = Number(b.dataset.delta);
      const q = d > 0 ? (l.qty >= 1 ? l.qty + 1 : 1) : (l.qty > 1 ? l.qty - 1 : 0.5);
      await rewrite((x, i) => lineText(x, i === n ? q : x.qty));
      $('#foods').querySelector(`[data-action="qty"][data-line="${n}"][data-delta="${d}"]`)?.focus();
      break;
    }
    case 'remove':
      await rewrite((x, i) => (i === n ? '' : lineText(x)));
      input.focus();
      break;
    case 'change':
      openEdit(l);
      break;
  }
});

// ---------- Écran « Changer de produit » ----------
let edit = null; // { key, text, qty, current, sel, baseCands, results }
let mainScroll = 0;
let searchRun = 0;
let searchTimer;

function showView(name) {
  $('#view-main').hidden = name !== 'main';
  $('#view-edit').hidden = name !== 'edit';
}

function openEdit(l) {
  edit = { key: l.key, text: l.text, qty: l.qty, current: l.chosen, sel: l.chosen, status: l.status, baseCands: l.cands.map((c) => c.i), results: [] };
  history.pushState({ edit: true }, '', '#changer');
  mainScroll = window.scrollY;
  showView('edit');
  $('#q').value = l.text;
  window.scrollTo(0, 0);
  runSearch();
}

function closeEdit() {
  edit = null;
  showView('main');
  window.scrollTo(0, mainScroll);
}

window.addEventListener('popstate', () => { if (edit) closeEdit(); });
$('#back').addEventListener('click', () => { if (history.state?.edit) history.back(); else closeEdit(); });

async function runSearch() {
  if (!edit) return;
  const my = ++searchRun;
  const q = $('#q').value.trim();
  let list;
  if (!q) {
    list = [...edit.baseCands];
  } else {
    let qVec = null;
    if (modelReady && vectors) {
      try { qVec = await embed(q); } catch { /* repli sur les mots-clés */ }
      if (my !== searchRun || !edit) return;
    }
    list = rank(q, index, qVec, vectors, dim, 10).filter((c) => c.score >= 0.2).map((c) => c.i);
  }
  if (edit.current !== null && !list.includes(edit.current)) list.unshift(edit.current);
  edit.results = list;
  renderEdit();
}

$('#q').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(runSearch, 200); });

function renderEdit() {
  if (!edit) return;
  const cur = edit.current !== null ? products[edit.current] : null;
  $('#fix-name').textContent = cur ? cur.name : cap(edit.text);
  $('#fix-sub').textContent = `${qtyLabel(edit.qty)} · la quantité sera conservée`;
  $('#fix-icon').className = `ic ic-${pictoFor(cur)}`;

  $('#count').textContent = `${edit.results.length} résultat${edit.results.length > 1 ? 's' : ''}`;
  $('#results').innerHTML = edit.results.length ? edit.results.map((i) => {
    const p = products[i];
    const selected = i === edit.sel;
    const isCurrent = i === edit.current;
    return `<li><button type="button" class="opt" role="radio" aria-checked="${selected}" data-idx="${i}">
      <img src="icons/ui/selection-${selected ? 'on' : 'off'}.svg" alt="">
      <span class="opt-info">
        <span class="n">${esc(p.name)}</span>
        <span class="s">${esc(p.section || 'Produit du Crous')}</span>
        ${isCurrent ? `<span class="cur">Produit actuel${edit.status === 'check' ? ' · à vérifier' : ''}</span>` : ''}
      </span>
      <span class="opt-energy"><b>${fmt(p.kcal)}</b><span>kcal / portion</span></span>
    </button></li>`;
  }).join('') : '<li class="no-result">Aucun produit ne correspond à cette recherche.</li>';

  // Aperçu : le repas avant / après correction (toutes les lignes qui partagent cette saisie sont corrigées)
  const others = lines.filter((l) => l.key !== edit.key && l.chosen !== null).map((l) => ({ product: products[l.chosen], qty: l.qty }));
  const same = lines.filter((l) => l.key === edit.key);
  const before = totals([...others, ...same.filter((l) => l.chosen !== null).map((l) => ({ product: products[l.chosen], qty: l.qty }))]).kcal;
  const after = edit.sel !== null
    ? totals([...others, ...same.map((l) => ({ product: products[edit.sel], qty: l.qty }))]).kcal : before;
  $('#pv-total').textContent = `${round(after)} kcal`;
  const delta = Math.round(after) - Math.round(before);
  $('#pv-delta').textContent = delta === 0
    ? 'Le total du repas ne change pas.'
    : `${round(before)} → ${round(after)} kcal · soit ${delta > 0 ? '+' : '−'}${fmt(Math.abs(delta))} kcal pour ${qtyLabel(edit.qty)}`;
  $('#confirm').disabled = edit.sel === null;
}

$('#results').addEventListener('click', (ev) => {
  const b = ev.target.closest('button.opt');
  if (!b || !edit) return;
  edit.sel = Number(b.dataset.idx);
  renderEdit();
  $('#results').querySelector(`[data-idx="${edit.sel}"]`)?.focus();
});

$('#confirm').addEventListener('click', async () => {
  if (!edit || edit.sel === null) return;
  overrides[edit.key] = products[edit.sel].id; // mémorisé pour la prochaine fois
  store.set('plateau.overrides', overrides);
  await analyze();
  if (history.state?.edit) history.back(); else closeEdit();
});

// ---------- Démarrage ----------
if (location.hash === '#changer') history.replaceState(null, '', location.pathname + location.search);
input.value = store.get('plateau.draft', '');
autosize();
updateGo();
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
