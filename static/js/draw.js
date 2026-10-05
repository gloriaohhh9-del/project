(function () {
  const canvasStack = document.getElementById("canvasStack");
  if (!canvasStack) return;

  const CANVAS_WIDTH = 1200;
  const CANVAS_HEIGHT = 675;

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

  function createLayer(name) {
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

      if (layers.length > 1) {
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
    if (index === -1) return;
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

  function beginStroke(event) {
    drawing = true;
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
    pushUndoState();
    const layer = getActiveLayer();
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
        pushUndoState();
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

  // --- Init ---

  const firstLayer = createLayer();
  setActiveLayer(firstLayer.id);
  updateHistoryButtons();
})();
