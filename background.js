/**
 * 拾图 · PixHarvest — background service worker
 * ------------------------------------------------------------------
 * 职责：
 *  1. 接收内容脚本提取到的图片列表，写入 chrome.storage.local；
 *  2. 打开 / 聚焦图库页 gallery.html；
 *  3. 接收图库的批量下载请求：把图片转码成 PNG 后交给 chrome.downloads。
 *
 * 设计要点：
 *  - MV3 的 Service Worker 随时可能被回收，因此「批量下载」采用
 *    "立即应答 + 后台任务 + 进度写入 storage" 的模式，不依赖长连接。
 *  - Service Worker 里没有 document / FileReader / URL.createObjectURL，
 *    因此用 OffscreenCanvas + createImageBitmap 转 PNG，
 *    再用 ArrayBuffer -> base64 生成 data: URL 交给下载 API。
 *  - Service Worker 里也不能设置 Referer 请求头（forbidden header），
 *    但 fetch 的 init 支持 referrer / referrerPolicy，用它在部分 CDN
 *    开启防盗链时提高成功率。
 */

const GALLERY_PAGE = "gallery.html";
const STORAGE_KEY = "extracted";
const JOB_KEY = "downloadJob";
const FOLDER_ROOT = "拾图";

const MAX_ITEMS = 500;
const CONCURRENCY = 3;
const ITEM_TIMEOUT = 90_000;
/** 单张图片转 PNG 的体积上限（字节）。超过则回退下载原图，避免超大 base64。 */
const MAX_PNG_BYTES = 24 * 1024 * 1024;
const IMAGE_ACCEPT =
  "image/avif,image/webp,image/apng,image/png,image/jpeg,image/*;q=0.8,*/*;q=0.5";

/* ------------------------------------------------------------------ */
/* 生命周期                                                            */
/* ------------------------------------------------------------------ */

chrome.action.onClicked.addListener(() => {
  openGallery().catch((error) => console.warn("[拾图] 打开图库失败", error));
});

chrome.runtime.onInstalled.addListener(() => {
  markStaleJob().catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  markStaleJob().catch(() => {});
});

/** 浏览器重启后，上一次没跑完的任务不应一直显示为 running。 */
async function markStaleJob() {
  const data = await chrome.storage.local.get(JOB_KEY);
  const job = data[JOB_KEY];
  if (job && job.state === "running") {
    await chrome.storage.local.set({
      [JOB_KEY]: { ...job, state: "interrupted", finishedAt: Date.now() },
    });
  }
}

/* ------------------------------------------------------------------ */
/* 消息路由                                                            */
/* ------------------------------------------------------------------ */

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const type = message && message.type;

  if (type === "IG_SAVE_IMAGES") {
    saveImages(message.payload)
      .then(sendResponse)
      .catch((error) => sendResponse(fail(error)));
    return true; // 保持消息通道，异步 sendResponse
  }

  if (type === "IG_DOWNLOAD_PNG") {
    startDownloadJob(message.payload)
      .then(sendResponse)
      .catch((error) => sendResponse(fail(error)));
    return true;
  }

  if (type === "IG_OPEN_GALLERY") {
    openGallery()
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse(fail(error)));
    return true;
  }

  return false;
});

function fail(error) {
  const text =
    (error && (error.message || error.error)) || String(error || "未知错误");
  console.warn("[拾图]", text);
  return { ok: false, error: text };
}

/* ------------------------------------------------------------------ */
/* 保存提取结果                                                        */
/* ------------------------------------------------------------------ */

async function saveImages(payload) {
  const images = normalizeImages(payload && payload.images);
  if (!images.length) {
    throw new Error("没有找到可用的图片。");
  }

  const record = {
    images,
    pageTitle: cleanText(payload && payload.pageTitle) || "未命名页面",
    pageUrl: typeof (payload && payload.pageUrl) === "string" ? payload.pageUrl : "",
    extractedAt: Date.now(),
  };

  await chrome.storage.local.set({ [STORAGE_KEY]: record });
  broadcast({ type: "IG_EXTRACTED", payload: { count: images.length } });
  await openGallery();
  return { ok: true, count: images.length };
}

/** 只接受可下载的图片地址，去重并限制数量。 */
function normalizeImages(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const result = [];

  for (const raw of list) {
    if (!raw) continue;
    const url = typeof raw === "string" ? raw : raw.url;
    if (typeof url !== "string" || !isDownloadableUrl(url)) continue;
    const key = url.split("#")[0];
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({
      id: typeof raw.id === "string" && raw.id ? raw.id : `img-${result.length}-${Date.now()}`,
      url,
      alt: cleanText(raw.alt, 120),
      w: Number(raw.w) > 0 ? Number(raw.w) : 0,
      h: Number(raw.h) > 0 ? Number(raw.h) : 0,
    });
    if (result.length >= MAX_ITEMS) break;
  }

  return result;
}

function isDownloadableUrl(url) {
  if (/^https?:\/\//i.test(url)) return true;
  if (/^data:image\/(png|jpe?g|webp|gif|bmp|avif);base64,/i.test(url)) {
    return url.length < 2_000_000; // 防止把超大 base64 写进 storage
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* 图库页                                                              */
/* ------------------------------------------------------------------ */

async function openGallery() {
  const url = chrome.runtime.getURL(GALLERY_PAGE);

  // Chrome 116+ / Edge 116+：可以直接找到已打开的图库标签页
  if (typeof chrome.runtime.getContexts === "function") {
    try {
      const contexts = await chrome.runtime.getContexts({
        contextTypes: ["TAB"],
        documentUrls: [url],
      });
      const context = contexts.find((item) => item.tabId >= 0);
      if (context) {
        await focusTab(context.tabId);
        return;
      }
    } catch {
      /* 老版本或权限不足时走下面的兜底方案 */
    }
  }

  // 兜底：遍历标签页，比较 url（扩展对自己的页面默认可见）
  try {
    const tabs = await chrome.tabs.query({});
    const existing = tabs.find((tab) => tab.url === url);
    if (existing && existing.id != null) {
      await focusTab(existing.id);
      return;
    }
  } catch {
    /* 没有 tabs 权限时 query 可能失败，直接新建 */
  }

  await chrome.tabs.create({ url });
}

async function focusTab(tabId) {
  await chrome.tabs.update(tabId, { active: true });
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab.windowId != null) {
      await chrome.windows.update(tab.windowId, { focused: true });
    }
  } catch {
    /* 窗口信息拿不到时也不影响使用 */
  }
}

/* ------------------------------------------------------------------ */
/* 批量下载任务                                                        */
/* ------------------------------------------------------------------ */

let jobRunning = false;
let persistTimer = 0;

async function startDownloadJob(payload) {
  if (jobRunning) {
    throw new Error("已有下载任务正在进行，请等它结束。");
  }

  const items = normalizeImages(payload && payload.items);
  if (!items.length) {
    throw new Error("没有选中可下载的图片。");
  }

  const job = {
    id: `job-${Date.now()}`,
    total: items.length,
    done: 0,
    success: 0,
    failed: 0,
    state: "running",
    pageTitle: cleanText(payload && payload.pageTitle) || "未命名页面",
    startedAt: Date.now(),
  };

  await chrome.storage.local.set({ [JOB_KEY]: job });
  jobRunning = true;
  broadcast({ type: "IG_PROGRESS", payload: job });

  // 不 await：立即应答，任务在后台继续跑
  runJob(job, items).catch((error) => console.warn("[拾图] 任务异常", error));

  return { ok: true, jobId: job.id, total: items.length };
}

async function runJob(job, items) {
  const folder = `${FOLDER_ROOT}/${safeFileName(job.pageTitle, 42)}`;
  const total = items.length;
  let cursor = 0;

  const worker = async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= total) return;

      const item = items[index];
      let outcome;
      try {
        outcome = await downloadOne(item.url, folder, index, job.pageTitle);
      } catch (error) {
        outcome = { ok: false, error: String((error && error.message) || error) };
      }

      job.done += 1;
      if (outcome.ok) job.success += 1;
      else job.failed += 1;

      broadcast({ type: "IG_PROGRESS", payload: { ...job } });
      schedulePersist(job);

      // 轻微限速，避免瞬时打出几十个请求
      await sleep(120);
    }
  };

  try {
    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, total) }, () => worker())
    );
    job.state = "done";
  } catch (error) {
    job.state = "failed";
    job.error = String((error && error.message) || error);
  } finally {
    job.finishedAt = Date.now();
    jobRunning = false;
    clearTimeout(persistTimer);
    await chrome.storage.local.set({ [JOB_KEY]: { ...job } });
    broadcast({ type: job.state === "done" ? "IG_DONE" : "IG_FAILED", payload: { ...job } });
  }
}

function schedulePersist(job) {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    chrome.storage.local.set({ [JOB_KEY]: { ...job } }).catch(() => {});
  }, 250);
}

/**
 * 下载单张图片：
 *  1) 先尝试取回图片 → 转成 PNG → 用 data: URL 下载为 .png；
 *  2) 任一环节失败则回退成原始地址下载，并保留正确的扩展名。
 */
async function downloadOne(url, folder, index, pageTitle) {
  const base = `${folder}/${String(index + 1).padStart(3, "0")}`;

  try {
    const pngDataUrl = await toPngDataUrl(url, pageTitle);
    const id = await chrome.downloads.download({
      url: pngDataUrl,
      filename: `${base}.png`,
      conflictAction: "uniquify",
      saveAs: false,
    });
    const state = await waitForDownload(id, ITEM_TIMEOUT);
    if (state === "complete") {
      return { ok: true, filename: `${base}.png`, converted: true };
    }
    throw new Error(`PNG 下载未完成：${state}`);
  } catch {
    // 回退：原始文件
    const ext = guessExtension(url);
    const id = await chrome.downloads.download({
      url,
      filename: `${base}.${ext}`,
      conflictAction: "uniquify",
      saveAs: false,
    });
    const state = await waitForDownload(id, ITEM_TIMEOUT);
    if (state === "complete") {
      return { ok: true, filename: `${base}.${ext}`, converted: false };
    }
    throw new Error(`原图下载未完成：${state}`);
  }
}

/** 取图 → 解码 → 画到 OffscreenCanvas → 导出 PNG → data URL */
async function toPngDataUrl(url, pageTitle) {
  const blob = await fetchImageBlob(url, pageTitle);
  if (!blob || !blob.size) throw new Error("图片响应为空");

  const type = (blob.type || "").toLowerCase();
  if (type.includes("svg")) throw new Error("SVG 不做位图转换");
  if (type.includes("gif")) throw new Error("GIF 保留原始动画");

  const bitmap = await createImageBitmap(blob);
  const width = bitmap.width;
  const height = bitmap.height;
  if (!width || !height) throw new Error("图片尺寸无效");

  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("无法创建画布上下文");
  ctx.drawImage(bitmap, 0, 0);
  if (typeof bitmap.close === "function") bitmap.close();

  const pngBlob = await canvas.convertToBlob({ type: "image/png" });
  if (!pngBlob || !pngBlob.size) throw new Error("PNG 转码失败");
  if (pngBlob.size > MAX_PNG_BYTES) throw new Error("PNG 体积过大");

  return blobToDataUrl(pngBlob);
}

/**
 * 用多种策略取图。某些电商 CDN 会校验 Referer / Cookie，
 * 因此依次尝试「带页面 Referer」→「仅带 Cookie」→「最简请求」。
 */
async function fetchImageBlob(url, pageUrl) {
  if (url.startsWith("data:")) {
    const response = await fetch(url);
    return response.blob();
  }

  const attempts = [
    pageUrl
      ? { referrer: pageUrl, referrerPolicy: "unsafe-url", credentials: "include" }
      : null,
    pageUrl
      ? { referrer: pageUrl, referrerPolicy: "no-referrer-when-downgrade", credentials: "include" }
      : null,
    { credentials: "include" },
    {},
  ].filter(Boolean);

  let lastError = null;

  for (const attempt of attempts) {
    try {
      const response = await fetch(url, {
        ...attempt,
        cache: "force-cache",
        headers: { Accept: IMAGE_ACCEPT },
      });
      if (!response.ok) {
        lastError = new Error(`HTTP ${response.status}`);
        continue;
      }
      const blob = await response.blob();
      if (blob.size > 0) return blob;
      lastError = new Error("图片响应为空");
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error("无法读取图片数据");
}

/** Service Worker 中 FileReader 不可靠，用 ArrayBuffer + btoa 分块编码。 */
async function blobToDataUrl(blob) {
  const buffer = new Uint8Array(await blob.arrayBuffer());
  const chunk = 0x8000;
  let binary = "";
  for (let i = 0; i < buffer.length; i += chunk) {
    binary += String.fromCharCode.apply(null, buffer.subarray(i, i + chunk));
  }
  const mime = blob.type || "image/png";
  return `data:${mime};base64,${btoa(binary)}`;
}

/** 等待某个下载项结束（complete / interrupted），带超时。 */
function waitForDownload(downloadId, timeout) {
  return new Promise((resolve) => {
    let settled = false;

    const finish = (state) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chrome.downloads.onChanged.removeListener(onChanged);
      resolve(state);
    };

    const onChanged = (delta) => {
      if (delta.id !== downloadId || !delta.state) return;
      if (delta.state.current === "complete") finish("complete");
      else if (delta.state.current === "interrupted") finish("interrupted");
    };

    const timer = setTimeout(() => finish("timeout"), timeout);

    chrome.downloads.onChanged.addListener(onChanged);
    chrome.downloads
      .search({ id: downloadId })
      .then(([item]) => {
        if (!item) {
          // 有些情况下 search 立刻查不到，交给 onChanged / 超时
          return;
        }
        if (item.state === "complete") finish("complete");
        else if (item.state === "interrupted") finish("interrupted");
      })
      .catch(() => {});
  });
}

/* ------------------------------------------------------------------ */
/* 工具函数                                                            */
/* ------------------------------------------------------------------ */

function guessExtension(url) {
  if (url.startsWith("data:")) {
    const match = /^data:image\/([a-z0-9.+-]+)/i.exec(url);
    const sub = match ? match[1].toLowerCase() : "png";
    if (sub === "jpeg") return "jpg";
    return /^(png|jpe?g|webp|gif|bmp|avif|svg)$/.test(sub) ? sub : "png";
  }
  try {
    const pathname = new URL(url).pathname.toLowerCase();
    const match = /\.(jpe?g|png|webp|gif|bmp|avif|svg)$/.exec(pathname);
    if (match) return match[1] === "jpeg" ? "jpg" : match[1];
  } catch {
    /* ignore */
  }
  return "jpg";
}

/** 去掉 Windows / chrome.downloads 不接受的文件名字符。 */
function safeFileName(input, maxLength) {
  let name = String(input || "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[<>:"/\\|?*]/g, "")
    .replace(/\s+/g, "_")
    .replace(/^[.\s]+|[.\s]+$/g, "")
    .slice(0, maxLength || 60);

  if (!name) name = "图片";
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(name)) name += "_";
  return name;
}

function cleanText(value, maxLength) {
  if (typeof value !== "string") return "";
  const text = value.replace(/\s+/g, " ").trim();
  return text.slice(0, maxLength || 200);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 向所有扩展页面（图库）广播进度；没有接收者时会 reject，忽略即可。 */
function broadcast(message) {
  try {
    const result = chrome.runtime.sendMessage(message);
    if (result && typeof result.catch === "function") result.catch(() => {});
  } catch {
    /* ignore */
  }
}
