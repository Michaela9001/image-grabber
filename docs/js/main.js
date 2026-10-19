/**
 * 拾图 PixHarvest · 官网交互
 * - 移动端导航开合
 * - 滚动进度条 / 导航高亮 / 回到顶部
 * - 平滑滚动（尊重 prefers-reduced-motion）
 * - 入场动画
 */

(() => {
  "use strict";

  const navbar = document.getElementById("navbar");
  const navToggle = document.getElementById("navToggle");
  const navLinks = document.getElementById("navLinks");
  const progressBar = document.getElementById("scrollProgress");
  const toTop = document.getElementById("toTop");
  const year = document.getElementById("year");

  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const navAnchors = [...navLinks.querySelectorAll("a:not(.nav__cta)")];
  const sections = navAnchors
    .map((link) => document.querySelector(link.getAttribute("href")))
    .filter(Boolean);

  if (year) year.textContent = String(new Date().getFullYear());

  /* ------------------------------ 移动端菜单 ------------------------------ */

  function setMenu(open) {
    navToggle.setAttribute("aria-expanded", String(open));
    navLinks.classList.toggle("is-open", open);
  }

  function closeMenu() {
    if (navToggle.getAttribute("aria-expanded") === "true") setMenu(false);
  }

  navToggle.addEventListener("click", () => {
    setMenu(navToggle.getAttribute("aria-expanded") !== "true");
  });

  navLinks.addEventListener("click", (event) => {
    if (event.target.closest("a")) closeMenu();
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeMenu();
  });

  document.addEventListener("click", (event) => {
    if (!navLinks.classList.contains("is-open")) return;
    if (event.target.closest("#navLinks") || event.target.closest("#navToggle")) return;
    closeMenu();
  });

  window.addEventListener("resize", () => {
    if (window.innerWidth > 960) closeMenu();
  });

  /* ------------------------------ 滚动进度 ------------------------------ */

  let ticking = false;

  function onScrollFrame() {
    ticking = false;
    const scrollTop = window.scrollY || document.documentElement.scrollTop;
    const scrollable =
      document.documentElement.scrollHeight - window.innerHeight;

    if (progressBar) {
      const percent = scrollable > 0 ? Math.min(1, scrollTop / scrollable) : 0;
      progressBar.style.transform = `scaleX(${percent})`;
    }

    if (navbar) navbar.classList.toggle("is-scrolled", scrollTop > 8);

    if (toTop) {
      const shouldShow = scrollTop > 640;
      if (shouldShow === toTop.hidden) {
        toTop.hidden = !shouldShow;
      }
    }
  }

  function onScroll() {
    if (ticking) return;
    ticking = true;
    window.requestAnimationFrame(onScrollFrame);
  }

  window.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("resize", onScroll, { passive: true });
  onScrollFrame();

  /* ------------------------------ 回到顶部 ------------------------------ */

  if (toTop) {
    toTop.addEventListener("click", () => {
      window.scrollTo({
        top: 0,
        behavior: reduceMotion.matches ? "auto" : "smooth",
      });
    });
  }

  /* ------------------------------ 导航高亮 ------------------------------ */

  function setActive(id) {
    navAnchors.forEach((link) => {
      const isActive = link.getAttribute("href") === `#${id}`;
      link.classList.toggle("is-active", isActive);
      if (isActive) link.setAttribute("aria-current", "true");
      else link.removeAttribute("aria-current");
    });
  }

  if ("IntersectionObserver" in window && sections.length) {
    const navObserver = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) setActive(entry.target.id);
        });
      },
      { rootMargin: "-45% 0px -50% 0px", threshold: 0 }
    );

    sections.forEach((section) => navObserver.observe(section));
  }

  /* ------------------------------ 入场动画 ------------------------------ */

  const revealItems = [...document.querySelectorAll(".reveal")];

  // 同一容器内的元素依次出现
  revealItems.forEach((item) => {
    const siblings = item.parentElement
      ? [...item.parentElement.children].filter((node) =>
          node.classList && node.classList.contains("reveal")
        )
      : [];
    const index = siblings.indexOf(item);
    if (index > 0) item.style.transitionDelay = `${Math.min(index * 70, 350)}ms`;
  });

  if ("IntersectionObserver" in window && revealItems.length) {
    const revealObserver = new IntersectionObserver(
      (entries, observer) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          entry.target.classList.add("is-visible");
          observer.unobserve(entry.target);
        });
      },
      { rootMargin: "0px 0px -8% 0px", threshold: 0.08 }
    );

    revealItems.forEach((item) => revealObserver.observe(item));
  } else {
    revealItems.forEach((item) => item.classList.add("is-visible"));
  }

  /* ------------------------------ FAQ 手风琴 ------------------------------ */

  const faqItems = [...document.querySelectorAll(".faq__item")];

  faqItems.forEach((item) => {
    item.addEventListener("toggle", () => {
      if (!item.open) return;
      faqItems.forEach((other) => {
        if (other !== item) other.open = false;
      });
    });
  });
})();
