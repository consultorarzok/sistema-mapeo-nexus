(function () {
  "use strict";

  const API_BASE = "https://n8n.consultorarz.com/webhook";
  const TOKEN_KEY = "nexus_auth_token_v1";

  window.NEXUS_API_BASE = API_BASE;

  let resolveReady;
  const readyPromise = new Promise((resolve) => {
    resolveReady = resolve;
  });

  function loadStored() {
    try {
      return JSON.parse(localStorage.getItem(TOKEN_KEY) || "null");
    } catch (e) {
      return null;
    }
  }
  function storeToken(token, expires_at) {
    try {
      localStorage.setItem(TOKEN_KEY, JSON.stringify({ token, expires_at }));
    } catch (e) {}
  }
  function clearToken() {
    try {
      localStorage.removeItem(TOKEN_KEY);
    } catch (e) {}
  }

  function reveal(token) {
    document.getElementById("login-screen").hidden = true;
    document.getElementById("app-shell").hidden = false;
    window.dispatchEvent(new Event("resize"));
    resolveReady({ token });
  }

  function showLoginError(msg) {
    const err = document.getElementById("login-error");
    err.textContent = msg;
    err.hidden = false;
  }

  async function attemptLogin(usuario, contrasena) {
    const btn = document.getElementById("login-submit");
    btn.disabled = true;
    btn.textContent = "Entrando…";
    try {
      const res = await fetch(API_BASE + "/nexus-login", {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: JSON.stringify({ usuario, contrasena }),
      });
      const data = await res.json();
      if (data.ok) {
        storeToken(data.token, data.expires_at);
        reveal(data.token);
      } else {
        showLoginError(data.error || "Usuario o contraseña incorrectos");
      }
    } catch (e) {
      showLoginError("No se pudo conectar. Probá de nuevo.");
    } finally {
      btn.disabled = false;
      btn.textContent = "Entrar";
    }
  }

  function setupForm() {
    const form = document.getElementById("login-form");
    form.addEventListener("submit", (ev) => {
      ev.preventDefault();
      const usuario = document.getElementById("login-usuario").value.trim();
      const contrasena = document.getElementById("login-contrasena").value;
      document.getElementById("login-error").hidden = true;
      attemptLogin(usuario, contrasena);
    });
  }

  window.NexusAuth = {
    ready: readyPromise,
    getToken() {
      const stored = loadStored();
      return stored ? stored.token : null;
    },
    logout() {
      clearToken();
      location.reload();
    },
    // la API respondió 401 — el token venció o es inválido, hay que loguearse de nuevo
    forceLogin() {
      clearToken();
      document.getElementById("app-shell").hidden = true;
      document.getElementById("login-screen").hidden = false;
      showLoginError("Tu sesión expiró — iniciá sesión de nuevo.");
    },
  };

  setupForm();

  const stored = loadStored();
  if (stored && stored.token && stored.expires_at > Date.now()) {
    reveal(stored.token);
  }
})();
