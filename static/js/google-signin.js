// "Continue with Google" on the login and sign-up pages. Firebase handles the
// Google popup; the resulting ID token goes to /auth/google, which checks it
// and signs the user in to AURA (creating or linking their account). The
// Firebase session itself isn't kept: AURA's own login cookie takes over.
import { initializeApp } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-app.js";
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
} from "https://www.gstatic.com/firebasejs/11.0.2/firebase-auth.js";

const button = document.getElementById("google-signin");
const errorBox = document.getElementById("google-signin-error");
const configEl = document.getElementById("firebase-config");

// The popup was closed or replaced by another one: not worth an error.
const QUIET_ERRORS = new Set(["auth/popup-closed-by-user", "auth/cancelled-popup-request"]);

function showError(message) {
  errorBox.textContent = message;
  errorBox.hidden = false;
}

if (button && configEl) {
  const auth = getAuth(initializeApp(JSON.parse(configEl.textContent)));
  const label = button.querySelector("span");
  const idleText = label.textContent;

  button.addEventListener("click", async () => {
    button.disabled = true;
    errorBox.hidden = true;
    label.textContent = "Signing in…";
    try {
      const result = await signInWithPopup(auth, new GoogleAuthProvider());
      const idToken = await result.user.getIdToken();
      const res = await fetch(button.dataset.url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ id_token: idToken }),
      });
      const body = await res.json().catch(() => ({}));
      await signOut(auth).catch(() => {});
      if (!res.ok) throw new Error(body.error || "Google sign-in failed (" + res.status + ").");
      window.location.assign(body.redirect || "/");
    } catch (err) {
      if (err && err.code === "auth/popup-blocked") {
        showError("Your browser blocked the Google window. Allow pop-ups for this site and try again.");
      } else if (!(err && QUIET_ERRORS.has(err.code))) {
        showError((err && err.message) || "Google sign-in failed.");
      }
      button.disabled = false;
      label.textContent = idleText;
    }
  });
}
