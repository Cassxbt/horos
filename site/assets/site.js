// Motion for the Horos site. Every element is readable without this script; it only animates what it can.
(() => {
  const root = document.documentElement;
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const fine = matchMedia('(pointer: fine)').matches;
  const { gsap, ScrollTrigger, Lenis } = window;
  if (!gsap || !ScrollTrigger || reduce) {
    root.classList.remove('js');
    document.querySelectorAll('.step').forEach((s) => s.classList.add('active'));
    document.querySelectorAll('.mail').forEach((m) => m.classList.add('lit'));
    document.querySelectorAll('.verdict-card').forEach((v) => v.classList.add('show'));
    return;
  }
  window.__horosReady = true;
  gsap.registerPlugin(ScrollTrigger);

  // Smooth scrolling, driven by GSAP's ticker so scroll-linked animation stays in step.
  if (Lenis) {
    const lenis = new Lenis({ duration: 1.15, easing: (t) => 1 - Math.pow(1 - t, 4), smoothWheel: true });
    lenis.on('scroll', ScrollTrigger.update);
    // The page grows once fonts and images arrive; the scroll limit and every trigger must follow it, or the last
    // section becomes unreachable on a short window.
    const remeasure = () => (lenis.resize(), ScrollTrigger.refresh());
    document.fonts?.ready.then(remeasure);
    addEventListener('load', remeasure);
    new ResizeObserver(() => lenis.resize()).observe(document.body);
    gsap.ticker.add((t) => lenis.raf(t * 1000));
    gsap.ticker.lagSmoothing(0);
    document.querySelectorAll('a[href^="#"]').forEach((a) => a.addEventListener('click', (e) => {
      const target = document.querySelector(a.getAttribute('href'));
      if (target) (e.preventDefault(), lenis.scrollTo(target, { offset: -90 }));
    }));
  }

  // Reading progress.
  gsap.to('.progress', { scaleX: 1, ease: 'none', scrollTrigger: { start: 0, end: 'max', scrub: 0.3 } });

  // Headline lines rise out of their masks; the hero copy follows.
  gsap.from('.line-mask > span', { yPercent: 115, rotate: 2, duration: 1.3, ease: 'expo.out', stagger: 0.09, delay: 0.1 });
  if (document.querySelector('[data-intro]')) gsap.from('[data-intro]', { opacity: 0, y: 22, duration: 1.1, ease: 'expo.out', stagger: 0.08, delay: 0.45 });

  // The hero scene: the email lands, the approved checkout follows, the policy answers, then the stamp.
  const scene = document.querySelector('.scene');
  if (scene) {
    const t = gsap.timeline({ delay: 0.5, defaults: { ease: 'expo.out', duration: 1.3 } });
    t.from('.scene .mailcard', { y: 80, opacity: 0, rotate: -12 })
      .from('.scene .paycard', { y: 90, opacity: 0, rotate: 9 }, '-=1.0')
      .from('.scene .policycard', { y: 60, opacity: 0 }, '-=0.9')
      .add(() => scene.querySelector('.stamp')?.classList.add('show'), '-=0.3');
    gsap.to('.scene .card', { y: (i) => [-10, 8, -6][i] ?? 0, duration: 3.4, ease: 'sine.inOut', yoyo: true, repeat: -1, stagger: 0.4, delay: 2.4 });
    gsap.to('.scene', { yPercent: -10, ease: 'none', scrollTrigger: { trigger: '.hero', start: 'top top', end: 'bottom top', scrub: true } });
    if (fine) {
      scene.addEventListener('pointermove', (e) => {
        const r = scene.getBoundingClientRect();
        gsap.to(scene, { rotateY: ((e.clientX - r.left) / r.width - 0.5) * 8, rotateX: -((e.clientY - r.top) / r.height - 0.5) * 6, duration: 0.8, ease: 'power3.out' });
      });
      scene.addEventListener('pointerleave', () => gsap.to(scene, { rotateY: 0, rotateX: 0, duration: 1.2, ease: 'power3.out' }));
    }
  }

  // Everything marked for reveal enters as it scrolls in, in small batches.
  ScrollTrigger.batch('[data-reveal]', {
    start: 'top 95%',
    onEnter: (els) => gsap.to(els, { opacity: 1, y: 0, duration: 1.1, ease: 'expo.out', stagger: 0.08, overwrite: true }),
  });

  // A statement read word by word as it passes.
  document.querySelectorAll('.statement').forEach((el) => {
    gsap.to(el.querySelectorAll('.w'), { opacity: 1, stagger: 0.06, ease: 'none', scrollTrigger: { trigger: el, start: 'top 80%', end: 'bottom 45%', scrub: 0.6 } });
  });

  // Figures count to their value; zeros roll down to zero, which is the point.
  document.querySelectorAll('[data-count]').forEach((el) => {
    const to = Number(el.dataset.count);
    const from = Number(el.dataset.from ?? (to === 0 ? 7 : 0));
    const decimals = (el.dataset.count.split('.')[1] || '').length;
    const state = { v: from };
    el.textContent = from.toFixed(decimals);
    ScrollTrigger.create({
      trigger: el, start: 'top 90%', once: true,
      onEnter: () => gsap.to(state, { v: to, duration: to === 0 ? 1.1 : 1.8, ease: 'power3.out', onUpdate: () => (el.textContent = state.v.toFixed(decimals).replace(/\B(?=(\d{3})+(?!\d))/g, ',')) }),
    });
  });

  // Gentle parallax on marked layers.
  document.querySelectorAll('[data-speed]').forEach((el) => {
    gsap.to(el, { yPercent: Number(el.dataset.speed) * -12, ease: 'none', scrollTrigger: { trigger: el, start: 'top bottom', end: 'bottom top', scrub: true } });
  });

  // The case: each step lights as it reaches the middle of the screen, and drives the email beside it.
  document.querySelectorAll('.step').forEach((step) => {
    ScrollTrigger.create({
      trigger: step, start: 'top 58%', end: 'bottom 42%',
      onToggle: ({ isActive }) => {
        step.classList.toggle('active', isActive);
        if (!isActive) return;
        const act = step.dataset.act;
        document.querySelectorAll('.mail').forEach((m) => m.classList.toggle('lit', act !== 'approved'));
        document.querySelectorAll('.verdict-card').forEach((v) => v.classList.toggle('show', act !== 'approved' && act !== 'email'));
      },
    });
  });
  document.querySelectorAll('.mail').forEach((m) => gsap.from(m, { rotateX: 8, y: 40, opacity: 0, duration: 1.4, ease: 'expo.out', scrollTrigger: { trigger: m, start: 'top 85%' } }));

  // The architecture draws itself.
  if (document.querySelector('.flow')) {
    document.querySelectorAll('.flow .wire').forEach((path) => {
      const len = path.getTotalLength();
      gsap.fromTo(path, { strokeDasharray: len, strokeDashoffset: len }, { strokeDashoffset: 0, ease: 'none', scrollTrigger: { trigger: '.flow', start: 'top 75%', end: 'center 45%', scrub: 0.8 } });
    });
    gsap.from('.flow .node', { opacity: 0, scale: 0.92, transformOrigin: '50% 50%', stagger: 0.07, duration: 0.9, ease: 'expo.out', scrollTrigger: { trigger: '.flow', start: 'top 70%' } });
  }

  if (!fine) return;

  // Light that follows the pointer: on the hero, and inside cards.
  addEventListener('pointermove', (e) => {
    root.style.setProperty('--mx', `${e.clientX}px`);
    root.style.setProperty('--my', `${e.clientY}px`);
  }, { passive: true });
  document.querySelectorAll('.spot').forEach((card) => card.addEventListener('pointermove', (e) => {
    const r = card.getBoundingClientRect();
    card.style.setProperty('--cx', `${e.clientX - r.left}px`);
    card.style.setProperty('--cy', `${e.clientY - r.top}px`);
  }));

  // Magnetic buttons.
  document.querySelectorAll('.btn, .nav a.link').forEach((btn) => {
    const strength = btn.classList.contains('btn') ? 0.28 : 0.18;
    btn.addEventListener('pointermove', (e) => {
      const r = btn.getBoundingClientRect();
      gsap.to(btn, { x: (e.clientX - r.left - r.width / 2) * strength, y: (e.clientY - r.top - r.height / 2) * strength, duration: 0.6, ease: 'power3.out' });
    });
    btn.addEventListener('pointerleave', () => gsap.to(btn, { x: 0, y: 0, duration: 0.9, ease: 'elastic.out(1, 0.4)' }));
  });

  // Attack cards tilt toward the pointer.
  document.querySelectorAll('.attack').forEach((card) => {
    card.addEventListener('pointermove', (e) => {
      const r = card.getBoundingClientRect();
      const px = (e.clientX - r.left) / r.width - 0.5;
      const py = (e.clientY - r.top) / r.height - 0.5;
      gsap.to(card, { rotateY: px * 5, rotateX: -py * 5, transformPerspective: 900, duration: 0.6, ease: 'power3.out' });
    });
    card.addEventListener('pointerleave', () => gsap.to(card, { rotateY: 0, rotateX: 0, duration: 0.9, ease: 'power3.out' }));
  });
})();
