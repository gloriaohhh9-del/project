// Title & description panel on the Analyze results: saves the version shown
// in the editor to the artist's board, as a draft or published. The first
// save creates the artwork; later saves update that same artwork. Without
// JS, the form still posts normally and lands on the board.
window.AuraSave = (function () {
  function init() {
    const form = document.getElementById("artwork-save");
    if (!form || form.dataset.ready) return;
    form.dataset.ready = "1";

    const title = document.getElementById("artwork-title");
    const versionInput = document.getElementById("artwork-save-version");
    const idInput = document.getElementById("artwork-save-id");
    const draftBtn = document.getElementById("artwork-save-draft");
    const publishBtn = document.getElementById("artwork-save-publish");
    const statusBox = document.getElementById("artwork-save-status");
    const statusText = document.getElementById("artwork-save-status-text");

    function setStatus(state, text, link) {
      statusBox.hidden = false;
      statusBox.className = "editor-status is-" + state;
      statusText.textContent = text;
      if (link) {
        const a = document.createElement("a");
        a.href = link;
        a.textContent = "View on My Board →";
        statusText.append(" ", a);
      }
    }

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const action = event.submitter ? event.submitter.value : "draft";
      if (action === "publish" && !title.value.trim()) {
        setStatus("error", "Give your artwork a title before publishing it.");
        title.focus();
        return;
      }

      // Save whichever version is selected in the editor's version strip.
      const active = document.querySelector(".version-thumb.is-active");
      if (active) versionInput.value = active.dataset.version;

      const formData = new FormData(form);
      formData.set("action", action);
      draftBtn.disabled = publishBtn.disabled = true;
      setStatus("busy", action === "publish" ? "Publishing…" : "Saving…");
      try {
        // getAttribute, not form.action: the buttons are named "action",
        // so form.action returns them instead of the form's URL.
        const res = await fetch(form.getAttribute("action"), {
          method: "POST",
          body: formData,
          headers: { Accept: "application/json" },
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok || !body.artwork_id) throw new Error(body.error || "Save failed (" + res.status + ").");

        idInput.value = body.artwork_id;
        draftBtn.textContent = body.published ? "Unpublish to draft" : "💾 Update draft";
        publishBtn.textContent = body.published ? "Update published" : "Publish";
        setStatus("done", body.message + " ✓", body.board_url);
      } catch (err) {
        setStatus("error", err.message);
      } finally {
        draftBtn.disabled = publishBtn.disabled = false;
      }
    });
  }

  init();
  return { init };
})();
