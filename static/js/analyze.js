// Analyze page: uploads the track in the background and shows live progress
// (upload -> measuring -> listening -> generating -> loading -> done) instead
// of a frozen page. Without JS, the form still posts normally.
(function () {
  const form = document.getElementById("analyze-form");
  if (!form) return;

  const STAGES = ["upload", "measuring", "listening", "generating", "loading", "done"];
  const STATUS_TEXT = {
    upload: "Uploading your track…",
    queued: "Getting ready…",
    measuring: "Measuring the audio…",
    listening: "ChatGPT is listening to your track…",
    generating: "Generating your artwork…",
    loading: "Loading the image…",
    done: "Completed",
  };
  const POLL_MS = 1000;

  const submitBtn = document.getElementById("analyze-submit");
  const panel = document.getElementById("progress-panel");
  const statusEl = document.getElementById("progress-status");
  const elapsedEl = document.getElementById("progress-elapsed");
  const uploadPercent = document.getElementById("upload-percent");
  const placeholder = document.getElementById("artwork-placeholder");
  const output = document.getElementById("analysis-output");
  const flashes = document.getElementById("flash-container");

  let timer = null;

  function queuedText(ahead) {
    // ahead: tracks in line before this one (the first is being measured).
    if (!ahead) return STATUS_TEXT.queued;
    return ahead === 1
      ? "Waiting in line: 1 track ahead of yours…"
      : "Waiting in line: " + ahead + " tracks ahead of yours…";
  }

  function setStage(stage, ahead) {
    // "queued" is the wait before the server starts measuring this track.
    const shown = stage === "queued" ? "measuring" : stage;
    const current = STAGES.indexOf(shown);
    panel.querySelectorAll(".progress-steps li").forEach((li) => {
      const i = STAGES.indexOf(li.dataset.stage);
      li.classList.toggle("is-done", i < current || shown === "done");
      li.classList.toggle("is-active", i === current && shown !== "done");
    });
    statusEl.textContent = stage === "queued" ? queuedText(ahead) : STATUS_TEXT[stage] || stage;
    panel.classList.toggle("is-complete", stage === "done");
    placeholder.hidden = !(stage === "generating" || stage === "loading");
  }

  function startTimer() {
    const started = Date.now();
    elapsedEl.textContent = "0s";
    timer = setInterval(() => {
      elapsedEl.textContent = Math.round((Date.now() - started) / 1000) + "s";
    }, 1000);
  }

  function stopTimer() {
    clearInterval(timer);
    timer = null;
  }

  function fail(message) {
    stopTimer();
    panel.classList.add("is-error");
    panel.querySelectorAll(".progress-steps li.is-active").forEach((li) => {
      li.classList.remove("is-active");
      li.classList.add("is-failed");
    });
    statusEl.textContent = message;
    placeholder.hidden = true;
    submitBtn.disabled = false;
  }

  function upload(formData) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", form.dataset.startUrl);
      xhr.responseType = "json";
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) {
          uploadPercent.textContent = Math.round((e.loaded / e.total) * 100) + "%";
        }
      };
      xhr.onload = () => {
        const body = xhr.response || {};
        if (xhr.status === 202 && body.job_id) resolve(body.job_id);
        else reject(new Error(body.error || "Upload failed (" + xhr.status + ")."));
      };
      xhr.onerror = () => reject(new Error("Upload failed — check your connection."));
      xhr.send(formData);
    });
  }

  async function poll(jobId) {
    const url = form.dataset.statusUrl.replace("JOB_ID", jobId);
    for (;;) {
      const res = await fetch(url, { headers: { Accept: "application/json" } });
      const job = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(job.error || "Lost track of this job (" + res.status + "). Please try again.");
      if (job.stage === "error") throw new Error(job.error || "Something went wrong.");
      if (job.stage === "done") return;
      setStage(job.stage, job.ahead);
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
  }

  async function showResult(jobId) {
    const url = form.dataset.resultUrl.replace("JOB_ID", jobId);
    const res = await fetch(url);
    if (!res.ok) throw new Error("Couldn't load the result (" + res.status + ").");
    const doc = new DOMParser().parseFromString(await res.text(), "text/html");

    setStage("loading");
    const img = doc.querySelector("#analysis-output .artwork-image");
    if (img) {
      // Preload so "Loading image" reflects the real download.
      await new Promise((resolve) => {
        const probe = new Image();
        probe.onload = probe.onerror = resolve;
        probe.src = img.getAttribute("src");
      });
    }

    output.innerHTML = doc.getElementById("analysis-output").innerHTML;
    flashes.innerHTML = doc.getElementById("flash-container").innerHTML;
    history.replaceState(null, "", url);
    if (window.AuraEditor) window.AuraEditor.init();
    if (window.AuraSave) window.AuraSave.init();
    if (window.AuraVideo) window.AuraVideo.init();

    stopTimer();
    setStage("done");
    submitBtn.disabled = false;
    output.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!form.reportValidity()) return;

    submitBtn.disabled = true;
    output.innerHTML = "";
    flashes.innerHTML = "";
    uploadPercent.textContent = "";
    panel.hidden = false;
    panel.classList.remove("is-error", "is-complete");
    panel.querySelectorAll(".is-failed").forEach((li) => li.classList.remove("is-failed"));
    stopTimer();
    startTimer();
    setStage("upload");

    try {
      const jobId = await upload(new FormData(form));
      uploadPercent.textContent = "";
      setStage("queued");
      await poll(jobId);
      await showResult(jobId);
    } catch (err) {
      fail(err.message);
    }
  });
})();
