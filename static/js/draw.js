(function () {
  const canvasStack = document.getElementById("canvasStack");
  if (!canvasStack) return;

  // Default canvas size; replaced by the artwork's own size when the page is
  // opened from Analyze to sketch an edit (see "Sketch edit mode" below).
  let CANVAS_WIDTH = 1200;
  let CANVAS_HEIGHT = 675;
  const editSource = canvasStack.dataset.backgroundUrl ? canvasStack.dataset : null;
  let sketchDirty = false;

  const colorPicker = document.getElementById("colorPicker");
  const sizeSlider = document.getElementById("sizeSlider");
  const sizeValue = document.getElementById("sizeValue");
  const opacitySlider = document.getElementById("opacitySlider");
  const opacityValue = document.getElementById("opacityValue");
  const undoBtn = document.getElementById("undoBtn");
  const redoBtn = document.getElementById("redoBtn");
  const clearBtn = document.getElementById("clearBtn");
  const downloadBtn = document.getElementById("downloadBtn");
  const insertImageBtn = document.getElementById("insertImageBtn");
  const imageInput = document.getElementById("imageInput");
  const addLayerBtn = document.getElementById("addLayerBtn");
  const layersList = document.getElementById("layersList");
  const toolButtons = document.querySelectorAll(".tool-btn");

  const MAX_HISTORY = 50;
  let undoStack = []; // { layerId, dataURL }
  let redoStack = [];
  let currentTool = "pencil";
  let drawing = false;
  let lastX = 0;
  let lastY = 0;
  let startX = 0;
  let startY = 0;
  let shapeSnapshot = null;

  let layers = [];
  let activeLayerId = null;
  let layerCounter = 0;

  const SHAPE_TOOLS = ["line", "rectangle", "ellipse"];
  function isShapeTool(tool) {
    return SHAPE_TOOLS.indexOf(tool) !== -1;
  }

  function getOpacity() {
    return parseInt(opacitySlider.value, 10) / 100;
  }

  // --- Layer management ---

  function createLayer(name, options) {
    layerCounter += 1;
    const layerCanvas = document.createElement("canvas");
    layerCanvas.width = CANVAS_WIDTH;
    layerCanvas.height = CANVAS_HEIGHT;
    layerCanvas.className = "draw-layer";
    const layer = {
      id: "layer-" + layerCounter,
      name: name || "Layer " + layerCounter,
      canvas: layerCanvas,
      ctx: layerCanvas.getContext("2d"),
      visible: true,
      locked: Boolean(options && options.locked),
    };
    layers.push(layer);
    canvasStack.appendChild(layerCanvas);
    updateLayerStacking();
    return layer;
  }

  function getActiveLayer() {
    return layers.find((l) => l.id === activeLayerId) || layers[layers.length - 1];
  }

  function setActiveLayer(id) {
    activeLayerId = id;
    renderLayersList();
  }

  function updateLayerStacking() {
    layers.forEach((layer, index) => {
      layer.canvas.style.zIndex = String(index);
      layer.canvas.style.display = layer.visible ? "block" : "none";
    });
  }

  function renderLayersList() {
    layersList.innerHTML = "";
    for (let i = layers.length - 1; i >= 0; i -= 1) {
      const layer = layers[i];
      const li = document.createElement("li");
      li.className = "layer-row" + (layer.id === activeLayerId ? " is-active" : "");
      li.addEventListener("click", (event) => {
        if (event.target.closest(".layer-visibility") || event.target.closest(".layer-delete")) {
          return;
        }
        setActiveLayer(layer.id);
      });

      const visBtn = document.createElement("button");
      visBtn.type = "button";
      visBtn.className = "layer-visibility";
      visBtn.title = layer.visible ? "Hide layer" : "Show layer";
      visBtn.textContent = layer.visible ? "👁" : "🚫";
      visBtn.addEventListener("click", () => {
        layer.visible = !layer.visible;
        updateLayerStacking();
        renderLayersList();
      });

      const nameSpan = document.createElement("span");
      nameSpan.className = "layer-name";
      nameSpan.textContent = layer.name;

      li.appendChild(visBtn);
      li.appendChild(nameSpan);

      if (layer.locked) {
        const lockIcon = document.createElement("span");
        lockIcon.className = "layer-lock";
        lockIcon.title = "Locked";
        lockIcon.textContent = "🔒";
        li.appendChild(lockIcon);
      } else if (layers.length > 1) {
        const delBtn = document.createElement("button");
        delBtn.type = "button";
        delBtn.className = "layer-delete";
        delBtn.title = "Delete layer";
        delBtn.textContent = "✕";
        delBtn.addEventListener("click", () => deleteLayer(layer.id));
        li.appendChild(delBtn);
      }

      layersList.appendChild(li);
    }
  }

  function deleteLayer(id) {
    if (layers.length <= 1) return;
    const index = layers.findIndex((l) => l.id === id);
    if (index === -1 || layers[index].locked) return;
    const [removed] = layers.splice(index, 1);
    removed.canvas.remove();
    if (activeLayerId === id) {
      activeLayerId = layers[layers.length - 1].id;
    }
    updateLayerStacking();
    renderLayersList();
  }

  addLayerBtn.addEventListener("click", () => {
    const layer = createLayer();
    setActiveLayer(layer.id);
  });

  // --- Undo / redo (per layer) ---

  function updateHistoryButtons() {
    undoBtn.disabled = undoStack.length === 0;
    redoBtn.disabled = redoStack.length === 0;
  }

  function pushUndoState() {
    const layer = getActiveLayer();
    undoStack.push({ layerId: layer.id, dataURL: layer.canvas.toDataURL() });
    if (undoStack.length > MAX_HISTORY) undoStack.shift();
    redoStack = [];
    updateHistoryButtons();
  }

  function restoreLayerFromDataURL(layerId, dataURL) {
    const layer = layers.find((l) => l.id === layerId);
    if (!layer) return;
    const img = new Image();
    img.onload = function () {
      const lctx = layer.ctx;
      lctx.save();
      lctx.globalCompositeOperation = "source-over";
      lctx.globalAlpha = 1;
      lctx.shadowBlur = 0;
      lctx.shadowColor = "transparent";
      lctx.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
      lctx.drawImage(img, 0, 0);
      lctx.restore();
    };
    img.src = dataURL;
  }

  function undo() {
    if (undoStack.length === 0) return;
    const entry = undoStack.pop();
    const layer = layers.find((l) => l.id === entry.layerId);
    if (layer) {
      redoStack.push({ layerId: entry.layerId, dataURL: layer.canvas.toDataURL() });
    }
    restoreLayerFromDataURL(entry.layerId, entry.dataURL);
    updateHistoryButtons();
  }

  function redo() {
    if (redoStack.length === 0) return;
    const entry = redoStack.pop();
    const layer = layers.find((l) => l.id === entry.layerId);
    if (layer) {
      undoStack.push({ layerId: entry.layerId, dataURL: layer.canvas.toDataURL() });
    }
    restoreLayerFromDataURL(entry.layerId, entry.dataURL);
    updateHistoryButtons();
  }

  // --- Tools ---

  function setTool(tool) {
    currentTool = tool;
    toolButtons.forEach((btn) => {
      btn.classList.toggle("is-active", btn.dataset.tool === tool);
    });
  }

  function getPos(event) {
    const rect = canvasStack.getBoundingClientRect();
    const scaleX = CANVAS_WIDTH / rect.width;
    const scaleY = CANVAS_HEIGHT / rect.height;
    return {
      x: (event.clientX - rect.left) * scaleX,
      y: (event.clientY - rect.top) * scaleY,
    };
  }

  function drawSegment(x0, y0, x1, y1) {
    const ctx = getActiveLayer().ctx;
    const size = parseInt(sizeSlider.value, 10);

    ctx.lineJoin = "round";
    ctx.lineCap = "round";

    if (currentTool === "eraser") {
      ctx.globalCompositeOperation = "destination-out";
      ctx.globalAlpha = 1;
      ctx.lineWidth = size * 2;
      ctx.shadowBlur = 0;
    } else if (currentTool === "brush") {
      ctx.globalCompositeOperation = "source-over";
      ctx.globalAlpha = getOpacity();
      ctx.lineWidth = size * 2;
      ctx.shadowBlur = size / 2;
      ctx.shadowColor = colorPicker.value;
      ctx.strokeStyle = colorPicker.value;
    } else {
      // pencil
      ctx.globalCompositeOperation = "source-over";
      ctx.globalAlpha = getOpacity();
      ctx.lineWidth = Math.max(1, size / 3);
      ctx.shadowBlur = 0;
      ctx.strokeStyle = colorPicker.value;
    }

    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.stroke();
  }

  function drawShapePreview(x0, y0, x1, y1, shiftKey) {
    const ctx = getActiveLayer().ctx;
    const size = parseInt(sizeSlider.value, 10);

    ctx.putImageData(shapeSnapshot, 0, 0);
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = getOpacity();
    ctx.shadowBlur = 0;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.strokeStyle = colorPicker.value;
    ctx.lineWidth = Math.max(1, size / 2);

    if (currentTool === "line") {
      let endX = x1;
      let endY = y1;
      if (shiftKey) {
        const dx = x1 - x0;
        const dy = y1 - y0;
        const angle = (Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * Math.PI) / 4;
        const dist = Math.hypot(dx, dy);
        endX = x0 + Math.cos(angle) * dist;
        endY = y0 + Math.sin(angle) * dist;
      }
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(endX, endY);
      ctx.stroke();
    } else if (currentTool === "rectangle") {
      let w = x1 - x0;
      let h = y1 - y0;
      if (shiftKey) {
        const side = Math.max(Math.abs(w), Math.abs(h));
        w = side * Math.sign(w || 1);
        h = side * Math.sign(h || 1);
      }
      ctx.beginPath();
      ctx.rect(x0, y0, w, h);
      ctx.stroke();
    } else if (currentTool === "ellipse") {
      let radiusX = Math.abs(x1 - x0) / 2;
      let radiusY = Math.abs(y1 - y0) / 2;
      if (shiftKey) {
        const radius = Math.max(radiusX, radiusY);
        radiusX = radius;
        radiusY = radius;
      }
      const cx = shiftKey ? x0 + Math.sign(x1 - x0 || 1) * radiusX : (x0 + x1) / 2;
      const cy = shiftKey ? y0 + Math.sign(y1 - y0 || 1) * radiusY : (y0 + y1) / 2;
      ctx.beginPath();
      ctx.ellipse(cx, cy, radiusX, radiusY, 0, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  function markSketchDirty() {
    sketchDirty = true;
    const submit = document.getElementById("sketchEditSubmit");
    if (submit) submit.disabled = false;
  }

  function beginStroke(event) {
    if (getActiveLayer().locked) return;
    drawing = true;
    markSketchDirty();
    pushUndoState();
    const pos = getPos(event);
    lastX = startX = pos.x;
    lastY = startY = pos.y;

    if (isShapeTool(currentTool)) {
      shapeSnapshot = getActiveLayer().ctx.getImageData(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
    } else {
      // Draw a dot on simple click so single taps still show a mark.
      drawSegment(pos.x, pos.y, pos.x, pos.y);
    }
  }

  function moveStroke(event) {
    if (!drawing) return;
    const pos = getPos(event);

    if (isShapeTool(currentTool)) {
      drawShapePreview(startX, startY, pos.x, pos.y, event.shiftKey);
    } else {
      drawSegment(lastX, lastY, pos.x, pos.y);
      lastX = pos.x;
      lastY = pos.y;
    }
  }

  function endStroke(event) {
    if (drawing && isShapeTool(currentTool) && shapeSnapshot) {
      const pos = getPos(event);
      drawShapePreview(startX, startY, pos.x, pos.y, event.shiftKey);
    }
    drawing = false;
    shapeSnapshot = null;
  }

  canvasStack.addEventListener("pointerdown", (event) => {
    canvasStack.setPointerCapture(event.pointerId);
    beginStroke(event);
  });
  canvasStack.addEventListener("pointermove", moveStroke);
  canvasStack.addEventListener("pointerup", endStroke);
  canvasStack.addEventListener("pointerleave", endStroke);
  canvasStack.addEventListener("pointercancel", endStroke);

  toolButtons.forEach((btn) => {
    btn.addEventListener("click", () => setTool(btn.dataset.tool));
  });

  sizeSlider.addEventListener("input", () => {
    sizeValue.textContent = sizeSlider.value;
  });

  opacitySlider.addEventListener("input", () => {
    opacityValue.textContent = opacitySlider.value + "%";
  });

  undoBtn.addEventListener("click", undo);
  redoBtn.addEventListener("click", redo);

  clearBtn.addEventListener("click", () => {
    const layer = getActiveLayer();
    if (layer.locked) return;
    pushUndoState();
    layer.ctx.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
  });

  downloadBtn.addEventListener("click", () => {
    const exportCanvas = document.createElement("canvas");
    exportCanvas.width = CANVAS_WIDTH;
    exportCanvas.height = CANVAS_HEIGHT;
    const exportCtx = exportCanvas.getContext("2d");
    exportCtx.fillStyle = "#ffffff";
    exportCtx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
    layers.forEach((layer) => {
      if (layer.visible) exportCtx.drawImage(layer.canvas, 0, 0);
    });
    const link = document.createElement("a");
    link.download = "aura-drawing.png";
    link.href = exportCanvas.toDataURL("image/png");
    link.click();
  });

  // --- Insert image (centered, scaled to fit, onto the active layer) ---

  insertImageBtn.addEventListener("click", () => imageInput.click());

  imageInput.addEventListener("change", (event) => {
    const file = event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (loadEvent) => {
      const img = new Image();
      img.onload = () => {
        if (getActiveLayer().locked) return;
        pushUndoState();
        markSketchDirty();
        const ctx = getActiveLayer().ctx;
        const scale = Math.min(CANVAS_WIDTH / img.width, CANVAS_HEIGHT / img.height, 1);
        const drawW = img.width * scale;
        const drawH = img.height * scale;
        const dx = (CANVAS_WIDTH - drawW) / 2;
        const dy = (CANVAS_HEIGHT - drawH) / 2;

        ctx.save();
        ctx.globalCompositeOperation = "source-over";
        ctx.globalAlpha = 1;
        ctx.shadowBlur = 0;
        ctx.drawImage(img, dx, dy, drawW, drawH);
        ctx.restore();
      };
      img.src = loadEvent.target.result;
    };
    reader.readAsDataURL(file);
    event.target.value = "";
  });

  document.addEventListener("keydown", (event) => {
    const isMac = navigator.platform.toUpperCase().indexOf("MAC") >= 0;
    const modifier = isMac ? event.metaKey : event.ctrlKey;
    if (!modifier) return;

    if (event.key.toLowerCase() === "z" && event.shiftKey) {
      event.preventDefault();
      redo();
    } else if (event.key.toLowerCase() === "z") {
      event.preventDefault();
      undo();
    } else if (event.key.toLowerCase() === "y") {
      event.preventDefault();
      redo();
    }
  });

  // --- Sketch edit mode (opened from an Analyze result) ---

  function flattenForEdit() {
    const out = document.createElement("canvas");
    out.width = CANVAS_WIDTH;
    out.height = CANVAS_HEIGHT;
    const octx = out.getContext("2d");
    octx.fillStyle = "#ffffff";
    octx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
    // The artwork layer is always included, even if hidden while sketching.
    layers.forEach((layer) => {
      if (layer.visible || layer.locked) octx.drawImage(layer.canvas, 0, 0);
    });
    return new Promise((resolve) => out.toBlob(resolve, "image/png"));
  }

  function initSketchEdit() {
    const form = document.getElementById("sketchEditBar");
    const promptInput = document.getElementById("sketchEditPrompt");
    const submit = document.getElementById("sketchEditSubmit");
    const status = document.getElementById("sketchEditStatus");
    const statusText = document.getElementById("sketchEditStatusText");
    const elapsed = document.getElementById("sketchEditElapsed");

    function setStatus(text, state) {
      status.hidden = false;
      status.className = "editor-status" + (state ? " is-" + state : "");
      statusText.textContent = text;
    }

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (!sketchDirty || submit.disabled) return;

      submit.disabled = true;
      promptInput.disabled = true;
      canvasStack.classList.add("is-busy");
      const t0 = Date.now();
      elapsed.textContent = "0s";
      const timer = setInterval(() => (elapsed.textContent = Math.round((Date.now() - t0) / 1000) + "s"), 1000);
      setStatus("Turning your sketch into an edit…", "busy");

      try {
        const formData = new FormData();
        formData.append("mode", "sketch");
        formData.append("prompt", promptInput.value.trim());
        formData.append("base_version", editSource.baseVersion);
        formData.append("sketch", await flattenForEdit(), "sketch.png");

        const res = await fetch(editSource.editUrl, { method: "POST", body: formData });
        const body = await res.json().catch(() => ({}));
        if (!res.ok || !body.url) throw new Error(body.error || "Edit failed (" + res.status + ").");

        setStatus("Edit applied ✓ Taking you back to your artwork…", "done");
        window.location.href = editSource.backUrl;
      } catch (err) {
        setStatus(err.message, "error");
        submit.disabled = false;
        promptInput.disabled = false;
        canvasStack.classList.remove("is-busy");
      } finally {
        clearInterval(timer);
      }
    });
  }

  // --- Init ---

  if (editSource) {
    const artwork = new Image();
    artwork.onload = () => {
      CANVAS_WIDTH = artwork.naturalWidth;
      CANVAS_HEIGHT = artwork.naturalHeight;
      canvasStack.style.aspectRatio = CANVAS_WIDTH + " / " + CANVAS_HEIGHT;

      const artworkLayer = createLayer("Artwork", { locked: true });
      artworkLayer.ctx.drawImage(artwork, 0, 0);
      const sketchLayer = createLayer("Sketch");
      setActiveLayer(sketchLayer.id);
      updateHistoryButtons();
      initSketchEdit();
    };
    artwork.onerror = () => {
      window.location.href = editSource.backUrl;
    };
    artwork.src = editSource.backgroundUrl;
  } else {
    const firstLayer = createLayer();
    setActiveLayer(firstLayer.id);
    updateHistoryButtons();
  }
})();
