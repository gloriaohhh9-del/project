// Like buttons (templates/_like_button.html): toggles the like without
// reloading the page. Without JS the form still posts and comes back.
(function () {
  document.addEventListener("submit", async (event) => {
    const form = event.target.closest(".like-form");
    if (!form) return;
    event.preventDefault();

    const button = form.querySelector(".like-btn");
    const count = form.querySelector(".like-count");
    if (button.disabled) return;
    button.disabled = true;
    try {
      const res = await fetch(form.getAttribute("action"), {
        method: "POST",
        headers: { Accept: "application/json" },
      });
      const body = await res.json().catch(() => ({}));
      if (res.status === 401 && body.login_url) {
        window.location.assign(body.login_url);
        return;
      }
      if (!res.ok) throw new Error(body.error || "Couldn't update the like (" + res.status + ").");
      button.classList.toggle("is-liked", body.liked);
      button.setAttribute("aria-pressed", body.liked ? "true" : "false");
      button.title = body.liked ? "Unlike" : "Like";
      count.textContent = body.like_count;
    } catch (err) {
      button.title = err.message;
      button.classList.add("is-error");
      setTimeout(() => button.classList.remove("is-error"), 1200);
    } finally {
      button.disabled = false;
    }
  });
})();
