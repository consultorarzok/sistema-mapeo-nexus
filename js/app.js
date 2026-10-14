(function () {
  "use strict";

  const STATE = {
    general: [],
    registroB: [],
    selectedDepto: "",
    selectedDistrito: "",
    selectedInstitucion: "",
    map: null,
    markerLayer: null,
  };

  const GEOCODE_CACHE_KEY = "nexus_geocode_cache_v1";
  const OBS_OVERRIDES_KEY = "nexus_obs_overrides_v1"; // demo-only, guarda observaciones locales hasta que se conecte el Google Sheet real

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

  function personKey(p) {
    return normalize(p.Nombre) + "|" + normalize(p.Apellido);
  }

  function loadGeocodeCache() {
    try {
      return JSON.parse(localStorage.getItem(GEOCODE_CACHE_KEY) || "{}");
    } catch (e) {
      return {};
    }
  }
  function saveGeocodeCache(cache) {
    try {
      localStorage.setItem(GEOCODE_CACHE_KEY, JSON.stringify(cache));
    } catch (e) {}
  }

  function loadObsOverrides() {
    try {
      return JSON.parse(localStorage.getItem(OBS_OVERRIDES_KEY) || "{}");
    } catch (e) {
      return {};
    }
  }
  function saveObsOverride(orden, texto) {
    const o = loadObsOverrides();
    o[orden] = texto;
    try {
      localStorage.setItem(OBS_OVERRIDES_KEY, JSON.stringify(o));
    } catch (e) {}
  }
  function getObservacion(p) {
    const overrides = loadObsOverrides();
    if (Object.prototype.hasOwnProperty.call(overrides, p.Orden)) return overrides[p.Orden];
    return p.Observacion || "";
  }

  // ---------------------------------------------------------------
  // Geocoding (Nominatim / OpenStreetMap) — etapa gratuita, sin API key.
  // Más adelante se reemplaza por Google Maps API (pago) sin tocar el resto del front.
  // ---------------------------------------------------------------
  async function geocode(address) {
    const cache = loadGeocodeCache();
    if (cache[address]) return cache[address];
    try {
      const url =
        "https://nominatim.openstreetmap.org/search?format=json&limit=1&q=" +
        encodeURIComponent(address);
      const res = await fetch(url, { headers: { Accept: "application/json" } });
      const data = await res.json();
      if (data && data[0]) {
        const coords = { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) };
        cache[address] = coords;
        saveGeocodeCache(cache);
        return coords;
      }
    } catch (e) {
      console.warn("geocode fallo", address, e);
    }
    return null;
  }

  function fullAddress(p, useInstitucion) {
    if (useInstitucion) {
      return p["Direccion de Institucion"] + ", " + p.Departamento + ", Jujuy, Argentina";
    }
    return p.Direccion + " " + p.Numero + ", " + p.Departamento + ", Jujuy, Argentina";
  }

  function googleMapsUrl(p) {
    const q = p.Direccion + " " + p.Numero + ", " + p.Departamento + ", Jujuy, Argentina";
    return "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent(q);
  }

  // ---------------------------------------------------------------
  // Carga de datos
  // ---------------------------------------------------------------
  async function loadData() {
    const [gRes, bRes] = await Promise.all([
      fetch("js/data-general.json"),
      fetch("js/data-b.json"),
    ]);
    STATE.general = await gRes.json();
    STATE.registroB = await bRes.json();
    const bKeys = new Set(STATE.registroB.map(personKey));
    STATE.general.forEach((p) => {
      p._enB = bKeys.has(personKey(p));
    });
  }

  // ---------------------------------------------------------------
  // Tabs
  // ---------------------------------------------------------------
  function setupTabs() {
    document.querySelectorAll(".tab-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
        document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
        btn.classList.add("active");
        document.getElementById("tab-" + btn.dataset.tab).classList.add("active");
      });
    });
  }

  // ---------------------------------------------------------------
  // Inicio
  // ---------------------------------------------------------------
  function renderInicio() {
    const total = STATE.general.length;
    const totalB = STATE.registroB.length;
    const pct = total ? ((totalB / total) * 100).toFixed(1) : "0.0";
    document.getElementById("stat-general").textContent = total;
    document.getElementById("stat-b").textContent = totalB;
    document.getElementById("stat-b-pct").textContent = pct + "%";
  }

  // ---------------------------------------------------------------
  // Mapa: Departamento -> Distrito -> Instituciones -> Personas
  // ---------------------------------------------------------------
  function uniqueSorted(arr) {
    return Array.from(new Set(arr)).sort((a, b) => a.localeCompare(b, "es"));
  }

  function populateDeptoSelect() {
    const sel = document.getElementById("sel-depto");
    const deptos = uniqueSorted(STATE.general.map((p) => p.Departamento));
    deptos.forEach((d) => {
      const opt = document.createElement("option");
      opt.value = d;
      opt.textContent = d;
      sel.appendChild(opt);
    });
    sel.addEventListener("change", () => {
      STATE.selectedDepto = sel.value;
      STATE.selectedDistrito = "";
      populateDistritoSelect();
      renderInstGrid();
      clearDetail();
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
      STATE.general.filter((p) => p.Departamento === STATE.selectedDepto).map((p) => p.Distrito)
    );
    distritos.forEach((d) => {
      const opt = document.createElement("option");
      opt.value = d;
      opt.textContent = d;
      sel.appendChild(opt);
    });
    sel.disabled = false;
    sel.onchange = () => {
      STATE.selectedDistrito = sel.value;
      renderInstGrid();
      clearDetail();
    };
  }

  function scopedPeople() {
    return STATE.general.filter((p) => {
      if (STATE.selectedDepto && p.Departamento !== STATE.selectedDepto) return false;
      if (STATE.selectedDistrito && p.Distrito !== STATE.selectedDistrito) return false;
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
    const people = scopedPeople();
    const byInst = {};
    people.forEach((p) => {
      byInst[p.Institucion] = byInst[p.Institucion] || [];
      byInst[p.Institucion].push(p);
    });
    const names = uniqueSorted(Object.keys(byInst));
    if (!names.length) {
      grid.innerHTML = '<div class="empty-hint">No hay instituciones cargadas en este recorte.</div>';
      return;
    }
    names.forEach((name) => {
      const card = document.createElement("div");
      card.className = "inst-card";
      card.innerHTML =
        '<span class="inst-icon">' +
        instIcon() +
        "</span>" +
        '<span><span class="inst-name">' +
        name +
        '</span><div class="inst-count">' +
        byInst[name].length +
        " persona(s)</div></span>";
      card.addEventListener("click", () => {
        document.querySelectorAll(".inst-card").forEach((c) => c.classList.remove("active"));
        card.classList.add("active");
        STATE.selectedInstitucion = name;
        renderInstDetail(byInst[name]);
      });
      grid.appendChild(card);
    });
  }

  function clearDetail() {
    document.getElementById("inst-detail").hidden = true;
    document.getElementById("inst-detail").innerHTML = "";
    document.getElementById("map-wrap").hidden = true;
  }

  function renderInstDetail(people) {
    const detail = document.getElementById("inst-detail");
    detail.hidden = false;
    detail.innerHTML =
      "<h3>" +
      STATE.selectedInstitucion +
      "</h3>" +
      '<div class="point-list">' +
      people
        .map(
          (p) =>
            '<span class="point-chip"><span class="codigo-mono">' +
            p.Codigo +
            "</span> · " +
            p.Nombre +
            " " +
            p.Apellido +
            "</span>"
        )
        .join("") +
      "</div>" +
      '<div class="planilla-btns">' +
      '<button class="btn btn-general" id="btn-planilla-general">Planilla General</button>' +
      '<button class="btn btn-b" id="btn-planilla-b">Planilla B</button>' +
      "</div>" +
      '<div id="person-grid" class="person-grid"></div>';

    document.getElementById("btn-planilla-general").addEventListener("click", () => {
      renderPersonGrid(people, "general");
      showMapFor(people, "general");
    });
    document.getElementById("btn-planilla-b").addEventListener("click", () => {
      const matches = people.filter((p) => p._enB);
      renderPersonGrid(matches, "b");
      showMapFor(matches, "b");
    });
  }

  function personFieldsHtml(p) {
    return (
      '<div class="person-fields">' +
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
      "</div>" +
      "<div><b>Institución</b>" +
      p.Institucion +
      "</div>" +
      "<div><b>Dirección institución</b>" +
      p["Direccion de Institucion"] +
      "</div>" +
      "</div>"
    );
  }

  function renderPersonGrid(people, kind) {
    const grid = document.getElementById("person-grid");
    if (!people.length) {
      grid.innerHTML =
        '<div class="empty-hint">' +
        (kind === "b"
          ? "Ninguna de estas personas está en Registro B todavía."
          : "No hay personas para mostrar.") +
        "</div>";
      return;
    }
    grid.innerHTML = people
      .map(
        (p) =>
          '<div class="person-card ' +
          (kind === "b" ? "is-b" : "is-general") +
          '">' +
          '<div class="person-head">' +
          '<span class="person-name">' +
          p.Codigo +
          " — " +
          p.Nombre +
          " " +
          p.Apellido +
          "</span>" +
          "</div>" +
          personFieldsHtml(p) +
          "</div>"
      )
      .join("");
  }

  // ---------------------------------------------------------------
  // Mapa Leaflet
  // ---------------------------------------------------------------
  function ensureMap() {
    if (STATE.map) return STATE.map;
    STATE.map = L.map("leaflet-map").setView([-23.9, -65.45], 9); // Jujuy
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 18,
      attribution: "&copy; OpenStreetMap",
    }).addTo(STATE.map);
    STATE.markerLayer = L.layerGroup().addTo(STATE.map);
    return STATE.map;
  }

  function coloredIcon(color) {
    return L.divIcon({
      className: "",
      html:
        '<div style="width:16px;height:16px;border-radius:50%;background:' +
        color +
        ';border:2px solid white;box-shadow:0 0 0 1px rgba(0,0,0,.25);"></div>',
      iconSize: [16, 16],
      iconAnchor: [8, 8],
    });
  }

  async function showMapFor(people, kind) {
    const wrap = document.getElementById("map-wrap");
    wrap.hidden = false;
    const map = ensureMap();
    STATE.markerLayer.clearLayers();
    setTimeout(() => map.invalidateSize(), 50);

    const color = kind === "b" ? "#EB5757" : "#27AE60";
    const bounds = [];
    for (const p of people) {
      const coords = await geocode(fullAddress(p, false));
      if (!coords) continue;
      bounds.push([coords.lat, coords.lng]);
      L.marker([coords.lat, coords.lng], { icon: coloredIcon(color) })
        .bindPopup(
          "<b>" + p.Nombre + " " + p.Apellido + "</b><br>" + p.Institucion + "<br>" + p.Direccion + " " + p.Numero
        )
        .addTo(STATE.markerLayer);
    }
    if (bounds.length) {
      map.fitBounds(bounds, { padding: [30, 30], maxZoom: 15 });
    }
  }

  // ---------------------------------------------------------------
  // Buscador por código
  // ---------------------------------------------------------------
  function populateCodigoSelect() {
    const sel = document.getElementById("sel-codigo");
    const codigos = uniqueSorted(STATE.general.map((p) => p.Codigo)).sort((a, b) => {
      return parseInt(a.replace(/\D/g, ""), 10) - parseInt(b.replace(/\D/g, ""), 10);
    });
    codigos.forEach((c) => {
      const opt = document.createElement("option");
      opt.value = c;
      opt.textContent = c;
      sel.appendChild(opt);
    });
    sel.addEventListener("change", () => renderCodigoResults(sel.value));
  }

  function renderCodigoResults(codigo) {
    const wrap = document.getElementById("codigo-results");
    wrap.innerHTML = "";
    if (!codigo) return;
    const people = STATE.general.filter((p) => p.Codigo === codigo);
    if (!people.length) {
      wrap.innerHTML = '<div class="empty-hint">No hay personas cargadas con ese código.</div>';
      return;
    }
    people.forEach((p) => {
      const card = document.createElement("div");
      card.className = "result-card";
      const enB = p._enB;
      card.innerHTML =
        '<div class="result-head">' +
        "<div>" +
        '<div class="result-name">' +
        p.Nombre +
        " " +
        p.Apellido +
        "</div>" +
        '<div class="result-sub">' +
        p.Codigo +
        " · Orden " +
        p.Orden +
        "</div>" +
        "</div>" +
        '<div class="status-box ' +
        (enB ? "is-x" : "is-check") +
        '" title="' +
        (enB ? "Está en Registro B" : "No está en Registro B") +
        '">' +
        (enB ? "✕" : "✓") +
        "</div>" +
        "</div>" +
        '<div class="result-fields">' +
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
        "</div>" +
        "<div><b>Institución</b>" +
        p.Institucion +
        "</div>" +
        "<div><b>Dirección institución</b>" +
        p["Direccion de Institucion"] +
        "</div>" +
        "</div>" +
        '<a class="btn btn-maps" target="_blank" rel="noopener" href="' +
        googleMapsUrl(p) +
        '">Ver en Google Maps</a>' +
        '<div class="obs-row">' +
        '<textarea placeholder="Observación…">' +
        (getObservacion(p) || "") +
        "</textarea>" +
        '<button class="btn btn-secondary btn-guardar-obs">Guardar</button>' +
        "</div>" +
        '<div class="obs-saved-note">Guardado localmente (demo) — todavía no está conectado al Google Sheet real.</div>';

      const textarea = card.querySelector("textarea");
      const saveBtn = card.querySelector(".btn-guardar-obs");
      const note = card.querySelector(".obs-saved-note");
      saveBtn.addEventListener("click", () => {
        saveObsOverride(p.Orden, textarea.value);
        note.classList.add("show");
        setTimeout(() => note.classList.remove("show"), 2500);
      });

      wrap.appendChild(card);
    });
  }

  // ---------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------
  async function init() {
    setupTabs();
    await loadData();
    renderInicio();
    populateDeptoSelect();
    populateDistritoSelect();
    renderInstGrid();
    populateCodigoSelect();
  }

  document.addEventListener("DOMContentLoaded", init);
})();
