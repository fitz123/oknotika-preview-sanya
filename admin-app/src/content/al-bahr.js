export const AL_BAHR_FIXTURE = Object.freeze({
  slug: 'al-bahr-towers-dynamic-facade',
  title: 'Фасад может реагировать на солнце',
  publicationDate: '2026-07-09',
  lead: 'Al Bahr Towers в Абу-Даби показывают простую мысль: фасад может быть активной инженерной системой, которая управляет солнцем, теплом и комфортом.',
  bodyMarkdown: `В проекте Al Bahr Towers архитекторы Aedas использовали динамическую солнцезащиту по мотивам традиционной машрабии. Элементы фасада открываются и закрываются в зависимости от положения солнца, помогая снижать перегрев и блики.

Для ОКНОТИКИ это хороший пример языка, на котором можно говорить с архитекторами и девелоперами: современное остекление — это не “поставить стекло”, а собрать оболочку здания, которая работает на свет, температуру, вид, ресурс и эксплуатацию.

**Почему это важно:** чем сложнее объект, тем раньше нужно обсуждать профильную систему, стеклопакет, солнцезащиту, автоматику, монтажные узлы и обслуживание.`,
  coverAlt: 'Динамический фасад Al Bahr Towers',
  sourceUrl: 'https://www.archdaily.com/270592/al-bahar-towers-responsive-facade-aedas',
  importedMetadata: Object.freeze({
    eyebrow: 'Факт недели · алюминий',
    description: 'Факт недели ОКНОТИКИ: Al Bahr Towers и динамический фасад как пример активной инженерной оболочки здания.',
    listingExcerpt: 'Al Bahr Towers в Абу-Даби используют динамическую солнцезащиту по мотивам машрабии: фасад реагирует на солнце и снижает перегрев. Это хороший пример того, что современный фасад — активная инженерная система, а не просто стеклянная плоскость.',
  }),
});

export function importAlBahr(service, { editorId, coverAssetId }) {
  const created = service.createArticle({ ...AL_BAHR_FIXTURE, coverAssetId }, editorId, {
    initialSlug: AL_BAHR_FIXTURE.slug,
    importedMetadata: AL_BAHR_FIXTURE.importedMetadata,
  });
  service.publishRevision(created.articleId, created.revisionId, editorId);
  return created;
}
