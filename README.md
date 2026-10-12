# Plateau – calories du Crous de Montpellier

Tu écris « pâtes bolo, 2 yaourts à la fraise », Plateau retrouve chaque produit dans le catalogue du Crous et additionne les calories.

## Mise en route

```bash
npm install
npm run data      # scrape le catalogue puis calcule les vecteurs (≈ 10 min la première fois)
npm run serve     # http://localhost:3000
npm test          # tests de la logique (découpage, quantités, classement, totaux)
```

`npm run data` = `npm run scrape` (→ `public/data/products.json`) puis `npm run embed` (→ `public/data/vectors.bin`).
Le scraping est incrémental : relancé, il ne télécharge que les nouveaux produits (`npm run scrape -- --refresh` pour tout refaire).
Les sections 1 à 30 sont balayées ; celles qui ne sont pas nommées dans `scripts/scrape.mjs` apparaissent comme « Section N ».

## Déployer sur GitHub Pages

1. Dépôt public, commit de tout le projet **y compris `public/data/`**.
2. Settings → Pages → Source : **GitHub Actions**. Chaque push sur `main` déploie le dossier `public/`.

## PWA (installation et hors-ligne)

- `manifest.webmanifest` + icônes (`public/icons/`) : l'app s'installe sur l'écran d'accueil. Sur iPhone : Safari → Partager → « Sur l'écran d'accueil » (l'app l'explique elle-même au premier passage).
- `public/sw.js` précharge l'application et les données (`products.json`, `vectors.*`) puis les sert depuis le cache. Les scripts du CDN (transformers.js, runtime ONNX) sont mis en cache à la première utilisation ; les poids du modèle sont mis en cache par transformers.js.
- Le workflow remplace `__BUILD__` par le hash du commit : chaque déploiement crée un nouveau cache et l'app affiche « Une nouvelle version est prête » au prochain passage en ligne. En local, `__BUILD__` reste tel quel, ce qui fonctionne aussi.
- Pour tester le hors-ligne : `npm run serve`, ouvre l'app, recharge-la une fois, puis coupe le réseau dans les outils de développement.

## Comment ça comprend la phrase

1. Découpage sur `,` `;` `+` « et » « avec ».
2. Quantité en tête de segment : `2`, `2x`, `deux`, `½`, `1/2`, `une demi`, `x3` en fin.
3. Normalisation : accents, pluriels, mots vides, abréviations (`ALIASES` dans `public/core.js`, à compléter).
4. Score = mots communs + similarité d'embeddings (multilingual-e5-small, calculé dans le navigateur).
5. Sous les seuils, la ligne est marquée « À vérifier » ou « Non compté ». Un choix manuel est mémorisé (localStorage).

Les seuils et le poids des embeddings sont dans `CONFIG` (`public/core.js`) : ce sont des valeurs de départ, pas calibrées sur ton catalogue réel.
Sans `vectors.bin`, ou si le modèle ne charge pas, l'app fonctionne avec les mots communs seuls.
