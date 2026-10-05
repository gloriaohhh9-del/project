/**
 * AURA — Scroll Animations
 * Uses Intersection Observer to reveal elements as they enter the viewport.
 */

(function () {
  'use strict';

  const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const SCROLL_SELECTOR = [
    'main > section',
    '#how-it-works li',
    '#features li',
    '#use-cases article',
    'footer',
  ].join(', ');

  const STAGGER_SELECTOR = [
    '#how-it-works li',
    '#features li',
    '#use-cases article',
  ].join(', ');

  const STAGGER_DELAY = 100;

  function initHeroAnimation() {
    const header = document.querySelector('header');
    if (!header) return;

    header.classList.add('animate-hero');

    const heroItems = header.querySelectorAll('.hero-content h1, .hero-content p, .hero-visual');
    heroItems.forEach((item, index) => {
      item.style.setProperty('--hero-delay', `${index * 150}ms`);
      item.classList.add('animate-hero-item');
    });
  }

  function initScrollAnimations() {
    const elements = document.querySelectorAll(SCROLL_SELECTOR);

    elements.forEach((el) => {
      el.classList.add('animate-on-scroll');

      if (el.matches(STAGGER_SELECTOR)) {
        const siblings = el.parentElement.querySelectorAll(':scope > ' + el.tagName.toLowerCase());
        const index = Array.from(siblings).indexOf(el);
        el.style.setProperty('--delay', `${index * STAGGER_DELAY}ms`);
      }
    });

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add('is-visible');
            observer.unobserve(entry.target);
          }
        });
      },
      {
        root: null,
        rootMargin: '0px 0px -8% 0px',
        threshold: 0.15,
      }
    );

    elements.forEach((el) => observer.observe(el));
  }

  function initNavbar() {
    const navbar = document.getElementById('navbar');
    const toggle = document.querySelector('.navbar-toggle');
    const menu = document.getElementById('navbar-menu');
    if (!navbar || !toggle || !menu) return;

    const links = menu.querySelectorAll('a[href^="#"]');
    const sections = document.querySelectorAll('main section[id]');

    function closeMenu() {
      toggle.classList.remove('is-open');
      menu.classList.remove('is-open');
      toggle.setAttribute('aria-expanded', 'false');
    }

    toggle.addEventListener('click', () => {
      const isOpen = menu.classList.toggle('is-open');
      toggle.classList.toggle('is-open', isOpen);
      toggle.setAttribute('aria-expanded', String(isOpen));
    });

    links.forEach((link) => {
      link.addEventListener('click', () => {
        closeMenu();
      });
    });

    window.addEventListener('scroll', () => {
      navbar.classList.toggle('is-scrolled', window.scrollY > 20);
    }, { passive: true });

    const sectionObserver = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            const id = entry.target.getAttribute('id');
            links.forEach((link) => {
              link.classList.toggle('is-active', link.getAttribute('href') === '#' + id);
            });
          }
        });
      },
      {
        rootMargin: '-40% 0px -50% 0px',
        threshold: 0,
      }
    );

    sections.forEach((section) => sectionObserver.observe(section));
  }

  document.addEventListener('DOMContentLoaded', () => {
    initNavbar();

    if (prefersReducedMotion) {
      return;
    }

    initHeroAnimation();
    initScrollAnimations();
  });
})();
