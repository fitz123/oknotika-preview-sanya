(() => {
  const header = document.querySelector('[data-header]');
  const cookie = document.querySelector('[data-cookie]');
  const accept = document.querySelectorAll('[data-cookie-accept]');
  const decline = document.querySelector('[data-cookie-decline]');
  const consent = localStorage.getItem('oknotika_cookie_ok');

  const loadConsentEmbeds = () => {
    document.querySelectorAll('iframe[data-cookie-src]').forEach((embed) => {
      if (!embed.getAttribute('src')) embed.setAttribute('src', embed.dataset.cookieSrc);
      embed.closest('.yandex-embed')?.classList.add('is-loaded');
    });
  };

  const onScroll = () => {
    if (!header) return;
    header.classList.toggle('is-scrolled', window.scrollY > 24);
  };
  onScroll();
  window.addEventListener('scroll', onScroll, { passive: true });

  if (consent === '1') loadConsentEmbeds();
  if (cookie && consent === null) {
    requestAnimationFrame(() => cookie.classList.add('is-visible'));
  }
  accept.forEach((button) => {
    button.addEventListener('click', () => {
      localStorage.setItem('oknotika_cookie_ok', '1');
      loadConsentEmbeds();
      cookie?.classList.remove('is-visible');
    });
  });
  decline?.addEventListener('click', () => {
    localStorage.setItem('oknotika_cookie_ok', '0');
    cookie?.classList.remove('is-visible');
  });

  document.querySelectorAll('.avatar img').forEach((img) => {
    img.addEventListener('error', () => { img.style.display = 'none'; });
  });

  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        entry.target.classList.add('is-visible');
        observer.unobserve(entry.target);
      }
    });
  }, { threshold: 0.12 });

  document.querySelectorAll('.reveal').forEach((el) => observer.observe(el));
})();
