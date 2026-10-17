(function () {
  "use strict";

  const SB_URL = "https://henegdflczhrorprgbgf.supabase.co";
  const SB_KEY = "sb_publishable_BVOqZJCP4_KthXjirtYEug_TqmbFJDX";
  const TOKEN_KEY = "nexus_auth_token_v2";

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

  // Si la base está ocupada (ej. mientras se actualiza desde la planilla) puede cortar una consulta
  // por tiempo (5xx): se reintenta hasta 2 veces antes de mostrar error. Todas las funciones son
  // seguras de repetir (lecturas, o escrituras que dejan el mismo resultado).
  async function rawRpc(fn, args) {
    let res;
    for (let intento = 0; ; intento++) {
      res = await fetch(SB_URL + "/rest/v1/rpc/" + fn, {
        method: "POST",
        headers: { apikey: SB_KEY, "Content-Type": "application/json" },
        body: JSON.stringify(args),
      });
      if (res.status < 500 || intento >= 2) break;
      await new Promise((r) => setTimeout(r, 1500 * (intento + 1)));
    }
    if (res.status === 401) {
      const e = new Error("Sesión vencida");
      e.unauthorized = true;
      throw e;
    }
    if (!res.ok) throw new Error("Error " + res.status);
    return res.json();
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
      const data = await rawRpc("nx_login", { p_usuario: usuario, p_contrasena: contrasena });
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
    // llama a una función de la base con el token de sesión; si venció, vuelve al login
    async rpc(fn, args) {
      try {
        return await rawRpc(fn, Object.assign({ p_token: this.getToken() }, args || {}));
      } catch (e) {
        if (e.unauthorized) this.forceLogin();
        throw e;
      }
    },
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
