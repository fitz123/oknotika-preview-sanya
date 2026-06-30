(() => {
  const header = document.querySelector('[data-header]');
  const cookie = document.querySelector('[data-cookie]');
  const accept = document.querySelector('[data-cookie-accept]');

  const onScroll = () => {
    if (!header) return;
    header.classList.toggle('is-scrolled', window.scrollY > 24);
  };
  onScroll();
  window.addEventListener('scroll', onScroll, { passive: true });

  if (cookie && !localStorage.getItem('oknotika_cookie_ok')) {
    requestAnimationFrame(() => cookie.classList.add('is-visible'));
  }
  accept?.addEventListener('click', () => {
    localStorage.setItem('oknotika_cookie_ok', '1');
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
