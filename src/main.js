import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import {
  CSS2DRenderer,
  CSS2DObject,
} from "three/addons/renderers/CSS2DRenderer.js";

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

// CSS2D renderer for HTML labels that track 3D positions
const labelRenderer = new CSS2DRenderer();
labelRenderer.setSize(host.clientWidth, host.clientHeight);
labelRenderer.domElement.style.position = "absolute";
labelRenderer.domElement.style.top = "0";
labelRenderer.domElement.style.left = "0";
labelRenderer.domElement.style.pointerEvents = "none";
host.appendChild(labelRenderer.domElement);

const camera = new THREE.PerspectiveCamera(42, 1, 0.05, 800);
camera.position.set(2.8, 1.6, 3.4);

// ═══════════════════════════════════════════════════════════════════════════
// Part Labels Configuration
// ═══════════════════════════════════════════════════════════════════════════

/**
 * @typedef {Object} PartLabelConfig
 * @property {string} id - Unique identifier
 * @property {string} title - Part name (uppercase label)
 * @property {string} desc - Description text
 * @property {THREE.Vector3} position - World position to attach label
 * @property {string} [meshPattern] - Regex pattern to match mesh names
 */

/** @type {PartLabelConfig[]} */
const PART_LABELS = [
  {
    id: "cylinder-head-1",
    title: "Cylinder Head",
    desc: "Air-cooled combustion chamber",
    position: new THREE.Vector3(-0.9, 0, 0),
    meshPattern: /Lid1/i,
  },
  {
    id: "cylinder-2",
    title: "Cylinder",
    desc: "Radial arrangement",
    position: new THREE.Vector3(0.45, 0.78, 0),
    meshPattern: /Lid_.*0$/,
  },
  {
    id: "cylinder-3",
    title: "Cylinder",
    desc: "Radial arrangement",
    position: new THREE.Vector3(0.45, -0.78, 0),
    meshPattern: /Lid_.*001/,
  },
  {
    id: "crankcase",
    title: "Crankcase",
    desc: "Houses crankshaft & master rod",
    position: new THREE.Vector3(0, 0, -0.5),
    meshPattern: /polySurface1_/,
  },
  {
    id: "prop-hub",
    title: "Propeller Hub",
    desc: "Reduction gear assembly",
    position: new THREE.Vector3(0, 0, 0.65),
    meshPattern: /polySurface10/,
  },
  {
    id: "rocker-arm",
    title: "Rocker Arm",
    desc: "Actuates intake/exhaust valves",
    position: new THREE.Vector3(0.42, 0, 0.8),
    meshPattern: /polySurface11/,
  },
  {
    id: "push-rod",
    title: "Push Rod Tube",
    desc: "Connects cam to rockers",
    position: new THREE.Vector3(-0.42, 0, 0.06),
    meshPattern: /GloveFinger/,
  },
  {
    id: "piston",
    title: "Piston",
    desc: "Converts combustion to motion",
    position: new THREE.Vector3(-0.03, 0, 0.12),
    meshPattern: /Piston/,
  },
  {
    id: "cooling-fins",
    title: "Cooling Fins",
    desc: "Dissipate engine heat",
    position: new THREE.Vector3(-0.5, 0, 0),
    meshPattern: /Plate_.*Grey/,
  },
  {
    id: "bolts",
    title: "Cylinder Bolts",
    desc: "Secure head to block",
    position: new THREE.Vector3(-0.85, -0.23, -0.35),
    meshPattern: /Bolt1_/,
  },
];

/** @type {Map<string, CSS2DObject>} */
const labelObjects = new Map();

/** @type {Map<string, HTMLElement>} */
const labelElements = new Map();

/** @type {Map<string, THREE.Mesh>} */
const labelMeshes = new Map();

/** @type {Map<string, THREE.Vector3>} */
const labelOffsets = new Map();

/** @type {Map<string, THREE.Vector3>} */
const labelFarthestPositions = new Map();

const MAX_VISIBLE_LABELS = 5;

function createPartLabel(config) {
  const container = document.createElement("div");
  container.className = "part-label";
  container.id = `label-${config.id}`;

  container.innerHTML = `
    <div class="part-label-card">
      <p class="part-label-title">${config.title}</p>
      <p class="part-label-desc">${config.desc}</p>
    </div>
    <div class="part-label-connector"></div>
    <div class="part-label-dot"></div>
  `;

  const labelObj = new CSS2DObject(container);
  labelObj.position.copy(config.position);
  labelObj.userData.labelConfig = config;

  labelObjects.set(config.id, labelObj);
  labelElements.set(config.id, container);

  return labelObj;
}

/**
 * Sample the animation to find the farthest position of each mesh from origin.
 * This positions labels at the most exploded/separated point in the animation cycle.
 */
function computeFarthestPositions(root, animMixer, duration) {
  if (!animMixer) return;

  const meshes = [];
  root.traverse((obj) => {
    if (obj.isMesh && obj.geometry && !obj.userData.depthProxy) {
      meshes.push(obj);
    }
  });

  // Sample animation at multiple points to find farthest positions
  const samples = 30;
  const originalTime = animTime;

  for (const config of PART_LABELS) {
    if (!config.meshPattern) continue;

    const matchingMesh = meshes.find((m) => config.meshPattern.test(m.name));
    if (!matchingMesh) continue;

    labelMeshes.set(config.id, matchingMesh);

    let farthestDist = 0;
    let farthestPos = new THREE.Vector3();
    let farthestTime = 0;

    // Sample the animation to find where this mesh is farthest from center
    for (let i = 0; i <= samples; i++) {
      const t = (i / samples) * duration;
      animMixer.setTime(t);
      root.updateMatrixWorld(true);

      const box = new THREE.Box3().setFromObject(matchingMesh);
      const center = box.getCenter(new THREE.Vector3());
      const dist = center.length(); // Distance from origin

      if (dist > farthestDist) {
        farthestDist = dist;
        farthestPos.copy(center);
        farthestTime = t;
      }
    }

    // Compute an offset that pushes the label outward from the mesh center
    const box = new THREE.Box3();
    animMixer.setTime(farthestTime);
    root.updateMatrixWorld(true);
    box.setFromObject(matchingMesh);
    const size = box.getSize(new THREE.Vector3());

    // Direction from origin to mesh center (outward direction)
    const outwardDir = farthestPos.clone();
    const distFromOrigin = outwardDir.length();
    if (distFromOrigin > 0.01) {
      outwardDir.normalize();
    } else {
      // Mesh is at origin - use config position as hint for direction
      outwardDir.copy(config.position).normalize();
      if (outwardDir.length() < 0.01) {
        outwardDir.set(1, 0, 0);
      }
    }

    // Offset: push label significantly outward from mesh
    // Scale offset based on how far the mesh moves and its size
    // Use a larger base offset to spread labels apart
    const outwardScale = Math.max(distFromOrigin * 0.6, 0.35);
    const offset = new THREE.Vector3(
      outwardDir.x * (outwardScale + size.x * 0.4),
      Math.max(size.y * 0.5, 0.15) + Math.abs(outwardDir.y) * 0.15,
      outwardDir.z * (outwardScale + size.z * 0.4)
    );

    labelOffsets.set(config.id, offset);
    labelFarthestPositions.set(config.id, farthestPos.clone().add(offset));
  }

  // Restore original animation time
  animMixer.setTime(originalTime);
  root.updateMatrixWorld(true);
}

function initPartLabels(root) {
  // Find meshes
  const meshes = [];
  root.traverse((obj) => {
    if (obj.isMesh && obj.geometry && !obj.userData.depthProxy) {
      meshes.push(obj);
    }
  });

  for (const config of PART_LABELS) {
    // Find matching mesh for this label
    if (config.meshPattern) {
      const matchingMesh = meshes.find((m) => config.meshPattern.test(m.name));
      if (matchingMesh) {
        labelMeshes.set(config.id, matchingMesh);
      }
    }

    const labelObj = createPartLabel(config);
    // Labels will be positioned dynamically in updateLabelPositions
    scene.add(labelObj);
  }
}

/**
 * Update label positions to follow their associated meshes.
 * Labels are positioned at an offset from their mesh's current position,
 * pushed outward from the model center for better readability.
 */
function updateLabelPositions() {
  for (const [id, labelObj] of labelObjects) {
    const mesh = labelMeshes.get(id);
    const offset = labelOffsets.get(id);

    if (mesh) {
      // Get current world position of mesh center
      const box = new THREE.Box3().setFromObject(mesh);
      const center = box.getCenter(new THREE.Vector3());
      const size = box.getSize(new THREE.Vector3());

      if (offset) {
        // Apply the pre-computed offset (pushes label outward from mesh)
        labelObj.position.copy(center).add(offset);
      } else {
        // Fallback: compute offset dynamically based on mesh position
        // Push label outward from origin (model center)
        const outwardDir = center.clone().normalize();
        const distFromOrigin = center.length();
        if (outwardDir.length() < 0.01) {
          outwardDir.set(1, 0, 0); // Default direction if at origin
        }
        const outwardScale = Math.max(distFromOrigin * 0.6, 0.35);
        const dynamicOffset = new THREE.Vector3(
          outwardDir.x * (outwardScale + size.x * 0.4),
          Math.max(size.y * 0.5, 0.15),
          outwardDir.z * (outwardScale + size.z * 0.4)
        );
        labelObj.position.copy(center).add(dynamicOffset);
      }
    }
  }
}

/**
 * Update label visibility based on camera view.
 * Shows only the top N labels that are:
 * 1. In front of the camera (not behind)
 * 2. Within the view cone
 * 3. Closer to camera center of view = higher priority
 */
function updateLabelVisibility() {
  if (labelObjects.size === 0) return;

  const cameraPos = camera.position.clone();
  const cameraDir = new THREE.Vector3();
  camera.getWorldDirection(cameraDir);

  // Score each label
  const scores = [];

  for (const [id, labelObj] of labelObjects) {
    const worldPos = new THREE.Vector3();
    labelObj.getWorldPosition(worldPos);

    // Vector from camera to label
    const toLabel = worldPos.clone().sub(cameraPos);
    const distance = toLabel.length();
    toLabel.normalize();

    // Dot product: 1 = directly in front, -1 = behind
    const dot = toLabel.dot(cameraDir);

    // Angle from view center (0 = center, PI = behind)
    const angle = Math.acos(Math.max(-1, Math.min(1, dot)));

    // Depth along view direction
    const depth = worldPos.clone().sub(cameraPos).dot(cameraDir);

    // Visibility score: prefer closer parts that are more central
    // Negative depth = closer to camera gets higher score
    const score = -depth * 0.5 + (1 - angle / Math.PI) * 2;

    scores.push({
      id,
      labelObj,
      element: labelElements.get(id),
      angle,
      depth,
      score,
      inFront: dot > 0,
    });
  }

  // Sort by score (higher = more visible priority)
  scores.sort((a, b) => b.score - a.score);

  // Show top N labels that are in front and within view cone
  let visibleCount = 0;

  for (const item of scores) {
    // Within ~100 degrees of view center and in front
    const shouldShow =
      visibleCount < MAX_VISIBLE_LABELS &&
      item.inFront &&
      item.angle < Math.PI * 0.55;

    if (shouldShow) {
      item.element.classList.remove("hidden");
      visibleCount++;
    } else {
      item.element.classList.add("hidden");
    }
  }
}

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
  labelRenderer.setSize(w, h);
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

    // Initialize part labels after model is loaded and positioned
    initPartLabels(modelRoot);

    // Compute farthest positions for each labeled component in the animation
    // This determines where labels should be positioned for best visibility
    if (mixer) {
      computeFarthestPositions(modelRoot, mixer, animDuration);
    }

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

  // Update label positions to follow their associated meshes
  if (modelRoot) {
    modelRoot.updateMatrixWorld(true);
    updateLabelPositions();
  }

  // Update label visibility based on view direction
  updateLabelVisibility();

  // Render 3D scene
  renderHiddenLine();

  // Render CSS2D labels on top
  labelRenderer.render(scene, camera);
}
tick();
