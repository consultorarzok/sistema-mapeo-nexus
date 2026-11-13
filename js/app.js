(function () {
  "use strict";

  const STATE = {
    insts: [], // instituciones (id, nombre, depto, distrito, dir, personas, b, lat, lng, radio)
    totals: { general: 0, b: 0, cruzan: 0, ubicadas: 0, ubicadas_b: 0 },
    version: null,
    peopleCache: new Map(), // inst_id -> personas ya cargadas
    rowIndex: new Map(), // row_number -> persona
    selectedDepto: "",
    selectedDistrito: "",
    selectedInstId: null,
    map: null,
    infoWindow: null,
    institutionMarkers: [],
    reachCircles: [],
    personLayer: null,
    soloReales: true, // casilla "Solo ubicación real": encendida por defecto
    loadSeq: 0, // cada elección/cambio de casilla invalida las cargas anteriores
    mapMode: "instituciones", // "instituciones" (azul, siempre visible) | "personas" (verde/rojo + círculo de alcance, se suma a las instituciones)
    mapaTabVisitada: false,
  };

  // Departamento ("4 - EL CARMEN") -> localidad para armar la dirección que se abre en Google Maps.
  const DEPTO_LOCALITY = {
    "dr. manuel belgrano": "San Salvador de Jujuy",
    "palpala": "Palpalá",
    "san antonio": "San Antonio",
    "el carmen": "El Carmen",
    "san pedro": "San Pedro de Jujuy",
    "santa barbara": "Palma Sola",
    "ledesma": "Libertador General San Martín",
    "valle grande": "Valle Grande",
    "tumbaya": "Tumbaya",
    "tilcara": "Tilcara",
    "humahuaca": "Humahuaca",
    "cochinoca": "Abra Pampa",
    "rinconada": "Rinconada",
    "santa catalina": "Santa Catalina",
    "yavi": "La Quiaca",
    "susques": "Susques",
  };

  // ---------------------------------------------------------------
  // Utilidades
  // ---------------------------------------------------------------
  function normalize(s) {
    return (s || "")
      .toString()
      .trim()
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "");
  }

  function numPrefix(s) {
    const m = /^\s*(\d+)/.exec(s || "");
    return m ? parseInt(m[1], 10) : 1e9;
  }
  function byNumberedName(a, b) {
    return numPrefix(a) - numPrefix(b) || String(a).localeCompare(String(b), "es");
  }
  function fmtN(n) {
    return Number(n || 0).toLocaleString("es-AR");
  }

  function getObservacion(p) {
    return p.Observacion || "";
  }

  async function saveObservacion(p, texto) {
    const data = await window.NexusAuth.rpc("nx_observacion", { p_row: p.row_number, p_texto: texto });
    if (!data.ok) throw new Error(data.error || "No se pudo guardar");
    p.Observacion = texto;
    p._obsLista = true;
  }

  // Las personas del mapa llegan sin observación: se pide al tocarlas (una consulta chica por código).
  async function cargarObservacion(p) {
    if (p._obsLista) return;
    const res = await window.NexusAuth.rpc("nx_buscar", { p_q: String(p.Codigo), p_limit: 60 });
    const fila = (res.rows || []).find((x) => x.row_number === p.row_number);
    if (p._obsLista) return; // la guardaron mientras tanto
    p.Observacion = fila ? fila.Observacion || "" : "";
    p.Verificado = !!(fila && fila.Verificado);
    p.Contactado = !!(fila && fila.Contactado);
    p.WhatsApp = fila ? fila.WhatsApp || "" : "";
    p._obsLista = true;
  }

  function cleanName(s) {
    return String(s || "").replace(/^\s*\d+\s*-\s*/, "").trim();
  }

  function locality(deptoRaw) {
    const k = normalize(cleanName(deptoRaw));
    return DEPTO_LOCALITY[k] || cleanName(deptoRaw);
  }

  function fullAddressInstitucion(inst) {
    return inst.dir + ", " + locality(inst.depto) + ", Jujuy, Argentina";
  }

  function googleMapsUrl(p) {
    const q = p.Direccion + " " + p.Numero + ", " + locality(p.Departamento) + ", Jujuy, Argentina";
    return "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent(q);
  }

  function googleMapsUrlInstitucion(inst) {
    return "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent(fullAddressInstitucion(inst));
  }

  // Búsqueda externa: solo un link a Google (sin API, sin costo)
  function googleSearchUrl(p) {
    const q = [p.Codigo, p.Nombre, p.Apellido].filter(Boolean).join(" ");
    return "https://www.google.com/search?q=" + encodeURIComponent(q);
  }

  // ---------------------------------------------------------------
  // Búsqueda en la web con IA (Gemini usando el buscador de Google).
  // La clave de Gemini vive en el servidor, nunca en la página. La página solo manda el código
  // de la persona: el servidor arma la búsqueda (número + nombre + apellido + localidad de Jujuy), así
  // nadie puede usar el servicio para buscar otra cosa. El resultado queda guardado 30 días.
  // ---------------------------------------------------------------
  const WEB_WEBHOOK = "https://n8n.consultorarz.com/webhook/nexus-busqueda-web";
  const WEB_ERRORES = {
    tope: "Se llegó al tope de búsquedas de hoy. Mañana se habilita de nuevo.",
    sin_persona: "No se encontró a esta persona en el padrón.",
    sin_configurar: "La búsqueda con IA todavía no está activada.",
    fallo: "El buscador no respondió. Probá de nuevo en un momento.",
  };
  const WEB_CONF = { alta: "Coincidencia alta", media: "Coincidencia media", baja: "Coincidencia baja" };

  async function pedirBusquedaWeb(p, forzar) {
    let res;
    try {
      res = await fetch(WEB_WEBHOOK, {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: JSON.stringify({ token: window.NexusAuth.getToken(), codigo: String(p.Codigo), forzar: !!forzar }),
      });
    } catch (e) {
      throw new Error(WEB_ERRORES.fallo);
    }
    if (res.status === 404) throw new Error(WEB_ERRORES.sin_configurar);
    let data = null;
    try {
      data = await res.json();
    } catch (e) {}
    if (data && data.error === "unauthorized") {
      window.NexusAuth.forceLogin();
      throw new Error("La sesión venció. Volvé a entrar.");
    }
    if (!data || !data.ok) throw new Error(WEB_ERRORES[data && data.error] || WEB_ERRORES.fallo);
    return data;
  }

  function urlSegura(u) {
    return /^https?:\/\//i.test(String(u || "")) ? String(u) : "";
  }

  // Fuente de cada coincidencia con el enlace para abrirla y verificar.
  // Los resultados guardados antes de agregar el enlace lo buscan por el nombre del sitio.
  function webFuenteHtml(c, fuentes) {
    let u = urlSegura(c.url);
    if (!u && c.sitio) {
      const f = fuentes.find((x) => String(x.url).toLowerCase().indexOf(String(c.sitio).toLowerCase()) !== -1);
      if (f) u = urlSegura(f.url);
    }
    if (u) {
      return (
        '<div class="web-sitio">Fuente: <a class="web-link" target="_blank" rel="noopener noreferrer" href="' +
        escapeHtml(u) + '">' + escapeHtml(c.sitio || u) + " ↗ Abrir y verificar</a></div>"
      );
    }
    return c.sitio ? '<div class="web-sitio">Fuente: ' + escapeHtml(c.sitio) + "</div>" : "";
  }

  function webResultadoHtml(data) {
    const r = data.resultado || {};
    const coincidencias = Array.isArray(r.coincidencias) ? r.coincidencias : [];
    const fuentes = (Array.isArray(r.fuentes) ? r.fuentes : []).filter((f) => urlSegura(f.url));
    const fecha = r.fecha ? new Date(r.fecha) : null;
    let h =
      '<div class="web-head"><b>Búsqueda en la web</b>' +
      (fecha && !isNaN(fecha) ? '<span class="web-date">Consultado el ' + fecha.toLocaleDateString("es-AR") + "</span>" : "") +
      '<button type="button" class="btn btn-secondary web-refresh">Buscar de nuevo</button></div>';
    if (r.resumen) h += '<p class="web-resumen">' + escapeHtml(r.resumen) + "</p>";
    if (!coincidencias.length) {
      h += '<p class="web-vacio">No se encontró información pública confiable sobre esta persona en Jujuy.</p>';
    } else {
      h += '<ul class="web-list">';
      coincidencias.forEach((c) => {
        const conf = WEB_CONF[c.confianza] ? c.confianza : "baja";
        h +=
          "<li>" +
          '<span class="web-conf web-conf--' + conf + '">' + WEB_CONF[conf] + "</span>" +
          '<div class="web-titulo">' + escapeHtml(c.titulo || "") + "</div>" +
          '<div class="web-detalle">' + escapeHtml(c.detalle || "") + "</div>" +
          webFuenteHtml(c, fuentes) +
          "</li>";
      });
      h += "</ul>";
    }
    // La lista de todas las páginas leídas se oculta: mezclaba páginas de otras personas.
    // Cada coincidencia ya trae su propio enlace de fuente.
    if (false && fuentes.length) {
      h += '<div class="web-fuentes"><b>Páginas que leyó el buscador</b>';
      fuentes.forEach((f) => {
        h += '<a target="_blank" rel="noopener noreferrer" href="' + escapeHtml(urlSegura(f.url)) + '">' + escapeHtml(f.titulo || f.url) + "</a>";
      });
      h += "</div>";
    }
    if (r.sugerencias_html) h += '<iframe class="web-sugerencias" title="Búsquedas de Google relacionadas" sandbox="allow-popups allow-popups-to-escape-sandbox"></iframe>';
    h += '<p class="web-nota">Resultado automático. Puede tratarse de otra persona con el mismo nombre: abrí la fuente antes de darlo por cierto.</p>';
    return h;
  }

  // Conecta el botón "Buscar en la web (IA)" de una ficha con su recuadro de resultados
  function conectarBusquedaWeb(cont, p) {
    const btn = cont.querySelector(".btn-web");
    const host = cont.querySelector(".web-host");
    if (!btn || !host) return;
    async function buscar(forzar) {
      btn.disabled = true;
      host.hidden = false;
      host.className = "web-host web-box is-loading";
      host.innerHTML = '<span class="web-spinner" aria-hidden="true"></span>Buscando en la web… puede tardar hasta medio minuto.';
      try {
        const data = await pedirBusquedaWeb(p, forzar);
        host.className = "web-host web-box";
        host.innerHTML = webResultadoHtml(data);
        const fr = host.querySelector(".web-sugerencias");
        if (fr) fr.srcdoc = String(data.resultado.sugerencias_html);
        const again = host.querySelector(".web-refresh");
        if (again) again.addEventListener("click", () => buscar(true));
      } catch (e) {
        host.className = "web-host web-box is-error";
        host.textContent = e.message;
      } finally {
        btn.disabled = false;
      }
    }
    btn.addEventListener("click", () => buscar(false));
  }

  // Búsqueda interna: lleva a la pestaña Buscador con el texto cargado
  function jumpToBuscadorQuery(texto) {
    const tabBtn = document.querySelector('.tab-btn[data-tab="buscador"]');
    if (tabBtn) tabBtn.click();
    const input = document.getElementById("input-codigo");
    if (!input) return;
    input.value = texto;
    runSearch(texto.trim());
    input.scrollIntoView({ behavior: "smooth", block: "center" });
  }
  function jumpToBuscador(p) {
    jumpToBuscadorQuery(String(p.Codigo));
  }

  function instById(id) {
    return STATE.insts.find((i) => i.id === id) || null;
  }

  // ---------------------------------------------------------------
  // Carga de datos (la base de Supabase responde por funciones, con el token de sesión)
  // ---------------------------------------------------------------
  async function loadData() {
    const data = await window.NexusAuth.rpc("nx_resumen");
    applyData(data);
    window.dispatchEvent(new CustomEvent("nexus:data-ready"));
  }

  // Sincronización automática con la planilla (n8n): hora de la última y aviso si quedó frenada
  function showSyncStatus(data) {
    const tag = document.getElementById("live-tag");
    if (tag && data.sync_at) {
      tag.title = "Última sincronización con la planilla: " + new Date(data.sync_at).toLocaleString("es-AR");
    }
    const box = document.getElementById("sync-alert");
    if (!box) return;
    box.hidden = !data.sync_error;
    box.textContent = data.sync_error
      ? "⚠️ La actualización desde la planilla está frenada: " + data.sync_error +
        (data.sync_autorizable ? " El administrador lo puede confirmar en Inicio." : "")
      : "";
    // borrado masivo frenado: el administrador lo confirma con su clave (nx_sync_autorizar)
    const auth = document.getElementById("admin-auth");
    if (auth) {
      auth.hidden = !data.sync_autorizable;
      document.getElementById("admin-auth-text").textContent = data.sync_autorizable
        ? data.sync_error + " Si borraste o reemplazaste los datos a propósito, confirmá y el sistema queda igual a la planilla."
        : "";
    }
  }

  function applyData(data) {
    STATE.insts = data.instituciones || [];
    STATE.version = data.version;
    STATE.totals = {
      general: data.total_general || 0,
      b: data.total_b || 0,
      cruzan: data.cruzan || 0,
      ubicadas: data.ubicadas || 0,
      ubicadas_b: data.ubicadas_b || 0,
      aproximadas: data.aproximadas || 0,
    };
    STATE.peopleCache.clear();
    showSyncStatus(data);
    // globe.js solo necesita las cantidades
    window.NexusData = { general: { length: STATE.totals.general }, registroB: { length: STATE.totals.b } };
  }

  // ---------------------------------------------------------------
  // Actualización automática: cada REFRESH_MS (y al volver a la pestaña del navegador)
  // se consulta la versión de los datos; si cambió se recarga y se redibuja sin recargar la página.
  // ---------------------------------------------------------------
  const REFRESH_MS = 60000;
  let refreshing = false;
  let lastRefreshAt = Date.now();

  function userIsTypingObservation() {
    const a = document.activeElement;
    return !!(a && a.tagName === "TEXTAREA");
  }

  async function refreshData() {
    if (refreshing || document.hidden) return;
    refreshing = true;
    try {
      if (!window.NexusAuth.getToken()) return;
      const v = await window.NexusAuth.rpc("nx_version");
      lastRefreshAt = Date.now();
      setLiveStamp();
      if (v.version === STATE.version) return;
      applyData(await window.NexusAuth.rpc("nx_resumen"));
      rerenderAll();
      window.dispatchEvent(new CustomEvent("nexus:data-updated"));
    } catch (e) {
      console.warn("refresh fallo", e);
    } finally {
      refreshing = false;
    }
  }

  function setLiveStamp() {
    const el = document.getElementById("live-stamp");
    if (!el) return;
    const d = new Date();
    el.textContent = "Sincronizado con la base de datos · " + d.toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" });
  }

  function rerenderAll() {
    renderInicio();
    populateDeptoSelect();
    populateDistritoSelect();
    renderInstGrid();
    const input = document.getElementById("input-codigo");
    if (input && input.value.trim() && !userIsTypingObservation()) runSearch(input.value.trim());
    const mapaActive = document.getElementById("tab-mapa").classList.contains("active");
    if (STATE.mapaTabVisitada && STATE.map && STATE.mapMode === "instituciones") {
      if (mapaActive) populateInstitutionLayer();
    }
    if (STATE.selectedInstId && !userIsTypingObservation()) {
      const inst = instById(STATE.selectedInstId);
      if (inst) selectInstitucion(inst, { silent: true });
    }
    if (OSM.map) renderOsm({ keepView: true });
  }

  function startAutoRefresh() {
    setLiveStamp();
    setInterval(refreshData, REFRESH_MS);
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden && Date.now() - lastRefreshAt > 20000) refreshData();
    });
  }

  // ---------------------------------------------------------------
  function setupTabs() {
    document.querySelectorAll(".tab-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
        document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
        btn.classList.add("active");
        btn.scrollIntoView({ inline: "center", block: "nearest", behavior: "smooth" }); // en celular el menú se desplaza
        document.getElementById("tab-" + btn.dataset.tab).classList.add("active");
        if (btn.dataset.tab === "mapa") {
          STATE.mapaTabVisitada = true;
          renderInstitutionMarkers();
        }
        if (btn.dataset.tab === "osm") openOsmTab();
        if (btn.dataset.tab === "verificaciones") openVerificacionesTab();
      });
    });
  }

  // ---------------------------------------------------------------
  // Inicio — números animados + sparkline + dona
  // ---------------------------------------------------------------
  function animateCount(el, to, duration) {
    const start = performance.now();
    function tick(now) {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      el.textContent = fmtN(Math.round(eased * to));
      if (t < 1) requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  }
  // ---------------------------------------------------------------
  // Inicio — números animados + dona
  // ---------------------------------------------------------------
  function renderInicio() {
    const total = STATE.totals.general;
    const totalB = STATE.totals.b;
    const pct = total ? (totalB / total) * 100 : 0;

    document.getElementById("stat-general-pct").textContent = "100%";
    document.getElementById("stat-b-pct").textContent = pct.toFixed(1) + "%";

    animateCount(document.getElementById("stat-general"), total, 900);
    animateCount(document.getElementById("stat-b"), totalB, 900);

    const circumference = 2 * Math.PI * 50; // r=50
    const arcLen = (pct / 100) * circumference;
    const arc = document.getElementById("donut-arc");
    requestAnimationFrame(() => {
      arc.setAttribute("stroke-dasharray", arcLen.toFixed(1) + " " + circumference.toFixed(1));
    });
    animateCount(document.getElementById("donut-pct"), Math.round(pct), 1100);
    setTimeout(() => {
      document.getElementById("donut-pct").textContent = pct.toFixed(1) + "%";
    }, 1150);

    // Territorio: se cuenta sobre las instituciones cargadas
    const deptos = new Map();
    STATE.insts.forEach((i) => {
      const key = i.depto || "Sin departamento";
      if (!deptos.has(key)) deptos.set(key, { insts: 0, distritos: new Set(), general: 0, b: 0 });
      const d = deptos.get(key);
      d.insts++;
      if (i.distrito) d.distritos.add(i.distrito);
      d.general += i.personas || 0;
      d.b += i.b || 0;
    });
    const totalDistritos = new Set(STATE.insts.filter((i) => i.distrito).map((i) => i.depto + "|" + i.distrito)).size;
    animateCount(document.getElementById("stat-inst"), STATE.insts.length, 900);
    animateCount(document.getElementById("stat-deptos"), deptos.size, 900);
    animateCount(document.getElementById("stat-distritos"), totalDistritos, 900);

    const max = Math.max(1, ...Array.from(deptos.values()).map((d) => d.general));
    const tbody = document.getElementById("depto-tbody");
    tbody.innerHTML = "";
    Array.from(deptos.keys()).sort(byNumberedName).forEach((name) => {
      const d = deptos.get(name);
      const tr = document.createElement("tr");
      tr.title = "Ver " + name + " en el mapa";
      tr.innerHTML =
        '<td><span class="depto-name"></span><span class="depto-bar">' +
        '<i class="bg" style="width:' + ((d.general / max) * 100).toFixed(1) + '%"></i>' +
        '<i class="bb" style="width:' + ((d.b / max) * 100).toFixed(1) + '%"></i></span></td>' +
        '<td class="num">' + fmtN(d.insts) + "</td>" +
        '<td class="num col-dist">' + fmtN(d.distritos.size) + "</td>" +
        '<td class="num">' + fmtN(d.general) + "</td>" +
        '<td class="num">' + fmtN(d.b) + "</td>";
      tr.querySelector(".depto-name").textContent = name;
      tr.addEventListener("click", () => gotoMapaDepto(name));
      tbody.appendChild(tr);
    });
  }

  // Desde el Inicio: abre la pestaña Mapa (opcionalmente con un departamento elegido)
  function gotoMapaDepto(depto) {
    document.querySelector('.tab-btn[data-tab="mapa"]').click();
    const sel = document.getElementById("sel-depto");
    if (depto && Array.from(sel.options).some((o) => o.value === depto)) {
      sel.value = depto;
      sel.dispatchEvent(new Event("change"));
    }
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
  document.querySelectorAll("#tab-inicio [data-goto='mapa']").forEach((el) =>
    el.addEventListener("click", () => gotoMapaDepto(""))
  );

  // ---------------------------------------------------------------
  // Mapa: Departamento -> Distrito -> Instituciones -> Personas
  // ---------------------------------------------------------------
  function uniqueSorted(arr) {
    return Array.from(new Set(arr)).sort(byNumberedName);
  }

  function populateDeptoSelect() {
    const sel = document.getElementById("sel-depto");
    const deptos = uniqueSorted(STATE.insts.map((i) => i.depto).filter(Boolean));
    while (sel.options.length > 1) sel.remove(1);
    deptos.forEach((d) => {
      const opt = document.createElement("option");
      opt.value = d;
      opt.textContent = d;
      sel.appendChild(opt);
    });
    sel.value = deptos.includes(STATE.selectedDepto) ? STATE.selectedDepto : "";
    if (sel.dataset.bound) return;
    sel.dataset.bound = "1";
    sel.addEventListener("change", () => {
      STATE.selectedDepto = sel.value;
      STATE.selectedDistrito = "";
      populateDistritoSelect();
      renderInstGrid();
      clearDetail();
      renderInstitutionMarkers();
    });
  }

  function populateDistritoSelect() {
    const sel = document.getElementById("sel-distrito");
    sel.innerHTML = '<option value="">— Elegir distrito —</option>';
    if (!STATE.selectedDepto) {
      sel.disabled = true;
      return;
    }
    const distritos = uniqueSorted(
      STATE.insts.filter((i) => i.depto === STATE.selectedDepto).map((i) => i.distrito).filter(Boolean)
    );
    distritos.forEach((d) => {
      const opt = document.createElement("option");
      opt.value = d;
      opt.textContent = d;
      sel.appendChild(opt);
    });
    sel.disabled = false;
    if (distritos.includes(STATE.selectedDistrito)) sel.value = STATE.selectedDistrito;
    sel.onchange = () => {
      STATE.selectedDistrito = sel.value;
      renderInstGrid();
      clearDetail();
      renderInstitutionMarkers();
    };
  }

  // ---------------------------------------------------------------
  // Buscador de instituciones con sugerencias (todas las palabras, en cualquier orden)
  // ---------------------------------------------------------------
  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  }

  function highlightWords(text, words) {
    const norm = normalize(text);
    const mark = new Array(text.length).fill(false);
    // normalize() quita tildes sin cambiar el largo de cada letra, así que los índices coinciden
    if (norm.length === text.length) {
      words.forEach((w) => {
        let i = norm.indexOf(w);
        while (i !== -1) {
          for (let k = i; k < i + w.length; k++) mark[k] = true;
          i = norm.indexOf(w, i + w.length);
        }
      });
    }
    let out = "";
    let open = false;
    for (let i = 0; i < text.length; i++) {
      if (mark[i] && !open) { out += "<mark>"; open = true; }
      if (!mark[i] && open) { out += "</mark>"; open = false; }
      out += escapeHtml(text[i]);
    }
    return open ? out + "</mark>" : out;
  }
  function institutionIndex() {
    return STATE.insts.map((i) => ({
      id: i.id,
      name: i.nombre,
      depto: i.depto,
      distritos: new Set([i.distrito]),
      count: i.personas,
      norm: normalize(i.nombre),
    }));
  }

  function goToInstitution(entry) {
    const inst = instById(entry.id);
    if (!inst) return;
    const selD = document.getElementById("sel-depto");
    selD.value = inst.depto;
    STATE.selectedDepto = inst.depto;
    STATE.selectedDistrito = "";
    populateDistritoSelect();
    renderInstGrid();
    clearDetail();
    renderInstitutionMarkers();
    selectInstitucion(inst);
  }

  function setupInstSearch() {
    const input = document.getElementById("inst-search-input");
    const list = document.getElementById("inst-suggest");
    let items = [];
    let active = -1;

    function close() {
      list.hidden = true;
      input.setAttribute("aria-expanded", "false");
      active = -1;
    }
    function setActive(i) {
      active = i;
      Array.from(list.children).forEach((li, k) => li.classList.toggle("active", k === i));
      const el = list.children[i];
      if (el && el.scrollIntoView) el.scrollIntoView({ block: "nearest" });
    }
    function choose(entry) {
      input.value = entry.name;
      close();
      goToInstitution(entry);
    }
    function render() {
      const words = normalize(input.value).split(/\s+/).filter(Boolean);
      if (!words.length) { close(); return; }
      items = institutionIndex()
        .filter((e) => words.every((w) => e.norm.includes(w)))
        .sort((a, b) => {
          const sa = a.norm.startsWith(words[0]) ? 0 : 1;
          const sb = b.norm.startsWith(words[0]) ? 0 : 1;
          return sa - sb || a.name.localeCompare(b.name, "es");
        });
      const total = items.length;
      items = items.slice(0, 10);
      list.innerHTML = "";
      if (!total) {
        list.innerHTML = '<li class="sg-empty">No hay instituciones con esas palabras</li>';
      } else {
        items.forEach((e) => {
          const li = document.createElement("li");
          li.setAttribute("role", "option");
          li.innerHTML =
            highlightWords(e.name, words) +
            '<span class="sg-sub">' + escapeHtml(cleanName(e.depto)) + " · " + escapeHtml(cleanName(Array.from(e.distritos).join(", "))) +
            " · " + fmtN(e.count) + " persona(s)</span>";
          li.addEventListener("mousedown", (ev) => { ev.preventDefault(); choose(e); });
          list.appendChild(li);
        });
        if (total > items.length) {
          const li = document.createElement("li");
          li.className = "sg-empty";
          li.textContent = "Y " + (total - items.length) + " más — escribí más palabras para acotar";
          list.appendChild(li);
        }
      }
      list.hidden = false;
      input.setAttribute("aria-expanded", "true");
      active = -1;
    }

    input.addEventListener("input", render);
    input.addEventListener("focus", () => { if (input.value.trim()) render(); });
    input.addEventListener("blur", () => setTimeout(close, 120));
    input.addEventListener("keydown", (ev) => {
      if (list.hidden) return;
      if (ev.key === "ArrowDown") { ev.preventDefault(); setActive(Math.min(active + 1, items.length - 1)); }
      else if (ev.key === "ArrowUp") { ev.preventDefault(); setActive(Math.max(active - 1, 0)); }
      else if (ev.key === "Enter") {
        ev.preventDefault();
        const e = items[active >= 0 ? active : 0];
        if (e) choose(e);
      } else if (ev.key === "Escape") close();
    });
  }

  function scopedInsts() {
    return STATE.insts.filter((i) => {
      if (STATE.selectedDepto && i.depto !== STATE.selectedDepto) return false;
      if (STATE.selectedDistrito && i.distrito !== STATE.selectedDistrito) return false;
      return true;
    });
  }

  function instIcon() {
    return (
      '<svg viewBox="0 0 24 24" width="19" height="19" fill="none">' +
      '<path d="M4 21V8l8-5 8 5v13" stroke="white" stroke-width="1.7" stroke-linejoin="round"/>' +
      '<path d="M9 21v-6h6v6" stroke="white" stroke-width="1.7" stroke-linejoin="round"/>' +
      '<path d="M9 11h.01M15 11h.01M9 15h.01M15 15h.01" stroke="white" stroke-width="1.9" stroke-linecap="round"/>' +
      "</svg>"
    );
  }

  function renderInstGrid() {
    const grid = document.getElementById("inst-grid");
    grid.innerHTML = "";
    if (!STATE.selectedDepto) {
      grid.innerHTML = '<div class="empty-hint">Elegí un departamento para ver sus instituciones.</div>';
      return;
    }
    const insts = scopedInsts().sort((a, b) => a.nombre.localeCompare(b.nombre, "es"));
    if (!insts.length) {
      grid.innerHTML = '<div class="empty-hint">No hay instituciones cargadas en este recorte.</div>';
      return;
    }
    insts.forEach((inst) => {
      const card = document.createElement("div");
      card.className = "inst-card";
      card.dataset.inst = inst.id;
      if (inst.id === STATE.selectedInstId) card.classList.add("active");
      card.innerHTML =
        '<span class="inst-icon">' + instIcon() + "</span>" +
        '<span><span class="inst-name">' + escapeHtml(inst.nombre) + '</span><div class="inst-count">' +
        fmtN(inst.personas) + " persona(s)</div></span>";
      card.addEventListener("click", () => selectInstitucion(inst));
      grid.appendChild(card);
    });
  }

  // Al entrar a una institución se oculta la lista de todas y aparece arriba el botón para volver.
  function listaVisible(visible) {
    document.getElementById("inst-grid").hidden = !visible;
    document.getElementById("btn-volver-lista").hidden = visible;
  }

  // Vuelve a ver todas las instituciones (lista + mapa) y cierra la ficha de la elegida.
  function volverATodas() {
    exitPersonMode();
    clearDetail();
    renderInstGrid();
  }

  function clearDetail() {
    STATE.selectedInstId = null;
    document.getElementById("inst-detail").hidden = true;
    document.getElementById("inst-detail").innerHTML = "";
    hideSelectedPersonCard();
  }

  function renderInstDetail(inst, people) {
    const detail = document.getElementById("inst-detail");
    detail.hidden = false;
    detail.innerHTML =
      "<h3>" + escapeHtml(inst.nombre) + "</h3>" +
      '<div class="inst-fields">' +
      "<div><b>Dirección</b>" + escapeHtml(inst.dir || "—") + "</div>" +
      "<div><b>Ubicación</b>" + escapeHtml(cleanName(inst.depto)) + " · " + escapeHtml(cleanName(inst.distrito || "")) + "</div>" +
      "<div><b>Personas cargadas</b>" + fmtN(inst.personas) + " · " + fmtN(inst.b) + " en Planilla B</div>" +
      "</div>" +
      '<div class="result-links">' +
      '<a class="btn btn-maps" target="_blank" rel="noopener" href="' + googleMapsUrlInstitucion(inst) + '">Cómo llegar</a>' +
      '<button type="button" class="btn btn-secondary btn-excel">⬇ Descargar Excel (grupos de 200 por cercanía)</button>' +
      "</div>" +
      '<p class="excel-estado" hidden></p>' +
      '<p class="planilla-auto-note">Sus personas están en el mapa: con las casillas de arriba del mapa elegís Planilla General, Planilla B y el rango de alcance. Para buscar a alguien, usá el Buscador.</p>';
    const bx = detail.querySelector(".btn-excel");
    if (bx) bx.addEventListener("click", () => descargarExcel(inst, bx, detail.querySelector(".excel-estado")));
  }

  // ---------------------------------------------------------------
  // Excel: Planilla General de una institución dividida en grupos de hasta 200 personas por cercanía.
  // Usa las ubicaciones que ya están guardadas (exactas o aproximadas); no consulta nada a Google.
  // ---------------------------------------------------------------
  const GRUPO_PERSONAS = 200;
  let xlsxPromise = null;

  function cargarXlsx() {
    if (window.XLSX) return Promise.resolve(window.XLSX);
    if (!xlsxPromise) {
      xlsxPromise = new Promise((ok, mal) => {
        const sc = document.createElement("script");
        sc.src = "https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js";
        sc.onload = () => ok(window.XLSX);
        sc.onerror = () => { xlsxPromise = null; mal(new Error("No se pudo cargar el generador de Excel")); };
        document.head.appendChild(sc);
      });
    }
    return xlsxPromise;
  }

  // Parte los puntos en k grupos del mismo tamaño y juntos en el mapa: corta una y otra vez por la
  // dirección en que están más dispersos (norte-sur o este-oeste).
  function dividirPorCercania(pts, k) {
    if (k <= 1 || pts.length <= 1) return [pts];
    let minLa = Infinity, maxLa = -Infinity, minLo = Infinity, maxLo = -Infinity;
    for (const q of pts) {
      if (q.lat < minLa) minLa = q.lat;
      if (q.lat > maxLa) maxLa = q.lat;
      if (q.lng < minLo) minLo = q.lng;
      if (q.lng > maxLo) maxLo = q.lng;
    }
    const porLat = maxLa - minLa >= (maxLo - minLo) * 0.91; // 1° de longitud mide ~0,91 de uno de latitud en Jujuy
    const orden = pts.slice().sort((a, b) => (porLat ? a.lat - b.lat : a.lng - b.lng));
    const kIzq = Math.floor(k / 2);
    const corte = Math.round((orden.length * kIzq) / k);
    return dividirPorCercania(orden.slice(0, corte), kIzq).concat(dividirPorCercania(orden.slice(corte), k - kIzq));
  }

  // Dentro de cada grupo: recorrido del más al norte siguiendo siempre al más cercano.
  function ordenarRecorrido(g) {
    if (g.length < 3) return g;
    const resto = g.slice();
    let i0 = 0;
    for (let i = 1; i < resto.length; i++) if (resto[i].lat > resto[i0].lat) i0 = i;
    const res = [resto.splice(i0, 1)[0]];
    while (resto.length) {
      const a = res[res.length - 1];
      let mejor = 0, dMejor = Infinity;
      for (let i = 0; i < resto.length; i++) {
        const dy = resto[i].lat - a.lat, dx = (resto[i].lng - a.lng) * 0.91;
        const d = dy * dy + dx * dx;
        if (d < dMejor) { dMejor = d; mejor = i; }
      }
      res.push(resto.splice(mejor, 1)[0]);
    }
    return res;
  }

  // Todas las personas de la institución (también las de ubicación aproximada y las sin ubicar).
  async function cargarTodasParaExcel(inst, avisar) {
    const lista = [];
    let desde = 0, quedan = true;
    while (quedan) {
      const r = await window.NexusAuth.rpc("nx_personas_lite", { p_inst: inst.id, p_desde: desde, p_limit: TANDA_PERSONAS, p_solo_exactas: false });
      for (const a of r.items) lista.push(personaDeFila(inst, a));
      desde = r.last;
      quedan = r.more;
      avisar("Preparando el Excel… " + fmtN(lista.length) + " personas leídas");
    }
    return lista;
  }

  function linkMapaPersona(p) {
    if (!p._aprox && p.Latitud != null && p.Longitud != null) {
      return "https://www.google.com/maps/search/?api=1&query=" + p.Latitud + "," + p.Longitud;
    }
    return googleMapsUrl(p);
  }

  async function descargarExcel(inst, btn, estado) {
    const avisar = (t) => { estado.hidden = false; estado.textContent = t; };
    btn.disabled = true;
    try {
      avisar("Preparando el Excel…");
      const [XLSX, personas] = await Promise.all([cargarXlsx(), cargarTodasParaExcel(inst, avisar)]);
      if (!personas.length) { avisar("Esta institución no tiene personas cargadas."); return; }

      const conUbic = [], sinUbic = [];
      for (const p of personas) {
        const la = Number(p.Latitud), lo = Number(p.Longitud);
        if (p.Latitud != null && p.Longitud != null && isFinite(la) && isFinite(lo)) conUbic.push({ p, lat: la, lng: lo });
        else sinUbic.push({ p });
      }
      const grupos = [];
      if (conUbic.length) {
        const k = Math.ceil(conUbic.length / GRUPO_PERSONAS);
        dividirPorCercania(conUbic, k).forEach((g) => grupos.push({ tipo: "ubicadas", items: ordenarRecorrido(g) }));
      }
      sinUbic.sort((a, b) => (a.p.Direccion + " " + a.p.Numero).localeCompare(b.p.Direccion + " " + b.p.Numero, "es"));
      for (let i = 0; i < sinUbic.length; i += GRUPO_PERSONAS) grupos.push({ tipo: "sin", items: sinUbic.slice(i, i + GRUPO_PERSONAS) });

      const cab = ["Grupo", "N°", "Código", "Apellido", "Nombre", "Dirección", "Número", "Departamento", "Distrito", "Institución", "Ubicación", "Latitud", "Longitud", "En Planilla B", "Ver en Google Maps"];
      const anchos = [10, 5, 11, 20, 24, 28, 8, 22, 22, 28, 12, 11, 11, 12, 48];
      const wb = XLSX.utils.book_new();
      const resumen = [["Planilla General · " + inst.nombre], ["Dirección: " + (inst.dir || "—")], ["Personas: " + personas.length + " · en grupos de hasta " + GRUPO_PERSONAS + ", ordenados por cercanía"], [], ["Grupo", "Personas", "Zona (lat, lng)", "Ver en Google Maps"]];
      let nSin = 0, nUb = 0;
      grupos.forEach((g) => {
        const nombre = g.tipo === "sin" ? "Sin ubicar " + String(++nSin).padStart(2, "0") : "Grupo " + String(++nUb).padStart(2, "0");
        let centro = "", link = "";
        if (g.tipo === "ubicadas") {
          const la = g.items.reduce((t, x) => t + x.lat, 0) / g.items.length, lo = g.items.reduce((t, x) => t + x.lng, 0) / g.items.length;
          centro = la.toFixed(5) + ", " + lo.toFixed(5);
          link = "https://www.google.com/maps/search/?api=1&query=" + la.toFixed(6) + "," + lo.toFixed(6);
        }
        resumen.push([nombre, g.items.length, centro || "Sin ubicación en el mapa", link]);
        const filas = [cab];
        g.items.forEach((x, i) => {
          const p = x.p;
          filas.push([nombre, i + 1, p.Codigo, p.Apellido, p.Nombre, p.Direccion, p.Numero, cleanName(p.Departamento), cleanName(p.Distrito), p.Institucion,
            g.tipo === "sin" ? "Sin ubicar" : p._aprox ? "Aproximada" : "Exacta", g.tipo === "sin" ? "" : x.lat, g.tipo === "sin" ? "" : x.lng, p._enB ? "Sí" : "No", linkMapaPersona(p)]);
        });
        const ws = XLSX.utils.aoa_to_sheet(filas);
        ws["!cols"] = anchos.map((w) => ({ wch: w }));
        XLSX.utils.book_append_sheet(wb, ws, nombre);
      });
      const wsR = XLSX.utils.aoa_to_sheet(resumen);
      wsR["!cols"] = [{ wch: 16 }, { wch: 10 }, { wch: 26 }, { wch: 60 }];
      wb.SheetNames.unshift("Resumen");
      wb.Sheets["Resumen"] = wsR;

      const limpio = String(inst.nombre).replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 60);
      XLSX.writeFile(wb, "Planilla General - " + limpio + " - grupos de " + GRUPO_PERSONAS + ".xlsx");
      avisar("Listo: " + fmtN(personas.length) + " personas en " + grupos.length + " grupo(s)" + (sinUbic.length ? " (" + fmtN(sinUbic.length) + " sin ubicación en el mapa, al final)" : "") + ".");
    } catch (e) {
      avisar("No se pudo armar el Excel. Probá de nuevo en un momento.");
    } finally {
      btn.disabled = false;
    }
  }

  // Las personas de una institución llegan por tandas livianas (no todas juntas): la primera se dibuja
  // enseguida y el resto se va sumando. Los datos de la institución no se repiten en cada fila.
  const TANDA_PERSONAS = 1500;

  function personaDeFila(inst, a) {
    return {
      row_number: a[0], Codigo: a[1], Apellido: a[2], Nombre: a[3], Direccion: a[4], Numero: a[5], Orden: a[6],
      _enB: !!a[7], Latitud: a[8], Longitud: a[9], _aprox: !!a[10],
      Departamento: inst.depto, Distrito: inst.distrito || "", Institucion: inst.nombre,
      "Direccion de Institucion": inst.dir || "", inst_id: inst.id,
      Observacion: "", _obsLista: false, // la observación se pide recién al tocar a la persona
    };
  }

  async function loadPeople(inst, onChunk, seq) {
    const clave = inst.id + (STATE.soloReales ? ":reales" : ":todas");
    if (STATE.peopleCache.has(clave)) return STATE.peopleCache.get(clave);
    const people = [];
    let desde = 0, quedan = true;
    while (quedan) {
      const r = await window.NexusAuth.rpc("nx_personas_lite", { p_inst: inst.id, p_desde: desde, p_limit: TANDA_PERSONAS, p_solo_exactas: STATE.soloReales });
      if (desde === 0) { people.total = r.total; people.totalB = r.total_b; } // lo que coincide con el filtro
      for (const a of r.items) {
        const p = personaDeFila(inst, a);
        STATE.rowIndex.set(p.row_number, p);
        people.push(p);
      }
      desde = r.last;
      quedan = r.more;
      if (STATE.selectedInstId !== inst.id || seq !== STATE.loadSeq) return people; // eligió otra o cambió la casilla: no seguir pidiendo ni guardar a medias
      if (onChunk) onChunk(people, quedan);
    }
    STATE.peopleCache.set(clave, people);
    return people;
  }

  async function selectInstitucion(inst, opts) {
    const silent = opts && opts.silent;
    const sinMover = opts && opts.sinMover; // al cambiar la casilla no se vuelve a encuadrar el mapa
    const seq = ++STATE.loadSeq;
    STATE.selectedInstId = inst.id;
    document.querySelectorAll(".inst-card").forEach((c) => {
      c.classList.toggle("active", c.dataset.inst === String(inst.id));
    });
    const detail = document.getElementById("inst-detail");
    if (!silent) {
      detail.hidden = false;
      detail.innerHTML = "<h3>" + escapeHtml(inst.nombre) + '</h3><p class="planilla-auto-note">Cargando personas…</p>';
      detail.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
    let primera = true;
    const alLlegar = (parcial, quedan) => {
      if (STATE.selectedInstId !== inst.id || seq !== STATE.loadSeq) return;
      if (primera) {
        primera = false;
        renderInstDetail(inst, parcial);
        if (!silent) focusInstitutionOnMap(inst, parcial, !sinMover);
      } else if (!silent && STATE.focus && STATE.focus.inst === inst) {
        STATE.focus.people = parcial;
        drawFocusPersons(false, true);
      }
      if (quedan && !silent) {
        document.getElementById("map-note").textContent =
          "Cargando personas… " + fmtN(parcial.length) + " de " + fmtN(parcial.total != null ? parcial.total : inst.personas);
      }
    };
    let people;
    try {
      people = await loadPeople(inst, alLlegar, seq);
    } catch (e) {
      if (STATE.selectedInstId === inst.id) detail.innerHTML = '<p class="planilla-auto-note">No se pudieron cargar las personas. Probá de nuevo.</p>';
      return;
    }
    if (STATE.selectedInstId !== inst.id || seq !== STATE.loadSeq) return; // eligió otra mientras cargaba
    if (primera) { // ya estaban en memoria: se dibuja de una vez
      renderInstDetail(inst, people);
      if (!silent) focusInstitutionOnMap(inst, people, !sinMover);
    }
  }

  // ---------------------------------------------------------------
  // Mapa (Google Maps JS API) — los datos de cada persona se ven recién al tocar su punto
  // ---------------------------------------------------------------
  function ensureMap() {
    if (STATE.map) return STATE.map;
    STATE.map = new google.maps.Map(document.getElementById("map-canvas"), {
      center: { lat: -23.9, lng: -65.45 }, // Jujuy
      zoom: 9,
      mapTypeControl: false,
      streetViewControl: false,
      fullscreenControl: false,
    });
    // "capas" separadas: las instituciones (azul) nunca se borran al mostrar personas
    STATE.institutionMarkers = [];
    STATE.reachCircles = [];
    STATE.personLayer = crearCapaPersonas(STATE.map);

    // un solo InfoWindow compartido para todos los popups (institución o persona)
    STATE.infoWindow = new google.maps.InfoWindow();
    STATE.infoWindow.addListener("domready", () => {
      const btn = document.querySelector(".popup-btn-buscar");
      if (!btn) return;
      btn.addEventListener("click", () => {
        const p = STATE.rowIndex.get(parseInt(btn.dataset.row, 10));
        if (p) jumpToBuscador(p);
      });
    });

    return STATE.map;
  }

  // Capa única: todas las personas se dibujan en UN solo <canvas> sobre el mapa, en vez de un marcador de Google
  // por persona (con miles de marcadores el navegador se traba). Cada punto guarda su persona para el toque.
  function crearCapaPersonas(map) {
    const RADIO = 7, TOQUE = 12;
    class Capa extends google.maps.OverlayView {
      constructor() {
        super();
        this.pts = [];
        this.pendiente = false;
        this.canvas = document.createElement("canvas");
        this.canvas.style.position = "absolute";
        this.canvas.style.pointerEvents = "none";
        this.setMap(map);
      }
      onAdd() { this.getPanes().overlayLayer.appendChild(this.canvas); }
      onRemove() { this.canvas.remove(); }
      add(nuevos) { for (const pt of nuevos) this.pts.push(pt); this.pedirDibujo(); }
      clear() { this.pts.length = 0; this.pedirDibujo(); }
      pedirDibujo() {
        if (this.pendiente) return;
        this.pendiente = true;
        requestAnimationFrame(() => { this.pendiente = false; this.draw(); });
      }
      draw() {
        const proj = this.getProjection(), b = map.getBounds();
        if (!proj || !b) return;
        const sw = proj.fromLatLngToDivPixel(b.getSouthWest()), ne = proj.fromLatLngToDivPixel(b.getNorthEast());
        const ancho = Math.abs(ne.x - sw.x), alto = Math.abs(sw.y - ne.y);
        const mx = ancho * 0.5, my = alto * 0.5; // margen: al arrastrar el mapa no quedan bordes vacíos
        const x0 = Math.min(sw.x, ne.x) - mx, y0 = Math.min(sw.y, ne.y) - my;
        const w = Math.ceil(ancho + 2 * mx), h = Math.ceil(alto + 2 * my);
        const dpr = window.devicePixelRatio || 1;
        const c = this.canvas;
        if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
          c.width = Math.round(w * dpr);
          c.height = Math.round(h * dpr);
        }
        c.style.width = w + "px";
        c.style.height = h + "px";
        c.style.left = x0 + "px";
        c.style.top = y0 + "px";
        const ctx = c.getContext("2d");
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, w, h);
        ctx.lineWidth = 2;
        ctx.strokeStyle = "#fff";
        // primero las de Planilla General, encima las de B
        for (const rojo of [false, true]) {
          for (const pt of this.pts) {
            if (pt.b !== rojo) continue;
            const q = proj.fromLatLngToDivPixel(pt.ll);
            const x = q.x - x0, y = q.y - y0;
            if (x < -RADIO || y < -RADIO || x > w + RADIO || y > h + RADIO) continue;
            ctx.globalAlpha = pt.a ? 0.45 : 1;
            ctx.fillStyle = pt.color;
            ctx.beginPath();
            ctx.arc(x, y, RADIO, 0, 6.2832);
            ctx.fill();
            ctx.stroke();
          }
        }
        ctx.globalAlpha = 1;
      }
      // punto más cercano al toque (dentro de TOQUE píxeles); ante empate gana el de B, que se ve encima
      cercano(latLng) {
        const proj = this.getProjection();
        if (!proj || !latLng) return null;
        const t = proj.fromLatLngToContainerPixel(latLng);
        let mejor = null, dm = TOQUE + 1;
        for (const pt of this.pts) {
          const q = proj.fromLatLngToContainerPixel(pt.ll);
          const d = Math.hypot(q.x - t.x, q.y - t.y) - (pt.b ? 3 : 0);
          if (d <= TOQUE && d < dm) { dm = d; mejor = pt; }
        }
        return mejor;
      }
    }
    const capa = new Capa();
    map.addListener("idle", () => capa.pedirDibujo());
    map.addListener("click", (e) => {
      if (STATE.mapMode !== "personas") return;
      const pt = capa.cercano(e.latLng);
      if (!pt) return;
      STATE.infoWindow.setOptions({ pixelOffset: new google.maps.Size(0, -RADIO) });
      STATE.infoWindow.setContent(popupHtml(pt.p));
      STATE.infoWindow.setPosition(pt.ll);
      STATE.infoWindow.open({ map });
      showSelectedPersonCard(pt.p);
    });
    let ultimoMov = 0;
    map.addListener("mousemove", (e) => {
      const ahora = Date.now();
      if (ahora - ultimoMov < 90 || STATE.mapMode !== "personas") return;
      ultimoMov = ahora;
      map.setOptions({ draggableCursor: capa.cercano(e.latLng) ? "pointer" : null });
    });
    return capa;
  }

  function clearMarkers(arr) {
    arr.forEach((o) => o.setMap(null));
    arr.length = 0;
  }

  function fitToBounds(map, points) {
    if (!points.length) return;
    if (points.length === 1) { // un solo punto: fitBounds acercaría al máximo
      map.setCenter({ lat: points[0][0], lng: points[0][1] });
      map.setZoom(15);
      return;
    }
    const bounds = new google.maps.LatLngBounds();
    points.forEach(([lat, lng]) => bounds.extend({ lat, lng }));
    map.fitBounds(bounds, 30);
  }

  function haversineMeters(lat1, lng1, lat2, lng2) {
    const R = 6371000;
    const toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a =
      Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
  }

  function coloredIcon(color) {
    return {
      path: google.maps.SymbolPath.CIRCLE,
      fillColor: color,
      fillOpacity: 1,
      strokeColor: "#fff",
      strokeWeight: 2,
      scale: 8,
    };
  }

  function popupHtml(p) {
    return (
      '<div class="map-popup">' +
      "<b>" + escapeHtml(p.Codigo + " — " + p.Apellido + " " + p.Nombre) + "</b><br>" +
      "<small>" + escapeHtml(cleanName(p.Departamento) + " · " + cleanName(p.Distrito)) + "</small><br>" +
      escapeHtml(p.Direccion + " " + p.Numero) + "<br>" +
      "<i>" + escapeHtml(p.Institucion) + "</i>" +
      (p._aprox ? '<br><small class="aprox-note">📍 Ubicación aproximada (cerca de la institución)</small>' : "") +
      '<div class="popup-actions">' +
      '<button class="btn btn-secondary popup-btn-buscar" data-row="' + p.row_number + '">🔍 Buscar</button>' +
      '<a class="btn btn-secondary" target="_blank" rel="noopener" href="' + googleSearchUrl(p) + '">Google</a>' +
      '<a class="btn btn-secondary" target="_blank" rel="noopener" href="' + googleMapsUrl(p) + '">Cómo llegar</a>' +
      "</div>" +
      "</div>"
    );
  }

  function showSelectedPersonCard(p) {
    const box = document.getElementById("selected-person-card");
    box.hidden = false;
    box.innerHTML =
      '<div class="sp-head"><span class="sp-name">' +
      p.Apellido +
      " " +
      p.Nombre +
      '</span><span class="sp-codigo">' +
      p.Codigo +
      (p._enB ? " · en Registro B" : "") +
      "</span></div>" +
      '<div class="sp-fields">' +
      "<div><b>Departamento</b>" +
      p.Departamento +
      "</div>" +
      "<div><b>Distrito</b>" +
      p.Distrito +
      "</div>" +
      "<div><b>Dirección</b>" +
      p.Direccion +
      " " +
      p.Numero +
      (p._aprox ? ' <small class="aprox-note">(en el mapa: ubicación aproximada)</small>' : "") +
      "</div>" +
      "<div><b>Orden</b>" +
      p.Orden +
      "</div>" +
      "<div><b>Institución</b>" +
      p.Institucion +
      "</div>" +
      "<div><b>Dirección institución</b>" +
      p["Direccion de Institucion"] +
      "</div>" +
      '<div class="sp-obs"><b>Observación</b>' +
      (p._obsLista === false ? "…" : escapeHtml(getObservacion(p)) || "—") +
      "</div>" +
      "</div>" +
      '<div class="verif-host"></div>' +
      '<div class="result-links">' +
      '<button class="btn btn-secondary sp-btn-buscar">🔍 Buscar en el sistema</button>' +
      '<a class="btn btn-secondary" target="_blank" rel="noopener" href="' +
      googleSearchUrl(p) +
      '">Buscar en Google</a>' +
      '<button type="button" class="btn btn-secondary btn-web">Buscar en la web (IA)</button>' +
      '<a class="btn btn-maps" target="_blank" rel="noopener" href="' +
      googleMapsUrl(p) +
      '">Cómo llegar</a>' +
      "</div>" +
      '<div class="web-host" hidden></div>';
    box.querySelector(".sp-btn-buscar").addEventListener("click", () => jumpToBuscador(p));
    conectarBusquedaWeb(box, p);
    box.scrollIntoView({ behavior: "smooth", block: "nearest" });
    if (p._obsLista !== false) renderVerifControls(box.querySelector(".verif-host"), p);
    if (p._obsLista === false) {
      cargarObservacion(p)
        .then(() => {
          const vh = box.querySelector(".verif-host");
          if (vh && !box.hidden) renderVerifControls(vh, p);
          const el = box.querySelector(".sp-obs");
          if (el && !box.hidden) el.innerHTML = "<b>Observación</b>" + (escapeHtml(getObservacion(p)) || "—");
        })
        .catch(() => {
          const el = box.querySelector(".sp-obs");
          if (el) el.innerHTML = "<b>Observación</b>no se pudo cargar";
        });
    }
  }

  function hideSelectedPersonCard() {
    const box = document.getElementById("selected-person-card");
    box.hidden = true;
    box.innerHTML = "";
  }

  function institucionPopupHtml(inst) {
    return (
      '<div class="map-popup">' +
      "<b>" + escapeHtml(inst.nombre) + "</b><br>" +
      escapeHtml(inst.dir || "—") + "<br>" +
      "<small>" + escapeHtml(cleanName(inst.depto) + " · " + cleanName(inst.distrito || "")) + "</small><br>" +
      fmtN(inst.personas) + " persona(s) cargada(s)" +
      '<div class="popup-actions">' +
      '<a class="btn btn-secondary" target="_blank" rel="noopener" href="' + googleMapsUrlInstitucion(inst) + '">Cómo llegar</a>' +
      "</div>" +
      "</div>"
    );
  }

  // Dibuja los puntos azules de instituciones (ubicación guardada en la base). Si se pasa onlyInst, solo esa.
  function populateInstitutionLayer(onlyInst) {
    const map = ensureMap();
    clearMarkers(STATE.institutionMarkers);
    const list = onlyInst ? [onlyInst] : scopedInsts();
    const bounds = [];
    let sinUbicar = 0;
    for (const inst of list) {
      if (inst.lat == null || inst.lng == null) { sinUbicar++; continue; }
      bounds.push([inst.lat, inst.lng]);
      const marker = new google.maps.Marker({
        position: { lat: inst.lat, lng: inst.lng },
        map: gmChk("inst").checked ? map : null,
        icon: coloredIcon("#2D6CDF"),
      });
      marker.addListener("click", () => {
        STATE.infoWindow.setOptions({ pixelOffset: new google.maps.Size(0, 0) });
        STATE.infoWindow.setContent(institucionPopupHtml(inst));
        STATE.infoWindow.open({ anchor: marker, map });
        selectInstitucion(inst);
      });
      STATE.institutionMarkers.push(marker);
    }
    STATE.instSinUbicar = sinUbicar;
    return bounds;
  }

  function instNote() {
    const base = "Tocá una institución para ver sus datos";
    return STATE.instSinUbicar ? base + " · " + STATE.instSinUbicar + " sin ubicar todavía" : base;
  }

  // Modo "instituciones" (azul) — siempre visible, se recalcula con el filtro de depto/distrito
  function renderInstitutionMarkers() {
    STATE.mapMode = "instituciones";
    STATE.focus = null;
    setPersonToggles(false);
    document.getElementById("btn-volver-instituciones").hidden = true;
    listaVisible(true);
    hideSelectedPersonCard();

    const map = ensureMap();
    STATE.personLayer.clear();
    clearMarkers(STATE.reachCircles);
    setTimeout(() => google.maps.event.trigger(map, "resize"), 50);

    const bounds = populateInstitutionLayer();
    document.getElementById("map-note").textContent = instNote();
    fitToBounds(map, bounds);
  }

  // Al elegir una institución: las demás se ocultan y aparecen los puntos de sus personas.
  function focusInstitutionOnMap(inst, people, encuadrar) {
    STATE.focus = { inst, people };
    populateInstitutionLayer(inst);
    setPersonToggles(true);
    drawFocusPersons(encuadrar !== false);
  }

  // Casillas del mapa (igual que en Mapa general). Las de personas se habilitan al elegir una institución.
  const gmChk = (k) => document.getElementById("gm-chk-" + k);

  function setPersonToggles(enabled) {
    ["general", "b", "reach"].forEach((k) => (gmChk(k).disabled = !enabled));
    document.querySelectorAll(".gm-pers").forEach((l) => l.classList.toggle("is-disabled", !enabled));
    const f = STATE.focus;
    document.getElementById("gm-count-general").textContent = enabled && f ? fmtN(f.people.total != null ? f.people.total : f.inst.personas) : "";
    document.getElementById("gm-count-b").textContent = enabled && f ? fmtN(f.people.totalB != null ? f.people.totalB : f.inst.b) : "";
  }

  function setupMapToggles() {
    gmChk("inst").addEventListener("change", () => {
      const on = gmChk("inst").checked;
      STATE.institutionMarkers.forEach((m) => m.setMap(on ? STATE.map : null));
    });
    ["general", "b"].forEach((k) => gmChk(k).addEventListener("change", () => STATE.focus && drawFocusPersons(false)));
    gmChk("reales").addEventListener("change", () => {
      STATE.soloReales = gmChk("reales").checked;
      const f = STATE.focus;
      // vuelve a pedir las personas con el filtro nuevo; el mapa solo se mantiene en su lugar si ya había puntos a la vista
      if (f) selectInstitucion(f.inst, { sinMover: !!(f.stats && f.stats.visibles > 0) });
    });
    gmChk("reach").addEventListener("change", () => {
      const on = gmChk("reach").checked;
      STATE.reachCircles.forEach((c) => c.setMap(on ? STATE.map : null));
    });
  }

  // Personas de la institución elegida: verde = Planilla General, rojo = está en Planilla B
  // (con las dos casillas, las de B se ven en rojo). Se suma el círculo de rango de alcance.
  // Sin segundo argumento redibuja todo; con incremental=true (llegó otra tanda) solo suma los puntos nuevos.
  function drawFocusPersons(fit, soloNuevas) {
    const { inst, people } = STATE.focus;
    const incremental = !!(soloNuevas && STATE.focus.stats);
    STATE.mapMode = "personas";
    document.getElementById("btn-volver-instituciones").hidden = false;
    listaVisible(false);
    if (!incremental) hideSelectedPersonCard();

    const map = ensureMap();
    clearMarkers(STATE.reachCircles);
    if (!incremental) {
      STATE.personLayer.clear();
      STATE.focus.stats = { maxDist: 0, ubicadas: 0, visibles: 0, aprox: 0, hechas: 0 };
      setTimeout(() => google.maps.event.trigger(map, "resize"), 50);
    }
    const st = STATE.focus.stats;

    const wantG = gmChk("general").checked, wantB = gmChk("b").checked;
    const hasInst = inst.lat != null && inst.lng != null;
    const bounds = [];
    if (hasInst) bounds.push([inst.lat, inst.lng]);
    const desde = incremental ? st.hechas : 0;
    st.hechas = people.length;
    const nuevos = [];
    for (let k = desde; k < people.length; k++) {
      const p = people[k];
      const lat = p.Latitud, lng = p.Longitud;
      if (lat == null || lng == null) continue;
      st.ubicadas++;
      if (p._aprox) st.aprox++;
      // las aproximadas rodean la institución: no definen el rango de alcance
      if (hasInst && !p._aprox) st.maxDist = Math.max(st.maxDist, haversineMeters(inst.lat, inst.lng, lat, lng));
      const color = wantB && p._enB ? "#EB5757" : wantG ? "#27AE60" : null;
      if (!color) continue;
      st.visibles++;
      bounds.push([lat, lng]);
      nuevos.push({ ll: new google.maps.LatLng(lat, lng), p, color, b: color === "#EB5757", a: !!p._aprox });
    }
    STATE.personLayer.add(nuevos);

    if (hasInst && st.maxDist > 0) {
      const radius = Math.min(6000, Math.max(300, st.maxDist * 1.25));
      STATE.reachCircles.push(
        new google.maps.Circle({
          center: { lat: inst.lat, lng: inst.lng },
          radius,
          strokeColor: "#2D6CDF",
          strokeWeight: 1.5,
          strokeOpacity: 0.7,
          fillColor: "#2D6CDF",
          fillOpacity: 0.07,
          map: gmChk("reach").checked ? map : null,
        })
      );
    }

    const faltan = people.length - st.ubicadas;
    const aprox = st.aprox;
    let nota;
    if (STATE.soloReales) {
      const reales = people.total != null ? people.total : people.length;
      nota = reales === 0
        ? "Ninguna persona de esta institución tiene ubicación real · apagá «Solo ubicación real» para ver las " + fmtN(inst.personas) + " con ubicación aproximada"
        : (st.visibles ? "Tocá un punto para ver a la persona" : "Tildá Planilla General o Planilla B para ver sus personas") +
          " · solo ubicación real: " + fmtN(reales) + " de " + fmtN(inst.personas);
    } else {
      nota =
        (st.visibles ? "Tocá un punto para ver a la persona" : "Tildá Planilla General o Planilla B para ver sus personas") +
        (aprox > 0 ? " · " + fmtN(aprox) + " con ubicación aproximada (puntos claros)" : "") +
        (faltan > 0 ? " · " + fmtN(faltan) + " sin ubicar todavía" : "");
    }
    document.getElementById("map-note").textContent = nota;
    if (fit) fitToBounds(map, bounds);
  }

  // Vuelve a mostrar todas las instituciones y saca los puntos verdes/rojos + el círculo de alcance.
  function exitPersonMode() {
    STATE.mapMode = "instituciones";
    STATE.focus = null;
    setPersonToggles(false);
    STATE.personLayer.clear();
    clearMarkers(STATE.reachCircles);
    document.getElementById("btn-volver-instituciones").hidden = true;
    listaVisible(true);
    hideSelectedPersonCard();
    const map = ensureMap();
    const bounds = populateInstitutionLayer();
    document.getElementById("map-note").textContent = instNote();
    fitToBounds(map, bounds);
  }

  // ---------------------------------------------------------------
  // Buscador: solo por código. Busca en la base (620.000 personas),
  // no en el navegador; se espera un instante a que termine de escribir.
  // ---------------------------------------------------------------
  let searchSeq = 0;
  let searchTimer = null;

  function setupBuscador() {
    const input = document.getElementById("input-codigo");
    input.removeAttribute("list");
    const dl = document.getElementById("codigos-list");
    if (dl) dl.remove();
    input.addEventListener("input", () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => runSearch(input.value.trim()), 280);
    });
  }

  async function runSearch(valor) {
    const wrap = document.getElementById("codigo-results");
    const my = ++searchSeq;
    if (!valor) {
      wrap.innerHTML = "";
      return;
    }
    wrap.innerHTML = '<div class="empty-hint">Buscando…</div>';
    let res;
    try {
      res = await window.NexusAuth.rpc("nx_buscar", { p_q: valor, p_limit: 60 });
    } catch (e) {
      if (my === searchSeq) wrap.innerHTML = '<div class="empty-hint">No se pudo buscar. Probá de nuevo.</div>';
      return;
    }
    if (my !== searchSeq) return;
    renderCodigoResults(res.rows || [], res.more);
  }

  function renderCodigoResults(people, more) {
    const wrap = document.getElementById("codigo-results");
    wrap.innerHTML = "";
    if (!people.length) {
      wrap.innerHTML = '<div class="empty-hint">No hay personas con ese código.</div>';
      return;
    }
    people.forEach((p) => STATE.rowIndex.set(p.row_number, p));
    people.forEach((p) => {
      const card = document.createElement("div");
      card.className = "result-card";
      const enB = p._enB;
      card.innerHTML =
        '<div class="result-head">' +
        "<div>" +
        '<div class="result-name">' + escapeHtml(p.Apellido + " " + p.Nombre) + "</div>" +
        '<div class="result-sub">' + escapeHtml(p.Codigo) + " · Orden " + escapeHtml(p.Orden) + "</div>" +
        "</div>" +
        '<div class="status-box ' + (enB ? "is-x" : "is-check") + '" title="' +
        (enB ? "Está en Registro B" : "No está en Registro B") + '">' + (enB ? "✕" : "✓") + "</div>" +
        "</div>" +
        '<div class="result-fields">' +
        "<div><b>Departamento</b>" + escapeHtml(cleanName(p.Departamento)) + "</div>" +
        "<div><b>Distrito</b>" + escapeHtml(cleanName(p.Distrito)) + "</div>" +
        "<div><b>Dirección</b>" + escapeHtml(p.Direccion + " " + p.Numero) + "</div>" +
        "<div><b>Institución</b>" + escapeHtml(p.Institucion) + "</div>" +
        "<div><b>Dirección institución</b>" + escapeHtml(p["Direccion de Institucion"]) + "</div>" +
        "</div>" +
        '<div class="result-links">' +
        '<a class="btn btn-maps" target="_blank" rel="noopener" href="' + googleMapsUrl(p) + '">Ver en Google Maps</a>' +
        '<a class="btn btn-secondary" target="_blank" rel="noopener" href="' + googleSearchUrl(p) + '">Buscar en Google</a>' +
        '<button type="button" class="btn btn-secondary btn-web">Buscar en la web (IA)</button>' +
        "</div>" +
        '<div class="web-host" hidden></div>' +
        '<div class="verif-host"></div>' +
        '<div class="obs-row">' +
        '<textarea placeholder="Observación…">' + escapeHtml(getObservacion(p)) + "</textarea>" +
        '<button class="btn btn-secondary btn-guardar-obs">Guardar</button>' +
        "</div>" +
        '<div class="obs-saved-note"></div>';

      renderVerifControls(card.querySelector(".verif-host"), p);
      conectarBusquedaWeb(card, p);
      const textarea = card.querySelector("textarea");
      const saveBtn = card.querySelector(".btn-guardar-obs");
      const note = card.querySelector(".obs-saved-note");
      saveBtn.addEventListener("click", async () => {
        saveBtn.disabled = true;
        saveBtn.textContent = "Guardando…";
        try {
          await saveObservacion(p, textarea.value);
          note.textContent = "Observación guardada.";
          note.classList.remove("is-error");
          note.classList.add("show");
        } catch (e) {
          note.textContent = "Error al guardar: " + e.message;
          note.classList.add("show", "is-error");
        } finally {
          saveBtn.disabled = false;
          saveBtn.textContent = "Guardar";
          setTimeout(() => note.classList.remove("show"), 2500);
        }
      });

      wrap.appendChild(card);
    });
    if (more) {
      const m = document.createElement("div");
      m.className = "empty-hint";
      m.textContent = "Hay más coincidencias — escribí más letras o el código completo para acotar.";
      wrap.appendChild(m);
    }
  }

  // ---------------------------------------------------------------
  // Mapa general (OpenStreetMap / Leaflet, sin costo): todas las personas ubicadas.
  // Con muchas personas la base devuelve grupos (burbujas con cantidad) según el zoom y el
  // recuadro visible; al acercarse aparece cada persona.
  // ---------------------------------------------------------------
  const OSM = { map: null, layerGeneral: null, layerB: null, layerInst: null, layerReach: null, seq: 0, timer: null };

  function cssVar(name, fallback) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
  }

  function instKey(p) {
    return [p.Departamento, p.Institucion, p["Direccion de Institucion"]].join("|");
  }

  function osmSpread(items) {
    const groups = {};
    items.forEach((it) => {
      const k = it.lat.toFixed(5) + "," + it.lng.toFixed(5);
      (groups[k] = groups[k] || []).push(it);
    });
    Object.values(groups).forEach((g) => {
      g.forEach((it, i) => {
        if (g.length === 1) { it.dLat = it.lat; it.dLng = it.lng; return; }
        const r = 16 * Math.sqrt(i + 1);
        const th = i * 2.4;
        it.dLat = it.lat + (r * Math.cos(th)) / 111320;
        it.dLng = it.lng + (r * Math.sin(th)) / (111320 * Math.cos((it.lat * Math.PI) / 180));
      });
    });
  }

  function osmPopupHtml(it) {
    const tag = it.b
      ? '<span class="osm-tag" style="background:' + cssVar("--c-b", "#EB5757") + '">En Planilla B</span>'
      : '<span class="osm-tag" style="background:' + cssVar("--c-general", "#27AE60") + '">Planilla General</span>';
    return (
      '<div class="osm-popup"><b>' + escapeHtml(it.n) + "</b>" +
      '<div class="osm-sub">' + escapeHtml(it.c || "") + " · Orden " + escapeHtml(it.o) + "<br>" +
      escapeHtml(it.d) + "<br>" +
      escapeHtml(it.i || "") +
      (it.a ? '<br><span class="aprox-note">📍 Ubicación aproximada (cerca de la institución)</span>' : "") +
      "</div>" + tag +
      '<button type="button" class="osm-btn-buscar">🔍 Buscar en el sistema</button></div>'
    );
  }

  function osmInstPopupHtml(inst) {
    const radius = inst.radio;
    return (
      '<div class="osm-popup"><b>' + escapeHtml(inst.nombre) + "</b>" +
      '<div class="osm-sub">' + escapeHtml(inst.dir || "") + "<br>" +
      escapeHtml(cleanName(inst.depto) + " · " + cleanName(inst.distrito || "")) + "<br>" +
      '<b style="display:inline">' + fmtN(inst.personas) + '</b> personas · <b style="display:inline">' + fmtN(inst.b) + "</b> en Planilla B" +
      (radius ? "<br>Rango de alcance: " + (radius >= 1000 ? (radius / 1000).toFixed(1) + " km" : Math.round(radius) + " m") : "") +
      '</div><button type="button" class="osm-btn-inst">Abrir en el Mapa (Google)</button></div>'
    );
  }

  function osmCounts() {
    const located = STATE.insts.filter((i) => i.lat != null).length;
    document.getElementById("osm-count-general").textContent = fmtN(STATE.totals.ubicadas);
    document.getElementById("osm-count-b").textContent = fmtN(STATE.totals.ubicadas_b);
    document.getElementById("osm-count-inst").textContent = located;
  }

  function osmStatus(msg) {
    const t = STATE.totals;
    let s = msg;
    if (t.aproximadas) s += " · " + fmtN(t.aproximadas) + " con ubicación aproximada";
    if (t.general > t.ubicadas) s += " · " + fmtN(t.general - t.ubicadas) + " personas todavía sin ubicar";
    const sinInst = STATE.insts.filter((i) => i.lat == null).length;
    if (sinInst) s += " · " + sinInst + " instituciones sin ubicar";
    document.getElementById("osm-status").textContent = s;
  }

  function osmInstLayers() {
    OSM.layerInst.clearLayers();
    OSM.layerReach.clearLayers();
    const colorI = cssVar("--c-inst", "#2F80ED");
    STATE.insts.forEach((inst) => {
      if (inst.lat == null || inst.lng == null) return;
      let circle = null;
      if (inst.radio) {
        circle = L.circle([inst.lat, inst.lng], {
          radius: inst.radio, color: colorI, weight: 1.4, dashArray: "6 6", fillColor: colorI, fillOpacity: 0.05, interactive: false,
        }).addTo(OSM.layerReach);
      }
      const icon = L.divIcon({
        className: "osm-inst-icon",
        html: '<div class="osm-inst-badge" style="background:' + colorI + '">' + escapeHtml(compactN(inst.personas)) + "</div>",
        iconSize: [34, 34], iconAnchor: [17, 17], popupAnchor: [0, -16],
      });
      const m = L.marker([inst.lat, inst.lng], { icon, zIndexOffset: 1000, title: inst.nombre }).addTo(OSM.layerInst);
      m.bindPopup(osmInstPopupHtml(inst));
      m.on("popupopen", (e) => {
        if (circle) circle.setStyle({ weight: 2.6, fillOpacity: 0.16 });
        const btn = e.popup.getElement().querySelector(".osm-btn-inst");
        if (btn) btn.addEventListener("click", () => {
          document.querySelector('.tab-btn[data-tab="mapa"]').click();
          goToInstitution({ id: inst.id });
        });
      });
      m.on("popupclose", () => circle && circle.setStyle({ weight: 1.4, fillOpacity: 0.05 }));
    });
  }

  function compactN(n) {
    n = Number(n || 0);
    if (n >= 1e6) return (n / 1e6).toFixed(1).replace(".0", "") + "M";
    if (n >= 1e4) return Math.round(n / 1e3) + "k";
    if (n >= 1e3) return (n / 1e3).toFixed(1).replace(".0", "") + "k";
    return String(n);
  }

  function scheduleOsmLoad() {
    clearTimeout(OSM.timer);
    OSM.timer = setTimeout(loadOsmPoints, 250);
  }

  async function loadOsmPoints() {
    if (!OSM.map) return;
    const wantG = document.getElementById("osm-chk-general").checked;
    const wantB = document.getElementById("osm-chk-b").checked;
    const my = ++OSM.seq;
    if (!wantG && !wantB) {
      OSM.layerGeneral.clearLayers();
      OSM.layerB.clearLayers();
      osmStatus("Capas de personas apagadas");
      return;
    }
    const b = OSM.map.getBounds();
    const cell = (60 * 360) / (256 * Math.pow(2, OSM.map.getZoom()));
    let res;
    try {
      res = await window.NexusAuth.rpc("nx_mapa", {
        p_s: b.getSouth(), p_w: b.getWest(), p_n: b.getNorth(), p_e: b.getEast(), p_cell: cell, p_solo_b: !wantG && wantB,
      });
    } catch (e) {
      if (e && e.unauthorized) return;
      // base ocupada (ej. actualizándose desde la planilla): se reintenta solo, sin que el usuario haga nada
      if (my === OSM.seq) {
        osmStatus("La base está ocupada (puede estar actualizándose desde la planilla) · reintentando…");
        clearTimeout(OSM.timer);
        OSM.timer = setTimeout(loadOsmPoints, 6000);
      }
      return;
    }
    if (my !== OSM.seq) return;
    OSM.layerGeneral.clearLayers();
    OSM.layerB.clearLayers();
    const colorG = cssVar("--c-general", "#27AE60");
    const colorB = cssVar("--c-b", "#EB5757");
    const items = res.items || [];

    if (res.mode === "points") {
      osmSpread(items);
      items.forEach((it) => {
        const mk = (color, layer, radius) => {
          const m = L.circleMarker([it.dLat, it.dLng], it.a
            ? { radius, color, weight: 1.5, dashArray: "2 3", fillColor: color, fillOpacity: 0.35 }
            : { radius, color: "#fff", weight: 1.5, fillColor: color, fillOpacity: 0.95 }
          ).addTo(layer);
          m.bindPopup(osmPopupHtml(it));
          m.on("popupopen", (e) => {
            const btn = e.popup.getElement().querySelector(".osm-btn-buscar");
            if (btn) btn.addEventListener("click", () => jumpToBuscadorQuery(it.c));
          });
        };
        if (wantG) mk(colorG, OSM.layerGeneral, 9);
        if (it.b && wantB) mk(colorB, OSM.layerB, wantG ? 6 : 9);
      });
      osmStatus(fmtN(items.length) + " personas a la vista");
    } else {
      items.forEach((c) => {
        const size = 26 + Math.min(26, Math.round(Math.log10(c.n + 1) * 7));
        const onlyB = !wantG && wantB;
        const html =
          '<div class="osm-cl" style="width:' + size + "px;height:" + size + "px;background:" + (onlyB ? colorB : colorG) + '">' +
          escapeHtml(compactN(onlyB ? c.b : c.n)) +
          (wantG && wantB && c.b > 0 ? '<span class="osm-cl-b" style="background:' + colorB + '">' + escapeHtml(compactN(c.b)) + "</span>" : "") +
          "</div>";
        const icon = L.divIcon({ className: "osm-cl-icon", html, iconSize: [size, size], iconAnchor: [size / 2, size / 2] });
        const m = L.marker([c.lat, c.lng], { icon }).addTo(onlyB ? OSM.layerB : OSM.layerGeneral);
        m.on("click", () => OSM.map.setView([c.lat, c.lng], Math.min(OSM.map.getZoom() + 2, 18)));
      });
      osmStatus("Grupos de personas · acercate para ver cada una");
    }
  }

  async function renderOsm(opts) {
    if (!window.L || !OSM.map) return;
    osmCounts();
    osmInstLayers();
    applyOsmToggles();
    if (!(opts && opts.keepView)) {
      const pts = STATE.insts.filter((i) => i.lat != null).map((i) => [i.lat, i.lng]);
      if (pts.length) OSM.map.fitBounds(L.latLngBounds(pts), { padding: [30, 30], maxZoom: 15 });
    }
    scheduleOsmLoad();
  }

  function applyOsmToggles() {
    if (!OSM.map) return;
    const want = {
      inst: document.getElementById("osm-chk-inst").checked,
      reach: document.getElementById("osm-chk-reach").checked,
    };
    [["inst", OSM.layerInst], ["reach", OSM.layerReach]].forEach(([k, layer]) => {
      const on = OSM.map.hasLayer(layer);
      if (want[k] && !on) OSM.map.addLayer(layer);
      if (!want[k] && on) OSM.map.removeLayer(layer);
    });
    if (want.reach) OSM.layerReach.eachLayer((l) => l.bringToBack());
  }

  function openOsmTab() {
    if (!window.L) {
      document.getElementById("osm-status").textContent = "No se pudo cargar el mapa (Leaflet).";
      return;
    }
    if (!OSM.map) {
      OSM.map = L.map("osm-canvas", { zoomControl: true }).setView([-23.4, -65.4], 8);
      L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      }).addTo(OSM.map);
      OSM.layerReach = L.layerGroup().addTo(OSM.map);
      OSM.layerGeneral = L.layerGroup().addTo(OSM.map);
      OSM.layerB = L.layerGroup().addTo(OSM.map);
      OSM.layerInst = L.layerGroup().addTo(OSM.map);
      ["inst", "reach"].forEach((k) => document.getElementById("osm-chk-" + k).addEventListener("change", applyOsmToggles));
      ["general", "b"].forEach((k) => document.getElementById("osm-chk-" + k).addEventListener("change", scheduleOsmLoad));
      OSM.map.on("moveend", scheduleOsmLoad);
      renderOsm();
    } else {
      OSM.map.invalidateSize();
    }
  }

  // ---------------------------------------------------------------
  // Actualización manual desde la planilla (solo con clave de administrador).
  // La clave la valida la base (nx_sync_pedir); recién ahí se avisa a n8n, que sin
  // un pedido válido no hace nada. Al terminar, el sitio se refresca solo.
  // ---------------------------------------------------------------
  const SYNC_WEBHOOK = "https://n8n.consultorarz.com/webhook/nexus-sync-ahora";

  function setupAdminSync() {
    const openBtn = document.getElementById("admin-sync-open");
    const form = document.getElementById("admin-sync-form");
    const input = document.getElementById("admin-sync-clave");
    const msg = document.getElementById("admin-sync-msg");
    if (!openBtn || !form) return;
    openBtn.addEventListener("click", () => {
      form.hidden = !form.hidden;
      msg.textContent = "";
      if (!form.hidden) input.focus();
    });
    form.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const btn = form.querySelector("button[type=submit]");
      btn.disabled = true;
      msg.textContent = "Verificando…";
      try {
        const r = await window.NexusAuth.rpc("nx_sync_pedir", { p_clave: input.value });
        if (!r || !r.ok) {
          msg.textContent = (r && r.error) || "No se pudo pedir la actualización.";
          return;
        }
        input.value = "";
        if (r.en_curso) {
          msg.textContent = "Ya hay una actualización en curso. El sistema se refresca solo cuando termina.";
          form.hidden = true;
          return;
        }
        await avisarN8n();
        msg.textContent = "Listo: se está leyendo la planilla. Tarda unos 8 minutos y el sistema se actualiza solo, no hace falta recargar.";
        form.hidden = true;
      } catch (e) {
        if (e && e.unauthorized) return;
        msg.textContent = "No se pudo avisar al servidor. Probá de nuevo en un rato.";
      } finally {
        btn.disabled = false;
      }
    });

    // Confirmar un borrado masivo que el control de seguridad frenó (vale una sola vez)
    const auth = document.getElementById("admin-auth");
    const authForm = document.getElementById("admin-auth-form");
    const authInput = document.getElementById("admin-auth-clave");
    if (!authForm) return;
    authForm.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const btn = authForm.querySelector("button[type=submit]");
      btn.disabled = true;
      msg.textContent = "Verificando…";
      try {
        const r = await window.NexusAuth.rpc("nx_sync_autorizar", { p_clave: authInput.value });
        if (!r || !r.ok) {
          msg.textContent = (r && r.error) || "No se pudo confirmar.";
          return;
        }
        authInput.value = "";
        auth.hidden = true;
        if (r.en_curso) {
          msg.textContent = "Ya hay una actualización en curso. El sistema se refresca solo cuando termina.";
          return;
        }
        await avisarN8n();
        msg.textContent = "Confirmado: el sistema se está reemplazando con lo que hay en la planilla. Tarda unos minutos y se actualiza solo.";
      } catch (e) {
        if (e && e.unauthorized) return;
        msg.textContent = "No se pudo avisar al servidor. Probá de nuevo en un rato.";
      } finally {
        btn.disabled = false;
      }
    });
  }

  // no-cors + text/plain: pedido simple, sin consulta previa; solo falla si no hay red
  function avisarN8n() {
    return fetch(SYNC_WEBHOOK, { method: "POST", mode: "no-cors", headers: { "Content-Type": "text/plain" }, body: "{}" });
  }


  // ---------------------------------------------------------------
  // Verificaciones: Verificado / Contactado / WhatsApp por persona (se guarda en la base al instante)
  // ---------------------------------------------------------------
  async function saveVerif(p, args) {
    const data = await window.NexusAuth.rpc("nx_verificacion", Object.assign({ p_codigo: String(p.Codigo) }, args));
    if (!data.ok) throw new Error(data.error || "No se pudo guardar");
    if ("p_verificado" in args) p.Verificado = args.p_verificado;
    if ("p_contactado" in args) p.Contactado = args.p_contactado;
    if ("p_whatsapp" in args) p.WhatsApp = args.p_whatsapp;
  }

  function waLink(num) {
    const d = String(num || "").replace(/\D/g, "");
    return d.length >= 8 ? "https://wa.me/" + d : "";
  }

  function renderVerifControls(host, p, onSaved) {
    if (!host) return;
    host.innerHTML =
      '<div class="verif-row">' +
      '<label class="verif-field"><span>Verificación</span><select class="verif-sel" data-k="ver">' +
      '<option value="no">Sin verificar</option><option value="si">Verificado</option></select></label>' +
      '<label class="verif-field"><span>Contacto</span><select class="verif-sel" data-k="con">' +
      '<option value="no">Sin contactar</option><option value="si">Contactado</option></select></label>' +
      '<label class="verif-field verif-field--wsp"><span>WhatsApp</span><span class="verif-wsp-row">' +
      '<input class="verif-wsp" type="tel" inputmode="tel" maxlength="30" placeholder="+54 9 388 …" autocomplete="off">' +
      '<button type="button" class="btn btn-secondary verif-wsp-save">Guardar</button>' +
      '<a class="btn btn-secondary verif-wsp-open" target="_blank" rel="noopener" hidden>Abrir</a></span></label>' +
      "</div>" +
      '<div class="verif-note" role="status"></div>';
    const selV = host.querySelector('[data-k="ver"]');
    const selC = host.querySelector('[data-k="con"]');
    const wsp = host.querySelector(".verif-wsp");
    const wspBtn = host.querySelector(".verif-wsp-save");
    const wspOpen = host.querySelector(".verif-wsp-open");
    const note = host.querySelector(".verif-note");
    selV.value = p.Verificado ? "si" : "no";
    selC.value = p.Contactado ? "si" : "no";
    wsp.value = p.WhatsApp || "";
    const paint = () => {
      selV.classList.toggle("is-on", selV.value === "si");
      selC.classList.toggle("is-on", selC.value === "si");
      const l = waLink(p.WhatsApp);
      wspOpen.hidden = !l;
      if (l) wspOpen.href = l;
    };
    paint();
    let noteTimer;
    const say = (msg, err) => {
      note.textContent = msg;
      note.classList.toggle("is-error", !!err);
      note.classList.add("show");
      clearTimeout(noteTimer);
      noteTimer = setTimeout(() => note.classList.remove("show"), 2500);
    };
    async function guardar(args, sel, anterior) {
      if (sel) sel.disabled = true;
      wspBtn.disabled = true;
      try {
        await saveVerif(p, args);
        say("Guardado.");
        if (onSaved) onSaved(p);
      } catch (e) {
        if (sel) sel.value = anterior;
        say("Error al guardar: " + e.message, true);
      } finally {
        if (sel) sel.disabled = false;
        wspBtn.disabled = false;
        paint();
      }
    }
    selV.addEventListener("change", () => guardar({ p_verificado: selV.value === "si" }, selV, selV.value === "si" ? "no" : "si"));
    selC.addEventListener("change", () => guardar({ p_contactado: selC.value === "si" }, selC, selC.value === "si" ? "no" : "si"));
    const guardarWsp = () => {
      if (wsp.value.trim() === (p.WhatsApp || "")) return;
      guardar({ p_whatsapp: wsp.value.trim() }, null);
    };
    wspBtn.addEventListener("click", guardarWsp);
    wsp.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        guardarWsp();
      }
    });
  }

  const VERIF = { after: 0, seq: 0, abierta: false };

  async function cargarVerifResumen() {
    try {
      const r = await window.NexusAuth.rpc("nx_verif_resumen");
      document.getElementById("vf-total").textContent = fmtN(r.total);
      document.getElementById("vf-ver").textContent = fmtN(r.verificados);
      document.getElementById("vf-con").textContent = fmtN(r.contactados);
      document.getElementById("vf-wsp").textContent = fmtN(r.con_whatsapp);
    } catch (e) {
      /* el resumen es solo informativo */
    }
  }

  async function cargarVerifLista(append) {
    const wrap = document.getElementById("vf-results");
    const moreBtn = document.getElementById("vf-more");
    const my = ++VERIF.seq;
    if (!append) {
      VERIF.after = 0;
      wrap.innerHTML = '<div class="empty-hint">Buscando…</div>';
    }
    moreBtn.hidden = true;
    let res;
    try {
      res = await window.NexusAuth.rpc("nx_verif_lista", {
        p_verif: document.getElementById("vf-verif").value,
        p_cont: document.getElementById("vf-cont").value,
        p_wsp: document.getElementById("vf-wsp-f").value,
        p_q: document.getElementById("vf-q").value.trim(),
        p_after: VERIF.after,
        p_limit: 40,
      });
    } catch (e) {
      if (my === VERIF.seq) wrap.innerHTML = '<div class="empty-hint">No se pudo cargar. Probá de nuevo.</div>';
      return;
    }
    if (my !== VERIF.seq) return;
    const rows = res.rows || [];
    if (!append) wrap.innerHTML = "";
    if (!rows.length && !append) {
      wrap.innerHTML = '<div class="empty-hint">No hay personas con ese filtro.</div>';
      return;
    }
    rows.forEach((p) => {
      const card = document.createElement("div");
      card.className = "result-card vf-card";
      card.innerHTML =
        '<div class="result-head"><div>' +
        '<div class="result-name">' + escapeHtml(p.Apellido + " " + p.Nombre) + "</div>" +
        '<div class="result-sub">' + escapeHtml(p.Codigo) + " · " + escapeHtml(p.Institucion || "") + " · " +
        escapeHtml(cleanName(p.Departamento)) + "</div></div></div>" +
        '<div class="verif-host"></div>';
      renderVerifControls(card.querySelector(".verif-host"), p, cargarVerifResumen);
      wrap.appendChild(card);
    });
    if (rows.length) VERIF.after = rows[rows.length - 1].row_number;
    moreBtn.hidden = !res.more;
  }

  function setupVerificaciones() {
    let t;
    const recargar = () => cargarVerifLista(false);
    ["vf-verif", "vf-cont", "vf-wsp-f"].forEach((id) => document.getElementById(id).addEventListener("change", recargar));
    document.getElementById("vf-q").addEventListener("input", () => {
      clearTimeout(t);
      t = setTimeout(recargar, 350);
    });
    document.getElementById("vf-more").addEventListener("click", () => cargarVerifLista(true));
  }

  function openVerificacionesTab() {
    cargarVerifResumen();
    if (!VERIF.abierta) {
      VERIF.abierta = true;
      cargarVerifLista(false);
    }
  }

  // ---------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------
  async function init() {
    setupTabs();
    try {
      await loadData();
    } catch (e) {
      if (e && e.unauthorized) return;
      document.getElementById("live-stamp").textContent = "No se pudo conectar con la base de datos. Recargá la página.";
      throw e;
    }
    renderInicio();
    populateDeptoSelect();
    setupInstSearch();
    populateDistritoSelect();
    renderInstGrid();
    setupBuscador();
    setupVerificaciones();
    setupAdminSync();
    setupMapToggles();
    document.getElementById("btn-volver-instituciones").addEventListener("click", volverATodas);
    document.getElementById("btn-volver-lista").addEventListener("click", volverATodas);
    const logoutBtn = document.getElementById("logout-btn");
    if (logoutBtn) logoutBtn.addEventListener("click", () => window.NexusAuth.logout());
    startAutoRefresh();
  }

  window.NexusAuth.ready.then(init);
})();
