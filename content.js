/**
 * 拾图 · PixHarvest — content script
 * ------------------------------------------------------------------
 * 在页面右下角注入一个「获取图片」悬浮按钮（Shadow DOM 隔离样式），
 * 点击后扫描当前商品详情页，收集 img / srcset / 懒加载属性 /
 * 背景图 / JSON-LD / 常见电商高清图地址，去重后交给 background 保存。
 */

(() => {
  "use strict";

  // 只在顶层文档注入，iframe 里不重复出现按钮
  if (window.top !== window.self) return;
  if (document.getElementById("pixharvest-root")) return;

  const MIN_PX = 90; // 小于这个尺寸的多半是图标 / 占位图
  const MAX_ITEMS = 400;
  const MAX_STYLE_NODES = 700; // 计算样式扫描上限，避免卡顿

  const JUNK_RE =
    /(sprite|favicon|avatar|emoji|pixel|tracking|spacer|placeholder|loading[.\-_]|blank\.(?:gif|png)|1x1|transparent\.(?:gif|png)|qr-?code|qrcode|beian|icon[-_]?\d{1,3}\.)/i;
  const IMAGE_EXT_RE = /\.(jpe?g|png|webp|gif|avif|bmp)(?:[?#]|$)/i;

  const LUCIDE_ICON = `
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <rect x="3" y="4.5" width="18" height="15" rx="2.4"></rect>
      <circle cx="8.6" cy="9.6" r="1.5"></circle>
      <path d="M20.4 15.6l-4.9-4.9a1.5 1.5 0 0 0-2.1 0L6 18.1"></path>
    </svg>`;

  /* ---------------------------------------------------------------- */
  /* UI                                                               */
  /* ---------------------------------------------------------------- */

  const host = document.createElement("div");
  host.id = "pixharvest-root";
  host.setAttribute("data-pixharvest", "1");
  // 用内联 !important 抵抗页面自身对 div / 固定定位的重置
  host.style.cssText = [
    "all: initial !important",
    "position: fixed !important",
    "inset: 0 !important",
    "display: block !important",
    "pointer-events: none !important",
    "z-index: 2147483647 !important",
  ].join(";");
  const shadow = host.attachShadow({ mode: "open" });

  const style = document.createElement("link");
  style.rel = "stylesheet";
  style.href = chrome.runtime.getURL("content.css");
  shadow.appendChild(style);

  const button = document.createElement("button");
  button.type = "button";
  button.className = "ph-fab";
  button.title = "提取当前页面的商品图片";
  button.innerHTML = `
    <span class="ph-fab__icon">${LUCIDE_ICON}</span>
    <span class="ph-fab__label">获取图片</span>
    <span class="ph-fab__spinner" aria-hidden="true"></span>`;
  button.style.visibility = "hidden"; // 等样式表就绪，避免闪烁
  shadow.appendChild(button);

  style.addEventListener("load", () => {
    button.style.visibility = "";
  });
  style.addEventListener("error", () => {
    host.remove(); // 样式加载失败时不留下裸按钮
  });

  const toast = document.createElement("div");
  toast.className = "ph-toast";
  toast.setAttribute("role", "status");
  toast.setAttribute("aria-live", "polite");
  shadow.appendChild(toast);

  (document.documentElement || document.body).appendChild(host);

  let toastTimer = 0;
  function showToast(text, tone) {
    toast.textContent = text;
    toast.dataset.tone = tone || "info";
    toast.classList.add("is-visible");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove("is-visible"), 3200);
  }

  function setBusy(busy) {
    button.classList.toggle("is-busy", busy);
    button.disabled = busy;
    button.querySelector(".ph-fab__label").textContent = busy ? "正在提取…" : "获取图片";
  }

  /* ---------------------------------------------------------------- */
  /* URL 处理                                                          */
  /* ---------------------------------------------------------------- */

  function absoluteUrl(value) {
    if (typeof value !== "string") return "";
    let raw = value.trim();
    if (!raw || raw.length > 4000) return "";
    // 去掉包裹的引号与 HTML 实体
    raw = raw.replace(/^['"]+|['"]+$/g, "").replace(/&amp;/g, "&");
    if (!raw || /^(javascript|about|mailto|tel):/i.test(raw)) return "";
    if (raw.startsWith("data:")) {
      return /^data:image\/(png|jpe?g|webp|gif|bmp|avif);base64,/i.test(raw) ? raw : "";
    }
    if (raw.startsWith("blob:")) return ""; // background 无法访问页面的 blob URL
    try {
      return new URL(raw, document.baseURI || location.href).href;
    } catch {
      return "";
    }
  }

  /**
   * 把常见的缩略图地址还原成原始大图：
   *  - 淘宝/天猫:  xxx.jpg_430x430q90.jpg_.webp  -> xxx.jpg
   *  - Amazon:     xxx._AC_SL1500_.jpg           -> xxx.jpg
   *  - 京东:       /s450x450_jfs/  -> /jfs/ , /n1/ -> /n0/
   *  - 通用:       xxx_640x640.jpg / xxx-300x300.jpg
   *  - 阿里 OSS:   ?x-oss-process=image/resize... 去掉处理参数
   */
  function upgradeUrl(url) {
    if (!url || url.startsWith("data:")) return url;

    try {
      const parsed = new URL(url);
      let path = parsed.pathname;

      // Amazon: ._AC_SL1500_.jpg / ._SL1500_.webp
      path = path.replace(/\._[A-Za-z0-9,_-]+_\.(jpe?g|png|webp|gif)$/i, ".$1");

      // 淘宝 / 天猫 / 通用缩略后缀
      path = path.replace(
        /(\.(?:jpe?g|png|webp|gif))_(?:\d+x\d+(?:q\d+)?|sum|watermark|small|medium|large|thumb(?:nail)?|pico)(?:\.(?:jpe?g|png|webp|gif))?(?:_\.webp)?$/i,
        "$1"
      );

      // 通用 _640x480 / -300x300 / _640x
      path = path.replace(/_\d+x\d*(?:q\d+)?(?=\.(?:jpe?g|png|webp|gif)$)/i, "");
      path = path.replace(/-\d+x\d+(?=\.(?:jpe?g|png|webp|gif)$)/i, "");

      if (/(^|\.)360buyimg\.com$/i.test(parsed.hostname)) {
        path = path.replace(/\/s\d+x\d+_jfs\//i, "/jfs/");
        path = path.replace(/\/n[1-9]\//i, "/n0/");
      }

      // Shopify / CDN: xxx_400x400.progressive.jpg
      path = path.replace(/_\d+x\d*\.(progressive\.)?(jpe?g|png|webp)$/i, ".$2");

      if (path !== parsed.pathname) parsed.pathname = path;

      const processingParams = [
        "x-oss-process",
        "imageView2",
        "imageMogr2",
        "image_process",
        "imageview2",
      ];
      let removed = false;
      for (const key of processingParams) {
        if (parsed.searchParams.has(key)) {
          parsed.searchParams.delete(key);
          removed = true;
        }
      }
      if (removed) {
        const query = parsed.searchParams.toString();
        parsed.search = query ? `?${query}` : "";
      }

      return parsed.href;
    } catch {
      return url;
    }
  }

  function isJunk(url, img) {
    if (!url) return true;
    if (url.startsWith("data:")) {
      return url.length < 3000 || url.length > 1_500_000;
    }
    if (!/^https?:/i.test(url)) return true;
    if (/\.svg(?:[?#]|$)/i.test(url)) return true;
    if (JUNK_RE.test(url)) return true;

    if (img) {
      const width = img.naturalWidth || 0;
      const height = img.naturalHeight || 0;
      // 图片已加载且明显太小 → 丢
      if (width && height && (width < MIN_PX || height < MIN_PX)) return true;
    }
    return false;
  }

  /* ---------------------------------------------------------------- */
  /* 收集器                                                            */
  /* ---------------------------------------------------------------- */

  function createCollector() {
    const map = new Map();

    return {
      add(rawValue, meta) {
        const img = meta && meta.img ? meta.img : null;
        const base = absoluteUrl(rawValue);
        if (!base) return;

        const url = upgradeUrl(base);
        if (isJunk(url, img)) return;

        const key = url.split("#")[0];
        if (map.has(key)) return;

        const alt = img && typeof img.alt === "string" ? img.alt.trim() : "";
        map.set(key, {
          url,
          alt: alt.slice(0, 120),
          w: img ? img.naturalWidth || 0 : 0,
          h: img ? img.naturalHeight || 0 : 0,
        });
      },
      get size() {
        return map.size;
      },
      list() {
        return [...map.values()].slice(0, MAX_ITEMS);
      },
    };
  }

  function splitSrcset(value) {
    if (!value || typeof value !== "string") return [];
    return value
      .split(",")
      .map((part) => part.trim().split(/\s+/)[0])
      .filter(Boolean);
  }

  /** 从 CSS 的 `url(...)` 中取出图片地址 */
  function urlsInCss(value, collector, img) {
    if (!value || value === "none") return;
    const pattern = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi;
    let match;
    while ((match = pattern.exec(value)) !== null) {
      collector.add(match[2], { img });
    }
  }

  /* ---------------------------------------------------------------- */
  /* 提取策略                                                          */
  /* ---------------------------------------------------------------- */

  function collectMeta(collector) {
    const selectors = [
      'meta[property="og:image"]',
      'meta[property="og:image:secure_url"]',
      'meta[name="twitter:image"]',
      'meta[itemprop="image"]',
      'link[rel="image_src"]',
      'link[rel="preload"][as="image"]',
    ];
    document.querySelectorAll(selectors.join(",")).forEach((node) => {
      collector.add(node.getAttribute("content") || node.getAttribute("href"));
    });
  }

  function collectImgTags(collector) {
    const urlAttrs = [
      "src",
      "data-src",
      "data-original",
      "data-lazy",
      "data-lazy-src",
      "data-lazyload",
      "data-echo",
      "data-url",
      "data-image",
      "data-img",
      "data-ks-image",
      "data-zoom-image",
      "data-large-image",
      "data-large_image",
      "data-src-large",
      "data-old-hires",
      "zoomfile",
    ];

    document.querySelectorAll("img").forEach((img) => {
      // 当前真实渲染的地址优先
      collector.add(img.currentSrc || img.src, { img });
      if (img.src && img.src !== img.currentSrc) collector.add(img.src, { img });

      for (const name of urlAttrs) {
        const value = img.getAttribute(name);
        if (value) collector.add(value, { img });
      }

      // srcset / picture > source
      splitSrcset(img.getAttribute("srcset")).forEach((item) =>
        collector.add(item, { img })
      );
      splitSrcset(img.getAttribute("data-srcset")).forEach((item) =>
        collector.add(item, { img })
      );

      // 兜底：任何看起来像图片地址的 data-* 属性
      if (img.dataset) {
        for (const [key, value] of Object.entries(img.dataset)) {
          if (typeof value !== "string" || value.length > 2048) continue;
          if (!/(src|image|img|original|zoom|large|hires|thumb)/i.test(key)) continue;
          if (/^(https?:)?\/\//i.test(value) || value.startsWith("data:image")) {
            collector.add(value, { img });
          }
        }
      }
    });
  }

  function collectSources(collector) {
    document.querySelectorAll("source").forEach((source) => {
      splitSrcset(source.getAttribute("srcset")).forEach((item) => collector.add(item));
      if (source.getAttribute("src")) collector.add(source.getAttribute("src"));
    });
  }

  function collectDynamicImages(collector) {
    // Amazon 会把多尺寸图片塞进 JSON：{"url": [w, h]}
    document.querySelectorAll("[data-a-dynamic-image]").forEach((node) => {
      try {
        const map = JSON.parse(node.getAttribute("data-a-dynamic-image") || "{}");
        Object.keys(map).forEach((url) => collector.add(url));
      } catch {
        /* 非 JSON，忽略 */
      }
    });
  }

  function collectJsonLd(collector) {
    document
      .querySelectorAll('script[type="application/ld+json"]')
      .forEach((script) => {
        const text = script.textContent || "";
        if (!text || text.length > 500_000) return;
        let data;
        try {
          data = JSON.parse(text);
        } catch {
          return;
        }
        walkJsonLd(data, collector, 0);
      });
  }

  function walkJsonLd(node, collector, depth) {
    if (!node || depth > 6) return;
    if (Array.isArray(node)) {
      node.forEach((item) => walkJsonLd(item, collector, depth + 1));
      return;
    }
    if (typeof node === "string") return;
    if (typeof node !== "object") return;

    for (const [key, value] of Object.entries(node)) {
      if (/^(image|thumbnailUrl|contentUrl)$/i.test(key)) {
        if (typeof value === "string") collector.add(value);
        else if (Array.isArray(value)) {
          value.forEach((entry) => {
            if (typeof entry === "string") collector.add(entry);
            else if (entry && typeof entry === "object") {
              collector.add(entry.url || entry.contentUrl || "");
            }
          });
        } else if (value && typeof value === "object") {
          collector.add(value.url || value.contentUrl || "");
        }
      } else if (value && typeof value === "object") {
        walkJsonLd(value, collector, depth + 1);
      }
    }
  }

  function collectInlineBackgrounds(collector) {
    document.querySelectorAll('[style*="background"]').forEach((node) => {
      urlsInCss(node.getAttribute("style"), collector);
    });
  }

  function collectComputedBackgrounds(collector) {
    // 详情页常把大图放在轮播 / 画廊容器的 CSS 背景里
    const selectors = [
      ".swiper-slide",
      "[class*='gallery']",
      "[class*='carousel']",
      "[class*='detail']",
      "[class*='thumb']",
      "[class*='banner']",
      "[class*='pic']",
      "[class*='image']",
      "[style*='background-image']",
    ];
    const nodes = document.querySelectorAll(selectors.join(","));
    const limit = Math.min(nodes.length, MAX_STYLE_NODES);

    for (let i = 0; i < limit; i += 1) {
      const node = nodes[i];
      let background = "";
      try {
        background = getComputedStyle(node).backgroundImage;
      } catch {
        continue;
      }
      urlsInCss(background, collector);
    }
  }

  function collectLinks(collector) {
    // 大图常常包在 <a href="...jpg"> 里
    document.querySelectorAll("a[href]").forEach((anchor) => {
      const href = anchor.getAttribute("href");
      if (href && IMAGE_EXT_RE.test(href)) collector.add(href);
    });
  }

  function extractImages() {
    const collector = createCollector();

    collectMeta(collector);
    collectImgTags(collector);
    collectSources(collector);
    collectDynamicImages(collector);
    collectJsonLd(collector);
    collectInlineBackgrounds(collector);
    collectComputedBackgrounds(collector);
    collectLinks(collector);

    return collector.list();
  }

  /* ---------------------------------------------------------------- */
  /* 事件                                                              */
  /* ---------------------------------------------------------------- */

  function runtimeAlive() {
    try {
      return Boolean(chrome && chrome.runtime && chrome.runtime.id);
    } catch {
      return false;
    }
  }

  button.addEventListener("click", async (event) => {
    event.preventDefault();
    event.stopPropagation();

    if (button.disabled) return;

    if (!runtimeAlive()) {
      showToast("扩展已更新或停用，请刷新页面后重试。", "error");
      return;
    }

    setBusy(true);
    try {
      // 让浏览器先绘制 loading 状态
      await new Promise((resolve) => requestAnimationFrame(() => resolve()));

      const images = extractImages();
      if (!images.length) {
        showToast("这个页面没有找到可用的商品图片，试试滚动加载后再点一次。", "warn");
        return;
      }

      const response = await chrome.runtime.sendMessage({
        type: "IG_SAVE_IMAGES",
        payload: {
          images: images.map((item, index) => ({ ...item, id: `ig-${Date.now()}-${index}` })),
          pageTitle: document.title || location.hostname,
          pageUrl: location.href,
        },
      });

      if (response && response.ok) {
        showToast(`已提取 ${response.count} 张图片，正在打开图库…`, "ok");
      } else {
        showToast((response && response.error) || "提取失败，请稍后重试。", "error");
      }
    } catch (error) {
      console.warn("[拾图]", error);
      showToast("扩展通信失败，请刷新页面后重试。", "error");
    } finally {
      setBusy(false);
    }
  });
})();
