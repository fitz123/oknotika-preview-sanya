const CYRILLIC = new Map(Object.entries({
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i',
  й: 'i', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't',
  у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y',
  ь: '', э: 'e', ю: 'yu', я: 'ya',
}));

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
  return slug || 'fakt-nedeli';
}

export function allocateSlug(db, title) {
  const base = slugify(title);
  let candidate = base;
  let suffix = 2;
  const exists = db.prepare('SELECT 1 FROM articles WHERE slug = ?');
  while (exists.get(candidate)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}
