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
    personMarkers: [],
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
    jumpToBuscadorQuery(p.Apellido + " " + p.Nombre);
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
      ? "⚠️ La actualización desde la planilla está frenada: " + data.sync_error
      : "";
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
        document.getElementById("tab-" + btn.dataset.tab).classList.add("active");
        if (btn.dataset.tab === "mapa") {
          STATE.mapaTabVisitada = true;
          renderInstitutionMarkers();
        }
        if (btn.dataset.tab === "osm") openOsmTab();
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
      el.textContent = Math.round(eased * to);
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
  }

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
      "<div><b>Personas cargadas</b>" + fmtN(people.length) + " · " + fmtN(people.filter((p) => p._enB).length) + " en Planilla B</div>" +
      "</div>" +
      '<div class="result-links">' +
      '<a class="btn btn-maps" target="_blank" rel="noopener" href="' + googleMapsUrlInstitucion(inst) + '">Cómo llegar</a>' +
      "</div>" +
      '<p class="planilla-auto-note">Sus personas están en el mapa: con las casillas de arriba del mapa elegís Planilla General, Planilla B y el rango de alcance. Para buscar a alguien, usá el Buscador.</p>';
  }

  async function loadPeople(inst) {
    if (STATE.peopleCache.has(inst.id)) return STATE.peopleCache.get(inst.id);
    const people = await window.NexusAuth.rpc("nx_personas", { p_inst: inst.id, p_limit: 8000 });
    people.forEach((p) => STATE.rowIndex.set(p.row_number, p));
    STATE.peopleCache.set(inst.id, people);
    return people;
  }

  async function selectInstitucion(inst, opts) {
    const silent = opts && opts.silent;
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
    let people;
    try {
      people = await loadPeople(inst);
    } catch (e) {
      if (STATE.selectedInstId === inst.id) detail.innerHTML = '<p class="planilla-auto-note">No se pudieron cargar las personas. Probá de nuevo.</p>';
      return;
    }
    if (STATE.selectedInstId !== inst.id) return; // eligió otra mientras cargaba
    renderInstDetail(inst, people);
    if (!silent) focusInstitutionOnMap(inst, people);
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
    STATE.personMarkers = [];

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

  function clearMarkers(arr) {
    arr.forEach((o) => o.setMap(null));
    arr.length = 0;
  }

  function fitToBounds(map, points) {
    if (!points.length) return;
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
      "<div><b>Observación</b>" +
      (getObservacion(p) || "—") +
      "</div>" +
      "</div>" +
      '<div class="result-links">' +
      '<button class="btn btn-secondary sp-btn-buscar">🔍 Buscar en el sistema</button>' +
      '<a class="btn btn-secondary" target="_blank" rel="noopener" href="' +
      googleSearchUrl(p) +
      '">Buscar en Google</a>' +
      '<a class="btn btn-maps" target="_blank" rel="noopener" href="' +
      googleMapsUrl(p) +
      '">Cómo llegar</a>' +
      "</div>";
    box.querySelector(".sp-btn-buscar").addEventListener("click", () => jumpToBuscador(p));
    box.scrollIntoView({ behavior: "smooth", block: "nearest" });
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
    hideSelectedPersonCard();

    const map = ensureMap();
    clearMarkers(STATE.personMarkers);
    clearMarkers(STATE.reachCircles);
    setTimeout(() => google.maps.event.trigger(map, "resize"), 50);

    const bounds = populateInstitutionLayer();
    document.getElementById("map-note").textContent = instNote();
    fitToBounds(map, bounds);
  }

  // Al elegir una institución: las demás se ocultan y aparecen los puntos de sus personas.
  function focusInstitutionOnMap(inst, people) {
    STATE.focus = { inst, people };
    populateInstitutionLayer(inst);
    setPersonToggles(true);
    drawFocusPersons(true);
  }

  // Casillas del mapa (igual que en Mapa general). Las de personas se habilitan al elegir una institución.
  const gmChk = (k) => document.getElementById("gm-chk-" + k);

  function setPersonToggles(enabled) {
    ["general", "b", "reach"].forEach((k) => (gmChk(k).disabled = !enabled));
    document.querySelectorAll(".gm-pers").forEach((l) => l.classList.toggle("is-disabled", !enabled));
    const f = STATE.focus;
    document.getElementById("gm-count-general").textContent = enabled && f ? fmtN(f.people.length) : "";
    document.getElementById("gm-count-b").textContent = enabled && f ? fmtN(f.people.filter((p) => p._enB).length) : "";
  }

  function setupMapToggles() {
    gmChk("inst").addEventListener("change", () => {
      const on = gmChk("inst").checked;
      STATE.institutionMarkers.forEach((m) => m.setMap(on ? STATE.map : null));
    });
    ["general", "b"].forEach((k) => gmChk(k).addEventListener("change", () => STATE.focus && drawFocusPersons(false)));
    gmChk("reach").addEventListener("change", () => {
      const on = gmChk("reach").checked;
      STATE.reachCircles.forEach((c) => c.setMap(on ? STATE.map : null));
    });
  }

  // Personas de la institución elegida: verde = Planilla General, rojo = está en Planilla B
  // (con las dos casillas, las de B se ven en rojo). Se suma el círculo de rango de alcance.
  function drawFocusPersons(fit) {
    const { inst, people } = STATE.focus;
    STATE.mapMode = "personas";
    document.getElementById("btn-volver-instituciones").hidden = false;
    hideSelectedPersonCard();

    const map = ensureMap();
    clearMarkers(STATE.personMarkers);
    clearMarkers(STATE.reachCircles);
    setTimeout(() => google.maps.event.trigger(map, "resize"), 50);

    const wantG = gmChk("general").checked, wantB = gmChk("b").checked;
    const hasInst = inst.lat != null && inst.lng != null;
    const bounds = [];
    if (hasInst) bounds.push([inst.lat, inst.lng]);
    let maxDist = 0;
    let ubicadas = 0, visibles = 0;
    for (const p of people) {
      const lat = p.Latitud, lng = p.Longitud;
      if (lat == null || lng == null) continue;
      ubicadas++;
      // las aproximadas rodean la institución: no definen el rango de alcance
      if (hasInst && !p._aprox) maxDist = Math.max(maxDist, haversineMeters(inst.lat, inst.lng, lat, lng));
      const color = wantB && p._enB ? "#EB5757" : wantG ? "#27AE60" : null;
      if (!color) continue;
      visibles++;
      bounds.push([lat, lng]);
      const marker = new google.maps.Marker({ position: { lat, lng }, map, icon: coloredIcon(color), opacity: p._aprox ? 0.45 : 1, zIndex: color === "#EB5757" ? 2 : 1 });
      marker.addListener("click", () => {
        STATE.infoWindow.setContent(popupHtml(p));
        STATE.infoWindow.open({ anchor: marker, map });
        showSelectedPersonCard(p);
      });
      STATE.personMarkers.push(marker);
    }

    if (hasInst && maxDist > 0) {
      const radius = Math.min(6000, Math.max(300, maxDist * 1.25));
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

    const faltan = people.length - ubicadas;
    const aprox = people.filter((p) => p._aprox).length;
    document.getElementById("map-note").textContent =
      (visibles ? "Tocá un punto para ver a la persona" : "Tildá Planilla General o Planilla B para ver sus personas") +
      (aprox > 0 ? " · " + fmtN(aprox) + " con ubicación aproximada (puntos claros)" : "") +
      (faltan > 0 ? " · " + fmtN(faltan) + " sin ubicar todavía" : "");
    if (fit) fitToBounds(map, bounds);
  }

  // Vuelve a mostrar todas las instituciones y saca los puntos verdes/rojos + el círculo de alcance.
  function exitPersonMode() {
    STATE.mapMode = "instituciones";
    STATE.focus = null;
    setPersonToggles(false);
    clearMarkers(STATE.personMarkers);
    clearMarkers(STATE.reachCircles);
    document.getElementById("btn-volver-instituciones").hidden = true;
    hideSelectedPersonCard();
    const map = ensureMap();
    const bounds = populateInstitutionLayer();
    document.getElementById("map-note").textContent = instNote();
    fitToBounds(map, bounds);
  }

  // ---------------------------------------------------------------
  // Buscador: código, o nombre y apellido en cualquier orden. Busca en la base (620.000 personas),
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
      wrap.innerHTML = '<div class="empty-hint">No hay personas que coincidan con ese código o nombre.</div>';
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
        "</div>" +
        '<div class="obs-row">' +
        '<textarea placeholder="Observación…">' + escapeHtml(getObservacion(p)) + "</textarea>" +
        '<button class="btn btn-secondary btn-guardar-obs">Guardar</button>' +
        "</div>" +
        '<div class="obs-saved-note"></div>';

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
        // no-cors + text/plain: pedido simple, sin consulta previa; solo falla si no hay red
        await fetch(SYNC_WEBHOOK, { method: "POST", mode: "no-cors", headers: { "Content-Type": "text/plain" }, body: "{}" });
        msg.textContent = "Listo: se está leyendo la planilla. Tarda unos 8 minutos y el sistema se actualiza solo, no hace falta recargar.";
        form.hidden = true;
      } catch (e) {
        if (e && e.unauthorized) return;
        msg.textContent = "No se pudo avisar al servidor. Probá de nuevo en un rato.";
      } finally {
        btn.disabled = false;
      }
    });
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
    setupAdminSync();
    setupMapToggles();
    document.getElementById("btn-volver-instituciones").addEventListener("click", () => {
      exitPersonMode();
    });
    const logoutBtn = document.getElementById("logout-btn");
    if (logoutBtn) logoutBtn.addEventListener("click", () => window.NexusAuth.logout());
    startAutoRefresh();
  }

  window.NexusAuth.ready.then(init);
})();
