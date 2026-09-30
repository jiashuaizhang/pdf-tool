"use strict";

const MAX_FILE_BYTES = 300 * 1024 * 1024;
const INVALID_NAME = /[\\/:*?"<>|\u0000-\u001f]/;
const RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

const state = {
  mode: "split",
  jobId: null,
  pages: [],
  filenameDirty: false,
  busy: false,
};

const stage = document.querySelector("#stage");
const picker = document.querySelector("#picker");
const addButton = document.querySelector("#add");
const selectAllButton = document.querySelector("#selectAll");
const invertButton = document.querySelector("#invert");
const clearButton = document.querySelector("#clear");
const confirmButton = document.querySelector("#confirm");
const previewZoomOut = document.querySelector("#previewZoomOut");
const previewZoomIn = document.querySelector("#previewZoomIn");
const countLabel = document.querySelector("#count");
const filenameBox = document.querySelector("#filenameBox");
const stemInput = document.querySelector("#stem");
const toastEl = document.querySelector("#toast");
const busyEl = document.querySelector("#busy");
const lightbox = document.querySelector("#lightbox");
const lightboxBody = document.querySelector("#lightboxBody");
const lightboxCaption = document.querySelector("#lightboxCaption");
const lightboxClose = document.querySelector("#lightboxClose");
const cardTemplate = document.querySelector("#card-template");
const navButtons = [...document.querySelectorAll(".nav")];

const PREVIEW_SCALES = [0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3];
let previewScaleIndex = PREVIEW_SCALES.indexOf(1);
let previewWheel = 0;
let toastTimer = 0;
let previewToken = 0;
let dragDepth = 0;

function applyPreviewZoom() {
  previewZoomOut.disabled = previewScaleIndex === 0;
  previewZoomIn.disabled = previewScaleIndex === PREVIEW_SCALES.length - 1;
  const image = lightboxBody.querySelector("img");
  if (!image || !image.naturalWidth) return;
  const maxWidth = window.innerWidth - 96;
  const maxHeight = window.innerHeight - 180;
  const fit = Math.min(maxWidth / image.naturalWidth, maxHeight / image.naturalHeight);
  image.style.width = `${Math.round(image.naturalWidth * fit * PREVIEW_SCALES[previewScaleIndex])}px`;
  image.style.height = "auto";
}

function stepPreviewZoom(direction) {
  const next = Math.max(0, Math.min(PREVIEW_SCALES.length - 1, previewScaleIndex + direction));
  if (next === previewScaleIndex) return;
  previewScaleIndex = next;
  applyPreviewZoom();
}

function toast(message) {
  toastEl.textContent = message;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastEl.hidden = true;
  }, 4200);
}

function setBusy(text) {
  state.busy = Boolean(text);
  busyEl.hidden = !state.busy;
  busyEl.textContent = text || "";
  addButton.disabled = state.busy;
  updateChrome();
}

function stripPdf(name) {
  const base = String(name || "").split(/[/\\]/).pop() || "未命名";
  return base.replace(/\.pdf$/i, "");
}

function normalizeStem(raw) {
  let stem = String(raw || "").replace(/\u0000/g, "").trim();
  stem = stem.replace(/\.pdf$/i, "").trim();
  return stem.replace(/[. ]+$/g, "").trim();
}

function defaultStem() {
  if (state.mode === "merge") return "合并";
  if (!state.pages.length) return "";
  return `${stripPdf(state.pages[0].file)}-摘页`;
}

function setStem(value) {
  stemInput.value = value;
  stemInput.title = value;
  requestAnimationFrame(() => {
    stemInput.scrollLeft = stemInput.scrollWidth;
  });
}

function applyDefaultName() {
  if (state.filenameDirty) return;
  const next = defaultStem();
  if (stemInput.value !== next) setStem(next);
}

function selectedPages() {
  return state.pages.filter((page) => page.checked);
}

function updateChrome() {
  const hasPages = state.pages.length > 0;
  const selected = selectedPages().length;
  selectAllButton.hidden = !hasPages;
  invertButton.hidden = !hasPages;
  countLabel.hidden = !hasPages;
  filenameBox.hidden = !hasPages;
  clearButton.hidden = !hasPages;
  confirmButton.hidden = !hasPages;
  countLabel.textContent = `已选 ${selected} / ${state.pages.length}`;
  confirmButton.disabled = selected === 0 || state.busy;
  confirmButton.textContent = state.mode === "split"
    ? `生成摘页（${selected} 页）`
    : `生成合并文件（${selected} 页）`;
  picker.multiple = state.mode === "merge";
  for (const button of navButtons) {
    button.classList.toggle("is-active", button.dataset.mode === state.mode);
  }
}

function emptyView() {
  const wrap = document.createElement("div");
  wrap.className = "empty";
  const title = state.mode === "split" ? "拆分 PDF" : "合并 PDF";
  const description = state.mode === "split"
    ? "选择一个 PDF，勾选要保留的页面，再生成新文件。"
    : "选择多个 PDF，勾选要保留的页面，按当前顺序合并。";
  wrap.innerHTML = `
    <div class="doc-icon"></div>
    <h2>${title}</h2>
    <p>${description}</p>
    <p class="hint">也可以把 PDF 拖到这里。文件只在本机处理。</p>
    <button type="button" class="btn add" data-action="browse">选择文件</button>
  `;
  return wrap;
}

function syncCard(card, page) {
  card.classList.toggle("is-on", page.checked);
  card.classList.toggle("is-off", !page.checked);
}

function cardView(page) {
  const card = cardTemplate.content.firstElementChild.cloneNode(true);
  card.dataset.id = String(page.id);
  syncCard(card, page);
  const input = card.querySelector("input");
  input.checked = page.checked;
  input.setAttribute("aria-label", `选择第 ${page.page} 页`);
  const image = card.querySelector("img");
  image.alt = `第 ${page.page} 页`;
  image.loading = "lazy";
  image.src = `/api/jobs/${state.jobId}/pages/${page.id}/thumb`;
  image.addEventListener("error", () => {
    const failed = document.createElement("span");
    failed.className = "thumb-fail";
    failed.textContent = "无法预览";
    image.replaceWith(failed);
  });
  const file = card.querySelector(".file");
  file.textContent = page.file;
  file.title = page.file;
  const number = card.querySelector(".num");
  number.textContent = String(page.page);
  number.title = `第 ${page.page} 页`;
  return card;
}

function render() {
  applyDefaultName();
  updateChrome();
  stage.replaceChildren();
  if (!state.pages.length) {
    stage.append(emptyView());
    return;
  }
  const grid = document.createElement("div");
  grid.className = "grid";
  for (const page of state.pages) grid.append(cardView(page));
  stage.append(grid);
}

async function readError(response) {
  try {
    const data = await response.json();
    if (typeof data.detail === "string") return data.detail;
  } catch (_error) {
    /* 响应体不是 JSON 时使用下面的通用提示。 */
  }
  return `操作失败（${response.status}）`;
}

async function apiCreate(files) {
  const body = new FormData();
  for (const file of files) body.append("files", file);
  const response = await fetch("/api/jobs", { method: "POST", body });
  if (!response.ok) throw new Error(await readError(response));
  return response.json();
}

async function apiAppend(jobId, files) {
  const body = new FormData();
  for (const file of files) body.append("files", file);
  const response = await fetch(`/api/jobs/${jobId}/files`, { method: "POST", body });
  if (!response.ok) throw new Error(await readError(response));
  return response.json();
}

async function apiDelete(jobId) {
  const response = await fetch(`/api/jobs/${jobId}`, { method: "DELETE" });
  if (!response.ok) throw new Error(await readError(response));
}

function closeLightbox() {
  previewToken += 1;
  previewWheel = 0;
  lightbox.hidden = true;
  lightboxBody.replaceChildren();
  document.body.classList.remove("preview-open");
}

function openPreview(page) {
  if (!state.jobId) return;
  const token = ++previewToken;
  previewScaleIndex = PREVIEW_SCALES.indexOf(1);
  previewWheel = 0;
  applyPreviewZoom();
  lightbox.hidden = false;
  document.body.classList.add("preview-open");
  lightboxCaption.textContent = `${page.file} · 第 ${page.page} 页`;
  lightboxBody.textContent = "正在加载预览…";
  lightboxClose.focus();
  const image = new Image();
  image.alt = lightboxCaption.textContent;
  image.onload = () => {
    if (token !== previewToken) return;
    lightboxBody.replaceChildren(image);
    applyPreviewZoom();
  };
  image.onerror = () => {
    if (token !== previewToken) return;
    lightboxBody.textContent = "预览加载失败";
  };
  image.src = `/api/jobs/${state.jobId}/pages/${page.id}/preview`;
}

async function clearJob() {
  const jobId = state.jobId;
  state.jobId = null;
  state.pages = [];
  state.filenameDirty = false;
  closeLightbox();
  if (!jobId) return;
  try {
    await apiDelete(jobId);
  } catch (error) {
    console.error(error);
  }
}

async function uploadNew(files) {
  const data = await apiCreate(files);
  const previousId = state.jobId;
  state.jobId = data.id;
  state.pages = data.pages.map((page) => ({ ...page, checked: true }));
  if (previousId) {
    try {
      await apiDelete(previousId);
    } catch (error) {
      console.error(error);
    }
  }
}

async function appendFiles(files) {
  const data = await apiAppend(state.jobId, files);
  const checked = new Map(state.pages.map((page) => [page.id, page.checked]));
  state.pages = data.pages.map((page) => ({
    ...page,
    checked: checked.has(page.id) ? checked.get(page.id) : true,
  }));
}

function pdfFiles(fileList) {
  return [...fileList].filter((file) => /\.pdf$/i.test(file.name) || file.type === "application/pdf");
}

async function addFiles(fileList) {
  if (state.busy) return;
  const files = pdfFiles(fileList);
  if (!files.length) {
    toast("请选择 PDF 文件");
    return;
  }
  if (files.some((file) => file.size > MAX_FILE_BYTES)) {
    toast("单个文件不能超过 300MB");
    return;
  }
  if (state.mode === "split" && files.length > 1) {
    toast("拆分一次只能选择一个文件，已使用第一个");
  }
  const chosen = state.mode === "split" ? [files[0]] : files;
  if (state.mode === "split" && state.pages.length) {
    const ok = confirm("重新选择文件会替换当前预览，是否继续？");
    if (!ok) return;
  }
  setBusy("正在读取 PDF…");
  try {
    if (state.mode === "split" || !state.jobId) await uploadNew(chosen);
    else await appendFiles(chosen);
    if (state.mode === "split") state.filenameDirty = false;
    render();
  } catch (error) {
    console.error(error);
    toast(error.message || "读取失败");
  } finally {
    setBusy("");
  }
}

async function removePage(id) {
  state.pages = state.pages.filter((page) => page.id !== id);
  if (!state.pages.length) await clearJob();
  render();
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

async function exportPdf() {
  if (state.busy || !state.jobId) return;
  const stem = normalizeStem(stemInput.value);
  setStem(stem);
  if (!stem) {
    stemInput.classList.add("invalid");
    stemInput.focus();
    toast("请填写文件名");
    return;
  }
  if (stem.length > 180 || INVALID_NAME.test(stem) || RESERVED_NAME.test(stem)) {
    stemInput.classList.add("invalid");
    stemInput.focus();
    toast('文件名不能包含 \\ / : * ? " < > |');
    return;
  }
  const pageIds = selectedPages().map((page) => page.id);
  if (!pageIds.length) {
    toast("请至少选择一页");
    return;
  }
  closeLightbox();
  setBusy("正在生成 PDF…");
  try {
    const response = await fetch(`/api/jobs/${state.jobId}/export`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ page_ids: pageIds, filename: stem }),
    });
    if (!response.ok) throw new Error(await readError(response));
    downloadBlob(await response.blob(), `${stem}.pdf`);
  } catch (error) {
    console.error(error);
    toast(error.message || "生成失败");
  } finally {
    setBusy("");
  }
}

async function setMode(mode) {
  if (mode === state.mode || state.busy) return;
  if (state.pages.length) {
    const ok = confirm("切换功能会清空当前页面，是否继续？");
    if (!ok) return;
  }
  await clearJob();
  state.mode = mode;
  render();
}

function pageFromCard(card) {
  return state.pages.find((page) => page.id === Number(card.dataset.id));
}

stage.addEventListener("click", (event) => {
  if (event.target.closest("[data-action='browse']")) {
    picker.click();
    return;
  }
  const card = event.target.closest(".card");
  if (!card) return;
  const page = pageFromCard(card);
  if (!page) return;
  if (event.target.closest("[data-action='zoom']")) {
    openPreview(page);
    return;
  }
  if (event.target.closest("[data-action='delete']")) {
    removePage(page.id);
    return;
  }
  if (event.target.closest("input, .check")) return;
  const input = card.querySelector("input");
  input.checked = !input.checked;
  page.checked = input.checked;
  syncCard(card, page);
  updateChrome();
});

stage.addEventListener("change", (event) => {
  if (event.target.type !== "checkbox") return;
  const card = event.target.closest(".card");
  if (!card) return;
  const page = pageFromCard(card);
  if (!page) return;
  page.checked = event.target.checked;
  syncCard(card, page);
  updateChrome();
});

addButton.addEventListener("click", () => picker.click());
selectAllButton.addEventListener("click", () => {
  state.pages.forEach((page) => { page.checked = true; });
  render();
});
invertButton.addEventListener("click", () => {
  state.pages.forEach((page) => { page.checked = !page.checked; });
  render();
});
clearButton.addEventListener("click", async () => {
  if (state.busy) return;
  await clearJob();
  render();
});
confirmButton.addEventListener("click", exportPdf);
previewZoomOut.addEventListener("click", () => stepPreviewZoom(-1));
previewZoomIn.addEventListener("click", () => stepPreviewZoom(1));
lightbox.addEventListener("wheel", (event) => {
  if (lightbox.hidden || !event.deltaY || !event.ctrlKey) {
    previewWheel = 0;
    return;
  }
  event.preventDefault();
  previewWheel += event.deltaY;
  if (Math.abs(previewWheel) < 60) return;
  const direction = previewWheel > 0 ? -1 : 1;
  previewWheel = 0;
  stepPreviewZoom(direction);
}, { passive: false });
window.addEventListener("resize", () => {
  if (!lightbox.hidden) applyPreviewZoom();
});
navButtons.forEach((button) => {
  button.addEventListener("click", () => setMode(button.dataset.mode));
});
picker.addEventListener("change", () => {
  if (picker.files.length) addFiles(picker.files);
  picker.value = "";
});
stemInput.addEventListener("input", () => {
  state.filenameDirty = true;
  stemInput.classList.remove("invalid");
  stemInput.title = stemInput.value;
});
stemInput.addEventListener("blur", () => {
  setStem(normalizeStem(stemInput.value));
});
stemInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    exportPdf();
  }
});
lightboxClose.addEventListener("click", closeLightbox);
document.querySelector(".lightbox-backdrop").addEventListener("click", closeLightbox);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !lightbox.hidden) closeLightbox();
});

document.addEventListener("dragenter", (event) => {
  if (!event.dataTransfer || ![...event.dataTransfer.types].includes("Files")) return;
  event.preventDefault();
  dragDepth += 1;
  stage.classList.add("is-drag");
});
document.addEventListener("dragover", (event) => {
  if (!event.dataTransfer) return;
  event.preventDefault();
});
document.addEventListener("dragleave", () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) stage.classList.remove("is-drag");
});
document.addEventListener("drop", (event) => {
  event.preventDefault();
  dragDepth = 0;
  stage.classList.remove("is-drag");
  if (event.dataTransfer && event.dataTransfer.files.length) addFiles(event.dataTransfer.files);
});

render();
