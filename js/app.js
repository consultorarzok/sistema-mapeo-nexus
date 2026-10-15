(function () {
  "use strict";

  const STATE = {
    general: [],
    registroB: [],
    selectedDepto: "",
    selectedDistrito: "",
    selectedInstitucion: "",
    map: null,
    infoWindow: null,
    institutionMarkers: [],
    reachCircles: [],
    personMarkers: [],
    mapMode: "instituciones", // "instituciones" (azul, siempre visible) | "personas" (verde/rojo + círculo de alcance, se suma a las instituciones)
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

  // Búsqueda externa: solo un link a Google (sin API, sin costo) — no hay forma
  // gratuita de contar coincidencias reales, así que no se intenta.
  function googleSearchUrl(p) {
    const q = [p.Codigo, p.Nombre, p.Apellido].filter(Boolean).join(" ");
    return "https://www.google.com/search?q=" + encodeURIComponent(q);
  }

  // Búsqueda interna: lleva a la pestaña Buscador con código+nombre+apellido cargado
  function jumpToBuscador(p) {
    const tabBtn = document.querySelector('.tab-btn[data-tab="buscador"]');
    if (tabBtn) tabBtn.click();
    const input = document.getElementById("input-codigo");
    if (!input) return;
    input.value = p.Nombre + " " + p.Apellido;
    renderCodigoResults(input.value.trim());
    input.scrollIntoView({ behavior: "smooth", block: "center" });
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

  function renderInicio() {
    const total = STATE.general.length;
    const totalB = STATE.registroB.length;
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
      '<p class="planilla-auto-note">Mostrando Planilla General (' +
      people.length +
      ") en el mapa — tocá Planilla B para ver esos en cambio.</p>" +
      '<div class="planilla-btns">' +
      '<button class="btn btn-b" id="btn-planilla-b">Planilla B (' +
      people.filter((p) => p._enB).length +
      ")</button>" +
      "</div>";

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
    focusInstitutionOnMap(name, people);
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
        const p = STATE.general.find((x) => String(x.Orden) === btn.dataset.orden);
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
      '<div class="popup-actions">' +
      '<button class="btn btn-secondary popup-btn-buscar" data-orden="' +
      p.Orden +
      '">🔍 Buscar</button>' +
      '<a class="btn btn-secondary" target="_blank" rel="noopener" href="' +
      googleSearchUrl(p) +
      '">Google</a>' +
      '<a class="btn btn-secondary" target="_blank" rel="noopener" href="' +
      googleMapsUrl(p) +
      '">Cómo llegar</a>' +
      "</div>" +
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

  // Dibuja los puntos azules de instituciones. Si se pasa onlyName, solo esa
  // (las demás quedan ocultas) — usado al enfocar una institución elegida.
  async function populateInstitutionLayer(onlyName) {
    const map = ensureMap();
    clearMarkers(STATE.institutionMarkers);

    const people = scopedPeople();
    const byInst = {};
    people.forEach((p) => {
      byInst[p.Institucion] = byInst[p.Institucion] || [];
      byInst[p.Institucion].push(p);
    });
    const names = onlyName ? [onlyName] : Object.keys(byInst);

    const bounds = [];
    for (const name of names) {
      const group = byInst[name];
      if (!group) continue;
      const coords = await geocode(fullAddressInstitucion(group[0]));
      if (!coords) continue;
      bounds.push([coords.lat, coords.lng]);
      const marker = new google.maps.Marker({
        position: { lat: coords.lat, lng: coords.lng },
        map,
        icon: coloredIcon("#2D6CDF"),
      });
      marker.addListener("click", () => {
        STATE.infoWindow.setContent(institucionPopupHtml(name, group));
        STATE.infoWindow.open({ anchor: marker, map });
        selectInstitucion(name, group);
      });
      STATE.institutionMarkers.push(marker);
    }
    return bounds;
  }

  // Modo "instituciones" (azul) — siempre visible, se recalcula con el filtro de depto/distrito
  async function renderInstitutionMarkers() {
    STATE.mapMode = "instituciones";
    document.getElementById("btn-volver-instituciones").hidden = true;
    document.getElementById("map-note").textContent =
      "Tocá una institución para ver sus datos";
    hideSelectedPersonCard();

    const map = ensureMap();
    clearMarkers(STATE.personMarkers);
    clearMarkers(STATE.reachCircles);
    setTimeout(() => google.maps.event.trigger(map, "resize"), 50);

    const bounds = await populateInstitutionLayer();
    fitToBounds(map, bounds);
  }

  // Al elegir una institución: las demás instituciones se ocultan (solo queda
  // la elegida) y se muestra automáticamente su Planilla General en el mapa.
  async function focusInstitutionOnMap(name, people) {
    await populateInstitutionLayer(name);
    showPersonMarkers(people, "general");
  }

  // Modo "personas" (verde=Planilla General / rojo=Planilla B) — el punto azul de
  // la institución queda visible y se agrega un círculo de "radio de alcance"
  // hasta las personas que se muestran alrededor.
  async function showPersonMarkers(people, kind) {
    STATE.mapMode = "personas";
    document.getElementById("btn-volver-instituciones").hidden = false;
    document.getElementById("map-note").textContent = "Tocá un punto para ver a la persona";
    hideSelectedPersonCard();

    const map = ensureMap();
    clearMarkers(STATE.personMarkers);
    clearMarkers(STATE.reachCircles);
    setTimeout(() => google.maps.event.trigger(map, "resize"), 50);

    const color = kind === "b" ? "#EB5757" : "#27AE60";
    const institCoords = people[0] ? await geocode(fullAddressInstitucion(people[0])) : null;

    const bounds = [];
    if (institCoords) bounds.push([institCoords.lat, institCoords.lng]);
    let maxDist = 0;
    for (const p of people) {
      const coords = await geocode(fullAddress(p));
      if (!coords) continue;
      bounds.push([coords.lat, coords.lng]);
      if (institCoords) {
        maxDist = Math.max(maxDist, haversineMeters(institCoords.lat, institCoords.lng, coords.lat, coords.lng));
      }
      const marker = new google.maps.Marker({
        position: { lat: coords.lat, lng: coords.lng },
        map,
        icon: coloredIcon(color),
      });
      marker.addListener("click", () => {
        STATE.infoWindow.setContent(popupHtml(p));
        STATE.infoWindow.open({ anchor: marker, map });
        showSelectedPersonCard(p);
      });
      STATE.personMarkers.push(marker);
    }

    if (institCoords) {
      const radius = Math.min(6000, Math.max(300, maxDist * 1.25));
      const circle = new google.maps.Circle({
        center: { lat: institCoords.lat, lng: institCoords.lng },
        radius,
        strokeColor: "#2D6CDF",
        strokeWeight: 1.5,
        strokeOpacity: 0.7,
        fillColor: "#2D6CDF",
        fillOpacity: 0.07,
        map,
      });
      STATE.reachCircles.push(circle);
    }

    fitToBounds(map, bounds);
  }

  // Vuelve a mostrar todas las instituciones (se habían ocultado todas menos
  // la elegida) y saca los puntos verdes/rojos + el círculo de alcance.
  async function exitPersonMode() {
    STATE.mapMode = "instituciones";
    clearMarkers(STATE.personMarkers);
    clearMarkers(STATE.reachCircles);
    document.getElementById("btn-volver-instituciones").hidden = true;
    document.getElementById("map-note").textContent = "Tocá una institución para ver sus datos";
    hideSelectedPersonCard();
    const map = ensureMap();
    const bounds = await populateInstitutionLayer();
    fitToBounds(map, bounds);
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

  // Búsqueda combinada: código, o nombre+apellido (en cualquier orden)
  function matchesQuery(valorBuscado, p) {
    if (matchesCodigo(valorBuscado, p.Codigo)) return true;
    const a = normalize(valorBuscado);
    const nombreCompleto = normalize(p.Nombre + " " + p.Apellido);
    const apellidoNombre = normalize(p.Apellido + " " + p.Nombre);
    if (!a) return false;
    return nombreCompleto.includes(a) || apellidoNombre.includes(a);
  }

  function renderCodigoResults(valor) {
    const wrap = document.getElementById("codigo-results");
    wrap.innerHTML = "";
    if (!valor) return;
    const people = STATE.general.filter((p) => matchesQuery(valor, p));
    if (!people.length) {
      wrap.innerHTML = '<div class="empty-hint">No hay personas que coincidan con ese código o nombre.</div>';
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
        '<div class="result-links">' +
        '<a class="btn btn-maps" target="_blank" rel="noopener" href="' +
        googleMapsUrl(p) +
        '">Ver en Google Maps</a>' +
        '<a class="btn btn-secondary" target="_blank" rel="noopener" href="' +
        googleSearchUrl(p) +
        '">Buscar en Google</a>' +
        "</div>" +
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
      exitPersonMode();
    });
  }

  document.addEventListener("DOMContentLoaded", init);
})();
