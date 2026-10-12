// Extraction des infos d'une fiche /ajax/meal?products=<id> (fragment HTML).
// On travaille sur le texte aplati plutôt que sur les balises : plus robuste si le HTML change un peu.
import * as cheerio from 'cheerio';

const num = (m) => (m ? parseFloat(m[1].replace(',', '.')) : null);

export function parseMeal(html) {
  const $ = cheerio.load(html);
  $('*').each((_, el) => { $(el).append(' '); }); // évite que deux balises voisines se collent dans le texte
  const text = $.root().text().replace(/\s+/g, ' ').trim();

  const link = $('a[href*="/produit/"]').first();
  const name = (link.attr('title') || link.text() || '').replace(/\s+/g, ' ').trim() || null;

  const allergensMatch = text.match(/Allerg[èe]nes\s*(.*?)\s*Valeurs nutritionnelles/i);
  const allergens = allergensMatch
    ? allergensMatch[1].split(',').map((s) => s.trim()).filter((s) => s && !/^aucun/i.test(s))
    : [];

  const n = (re) => num(text.match(re));
  return {
    name,
    allergens,
    kj: n(/Energie\s*\(Kj\)\s*<?\s*([\d.,]+)/i),
    kcal: n(/Energie\s*\(Kcal\)\s*<?\s*([\d.,]+)/i),
    fat: n(/Lipides\s*<?\s*([\d.,]+)\s*g/i),
    sat: n(/Acides gras satur[ée]s\s*<?\s*([\d.,]+)\s*g/i),
    carb: n(/Glucides\s*<?\s*([\d.,]+)\s*g/i),
    sugar: n(/Sucres simples\s*<?\s*([\d.,]+)\s*g/i),
    fiber: n(/Fibres\s*<?\s*([\d.,]+)\s*g/i),
    prot: n(/Prot[ée]ines\s*<?\s*([\d.,]+)\s*g/i),
    salt: n(/Sel\s*<?\s*([\d.,]+)\s*g/i),
  };
}

// Liste d'une section (/ajax/search?...) -> [{id, name}]
export function parseSection(html) {
  const $ = cheerio.load(html);
  const seen = new Map();
  $('a[href*="/produit/"]').each((_, a) => {
    const id = Number(($(a).attr('href') || '').match(/\/produit\/(\d+)/)?.[1]);
    if (!id || seen.has(id)) return;
    const name = ($(a).attr('title') || $(a).text() || '').replace(/\s+/g, ' ').trim();
    if (name) seen.set(id, name);
  });
  return [...seen].map(([id, name]) => ({ id, name }));
}
