const CYRILLIC = new Map(Object.entries({
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i',
  й: 'i', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't',
  у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y',
  ь: '', э: 'e', ю: 'yu', я: 'ya',
}));
export const MAX_SLUG_LENGTH = 200;

export function slugify(title) {
  const transliterated = [...title.toLocaleLowerCase('ru-RU')]
    .map((character) => CYRILLIC.get(character) ?? character)
    .join('');
  const slug = transliterated
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
  return truncateSlug(slug || 'fakt-nedeli', MAX_SLUG_LENGTH);
}

export function allocateSlug(db, title) {
  const base = slugify(title);
  let candidate = base;
  let suffix = 2;
  const exists = db.prepare('SELECT 1 FROM articles WHERE slug = ?');
  while (exists.get(candidate)) {
    const ending = `-${suffix}`;
    const stem = truncateSlug(base, MAX_SLUG_LENGTH - ending.length);
    candidate = `${stem}${ending}`;
    suffix += 1;
  }
  return candidate;
}

function truncateSlug(slug, maximum) {
  if (maximum < 1) throw new Error('Slug collision suffix exhausted the filesystem-safe length');
  return slug.slice(0, maximum).replace(/-+$/g, '') || 'fakt-nedeli'.slice(0, maximum);
}
