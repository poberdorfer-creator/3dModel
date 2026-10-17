import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

const host = document.getElementById("canvas-host");
const scrubFill = document.getElementById("scrub-fill");
const frameIndex = document.getElementById("frame-index");
const themeToggle = document.getElementById("theme-toggle");

const PALETTE = {
  dark: { linePrimary: 0xd4ff4f, lineSecondary: 0xd4ff4f },
  light: { linePrimary: 0xe56b2e, lineSecondary: 0xe56b2e },
};

const scene = new THREE.Scene();

const renderer = new THREE.WebGLRenderer({
  antialias: true,
  alpha: true,
  powerPreference: "high-performance",
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setClearColor(0x000000, 0);
renderer.autoClear = false;
host.appendChild(renderer.domElement);

const camera = new THREE.PerspectiveCamera(42, 1, 0.05, 800);
camera.position.set(2.8, 1.6, 3.4);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableZoom = false;
controls.enablePan = false;
controls.enableDamping = true;
controls.dampingFactor = 0.06;
controls.minPolarAngle = 0.15;
controls.maxPolarAngle = Math.PI - 0.15;
controls.target.set(0, 0, 0);

const INFILL_OPACITY = 0.2;

const DEPTH_LAYER = 0;
const FILL_LAYER = 1;
const LINE_LAYER = 2;

// Soft base so shadowed material color still reads under the 20% infill.
const ambient = new THREE.AmbientLight(0xffffff, 0.22);
ambient.layers.enable(FILL_LAYER);
scene.add(ambient);

// Camera-locked three-point beauty light. Directional lights aim at the
// model origin; their positions travel with the view as the user orbits.
scene.add(camera);

function addViewLight(color, intensity, localPosition) {
  const light = new THREE.DirectionalLight(color, intensity);
  light.position.copy(localPosition);
  light.target.position.set(0, 0, 0);
  light.layers.enable(FILL_LAYER);
  camera.add(light);
  scene.add(light.target);
  return light;
}

addViewLight(0xfff0e0, 1.25, new THREE.Vector3(3.4, 4.6, 2.2));
addViewLight(0xdce8ff, 0.48, new THREE.Vector3(-4.6, 0.8, 2.8));
addViewLight(0xffffff, 1.55, new THREE.Vector3(-1.8, 3.4, -9.0));

const depthMaterial = new THREE.MeshBasicMaterial({
  color: 0xffffff,
  side: THREE.DoubleSide,
});
depthMaterial.colorWrite = false;
depthMaterial.depthWrite = true;
depthMaterial.depthTest = true;

camera.layers.enable(DEPTH_LAYER);
camera.layers.enable(FILL_LAYER);
camera.layers.enable(LINE_LAYER);

/** @type {Map<THREE.Material, THREE.Material>} */
const infillMaterials = new Map();

/** @type {THREE.LineBasicMaterial[]} */
const lineMaterials = [];
/** @type {THREE.Mesh[]} */
const bodyMeshes = [];
/** @type {THREE.LineSegments[]} */
const edgeLines = [];

let modelRoot = null;
let mixer = null;
let animDuration = 1;
let animTime = 0;
let playing = true;
let lastWheelAt = 0;

function themeKey() {
  return document.documentElement.getAttribute("data-theme") === "light"
    ? "light"
    : "dark";
}

function applyLineColors() {
  const p = PALETTE[themeKey()];
  if (lineMaterials[0]) lineMaterials[0].color.setHex(p.linePrimary);
  if (lineMaterials[1]) lineMaterials[1].color.setHex(p.lineSecondary);
}

function fitRenderer() {
  const w = host.clientWidth;
  const h = host.clientHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}

const _vertex = new THREE.Vector3();

/** Mean of all mesh vertex positions in world space (current pose). */
function computeVertexCentroid(root) {
  root.updateMatrixWorld(true);
  const sum = new THREE.Vector3();
  let count = 0;

  root.traverse((obj) => {
    if (!obj.isMesh || !obj.geometry || obj.userData.depthProxy) return;
    const position = obj.geometry.attributes.position;
    if (!position) return;
    const matrix = obj.matrixWorld;
    for (let i = 0; i < position.count; i++) {
      _vertex.fromBufferAttribute(position, i).applyMatrix4(matrix);
      sum.add(_vertex);
      count += 1;
    }
  });

  if (count === 0) return new THREE.Vector3();
  return sum.divideScalar(count);
}

function centerRootOnVertexCentroid(root) {
  const centroid = computeVertexCentroid(root);
  root.position.sub(centroid);
  root.updateMatrixWorld(true);
}

function frameModel(root) {
  centerRootOnVertexCentroid(root);

  const box = new THREE.Box3().setFromObject(root);
  const size = box.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z);
  if (maxDim > 0) {
    root.scale.setScalar(2.2 / maxDim);
    root.updateMatrixWorld(true);
    centerRootOnVertexCentroid(root);
  }

  controls.target.set(0, 0, 0);
  controls.update();
}

function makeInfillMaterial(source) {
  const cached = infillMaterials.get(source);
  if (cached) return cached;

  const mat = source.clone();
  mat.transparent = true;
  mat.opacity = source.opacity * INFILL_OPACITY;
  mat.depthWrite = false;
  mat.depthTest = true;
  mat.premultipliedAlpha = true;
  // Pull the shaded surface just in front of the depth prepass so the
  // standard-material depth matches the basic-material occlusion pass.
  mat.polygonOffset = true;
  mat.polygonOffsetFactor = -1;
  mat.polygonOffsetUnits = -2;
  infillMaterials.set(source, mat);
  return mat;
}

function attachHiddenLine(root) {
  bodyMeshes.length = 0;
  edgeLines.length = 0;
  lineMaterials.length = 0;
  infillMaterials.clear();

  const primaryMat = new THREE.LineBasicMaterial({
    color: PALETTE[themeKey()].linePrimary,
    depthTest: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
  });
  const secondaryMat = new THREE.LineBasicMaterial({
    color: PALETTE[themeKey()].lineSecondary,
    depthTest: true,
    depthWrite: false,
    transparent: true,
    opacity: 0.42,
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
  });
  lineMaterials.push(primaryMat, secondaryMat);

  const meshes = [];
  root.traverse((obj) => {
    if (!obj.isMesh || !obj.geometry || obj.userData.depthProxy) return;
    meshes.push(obj);
  });

  for (const mesh of meshes) {
    const sourceMaterial = mesh.material;
    mesh.material = Array.isArray(sourceMaterial)
      ? sourceMaterial.map(makeInfillMaterial)
      : makeInfillMaterial(sourceMaterial);
    mesh.frustumCulled = false;
    mesh.layers.set(FILL_LAYER);
    bodyMeshes.push(mesh);

    const depthMesh = new THREE.Mesh(mesh.geometry, depthMaterial);
    depthMesh.userData.depthProxy = true;
    depthMesh.frustumCulled = false;
    depthMesh.layers.set(DEPTH_LAYER);
    mesh.add(depthMesh);

    const primaryEdges = new THREE.EdgesGeometry(mesh.geometry, 11);
    const primaryLines = new THREE.LineSegments(primaryEdges, primaryMat);
    primaryLines.frustumCulled = false;
    primaryLines.layers.set(LINE_LAYER);
    mesh.add(primaryLines);
    edgeLines.push(primaryLines);

    const secondaryEdges = new THREE.EdgesGeometry(mesh.geometry, 35);
    const secondaryLines = new THREE.LineSegments(secondaryEdges, secondaryMat);
    secondaryLines.frustumCulled = false;
    secondaryLines.layers.set(LINE_LAYER);
    mesh.add(secondaryLines);
    edgeLines.push(secondaryLines);
  }
}

function setAnimTime(t) {
  animTime = ((t % animDuration) + animDuration) % animDuration;
  if (mixer) mixer.setTime(animTime);
  const pct = (animTime / animDuration) * 100;
  scrubFill.style.width = `${pct}%`;
  frameIndex.textContent = animTime.toFixed(2) + "s";
}

function renderHiddenLine() {
  renderer.clear(true, true, false);

  camera.layers.set(DEPTH_LAYER);
  renderer.render(scene, camera);

  camera.layers.set(FILL_LAYER);
  renderer.render(scene, camera);

  camera.layers.set(LINE_LAYER);
  renderer.render(scene, camera);

  camera.layers.enable(DEPTH_LAYER);
  camera.layers.enable(FILL_LAYER);
  camera.layers.enable(LINE_LAYER);
}

const loader = new GLTFLoader();
loader.load(
  "/radial_pneumatic_engine.glb",
  (gltf) => {
    modelRoot = gltf.scene;
    scene.add(modelRoot);
    attachHiddenLine(modelRoot);

    if (gltf.animations.length) {
      mixer = new THREE.AnimationMixer(modelRoot);
      const action = mixer.clipAction(gltf.animations[0]);
      action.play();
      // Keep the action unpaused: mixer.setTime() needs a non-zero effective
      // time scale or scrubbing (scroll) always samples the clip at t = 0.
      animDuration = gltf.animations[0].duration;
    }

    setAnimTime(0);
    if (mixer) mixer.update(0);
    modelRoot.updateMatrixWorld(true);
    fitModel(modelRoot);

    fitRenderer();
  },
  undefined,
  (err) => {
    console.error(err);
    frameIndex.textContent = "Load error";
  },
);

function fitModel(root) {
  fitRenderer();
  frameModel(root);
}

host.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();
    playing = false;
    lastWheelAt = performance.now();
    const delta = (e.deltaY / 1000) * animDuration;
    setAnimTime(animTime + delta);
  },
  { passive: false },
);

host.addEventListener("pointerdown", () => host.classList.add("grabbing"));
host.addEventListener("pointerup", () => host.classList.remove("grabbing"));
host.addEventListener("pointerleave", () => host.classList.remove("grabbing"));

window.addEventListener("keydown", (e) => {
  if (e.code === "Space") {
    e.preventDefault();
    playing = !playing;
  }
});

themeToggle.addEventListener("click", () => {
  const next = themeKey() === "dark" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", next);
  try {
    localStorage.setItem("tactic-theme", next);
  } catch {
    /* ignore */
  }
  applyLineColors();
});

window.addEventListener("resize", fitRenderer);

const clock = new THREE.Clock();
function tick() {
  requestAnimationFrame(tick);
  const dt = clock.getDelta();

  if (playing && mixer && performance.now() - lastWheelAt > 2500) {
    setAnimTime(animTime + dt);
  } else if (mixer) {
    mixer.setTime(animTime);
  }

  controls.update();
  renderHiddenLine();
}
tick();
