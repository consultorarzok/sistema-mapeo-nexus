import * as THREE from "https://cdnjs.cloudflare.com/ajax/libs/three.js/0.186.1/three.module.min.js";

const stage = document.querySelector(".nexus-hero");
const canvas = document.getElementById("globe-canvas");

const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.1;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);
camera.position.set(0, 0.2, 6.6);

function sizeToStage() {
  const w = stage.clientWidth;
  const h = stage.clientHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}

const textureLoader = new THREE.TextureLoader();
const globeTex = textureLoader.load("assets/globe-texture.png");
globeTex.wrapS = THREE.RepeatWrapping;
globeTex.colorSpace = THREE.SRGBColorSpace;
const glowTex = textureLoader.load("assets/glow.png");
const ringTex = textureLoader.load("assets/ring-texture.png");

// --- Núcleo / mundo (esfera) -------------------------------------------
const globeGeo = new THREE.SphereGeometry(1.5, 64, 64);
const globeMat = new THREE.MeshStandardMaterial({
  map: globeTex,
  emissive: new THREE.Color(0x0a2a4a),
  emissiveMap: globeTex,
  emissiveIntensity: 0.9,
  roughness: 0.55,
  metalness: 0.25,
});
const globe = new THREE.Mesh(globeGeo, globeMat);
scene.add(globe);

// capa de "aura" sutil, esfera levemente más grande, transparente
const auraGeo = new THREE.SphereGeometry(1.56, 48, 48);
const auraMat = new THREE.MeshBasicMaterial({
  color: 0x44b1ff,
  transparent: true,
  opacity: 0.07,
  side: THREE.BackSide,
});
scene.add(new THREE.Mesh(auraGeo, auraMat));

// --- Anillo tipo Saturno, inclinado --------------------------------------
const ringGeo = new THREE.RingGeometry(1.9, 2.5, 96);
// UVs radiales para que el degradé del ring-texture se vea correcto
{
  const pos = ringGeo.attributes.position;
  const uv = ringGeo.attributes.uv;
  const v3 = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v3.fromBufferAttribute(pos, i);
    const u = (v3.length() - 1.9) / (2.5 - 1.9);
    uv.setXY(i, u, 0.5);
  }
}
const ringMat = new THREE.MeshBasicMaterial({
  map: ringTex,
  transparent: true,
  side: THREE.DoubleSide,
  depthWrite: false,
  blending: THREE.AdditiveBlending,
});
const ring = new THREE.Mesh(ringGeo, ringMat);
ring.rotation.x = Math.PI / 2.4;
ring.rotation.z = 0.3;
scene.add(ring);

// --- Partículas (polvo estelar alrededor del núcleo) ---------------------
const PARTICLE_COUNT = 260;
const particlePositions = new Float32Array(PARTICLE_COUNT * 3);
for (let i = 0; i < PARTICLE_COUNT; i++) {
  const r = 2.6 + Math.random() * 1.8;
  const theta = Math.random() * Math.PI * 2;
  const phi = Math.acos(2 * Math.random() - 1);
  particlePositions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
  particlePositions[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
  particlePositions[i * 3 + 2] = r * Math.cos(phi);
}
const particleGeo = new THREE.BufferGeometry();
particleGeo.setAttribute("position", new THREE.BufferAttribute(particlePositions, 3));
const particleMat = new THREE.PointsMaterial({
  size: 0.055,
  map: glowTex,
  transparent: true,
  depthWrite: false,
  blending: THREE.AdditiveBlending,
  sizeAttenuation: true,
  color: 0x9fd8ff,
});
const particles = new THREE.Points(particleGeo, particleMat);
scene.add(particles);

// --- Estadísticas en vivo (Registro General / Registro B) -----------------
// Los datos ya los trajo app.js desde la API (evita duplicar la lectura al Google Sheet).
function waitForData() {
  if (window.NexusData) return Promise.resolve(window.NexusData);
  return new Promise((resolve) => {
    window.addEventListener("nexus:data-ready", () => resolve(window.NexusData), { once: true });
  });
}
async function loadStats() {
  try {
    const { general, registroB } = await waitForData();
    const total = general.length;
    const totalB = registroB.length;
    const pct = total ? ((totalB / total) * 100).toFixed(1) : "0.0";
    return { total, totalB, pct };
  } catch (e) {
    return { total: 0, totalB: 0, pct: "0.0" };
  }
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function makeLabelTexture({ eyebrow, value, color }) {
  const w = 560,
    h = 230;
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d");

  ctx.fillStyle = "rgba(10,14,26,0.74)";
  ctx.strokeStyle = "rgba(255,255,255,0.22)";
  ctx.lineWidth = 3;
  roundRect(ctx, 6, 6, w - 12, h - 12, 38);
  ctx.fill();
  ctx.stroke();

  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  if (value) {
    ctx.fillStyle = color;
    ctx.font = "700 36px 'JetBrains Mono', monospace";
    ctx.fillText(eyebrow.toUpperCase(), w / 2, 62);
    ctx.fillStyle = "#ffffff";
    ctx.font = "800 84px 'Bricolage Grotesque', sans-serif";
    ctx.fillText(value, w / 2, 152);
  } else {
    ctx.fillStyle = color;
    ctx.font = "700 48px 'Bricolage Grotesque', sans-serif";
    ctx.fillText(eyebrow, w / 2, h / 2 + 6);
  }

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

if (document.fonts && document.fonts.ready) {
  await document.fonts.ready;
}
const stats = await loadStats();

// --- Etiquetas orbitando: General / B / marca ----------------------------
const ORBITS = [
  {
    radius: 2.15,
    speed: 0.5,
    tilt: 0.3,
    phase: 0,
    w: 1.3,
    h: 0.54,
    texture: makeLabelTexture({ eyebrow: "Registro General", value: String(stats.total), color: "#27AE60" }),
  },
  {
    radius: 2.35,
    speed: -0.38,
    tilt: -0.32,
    phase: 2.1,
    w: 1.3,
    h: 0.54,
    texture: makeLabelTexture({ eyebrow: "Registro B", value: stats.pct + "%", color: "#EB5757" }),
  },
  {
    radius: 2.25,
    speed: 0.3,
    tilt: 0.5,
    phase: 4.2,
    w: 1.45,
    h: 0.44,
    texture: makeLabelTexture({ eyebrow: "Sistema de Mapeo", value: null, color: "#44b1ff" }),
  },
];
const orbiters = ORBITS.map((o) => {
  const mat = new THREE.SpriteMaterial({
    map: o.texture,
    transparent: true,
    depthWrite: false,
  });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(o.w, o.h, 1);
  scene.add(sprite);
  return { sprite, ...o };
});

// --- Luces (3 direccionales, como pide la referencia) --------------------
scene.add(new THREE.AmbientLight(0x335577, 0.6));
const keyLight = new THREE.DirectionalLight(0x9fd8ff, 1.6);
keyLight.position.set(3, 2, 4);
scene.add(keyLight);
const fillLight = new THREE.DirectionalLight(0x44b1ff, 0.6);
fillLight.position.set(-4, -1, 2);
scene.add(fillLight);
const rimLight = new THREE.DirectionalLight(0xffffff, 0.5);
rimLight.position.set(0, 3, -4);
scene.add(rimLight);

// --- Resize ---------------------------------------------------------------
new ResizeObserver(sizeToStage).observe(stage);
sizeToStage();

// --- Loop -------------------------------------------------------------
const clock = new THREE.Clock();
function animate() {
  requestAnimationFrame(animate);
  const t = clock.getElapsedTime();

  globe.rotation.y = t * 0.18;
  globeTex.offset.x = t * 0.015;
  ring.rotation.z += 0.0015;
  particles.rotation.y = t * 0.03;

  orbiters.forEach((o) => {
    const angle = t * o.speed + o.phase;
    o.sprite.position.set(
      Math.cos(angle) * o.radius,
      Math.sin(angle) * o.radius * Math.sin(o.tilt),
      Math.sin(angle) * o.radius * Math.cos(o.tilt)
    );
    o.sprite.material.opacity = 0.92 + Math.sin(t * 1.4 + o.phase) * 0.08;
  });

  renderer.render(scene, camera);
}
animate();
