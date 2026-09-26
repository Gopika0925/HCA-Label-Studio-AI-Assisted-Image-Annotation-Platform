/**
 * script.js — HCA Label Studio Frontend Logic
 * ============================================================
 * Handles:
 *  - Image upload via Fetch API
 *  - Canvas-based bounding-box rendering + interaction
 *  - Human-in-the-loop editing (move, resize, relabel, delete, add)
 *  - Saving annotations to backend
 *  - Gallery & retrain panels
 */

"use strict";

/* ══════════════════════════════════════════════════════════════════════════
   STATE
   ══════════════════════════════════════════════════════════════════════════ */
const state = {
  imageFile: null,   // original File object
  filename: null,   // server-assigned unique filename
  imageURL: null,   // URL to display
  imgEl: null,   // HTMLImageElement loaded on canvas
  annotations: [],     // [ { id, label, x, y, width, height, confidence } ]
  selectedId: null,
  originalLabel: "",     // AI label before human correction
  currentTool: "select",  // 'select' | 'draw'
  drawStart: null,   // { x, y } canvas-relative coords
  dragState: null,   // { type: 'move'|'resize', startX, startY, ann, handle }
  scaleX: 1,      // image → canvas scale
  scaleY: 1,
};

/* ══════════════════════════════════════════════════════════════════════════
   DOM REFS
   ══════════════════════════════════════════════════════════════════════════ */
const canvas = document.getElementById("annotationCanvas");
const ctx = canvas.getContext("2d");
const workspace = document.getElementById("workspace");
const uploadZone = document.getElementById("uploadZone");

/* ══════════════════════════════════════════════════════════════════════════
   INIT
   ══════════════════════════════════════════════════════════════════════════ */
(() => {
  // Health check
  fetch("/health")
    .then(r => r.json())
    .then(d => setStatus(true, `Model: ${d.model}`))
    .catch(() => setStatus(false, "Server offline"));

  // File input change
  document.getElementById("imageInput").addEventListener("change", e => {
    const file = e.target.files[0];
    if (file) handleFileSelected(file);
  });

  // Drag-and-drop on upload zone
  uploadZone.addEventListener("dragover", e => { e.preventDefault(); uploadZone.classList.add("drag-over"); });
  uploadZone.addEventListener("dragleave", () => uploadZone.classList.remove("drag-over"));
  uploadZone.addEventListener("drop", e => {
    e.preventDefault();
    uploadZone.classList.remove("drag-over");
    const file = e.dataTransfer.files[0];
    if (file) handleFileSelected(file);
  });
  uploadZone.addEventListener("click", () => document.getElementById("imageInput").click());

  // Canvas events
  canvas.addEventListener("mousedown", onCanvasMouseDown);
  canvas.addEventListener("mousemove", onCanvasMouseMove);
  canvas.addEventListener("mouseup", onCanvasMouseUp);
  canvas.addEventListener("mouseleave", onCanvasMouseUp);

  // Canvas touch support (mobile)
  canvas.addEventListener("touchstart", e => onCanvasMouseDown(touchToMouse(e)), { passive: false });
  canvas.addEventListener("touchmove", e => onCanvasMouseMove(touchToMouse(e)), { passive: false });
  canvas.addEventListener("touchend", e => onCanvasMouseUp(touchToMouse(e)), { passive: false });

  setStatus(false, "Checking…");
})();

/* ══════════════════════════════════════════════════════════════════════════
   PANEL NAVIGATION
   ══════════════════════════════════════════════════════════════════════════ */
function showPanel(name) {
  document.querySelectorAll(".panel").forEach(p => p.classList.remove("active"));
  document.querySelectorAll(".nav-item").forEach(n => n.classList.remove("active"));
  document.getElementById(`panel-${name}`).classList.add("active");
  document.getElementById(`nav-${name}`).classList.add("active");

  if (name === "gallery") loadGallery();
}

/* ══════════════════════════════════════════════════════════════════════════
   STATUS INDICATOR
   ══════════════════════════════════════════════════════════════════════════ */
function setStatus(online, text) {
  const dot = document.getElementById("statusDot");
  const span = document.getElementById("statusText");
  dot.className = "status-dot " + (online ? "online" : "offline");
  span.textContent = text || (online ? "Online" : "Offline");
}

/* ══════════════════════════════════════════════════════════════════════════
   FILE SELECTION & UPLOAD
   ══════════════════════════════════════════════════════════════════════════ */
async function handleFileSelected(file) {
  if (!file.type.startsWith("image/")) {
    showToast("Please select a valid image file.", "error");
    return;
  }

  state.imageFile = file;
  showLoader("Uploading & detecting objects…");

  try {
    const formData = new FormData();
    formData.append("image", file);

    const res = await fetch("/upload", { method: "POST", body: formData });
    const data = await res.json();

    if (!res.ok) throw new Error(data.error || "Upload failed");

    state.filename = data.filename;
    state.imageURL = data.image_url;
    state.originalLabel = data.detections.map(d => d.label).join(", ");

    // Clear previous state
    state.annotations = [];
    state.selectedId = null;

    // Add ALL YOLO detections as separate bounding boxes
    data.detections.forEach(det => {
      addAnnotation({
        label: det.label,
        x: det.bbox.x,
        y: det.bbox.y,
        width: det.bbox.width,
        height: det.bbox.height,
        confidence: det.confidence,
      });
    });

    // Update detection list card
    updateDetectionsCard(data.detections);

    // Load image onto canvas
    await loadImageOnCanvas(data.image_url);

    // Show workspace
    uploadZone.style.display = "none";
    workspace.style.display = "grid";
    document.getElementById("annListCard").style.display = "block";

    showToast(`✅ Detected ${data.detections.length} object(s)!`, "success");
  } catch (err) {
    showToast("Error: " + err.message, "error");
    console.error(err);
  } finally {
    hideLoader();
  }
}

/* ── Re-predict without re-uploading ─────────────────────────────────────── */
async function predictImage() {
  if (!state.filename) {
    showToast("Upload an image first.", "info");
    return;
  }
  showLoader("Re-running detection…");
  try {
    const formData = new FormData();
    formData.append("image", state.imageFile);
    const res = await fetch("/upload", { method: "POST", body: formData });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Detect failed");

    state.originalLabel = data.detections.map(d => d.label).join(", ");
    updateDetectionsCard(data.detections);

    // Replace annotations with new detections
    state.annotations = [];
    data.detections.forEach(det => {
      addAnnotation({
        label: det.label,
        x: det.bbox.x,
        y: det.bbox.y,
        width: det.bbox.width,
        height: det.bbox.height,
        confidence: det.confidence,
      });
    });
    renderCanvas();
    renderAnnotationList();
    showToast(`Re-detected ${data.detections.length} object(s)!`, "success");
  } catch (err) {
    showToast("Error: " + err.message, "error");
  } finally {
    hideLoader();
  }
}

/* ══════════════════════════════════════════════════════════════════════════
   CANVAS IMAGE LOADING
   ══════════════════════════════════════════════════════════════════════════ */
function loadImageOnCanvas(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      state.imgEl = img;

      // Fit inside the canvas wrapper
      const wrapper = document.getElementById("canvasWrapper");
      const maxW = wrapper.clientWidth || 700;
      const maxH = 520;
      const scale = Math.min(maxW / img.naturalWidth, maxH / img.naturalHeight, 1);

      canvas.width = Math.round(img.naturalWidth * scale);
      canvas.height = Math.round(img.naturalHeight * scale);

      state.scaleX = scale;
      state.scaleY = scale;

      document.getElementById("canvasInfo").textContent =
        `${img.naturalWidth}×${img.naturalHeight}px — Click boxes to select, ✏️ to draw new`;

      renderCanvas();
      resolve();
    };
    img.onerror = reject;
    img.src = url;
  });
}

/* ══════════════════════════════════════════════════════════════════════════
   CANVAS RENDERING
   ══════════════════════════════════════════════════════════════════════════ */
const BOX_COLORS = ["#6366f1", "#22d3a5", "#f59e0b", "#ef4444", "#a855f7", "#06b6d4"];
const HANDLE_SIZE = 8;

function renderCanvas() {
  if (!state.imgEl) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(state.imgEl, 0, 0, canvas.width, canvas.height);

  state.annotations.forEach((ann, i) => {
    const sx = ann.x * state.scaleX;
    const sy = ann.y * state.scaleY;
    const sw = ann.width * state.scaleX;
    const sh = ann.height * state.scaleY;
    const isSelected = ann.id === state.selectedId;
    const color = BOX_COLORS[i % BOX_COLORS.length];

    // Box fill (semi-transparent when selected)
    ctx.fillStyle = isSelected ? color + "25" : color + "15";
    ctx.fillRect(sx, sy, sw, sh);

    // Box stroke
    ctx.strokeStyle = color;
    ctx.lineWidth = isSelected ? 2.5 : 1.5;
    ctx.setLineDash(isSelected ? [] : [5, 3]);
    ctx.strokeRect(sx, sy, sw, sh);
    ctx.setLineDash([]);

    // Label chip
    drawLabelChip(sx, sy, ann.label, ann.confidence, color);

    // Resize handles (only when selected)
    if (isSelected) {
      drawHandles(sx, sy, sw, sh, color);
    }
  });
}

function drawLabelChip(x, y, label, conf, color) {
  const text = `${label} (${(conf * 100).toFixed(0)}%)`;
  const pad = 6;
  const fh = 12;
  ctx.font = `600 ${fh}px Inter, sans-serif`;
  const tw = ctx.measureText(text).width;
  const bx = x;
  const by = y - fh - pad * 2 - 2;
  const bw = tw + pad * 2;
  const bh = fh + pad * 2;

  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.roundRect(bx, by, bw, bh, 4);
  ctx.fill();

  ctx.fillStyle = "#ffffff";
  ctx.fillText(text, bx + pad, by + pad + fh - 2);
}

function drawHandles(sx, sy, sw, sh, color) {
  const hsize = HANDLE_SIZE;
  const handles = getHandlePositions(sx, sy, sw, sh);
  handles.forEach(h => {
    ctx.fillStyle = "#fff";
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.roundRect(h.x - hsize / 2, h.y - hsize / 2, hsize, hsize, 2);
    ctx.fill();
    ctx.stroke();
  });
}

function getHandlePositions(sx, sy, sw, sh) {
  return [
    { x: sx, y: sy, name: "nw" },
    { x: sx + sw / 2, y: sy, name: "n" },
    { x: sx + sw, y: sy, name: "ne" },
    { x: sx + sw, y: sy + sh / 2, name: "e" },
    { x: sx + sw, y: sy + sh, name: "se" },
    { x: sx + sw / 2, y: sy + sh, name: "s" },
    { x: sx, y: sy + sh, name: "sw" },
    { x: sx, y: sy + sh / 2, name: "w" },
  ];
}

/* ══════════════════════════════════════════════════════════════════════════
   CANVAS MOUSE EVENTS
   ══════════════════════════════════════════════════════════════════════════ */
function getCanvasPos(e) {
  const rect = canvas.getBoundingClientRect();
  const scX = canvas.width / rect.width;
  const scY = canvas.height / rect.height;
  return {
    x: (e.clientX - rect.left) * scX,
    y: (e.clientY - rect.top) * scY,
  };
}

function onCanvasMouseDown(e) {
  if (!state.imgEl) return;
  const pos = getCanvasPos(e);

  if (state.currentTool === "draw") {
    state.drawStart = pos;
    return;
  }

  // Check handles first (resize)
  if (state.selectedId !== null) {
    const ann = state.annotations.find(a => a.id === state.selectedId);
    if (ann) {
      const sx = ann.x * state.scaleX, sy = ann.y * state.scaleY;
      const sw = ann.width * state.scaleX, sh = ann.height * state.scaleY;
      const handles = getHandlePositions(sx, sy, sw, sh);
      for (const h of handles) {
        if (Math.abs(pos.x - h.x) < HANDLE_SIZE && Math.abs(pos.y - h.y) < HANDLE_SIZE) {
          state.dragState = {
            type: "resize", handle: h.name, ann, startX: pos.x, startY: pos.y,
            origX: ann.x, origY: ann.y, origW: ann.width, origH: ann.height
          };
          return;
        }
      }
    }
  }

  // Check if clicking inside a box (select + move)
  for (let i = state.annotations.length - 1; i >= 0; i--) {
    const ann = state.annotations[i];
    const sx = ann.x * state.scaleX, sy = ann.y * state.scaleY;
    const sw = ann.width * state.scaleX, sh = ann.height * state.scaleY;
    if (pos.x >= sx && pos.x <= sx + sw && pos.y >= sy && pos.y <= sy + sh) {
      state.selectedId = ann.id;
      state.dragState = {
        type: "move", ann, startX: pos.x, startY: pos.y,
        origX: ann.x, origY: ann.y
      };
      renderCanvas();
      renderAnnotationList();
      renderEditor(ann);
      return;
    }
  }

  // Clicked empty area — deselect
  state.selectedId = null;
  state.dragState = null;
  renderCanvas();
  renderAnnotationList();
  clearEditor();
}

function onCanvasMouseMove(e) {
  if (!state.imgEl) return;
  const pos = getCanvasPos(e);

  if (state.currentTool === "draw" && state.drawStart) {
    // Preview new box
    renderCanvas();
    const x = Math.min(pos.x, state.drawStart.x);
    const y = Math.min(pos.y, state.drawStart.y);
    const w = Math.abs(pos.x - state.drawStart.x);
    const h = Math.abs(pos.y - state.drawStart.y);
    ctx.strokeStyle = "#6366f1";
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 3]);
    ctx.strokeRect(x, y, w, h);
    ctx.setLineDash([]);
    return;
  }

  if (!state.dragState) return;
  const ds = state.dragState;
  const dx = (pos.x - ds.startX) / state.scaleX;
  const dy = (pos.y - ds.startY) / state.scaleY;

  if (ds.type === "move") {
    ds.ann.x = Math.max(0, ds.origX + dx);
    ds.ann.y = Math.max(0, ds.origY + dy);
  } else if (ds.type === "resize") {
    applyResize(ds, dx, dy);
  }

  renderCanvas();
  if (state.selectedId === ds.ann.id) renderEditor(ds.ann);
}

function onCanvasMouseUp(e) {
  if (!state.imgEl) return;
  const pos = getCanvasPos(e);

  if (state.currentTool === "draw" && state.drawStart) {
    const x = Math.min(pos.x, state.drawStart.x) / state.scaleX;
    const y = Math.min(pos.y, state.drawStart.y) / state.scaleY;
    const w = Math.abs(pos.x - state.drawStart.x) / state.scaleX;
    const h = Math.abs(pos.y - state.drawStart.y) / state.scaleY;
    if (w > 10 && h > 10) {
      addAnnotation({ label: "New Object", x, y, width: w, height: h, confidence: 1.0 });
    }
    state.drawStart = null;
    renderCanvas();
    renderAnnotationList();
    return;
  }

  state.dragState = null;
  renderAnnotationList();
}

/* ── Resize helper ───────────────────────────────────────────────────────── */
function applyResize(ds, dx, dy) {
  const { ann, handle, origX, origY, origW, origH } = ds;
  const minSize = 10;
  switch (handle) {
    case "se": ann.width = Math.max(minSize, origW + dx); ann.height = Math.max(minSize, origH + dy); break;
    case "sw": ann.x = origX + dx; ann.width = Math.max(minSize, origW - dx); ann.height = Math.max(minSize, origH + dy); break;
    case "ne": ann.width = Math.max(minSize, origW + dx); ann.y = origY + dy; ann.height = Math.max(minSize, origH - dy); break;
    case "nw": ann.x = origX + dx; ann.y = origY + dy; ann.width = Math.max(minSize, origW - dx); ann.height = Math.max(minSize, origH - dy); break;
    case "n": ann.y = origY + dy; ann.height = Math.max(minSize, origH - dy); break;
    case "s": ann.height = Math.max(minSize, origH + dy); break;
    case "e": ann.width = Math.max(minSize, origW + dx); break;
    case "w": ann.x = origX + dx; ann.width = Math.max(minSize, origW - dx); break;
  }
}

/* ══════════════════════════════════════════════════════════════════════════
   ANNOTATION MANAGEMENT
   ══════════════════════════════════════════════════════════════════════════ */
let _annIdCounter = 0;
function addAnnotation(data) {
  const ann = { id: ++_annIdCounter, ...data };
  state.annotations.push(ann);
  state.selectedId = ann.id;
  renderAnnotationList();
  if (state.imgEl) renderCanvas();
  renderEditor(ann);
  return ann;
}

function deleteSelected() {
  if (state.selectedId === null) { showToast("Select a box first.", "info"); return; }
  state.annotations = state.annotations.filter(a => a.id !== state.selectedId);
  state.selectedId = null;
  renderCanvas();
  renderAnnotationList();
  clearEditor();
}

function deleteAnnotation(id) {
  state.annotations = state.annotations.filter(a => a.id !== id);
  if (state.selectedId === id) { state.selectedId = null; clearEditor(); }
  renderCanvas();
  renderAnnotationList();
}

function focusAnnotation(id) {
  state.selectedId = id;
  const ann = state.annotations.find(a => a.id === id);
  renderCanvas();
  renderAnnotationList();
  if (ann) renderEditor(ann);
}

/* ══════════════════════════════════════════════════════════════════════════
   ANNOTATION LIST
   ══════════════════════════════════════════════════════════════════════════ */
function renderAnnotationList() {
  const body = document.getElementById("annListBody");
  const count = document.getElementById("annCount");

  count.textContent = state.annotations.length;
  body.innerHTML = "";

  if (state.annotations.length === 0) {
    body.innerHTML = `<p class="editor-hint" style="padding:12px 0">No annotations yet. Draw boxes or let the AI predict.</p>`;
    return;
  }

  state.annotations.forEach((ann, i) => {
    const isSelected = ann.id === state.selectedId;
    const color = BOX_COLORS[i % BOX_COLORS.length];
    const item = document.createElement("div");
    item.className = "ann-item" + (isSelected ? " selected" : "");
    item.style.borderLeftColor = color;
    item.style.borderLeftWidth = "3px";
    item.innerHTML = `
      <div>
        <span class="ann-label">${escHtml(ann.label)}</span>
        <span class="ann-coords">  x:${Math.round(ann.x)} y:${Math.round(ann.y)} w:${Math.round(ann.width)} h:${Math.round(ann.height)}</span>
      </div>
      <div style="display:flex;align-items:center;gap:8px">
        <span class="ann-conf">${(ann.confidence * 100).toFixed(0)}%</span>
        <div class="ann-actions">
          <button class="ann-btn" onclick="focusAnnotation(${ann.id})">✏️</button>
          <button class="ann-btn ann-del" onclick="deleteAnnotation(${ann.id})">🗑️</button>
        </div>
      </div>
    `;
    body.appendChild(item);
  });
}

/* ══════════════════════════════════════════════════════════════════════════
   EDITOR PANEL
   ══════════════════════════════════════════════════════════════════════════ */
function renderEditor(ann) {
  const body = document.getElementById("editorBody");
  body.innerHTML = `
    <div class="editor-field">
      <label>Label</label>
      <input id="editLabel" type="text" value="${escHtml(ann.label)}" oninput="updateAnnField(${ann.id},'label',this.value)" />
    </div>
    <div class="editor-coords">
      <div class="editor-field">
        <label>X</label>
        <input id="editX" type="number" value="${Math.round(ann.x)}" oninput="updateAnnField(${ann.id},'x',+this.value)" />
      </div>
      <div class="editor-field">
        <label>Y</label>
        <input id="editY" type="number" value="${Math.round(ann.y)}" oninput="updateAnnField(${ann.id},'y',+this.value)" />
      </div>
      <div class="editor-field">
        <label>Width</label>
        <input id="editW" type="number" value="${Math.round(ann.width)}" oninput="updateAnnField(${ann.id},'width',+this.value)" />
      </div>
      <div class="editor-field">
        <label>Height</label>
        <input id="editH" type="number" value="${Math.round(ann.height)}" oninput="updateAnnField(${ann.id},'height',+this.value)" />
      </div>
    </div>
    <div class="editor-field">
      <label>Confidence</label>
      <input id="editConf" type="number" step="0.01" min="0" max="1" value="${ann.confidence.toFixed(2)}" oninput="updateAnnField(${ann.id},'confidence',+this.value)" />
    </div>
  `;
}

function clearEditor() {
  document.getElementById("editorBody").innerHTML =
    `<p class="editor-hint">Select a bounding box on the canvas to edit it here.</p>`;
}

function updateAnnField(id, field, value) {
  const ann = state.annotations.find(a => a.id === id);
  if (!ann) return;
  ann[field] = value;
  renderCanvas();
  renderAnnotationList();
}

/* ══════════════════════════════════════════════════════════════════════════
   MULTI-DETECTION CARD
   ══════════════════════════════════════════════════════════════════════════ */
function updateDetectionsCard(detections) {
  const ui = document.getElementById("detectionsListUI");
  const badge = document.getElementById("confBadge");

  badge.textContent = `${detections.length} obj`;
  badge.className = "badge " + (detections.length > 0 ? "high" : "low");

  if (!detections || detections.length === 0) {
    ui.innerHTML = `<p class="editor-hint">No objects detected.</p>`;
    return;
  }

  ui.innerHTML = detections.map((det, i) => {
    const color = BOX_COLORS[i % BOX_COLORS.length];
    const pct = Math.round(det.confidence * 100);
    return `
      <div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--border)">
        <span style="width:10px;height:10px;border-radius:50%;background:${color};flex-shrink:0"></span>
        <div style="flex:1;min-width:0">
          <div style="font-weight:600;font-size:0.82rem;color:var(--text-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escHtml(det.label)}</div>
          <div style="height:4px;background:var(--bg-tertiary);border-radius:2px;margin-top:3px">
            <div style="height:100%;width:${pct}%;background:${color};border-radius:2px;transition:width 0.4s"></div>
          </div>
        </div>
        <span style="font-size:0.75rem;color:var(--text-muted);flex-shrink:0">${pct}%</span>
      </div>
    `;
  }).join("");
}

/* ══════════════════════════════════════════════════════════════════════════
   SAVE ANNOTATION
   ══════════════════════════════════════════════════════════════════════════ */
async function saveAnnotation() {
  if (!state.filename) { showToast("Upload an image first.", "info"); return; }
  if (state.annotations.length === 0) { showToast("Add at least one annotation.", "info"); return; }

  const reviewer = document.getElementById("reviewerInput").value.trim() || "anonymous";
  showLoader("Saving annotation…");

  try {
    const payload = {
      image_name: state.filename,
      reviewed_by: reviewer,
      original_label: state.originalLabel,
      annotations: state.annotations.map(a => ({
        label: a.label,
        x: Math.round(a.x),
        y: Math.round(a.y),
        width: Math.round(a.width),
        height: Math.round(a.height),
        confidence: a.confidence,
      })),
    };

    const res = await fetch("/save_annotation", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json();

    if (!res.ok) throw new Error(data.error || "Save failed");

    showToast("✅ " + data.message, "success");
  } catch (err) {
    showToast("Error: " + err.message, "error");
    console.error(err);
  } finally {
    hideLoader();
  }
}

/* ══════════════════════════════════════════════════════════════════════════
   CLEAR WORKSPACE
   ══════════════════════════════════════════════════════════════════════════ */
function clearWorkspace() {
  state.imageFile = null;
  state.filename = null;
  state.imageURL = null;
  state.imgEl = null;
  state.annotations = [];
  state.selectedId = null;
  state.originalLabel = "";
  state.dragState = null;
  state.drawStart = null;

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  canvas.width = 0; canvas.height = 0;

  workspace.style.display = "none";
  uploadZone.style.display = "block";
  document.getElementById("annListCard").style.display = "none";
  document.getElementById("imageInput").value = "";

  // Reset detection card
  document.getElementById("detectionsListUI").innerHTML =
    `<p class="editor-hint">Upload an image to see detections.</p>`;
  document.getElementById("confBadge").textContent = "—";
  clearEditor();
  renderAnnotationList();
}

/* ══════════════════════════════════════════════════════════════════════════
   TOOL SELECTION
   ══════════════════════════════════════════════════════════════════════════ */
function setTool(tool) {
  state.currentTool = tool;
  document.getElementById("toolSelect").classList.toggle("active", tool === "select");
  document.getElementById("toolDraw").classList.toggle("active", tool === "draw");
  canvas.style.cursor = tool === "draw" ? "crosshair" : "default";
}

/* ══════════════════════════════════════════════════════════════════════════
   GALLERY PANEL
   ══════════════════════════════════════════════════════════════════════════ */
async function loadGallery() {
  const body = document.getElementById("galleryBody");
  body.innerHTML = `<p class="editor-hint" style="padding:16px 0">Loading…</p>`;

  try {
    const res = await fetch("/annotations");
    const data = await res.json();

    if (data.length === 0) {
      body.innerHTML = `<p class="empty-state">No annotations saved yet.</p>`;
      return;
    }

    body.innerHTML = "";
    data.reverse().forEach(rec => {
      const labels = [...new Set(rec.annotations.map(a => a.label))];
      const div = document.createElement("div");
      div.className = "gallery-item";
      div.innerHTML = `
        <div class="gallery-item-header">
          <span class="gallery-filename">${escHtml(rec.image_name)}</span>
          <span class="gallery-time">${formatDate(rec.timestamp)}</span>
        </div>
        <div style="font-size:0.78rem;color:var(--text-muted);margin-bottom:8px">
          Reviewed by <strong style="color:var(--text-secondary)">${escHtml(rec.reviewed_by)}</strong>
          · ${rec.annotations.length} box(es)
        </div>
        <div class="gallery-tags">
          ${labels.map(l => `<span class="gallery-tag">${escHtml(l)}</span>`).join("")}
        </div>
      `;
      body.appendChild(div);
    });
  } catch (err) {
    body.innerHTML = `<p class="empty-state">Could not load annotations: ${err.message}</p>`;
  }
}

/* ══════════════════════════════════════════════════════════════════════════
   RETRAIN
   ══════════════════════════════════════════════════════════════════════════ */
async function retrainModel() {
  const btn = document.getElementById("retrainBtn");
  const result = document.getElementById("retrainResult");
  btn.disabled = true;
  btn.textContent = "⏳ Retraining…";
  result.style.display = "none";
  showLoader("Simulating retraining…");

  try {
    const res = await fetch("/retrain", { method: "POST" });
    const data = await res.json();

    result.style.display = "block";
    result.innerHTML = `
      <h3 style="color:var(--success);margin-bottom:8px">✅ Retraining Complete</h3>
      <p>${data.message}</p>
      <p style="margin-top:8px">
        Simulated accuracy: <strong style="color:var(--primary)">${(data.accuracy * 100).toFixed(1)}%</strong>
      </p>
    `;
    showToast("Model retrained (simulated)!", "success");
  } catch (err) {
    result.style.display = "block";
    result.innerHTML = `<p style="color:var(--danger)">Error: ${err.message}</p>`;
  } finally {
    btn.disabled = false;
    btn.textContent = "🔄 Start Retraining";
    hideLoader();
  }
}

/* ══════════════════════════════════════════════════════════════════════════
   TOAST
   ══════════════════════════════════════════════════════════════════════════ */
let _toastTimer;
function showToast(msg, type = "info") {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.className = `toast ${type} show`;
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => el.classList.remove("show"), 3500);
}

/* ══════════════════════════════════════════════════════════════════════════
   LOADER
   ══════════════════════════════════════════════════════════════════════════ */
function showLoader(text = "Loading…") {
  document.getElementById("loaderText").textContent = text;
  document.getElementById("loader").style.display = "flex";
}
function hideLoader() {
  document.getElementById("loader").style.display = "none";
}

/* ══════════════════════════════════════════════════════════════════════════
   UTILITIES
   ══════════════════════════════════════════════════════════════════════════ */
function escHtml(str) {
  return String(str).replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[c]));
}

function formatDate(iso) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString();
  } catch { return iso; }
}

function touchToMouse(e) {
  e.preventDefault();
  const t = e.touches[0] || e.changedTouches[0];
  return { clientX: t.clientX, clientY: t.clientY };
}
