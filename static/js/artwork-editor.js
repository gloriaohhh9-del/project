// Artwork editor on the Analyze results. Two ways to edit the generated
// image: describe the change in text (handled here), or sketch over it with
// the Draw page's tools (the Sketch tab links there with the chosen version).
// Every edit becomes a new version; picking an older version makes it the
// base for the next edit.
window.AuraEditor = (function () {
  function init() {
    const editor = document.getElementById("artwork-editor");
    if (!editor || editor.dataset.ready) return;
    editor.dataset.ready = "1";

    const img = document.getElementById("artwork-image");
    const tabs = editor.querySelectorAll(".editor-tab");
    const panels = editor.querySelectorAll(".editor-panel");
    const textForm = document.getElementById("editor-text");
    const textPrompt = document.getElementById("edit-text-prompt");
    const textSubmit = textForm.querySelector("button[type=submit]");
    const drawLink = document.getElementById("editor-draw-link");
    const statusBox = document.getElementById("editor-status");
    const statusText = document.getElementById("editor-status-text");
    const elapsedEl = document.getElementById("editor-elapsed");
    const strip = document.getElementById("version-strip");
    const downloadLink = document.getElementById("editor-download");

    let currentVersion = strip.querySelectorAll(".version-thumb").length - 1;
    let busy = false;
    let timer = null;

    // --- Mode tabs ---

    tabs.forEach((tab) =>
      tab.addEventListener("click", () => {
        tabs.forEach((t) => {
          t.classList.toggle("is-active", t === tab);
          t.setAttribute("aria-selected", String(t === tab));
        });
        panels.forEach((panel) => (panel.hidden = panel.dataset.mode !== tab.dataset.mode));
      })
    );

    // --- Versions ---

    function selectVersion(button) {
      strip.querySelectorAll(".version-thumb").forEach((b) => b.classList.toggle("is-active", b === button));
      currentVersion = parseInt(button.dataset.version, 10);
      img.src = button.dataset.url;
      downloadLink.href = button.dataset.url;
      downloadLink.download = currentVersion === 0 ? "aura-artwork.png" : "aura-artwork-edit-" + currentVersion + ".png";
      drawLink.href = drawLink.dataset.urlTemplate.replace("VERSION", currentVersion);
    }

    strip.addEventListener("click", (event) => {
      const button = event.target.closest(".version-thumb");
      if (button && !busy) selectVersion(button);
    });

    function addVersion(version, url, label) {
      const li = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.className = "version-thumb";
      button.dataset.version = version;
      button.dataset.url = url;
      button.title = label;
      const thumb = document.createElement("img");
      thumb.src = url;
      thumb.alt = label;
      const caption = document.createElement("span");
      caption.textContent = "Edit " + version;
      button.append(thumb, caption);
      li.appendChild(button);
      strip.appendChild(li);
      selectVersion(button);
      li.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "end" });
    }

    // --- Text edits ---

    function setBusy(on) {
      busy = on;
      editor.classList.toggle("is-busy", on);
      textPrompt.disabled = on;
      textSubmit.disabled = on;
    }

    function setStatus(text, state) {
      statusBox.hidden = false;
      statusBox.className = "editor-status" + (state ? " is-" + state : "");
      statusText.textContent = text;
    }

    function startTimer() {
      const t0 = Date.now();
      elapsedEl.textContent = "0s";
      timer = setInterval(() => (elapsedEl.textContent = Math.round((Date.now() - t0) / 1000) + "s"), 1000);
    }

    function stopTimer() {
      clearInterval(timer);
      timer = null;
    }

    async function submitTextEdit() {
      const text = textPrompt.value.trim();
      if (busy) return;
      if (!text) {
        textPrompt.focus();
        return;
      }
      const formData = new FormData();
      formData.append("mode", "text");
      formData.append("prompt", text);
      formData.append("base_version", currentVersion);

      setBusy(true);
      setStatus("Editing your artwork…", "busy");
      startTimer();
      try {
        const res = await fetch(editor.dataset.editUrl, { method: "POST", body: formData });
        const body = await res.json().catch(() => ({}));
        if (!res.ok || !body.url) throw new Error(body.error || "Edit failed (" + res.status + ").");

        setStatus("Loading the new version…", "busy");
        await new Promise((resolve) => {
          const probe = new Image();
          probe.onload = probe.onerror = resolve;
          probe.src = body.url;
        });
        addVersion(body.version, body.url, body.label);
        textPrompt.value = "";
        setStatus("Edit applied ✓", "done");
      } catch (err) {
        setStatus(err.message, "error");
      } finally {
        stopTimer();
        setBusy(false);
      }
    }

    textForm.addEventListener("submit", (event) => {
      event.preventDefault();
      submitTextEdit();
    });
    textPrompt.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        submitTextEdit();
      }
    });
  }

  init();
  return { init };
})();
