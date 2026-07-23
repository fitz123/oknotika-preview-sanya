(() => {
  const card = document.querySelector('[data-latest-fact]');
  if (!card || typeof fetch !== 'function') return;

  fetch('/articles/latest.json', {
    cache: 'no-cache',
    credentials: 'same-origin',
    headers: { Accept: 'application/json' },
  })
    .then((response) => {
      if (!response.ok) throw new Error('Latest fact is unavailable');
      return response.json();
    })
    .then((fact) => {
      if (!isValidFact(fact)) throw new Error('Latest fact payload is invalid');
      card.querySelector('[data-latest-title]').textContent = fact.title;
      card.querySelector('[data-latest-lead]').textContent = fact.lead;
      const link = card.querySelector('[data-latest-link]');
      link.href = fact.url;
      link.textContent = 'Открыть факт недели →';
      card.dataset.latestFactState = 'loaded';
    })
    .catch(() => {
      card.dataset.latestFactState = 'fallback';
    });

  function isValidFact(fact) {
    if (!fact || fact.category !== 'Факт недели') return false;
    if (typeof fact.title !== 'string' || fact.title.length < 1 || fact.title.length > 240) return false;
    if (typeof fact.lead !== 'string' || fact.lead.length < 1 || fact.lead.length > 1200) return false;
    try {
      const url = new URL(fact.url, window.location.origin);
      return url.protocol === 'https:'
        && url.origin === window.location.origin
        && url.pathname.startsWith('/articles/');
    } catch {
      return false;
    }
  }
})();
