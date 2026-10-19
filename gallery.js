/**
 * 拾图图库 · gallery.js
 * 读取 background 保存的提取结果，渲染网格，支持全选 / 反选 /
 * 单张预览 / 批量下载 PNG，并实时显示后台下载进度。
 */

(() => {
  "use strict";

  const el = {
    grid: document.getElementById("grid"),
    empty: document.getElementById("empty"),
    sourceMeta: document.getElementById("sourceMeta"),
    countLabel: document.getElementById("countLabel"),
    selectedLabel: document.getElementById("selectedLabel"),
    selectAllBtn: document.getElementById("selectAllBtn"),
    invertBtn: document.getElementById("invertBtn"),
    clearBtn: document.getElementById("clearBtn"),
    downloadBtn: document.getElementById("downloadBtn"),
    downloadLabel: document.getElementById("downloadLabel"),
    lightbox: document.getElementById("lightbox"),
    lightboxImage: document.getElementById("lightboxImage"),
    lightboxCounter: document.getElementById("lightboxCounter"),
    lightboxOpen: document.getElementById("lightboxOpen"),
    lightboxDownload: document.getElementById("lightboxDownload"),
    lightboxClose: document.getElementById("lightboxClose"),
    lightboxPrev: document.getElementById("lightboxPrev"),
    lightboxNext: document.getElementById("lightboxNext"),
    progress: document.getElementById("progress"),
    progressBar: document.getElementById("progressBar"),
    progressText: document.getElementById("progressText"),
    progressCount: document.getElementById("progressCount"),
    toast: document.getElementById("toast"),
  };

  const state = {
    images: [],
    selected: new Set(),
    pageTitle: "未命名页面",
    pageUrl: "",
    downloading: false,
    lightboxIndex: 0,
    notifiedJobId: "",
    toastTimer: 0,
    progressTimer: 0,
  };

  /* ---------------------------------------------------------------- */
  /* 工具                                                              */
  /* ---------------------------------------------------------------- */

  function showToast(text, tone) {
    el.toast.textContent = text;
    el.toast.dataset.tone = tone || "info";
    el.toast.classList.add("is-visible");
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => el.toast.classList.remove("is-visible"), 4200);
  }

  function showProgress(job) {
    clearTimeout(state.progressTimer);
    el.progress.hidden = false;
    const total = Math.max(1, Number(job.total) || 0);
    const done = Number(job.done) || 0;
    const percent = Math.min(100, Math.round((done / total) * 100));
    el.progressBar.style.width = `${percent}%`;
    el.progressCount.textContent = `${done} / ${total}`;

    if (job.state === "running") {
      el.progressText.textContent = "正在转换并下载 PNG…";
    } else if (job.state === "done") {
      el.progressText.textContent = `完成：成功 ${job.success} 张，失败 ${job.failed} 张`;
    } else {
      el.progressText.textContent = `任务${job.state === "interrupted" ? "被中断" : "失败"}：成功 ${job.success || 0} 张`;
    }
  }

  function scheduleProgressHide(delay) {
    clearTimeout(state.progressTimer);
    state.progressTimer = setTimeout(() => {
      el.progress.hidden = true;
    }, delay || 6000);
  }

  function formatTime(timestamp) {
    if (!timestamp) return "";
    try {
      return new Date(timestamp).toLocaleString("zh-CN", { hour12: false });
    } catch {
      return "";
    }
  }

  function hostOf(url) {
    try {
      return new URL(url).hostname;
    } catch {
      return "";
    }
  }

  /* ---------------------------------------------------------------- */
  /* 渲染                                                              */
  /* ---------------------------------------------------------------- */

  function renderMeta(record) {
    const parts = [state.pageTitle];
    const host = hostOf(state.pageUrl);
    if (host) parts.push(host);
    const time = formatTime(record.extractedAt);
    if (time) parts.push(time);
    parts.push(`${state.images.length} 张图片`);

    el.sourceMeta.textContent = parts.join(" · ");
    el.sourceMeta.title = state.pageUrl || "";
  }

  function createCard(item, index) {
    const card = document.createElement("article");
    card.className = "card";
    card.dataset.id = item.id;

    const label = document.createElement("label");
    label.className = "card__check";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.dataset.id = item.id;
    checkbox.checked = state.selected.has(item.id);
    label.append(checkbox, document.createTextNode(String(index + 1).padStart(2, "0")));

    const media = document.createElement("div");
    media.className = "card__media";
    media.dataset.index = String(index);
    media.setAttribute("role", "button");
    media.setAttribute("tabindex", "0");
    media.setAttribute("aria-label", `预览第 ${index + 1} 张图片`);

    const img = document.createElement("img");
    img.alt = item.alt || `提取图片 ${index + 1}`;
    img.loading = "lazy";
    img.decoding = "async";
    img.src = item.url;
    img.addEventListener("load", () => {
      img.classList.add("is-loaded");
      if (img.naturalWidth && img.naturalHeight) {
        dims.textContent = `${img.naturalWidth} × ${img.naturalHeight}`;
      }
    });
    img.addEventListener("error", () => {
      card.classList.add("is-broken");
      dims.textContent = "加载失败";
    });

    const dims = document.createElement("span");
    dims.className = "card__dims";
    dims.textContent = item.w && item.h ? `${item.w} × ${item.h}` : "";

    const link = document.createElement("a");
    link.className = "card__link";
    link.href = item.url;
    link.target = "_blank";
    link.rel = "noreferrer noopener";
    link.textContent = "原图 ↗";
    link.addEventListener("click", (event) => event.stopPropagation());

    const error = document.createElement("div");
    error.className = "card__error";
    error.textContent = "图片加载失败";

    media.append(img, dims, link, error);
    card.append(label, media);
    return card;
  }

  function render() {
    const fragment = document.createDocumentFragment();
    state.images.forEach((item, index) => {
      const card = createCard(item, index);
      card.classList.toggle("is-selected", state.selected.has(item.id));
      fragment.appendChild(card);
    });

    el.grid.replaceChildren(fragment);
    el.grid.hidden = state.images.length === 0;
    el.empty.hidden = state.images.length > 0;
    updateSummary();
  }

  function updateSummary() {
    const count = state.images.length;
    const selected = state.selected.size;

    el.countLabel.textContent = `${count} 张图片`;
    el.selectedLabel.textContent = `已选 ${selected} 张`;

    el.downloadLabel.textContent = state.downloading
      ? "下载中…"
      : selected > 0
        ? `批量下载 PNG（${selected}）`
        : "批量下载 PNG";

    el.downloadBtn.disabled = state.downloading || selected === 0;
    el.selectAllBtn.disabled = count === 0;
    el.invertBtn.disabled = count === 0;
    el.clearBtn.disabled = count === 0 || state.downloading;
  }

  function setSelected(id, checked) {
    if (checked) state.selected.add(id);
    else state.selected.delete(id);

    const card = el.grid.querySelector(`.card[data-id="${cssEscape(id)}"]`);
    if (card) card.classList.toggle("is-selected", checked);
    updateSummary();
  }

  /** 简易 CSS.escape 兜底 */
  function cssEscape(value) {
    if (window.CSS && typeof window.CSS.escape === "function") {
      return window.CSS.escape(value);
    }
    return String(value).replace(/["\\]/g, "\\$&");
  }

  /* ---------------------------------------------------------------- */
  /* 数据                                                              */
  /* ---------------------------------------------------------------- */

  async function loadExtracted() {
    let data;
    try {
      data = await chrome.storage.local.get("extracted");
    } catch (error) {
      showToast("无法读取扩展存储，请重新打开图库。", "error");
      return;
    }

    const record = (data && data.extracted) || {};
    state.images = Array.isArray(record.images) ? record.images : [];
    state.pageTitle = record.pageTitle || "未命名页面";
    state.pageUrl = record.pageUrl || "";

    // 新一次提取默认全选
    state.selected = new Set(state.images.map((item) => item.id));

    renderMeta(record);
    render();

    if (!state.images.length) {
      el.sourceMeta.textContent = "还没有提取任何图片";
      el.sourceMeta.title = "";
    }
  }

  /* ---------------------------------------------------------------- */
  /* 下载                                                              */
  /* ---------------------------------------------------------------- */

  async function startDownload(items) {
    if (state.downloading || !items.length) return;

    state.downloading = true;
    state.notifiedJobId = "";
    updateSummary();
    showProgress({ total: items.length, done: 0, success: 0, failed: 0, state: "running" });

    try {
      const response = await chrome.runtime.sendMessage({
        type: "IG_DOWNLOAD_PNG",
        payload: {
          items: items.map((item) => ({ url: item.url, alt: item.alt })),
          pageTitle: state.pageTitle,
        },
      });

      if (!response || !response.ok) {
        throw new Error((response && response.error) || "后台没有接受下载任务。");
      }
    } catch (error) {
      state.downloading = false;
      el.progress.hidden = true;
      updateSummary();
      showToast(
        `无法开始下载：${(error && error.message) || "未知错误"}`,
        "error"
      );
    }
  }

  function applyJob(job, options) {
    if (!job || !job.id) return;
    const silent = Boolean(options && options.silent);
    const isRunning = job.state === "running";

    state.downloading = isRunning;

    if (isRunning) {
      showProgress(job);
      updateSummary();
      return;
    }

    if (silent) {
      updateSummary();
      return;
    }

    showProgress(job);
    updateSummary();
    scheduleProgressHide(6500);

    if (state.notifiedJobId === job.id) return;
    state.notifiedJobId = job.id;

    if (job.state === "done") {
      if (job.failed > 0) {
        showToast(
          `下载结束：成功 ${job.success} 张，失败 ${job.failed} 张。成功的文件在「下载/拾图」文件夹。`,
          "info"
        );
      } else {
        showToast(
          `已下载 ${job.success} 张 PNG，保存在「下载/拾图/${state.pageTitle}」文件夹。`,
          "ok"
        );
      }
    } else if (job.state === "interrupted") {
      showToast("上一次下载任务被浏览器中断，可以重新选择图片再下载。", "error");
    } else {
      showToast(`下载任务失败：${job.error || "未知错误"}`, "error");
    }
  }

  /* ---------------------------------------------------------------- */
  /* 预览                                                              */
  /* ---------------------------------------------------------------- */

  function openLightbox(index) {
    if (!state.images.length) return;
    state.lightboxIndex = clampIndex(index);
    updateLightbox();
    el.lightbox.hidden = false;
    document.body.style.overflow = "hidden";
    el.lightboxClose.focus({ preventScroll: true });
  }

  function closeLightbox() {
    el.lightbox.hidden = true;
    el.lightboxImage.removeAttribute("src");
    document.body.style.overflow = "";
  }

  function clampIndex(index) {
    const total = state.images.length;
    if (!total) return 0;
    return ((index % total) + total) % total;
  }

  function updateLightbox() {
    const item = state.images[state.lightboxIndex];
    if (!item) return;
    el.lightboxImage.src = item.url;
    el.lightboxImage.alt = item.alt || `图片 ${state.lightboxIndex + 1}`;
    el.lightboxCounter.textContent = `${state.lightboxIndex + 1} / ${state.images.length}`;
    el.lightboxOpen.href = item.url;
  }

  function stepLightbox(delta) {
    state.lightboxIndex = clampIndex(state.lightboxIndex + delta);
    updateLightbox();
  }

  /* ---------------------------------------------------------------- */
  /* 事件                                                              */
  /* ---------------------------------------------------------------- */

  function bindEvents() {
    el.grid.addEventListener("change", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLInputElement) || target.type !== "checkbox") return;
      const id = target.dataset.id;
      if (!id) return;
      setSelected(id, target.checked);
    });

    el.grid.addEventListener("click", (event) => {
      const media = event.target.closest(".card__media");
      if (!media) return;
      if (event.target.closest("a")) return;
      openLightbox(Number(media.dataset.index) || 0);
    });

    el.grid.addEventListener("keydown", (event) => {
      const media = event.target.closest(".card__media");
      if (!media) return;
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        openLightbox(Number(media.dataset.index) || 0);
      }
    });

    el.selectAllBtn.addEventListener("click", () => {
      state.selected = new Set(state.images.map((item) => item.id));
      el.grid.querySelectorAll("input[type='checkbox']").forEach((input) => {
        input.checked = true;
      });
      el.grid.querySelectorAll(".card").forEach((card) => card.classList.add("is-selected"));
      updateSummary();
    });

    el.invertBtn.addEventListener("click", () => {
      const next = new Set();
      state.images.forEach((item) => {
        if (!state.selected.has(item.id)) next.add(item.id);
      });
      state.selected = next;
      el.grid.querySelectorAll("input[type='checkbox']").forEach((input) => {
        input.checked = state.selected.has(input.dataset.id);
      });
      el.grid.querySelectorAll(".card").forEach((card) => {
        card.classList.toggle("is-selected", state.selected.has(card.dataset.id));
      });
      updateSummary();
    });

    el.clearBtn.addEventListener("click", async () => {
      if (!state.images.length) return;
      const confirmed = window.confirm(
        "清空图库中的图片记录？已经下载到电脑上的文件不会被删除。"
      );
      if (!confirmed) return;
      await chrome.storage.local.remove("extracted");
    });

    el.downloadBtn.addEventListener("click", () => {
      const items = state.images.filter((item) => state.selected.has(item.id));
      startDownload(items);
    });

    el.lightboxClose.addEventListener("click", closeLightbox);
    el.lightboxPrev.addEventListener("click", () => stepLightbox(-1));
    el.lightboxNext.addEventListener("click", () => stepLightbox(1));

    el.lightbox.addEventListener("click", (event) => {
      if (event.target === el.lightbox) closeLightbox();
    });

    el.lightboxDownload.addEventListener("click", () => {
      const item = state.images[state.lightboxIndex];
      if (item) startDownload([item]);
    });

    document.addEventListener("keydown", (event) => {
      const lightboxOpen = !el.lightbox.hidden;

      if (lightboxOpen) {
        if (event.key === "Escape") {
          event.preventDefault();
          closeLightbox();
        } else if (event.key === "ArrowLeft") {
          event.preventDefault();
          stepLightbox(-1);
        } else if (event.key === "ArrowRight") {
          event.preventDefault();
          stepLightbox(1);
        }
        return;
      }

      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") {
        if (event.target instanceof HTMLInputElement) return;
        event.preventDefault();
        el.selectAllBtn.click();
      }
    });

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      if (changes.extracted) {
        loadExtracted().catch(() => {});
      }
      if (changes.downloadJob) {
        applyJob(changes.downloadJob.newValue);
      }
    });

    chrome.runtime.onMessage.addListener((message) => {
      if (!message || !message.type) return;
      if (
        message.type === "IG_PROGRESS" ||
        message.type === "IG_DONE" ||
        message.type === "IG_FAILED"
      ) {
        applyJob(message.payload);
      }
    });
  }

  /* ---------------------------------------------------------------- */
  /* 启动                                                              */
  /* ---------------------------------------------------------------- */

  async function init() {
    bindEvents();
    await loadExtracted();

    try {
      const data = await chrome.storage.local.get("downloadJob");
      if (data && data.downloadJob) {
        applyJob(data.downloadJob, { silent: data.downloadJob.state !== "running" });
      }
    } catch {
      /* 忽略：下载进度不是关键路径 */
    }
  }

  init();
})();
