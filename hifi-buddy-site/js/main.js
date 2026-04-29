/* ==========================================================================
   HiFi Buddy — marketing site
   Tiny, dependency-free script for scroll reveal, waveform render, copy btn,
   and nav scroll state.
   ========================================================================== */
(function () {
  'use strict';

  /* ---------- Scroll reveal ---------- */
  const reveals = document.querySelectorAll('.reveal');

  if ('IntersectionObserver' in window && reveals.length) {
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add('visible');
            io.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.12, rootMargin: '0px 0px -60px 0px' }
    );

    reveals.forEach((el) => io.observe(el));
  } else {
    reveals.forEach((el) => el.classList.add('visible'));
  }

  /* ---------- Nav scroll state ---------- */
  const nav = document.querySelector('.nav');
  if (nav) {
    const onScroll = () => {
      if (window.scrollY > 8) nav.classList.add('scrolled');
      else nav.classList.remove('scrolled');
    };
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
  }

  /* ---------- Waveform bars ---------- */
  const waveform = document.querySelector('.waveform');
  if (waveform) {
    const BAR_COUNT = 60;
    // Pseudo-randomized but deterministic-feeling pattern with a vague envelope.
    const heights = [];
    for (let i = 0; i < BAR_COUNT; i++) {
      const envelope = Math.sin((i / BAR_COUNT) * Math.PI) * 0.55 + 0.35;
      const noise = Math.sin(i * 1.7) * 0.18 + Math.cos(i * 0.6) * 0.12;
      const h = Math.max(0.18, Math.min(1, envelope + noise));
      heights.push(h);
    }

    const frag = document.createDocumentFragment();
    heights.forEach((h, i) => {
      const bar = document.createElement('span');
      bar.className = 'bar';
      bar.style.height = `${Math.round(h * 88)}px`;
      bar.style.animationDelay = `${(i % 12) * 0.08}s`;
      bar.style.animationDuration = `${1.8 + (i % 5) * 0.18}s`;
      frag.appendChild(bar);
    });
    waveform.appendChild(frag);
  }

  /* ---------- Copy button ---------- */
  const copyBtn = document.querySelector('.copy-btn');
  if (copyBtn) {
    copyBtn.addEventListener('click', async () => {
      const text = copyBtn.dataset.copy || '';
      const label = copyBtn.querySelector('span');
      const original = label ? label.textContent : 'Copy';
      try {
        if (navigator.clipboard && window.isSecureContext) {
          await navigator.clipboard.writeText(text);
        } else {
          const ta = document.createElement('textarea');
          ta.value = text;
          ta.style.position = 'fixed';
          ta.style.opacity = '0';
          document.body.appendChild(ta);
          ta.select();
          document.execCommand('copy');
          document.body.removeChild(ta);
        }
        copyBtn.classList.add('copied');
        if (label) label.textContent = 'Copied';
        setTimeout(() => {
          copyBtn.classList.remove('copied');
          if (label) label.textContent = original;
        }, 1600);
      } catch (e) {
        if (label) label.textContent = 'Press ⌘C';
        setTimeout(() => {
          if (label) label.textContent = original;
        }, 1600);
      }
    });
  }

  /* ---------- Timestamp click cycling (hero visual flair) ---------- */
  const timestamps = document.querySelectorAll('.ts');
  timestamps.forEach((ts) => {
    ts.addEventListener('click', () => {
      timestamps.forEach((t) => t.classList.remove('active'));
      ts.classList.add('active');
    });
  });

  /* ---------- Smooth-scroll for in-page links (extra polish) ---------- */
  document.querySelectorAll('a[href^="#"]').forEach((a) => {
    a.addEventListener('click', (e) => {
      const href = a.getAttribute('href');
      if (!href || href === '#') return;
      const target = document.querySelector(href);
      if (target) {
        e.preventDefault();
        const top = target.getBoundingClientRect().top + window.scrollY - 60;
        window.scrollTo({ top, behavior: 'smooth' });
      }
    });
  });
})();
