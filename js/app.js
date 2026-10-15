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
    mapMode: "instituciones", // "instituciones" (azul, siempre visible) | "personas" (verde/rojo, dentro de una institución)
    mapaTabVisitada: false,
  };

  const GEOCODE_CACHE_KEY = "nexus_geocode_cache_v2";
  const OBS_OVERRIDES_KEY = "nexus_obs_overrides_v1"; // demo-only, guarda observaciones locales hasta que se conecte el Google Sheet real

  // Departamento (real, provincia de Jujuy) -> localidad real para georreferenciar.
  // El Departamento "Dr. Manuel Belgrano" no es en sí una ciudad: su cabecera es San Salvador de Jujuy.
  const DEPTO_LOCALITY = {
    "Dr. Manuel Belgrano": "San Salvador de Jujuy",
    "El Carmen": "El Carmen",
    "Palpalá": "Palpalá",
    "Ledesma": "Libertador General San Martín",
    "Tilcara": "Tilcara",
    "Humahuaca": "Humahuaca",
    "San Antonio": "San Antonio",
    "Tumbaya": "Tumbaya",
    "Santa Bárbara": "Santa Bárbara",
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
  // Más adelante se reemplaza por Google Maps API (pago) sin tocar el resto del front:
  // alcanza con cambiar esta función por una que llame a la Geocoding API de Google.
  // ---------------------------------------------------------------
  async function geocode(address) {
    const cache = loadGeocodeCache();
    if (cache[address]) return cache[address];
    try {
      const url =
        "https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=ar&q=" +
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

  function locality(p) {
    return DEPTO_LOCALITY[p.Departamento] || p.Departamento;
  }

  function fullAddress(p) {
    return p.Direccion + " " + p.Numero + ", " + locality(p) + ", Jujuy, Argentina";
  }

  function fullAddressInstitucion(p) {
    return p["Direccion de Institucion"] + ", " + locality(p) + ", Jujuy, Argentina";
  }

  function googleMapsUrl(p) {
    const q = p.Direccion + " " + p.Numero + ", " + locality(p) + ", Jujuy, Argentina";
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
        if (btn.dataset.tab === "mapa") {
          STATE.mapaTabVisitada = true;
          renderInstitutionMarkers();
        }
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

  function buildSparkline(el, seedSeries) {
    const w = 100,
      h = 34;
    const n = seedSeries.length;
    const max = Math.max(...seedSeries);
    const min = Math.min(...seedSeries);
    const range = max - min || 1;
    const points = seedSeries
      .map((v, i) => {
        const x = (i / (n - 1)) * w;
        const y = h - ((v - min) / range) * (h - 6) - 3;
        return x.toFixed(1) + "," + y.toFixed(1);
      })
      .join(" ");
    el.setAttribute("points", points);
  }

  function cumulativeSeries(count) {
    // serie "acumulada hasta ahora" a partir del orden de carga, para dar sensación de evolución/movimiento
    const series = [];
    const steps = Math.min(12, Math.max(4, count));
    for (let i = 1; i <= steps; i++) {
      series.push(Math.round((count * i) / steps));
    }
    return series;
  }

  function renderInicio() {
    const total = STATE.general.length;
    const totalB = STATE.registroB.length;
    const pct = total ? (totalB / total) * 100 : 0;

    document.getElementById("stat-general-pct").textContent = "100%";
    document.getElementById("stat-b-pct").textContent = pct.toFixed(1) + "%";

    animateCount(document.getElementById("stat-general"), total, 900);
    animateCount(document.getElementById("stat-b"), totalB, 900);

    buildSparkline(document.getElementById("spark-general"), cumulativeSeries(total));
    buildSparkline(document.getElementById("spark-b"), cumulativeSeries(totalB));

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
      renderInstitutionMarkers();
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
      card.dataset.inst = name;
      card.innerHTML =
        '<span class="inst-icon">' +
        instIcon() +
        "</span>" +
        '<span><span class="inst-name">' +
        name +
        '</span><div class="inst-count">' +
        byInst[name].length +
        " persona(s)</div></span>";
      card.addEventListener("click", () => selectInstitucion(name, byInst[name]));
      grid.appendChild(card);
    });
  }

  function clearDetail() {
    document.getElementById("inst-detail").hidden = true;
    document.getElementById("inst-detail").innerHTML = "";
    hideSelectedPersonCard();
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
      '<button class="btn btn-general" id="btn-planilla-general">Planilla General (' +
      people.length +
      ")</button>" +
      '<button class="btn btn-b" id="btn-planilla-b">Planilla B (' +
      people.filter((p) => p._enB).length +
      ")</button>" +
      "</div>";

    document.getElementById("btn-planilla-general").addEventListener("click", () => {
      showPersonMarkers(people, "general");
    });
    document.getElementById("btn-planilla-b").addEventListener("click", () => {
      showPersonMarkers(
        people.filter((p) => p._enB),
        "b"
      );
    });
  }

  function selectInstitucion(name, people) {
    document.querySelectorAll(".inst-card").forEach((c) => {
      c.classList.toggle("active", c.dataset.inst === name);
    });
    STATE.selectedInstitucion = name;
    renderInstDetail(people);
    document.getElementById("inst-detail").scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  // ---------------------------------------------------------------
  // Mapa Leaflet — los datos de cada persona se ven recién al tocar su punto
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
        '<div style="width:18px;height:18px;border-radius:50%;background:' +
        color +
        ';border:2.5px solid white;box-shadow:0 1px 4px rgba(0,0,0,.4);"></div>',
      iconSize: [18, 18],
      iconAnchor: [9, 9],
    });
  }

  function popupHtml(p) {
    return (
      '<div class="map-popup">' +
      "<b>" +
      p.Codigo +
      " — " +
      p.Nombre +
      " " +
      p.Apellido +
      "</b><br>" +
      "<small>" +
      p.Departamento +
      " · " +
      p.Distrito +
      "</small><br>" +
      p.Direccion +
      " " +
      p.Numero +
      "<br>" +
      "<i>" +
      p.Institucion +
      "</i>" +
      "</div>"
    );
  }

  function showSelectedPersonCard(p) {
    const box = document.getElementById("selected-person-card");
    box.hidden = false;
    box.innerHTML =
      '<div class="sp-head"><span class="sp-name">' +
      p.Nombre +
      " " +
      p.Apellido +
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
      "</div>";
    box.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  function hideSelectedPersonCard() {
    const box = document.getElementById("selected-person-card");
    box.hidden = true;
    box.innerHTML = "";
  }

  function institucionPopupHtml(name, people) {
    return (
      '<div class="map-popup">' +
      "<b>" +
      name +
      "</b><br>" +
      people.length +
      " persona(s) cargada(s)<br>" +
      "<small>" +
      people[0].Departamento +
      "</small>" +
      "</div>"
    );
  }

  // Modo "instituciones" (azul) — siempre visible, se recalcula con el filtro de depto/distrito
  async function renderInstitutionMarkers() {
    STATE.mapMode = "instituciones";
    document.getElementById("btn-volver-instituciones").hidden = true;
    document.getElementById("map-note").textContent =
      "Geolocalización con OpenStreetMap · tocá una institución para ver sus datos";
    hideSelectedPersonCard();

    const map = ensureMap();
    STATE.markerLayer.clearLayers();
    setTimeout(() => map.invalidateSize(), 50);

    const people = scopedPeople();
    const byInst = {};
    people.forEach((p) => {
      byInst[p.Institucion] = byInst[p.Institucion] || [];
      byInst[p.Institucion].push(p);
    });
    const names = Object.keys(byInst);

    const bounds = [];
    for (const name of names) {
      const group = byInst[name];
      const coords = await geocode(fullAddressInstitucion(group[0]));
      if (!coords) continue;
      bounds.push([coords.lat, coords.lng]);
      const marker = L.marker([coords.lat, coords.lng], { icon: coloredIcon("#2D6CDF") })
        .bindPopup(institucionPopupHtml(name, group))
        .addTo(STATE.markerLayer);
      marker.on("click", () => selectInstitucion(name, group));
    }
    if (bounds.length) {
      map.fitBounds(bounds, { padding: [30, 30], maxZoom: 15 });
    }
  }

  // Modo "personas" (verde=Planilla General / rojo=Planilla B) — dentro de una institución
  async function showPersonMarkers(people, kind) {
    STATE.mapMode = "personas";
    document.getElementById("btn-volver-instituciones").hidden = false;
    document.getElementById("map-note").textContent =
      "Geolocalización con OpenStreetMap · tocá un punto para ver a la persona";
    hideSelectedPersonCard();

    const map = ensureMap();
    STATE.markerLayer.clearLayers();
    setTimeout(() => map.invalidateSize(), 50);

    const color = kind === "b" ? "#EB5757" : "#27AE60";
    const bounds = [];
    for (const p of people) {
      const coords = await geocode(fullAddress(p));
      if (!coords) continue;
      bounds.push([coords.lat, coords.lng]);
      const marker = L.marker([coords.lat, coords.lng], { icon: coloredIcon(color) })
        .bindPopup(popupHtml(p))
        .addTo(STATE.markerLayer);
      marker.on("click", () => showSelectedPersonCard(p));
    }
    if (bounds.length) {
      map.fitBounds(bounds, { padding: [30, 30], maxZoom: 15 });
    }
  }

  // ---------------------------------------------------------------
  // Buscador por código — input libre (no desplegable fijo): hoy filtra
  // contra los datos embebidos, el día que esto hable con el Google Sheet
  // en vivo la lista de códigos posibles puede crecer sin tocar el front.
  // ---------------------------------------------------------------
  function populateCodigoDatalist() {
    const list = document.getElementById("codigos-list");
    const codigos = uniqueSorted(STATE.general.map((p) => p.Codigo)).sort((a, b) => {
      return parseInt(a.replace(/\D/g, ""), 10) - parseInt(b.replace(/\D/g, ""), 10);
    });
    codigos.forEach((c) => {
      const opt = document.createElement("option");
      opt.value = c;
      list.appendChild(opt);
    });

    const input = document.getElementById("input-codigo");
    input.addEventListener("input", () => {
      renderCodigoResults(input.value.trim());
    });
  }

  function matchesCodigo(valorBuscado, codigoReal) {
    const a = normalize(valorBuscado);
    const b = normalize(codigoReal);
    if (!a) return false;
    // admite "5", "codigo 5", "código 5"
    const soloNumero = a.replace(/[^\d]/g, "");
    const numeroReal = b.replace(/[^\d]/g, "");
    if (soloNumero && soloNumero === numeroReal && /^(codigo|código)?\s*\d+$/i.test(a)) return true;
    return b.includes(a);
  }

  function renderCodigoResults(valor) {
    const wrap = document.getElementById("codigo-results");
    wrap.innerHTML = "";
    if (!valor) return;
    const people = STATE.general.filter((p) => matchesCodigo(valor, p.Codigo));
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
    populateCodigoDatalist();
    document.getElementById("btn-volver-instituciones").addEventListener("click", () => {
      document.querySelectorAll(".inst-card").forEach((c) => c.classList.remove("active"));
      clearDetail();
      renderInstitutionMarkers();
    });
  }

  document.addEventListener("DOMContentLoaded", init);
})();
