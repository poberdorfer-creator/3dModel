import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import {
  CSS2DRenderer,
  CSS2DObject,
} from "three/addons/renderers/CSS2DRenderer.js";

const host = document.getElementById("canvas-host");
const scrubFill = document.getElementById("scrub-fill");
const themeToggle = document.getElementById("theme-toggle");
const infoToggle = document.getElementById("info-toggle");
const infoPanel = document.getElementById("info-panel");
const attributionWrap = document.querySelector(".attribution-wrap");
const appHeader = document.getElementById("app-header");
const appTitle = document.querySelector(".app-title");

const PALETTE = {
  dark: { linePrimary: 0xd4ff4f },
  light: { linePrimary: 0xe56b2e },
};

/** 0.5 = half speed (one loop takes twice as long as the clip duration). */
const ANIM_PLAYBACK_RATE = 0.5;

/** Full assembly spin (Y) once per period while the viewer is idle. */
const AUTO_ROTATE_PERIOD_S = 30;
/** On-screen model size vs. tight bounding-sphere fit (midpoint of prior 1.0 and 1.4 boost). */
const MODEL_SCREEN_BOOST = 1.2;
/** Resume explosion + auto-rotate after this much time without interaction. */
const IDLE_RESUME_MS = 10_000;

/**
 * Push rod tube — drop the clip's scale and translation. It stays parented to
 * the cooling-fin plate for the explosion, and the crank solve slides it along
 * the cylinder with the piston's end plate.
 */
const PUSH_ROD_NODE = /GloveFinger/i;
const PUSH_ROD_NODES = ["GloveFinger", "GloveFinger_NoRing"];
const COOLING_FIN_PLATE_NODE = "Plate";
/** Cylinder whose diaphragm plate the push rod tube rides with. */
const PUSH_ROD_PISTON = "Piston";
/** Cylinder-1 bank the tube slides through. */
const CYLINDER_1_NODE = "Cylinder_1";
/**
 * Head, ring, and the bolts that explode along this cylinder. Same clip path,
 * with one shared extra along +X so their exploded spacing stays intact.
 * Bolt002 / nuts explode off-axis and must not be included.
 */
const HEAD_CLEARANCE_NODES = new Set([
  "Lid1",
  "Ring",
  "Bolt1",
  "Bolt2",
  "Bolt3",
  "Bolt4",
]);
/** Extra reaches full cylinder-depth when the tube stroke is this fraction of max. */
const HEAD_CLEARANCE_LEAD = 0.6;

/** Set to false to fall back to the GLB's baked motion for the crank and rods. */
const CRANK_DRIVE_ENABLED = true;
/** Nodes the crank drive owns. Their clip tracks are sampled separately so the mixer cannot overwrite the solved pose. */
const CRANK_DRIVEN_NODES = new Set([
  "polySurface13",
  "Piston",
  "polySurface4",
  "polySurface4001",
  "Washer_1",
  "Washer_2",
]);

/** @type {Map<string, {position?: THREE.Interpolant, quaternion?: THREE.Interpolant}>} */
const drivenClip = new Map();
/** @type {Map<string, THREE.Interpolant>} */
const headClearanceClip = new Map();

function prepareExplosionClip(source) {
  drivenClip.clear();
  headClearanceClip.clear();
  const tracks = [];
  for (const track of source.tracks) {
    const dot = track.name.lastIndexOf(".");
    if (dot === -1) {
      tracks.push(track);
      continue;
    }
    const nodeName = track.name.slice(0, dot);
    const prop = track.name.slice(dot + 1);
    if (
      CRANK_DRIVE_ENABLED &&
      CRANK_DRIVEN_NODES.has(nodeName) &&
      (prop === "position" || prop === "quaternion")
    ) {
      let entry = drivenClip.get(nodeName);
      if (!entry) {
        entry = {};
        drivenClip.set(nodeName, entry);
      }
      entry[prop] = track.createInterpolant();
      continue;
    }
    if (HEAD_CLEARANCE_NODES.has(nodeName) && prop === "position") {
      headClearanceClip.set(nodeName, track.createInterpolant());
      continue;
    }
    if (PUSH_ROD_NODE.test(nodeName) && (prop === "scale" || prop === "position")) {
      continue;
    }
    tracks.push(track);
  }
  return new THREE.AnimationClip(source.name, source.duration, tracks);
}

/** Crankshaft; turns with the pinion gear mounted on the same axis (engine-local Y through origin). */
const CRANK_NODE = "polySurface13";
const CRANK_GEAR_NODE = "polySurface10";
const ENGINE_NODE = "Radial_Engine";
/** Connecting rods hooked on the crank pin. GLTFLoader strips "." from names. */
const CONNECTING_RODS = [
  { node: "Piston", followers: ["Washer_1", "Washer_2"] },
  { node: "polySurface4", followers: [] },
  { node: "polySurface4001", followers: [] },
];
/** Rod-node local points (all rods share one mesh): crank-pin eye and diaphragm pivot. */
const ROD_PIN_LOCAL = new THREE.Vector3(-8.051, 0, 0);
const ROD_PIVOT_LOCAL = new THREE.Vector3(9.149, 0, 0);

const _driveMat = new THREE.Matrix4();
const _driveMat2 = new THREE.Matrix4();
const _driveQuat = new THREE.Quaternion();
const _driveVec = new THREE.Vector3();
const _driveVec2 = new THREE.Vector3();
const _clipQuat = new THREE.Quaternion();
const _Y_AXIS = new THREE.Vector3(0, 1, 0);

/** Angle of an XZ vector in the sense of a rotation about +Y. */
function yawOf(x, z) {
  return Math.atan2(-z, x);
}

/** First mesh under a node. */
function firstMesh(node) {
  let mesh = null;
  node?.traverse((obj) => {
    if (!mesh && obj.isMesh) mesh = obj;
  });
  return mesh;
}

/** Min/max of a node along the parent's local X. */
function axialSpanX(node, parent) {
  const mesh = firstMesh(node);
  if (!mesh || !parent) return { min: 0, max: 0 };
  parent.updateWorldMatrix(true, false);
  mesh.updateWorldMatrix(true, false);
  _driveMat.copy(parent.matrixWorld).invert().multiply(mesh.matrixWorld);
  const position = mesh.geometry.attributes.position;
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < position.count; i++) {
    _driveVec.fromBufferAttribute(position, i).applyMatrix4(_driveMat);
    min = Math.min(min, _driveVec.x);
    max = Math.max(max, _driveVec.x);
  }
  return { min, max };
}

/**
 * Slider-crank drive: the crank follows the pinion gear's spin, each rod's eye rides the
 * orbiting crank pin while its diaphragm end slides along its cylinder axis. The solved
 * pose is always taken from the assembled rest pose. The original explode translation is
 * added afterwards in parent space, so playback and scrubbing cannot land on different poses.
 */
function createCrankDrive(root) {
  const engine = root.getObjectByName(ENGINE_NODE);
  const crank = root.getObjectByName(CRANK_NODE);
  const gear = root.getObjectByName(CRANK_GEAR_NODE);
  if (!engine || !crank || !gear) return null;

  root.updateMatrixWorld(true);
  const engineInv = engine.matrixWorld.clone().invert();
  const toEngine = (obj) =>
    new THREE.Matrix4().multiplyMatrices(engineInv, obj.matrixWorld);

  const restOf = (obj) => ({
    obj,
    position: obj.position.clone(),
    quaternion: obj.quaternion.clone(),
    scale: obj.scale.clone(),
    engineRest: toEngine(obj),
    engineRestInv: toEngine(obj).invert(),
  });

  const gearParentQuat = new THREE.Quaternion();
  toEngine(gear.parent).decompose(_driveVec, gearParentQuat, _driveVec2);
  const gearRestInv = gearParentQuat.clone().multiply(gear.quaternion).invert();

  const crankRest = restOf(crank);
  const rods = [];
  for (const spec of CONNECTING_RODS) {
    const obj = root.getObjectByName(spec.node);
    if (!obj) continue;
    const rest = restOf(obj);
    const pin = ROD_PIN_LOCAL.clone().applyMatrix4(rest.engineRest);
    const pivot = ROD_PIVOT_LOCAL.clone().applyMatrix4(rest.engineRest);
    const axis = new THREE.Vector3(pivot.x, 0, pivot.z).normalize();
    rods.push({
      ...rest,
      pin,
      pivot,
      axis,
      length: Math.hypot(pivot.x - pin.x, pivot.z - pin.z),
      yaw0: yawOf(pivot.x - pin.x, pivot.z - pin.z),
      followers: spec.followers
        .map((name) => root.getObjectByName(name))
        .filter(Boolean)
        .map(restOf),
    });
  }

  // Captured after the tube is parented to the cooling-fin plate, so resetting
  // to this local pose each frame keeps the explosion and the stroke from stacking.
  const pushRods = PUSH_ROD_NODES.map((name) => root.getObjectByName(name))
    .filter(Boolean)
    .map(restOf);

  const cylinder = root.getObjectByName(CYLINDER_1_NODE);
  const headParts = [];
  if (cylinder) {
    for (const name of HEAD_CLEARANCE_NODES) {
      const obj = cylinder.getObjectByName(name);
      if (!obj) continue;
      headParts.push({
        obj,
        rest: obj.position.clone(),
      });
    }
  }
  const lidPart = headParts.find((p) => p.obj.name === "Lid1");
  const ringPart = headParts.find((p) => p.obj.name === "Ring");
  const plate = cylinder?.getObjectByName(COOLING_FIN_PLATE_NODE);
  const lidSpan = lidPart ? axialSpanX(lidPart.obj, cylinder) : { min: 0, max: 0 };
  const ringSpan = ringPart ? axialSpanX(ringPart.obj, cylinder) : { min: 0, max: 0 };
  const gloveSpan = axialSpanX(root.getObjectByName("GloveFinger"), cylinder);
  const cylinderDepth = lidSpan.max - lidSpan.min;
  const restNest = Math.max(0, gloveSpan.max - ringSpan.min);
  const plateRestX = plate?.position.x ?? 0;
  const ringRestX = ringPart?.rest.x ?? 0;
  const lidRestX = lidPart?.rest.x ?? 0;
  let lidExplodeMax = 0;
  const lidInterp = headClearanceClip.get("Lid1");
  if (lidInterp?.parameterPositions) {
    for (const t of lidInterp.parameterPositions) {
      lidExplodeMax = Math.max(lidExplodeMax, lidInterp.evaluate(t)[0] - lidRestX);
    }
  }
  lidExplodeMax = Math.max(lidExplodeMax, 1e-6);

  const pistonRod = rods.find((r) => r.obj.name === PUSH_ROD_PISTON);
  let strokeMax = 1e-6;
  if (pistonRod) {
    for (let i = 0; i < 64; i++) {
      _driveQuat.setFromAxisAngle(_Y_AXIS, (i / 64) * Math.PI * 2);
      _driveVec.copy(pistonRod.pin).applyQuaternion(_driveQuat);
      const along =
        _driveVec.x * pistonRod.axis.x + _driveVec.z * pistonRod.axis.z;
      const perpSq =
        _driveVec.x * _driveVec.x + _driveVec.z * _driveVec.z - along * along;
      const slide = along + Math.sqrt(Math.max(0, pistonRod.length ** 2 - perpSq));
      const stroke =
        pistonRod.axis.x * slide +
        pistonRod.axis.z * 0 -
        (pistonRod.axis.x * pistonRod.pivot.x +
          pistonRod.axis.z * pistonRod.pivot.z);
      strokeMax = Math.max(strokeMax, stroke);
    }
  }

  /** Clip pose plus one shared axial extra. Never accumulates — each sample writes the full pose. */
  function applyHeadClearance(clipTime, stroke) {
    if (!headParts.length || cylinderDepth <= 0) return;
    const lidSample = headClearanceClip.get("Lid1")?.evaluate(clipTime);
    const ringSample = headClearanceClip.get("Ring")?.evaluate(clipTime);
    const explodeEnv = lidSample
      ? Math.max(0, (lidSample[0] - lidRestX) / lidExplodeMax)
      : 0;
    const strokeEnv = Math.max(
      0,
      Math.min(1, stroke / (HEAD_CLEARANCE_LEAD * strokeMax)),
    );
    const plateDelta = (plate?.position.x ?? plateRestX) - plateRestX;
    const ringDelta = (ringSample?.[0] ?? ringRestX) - ringRestX;
    const tubeLead = Math.max(0, stroke + plateDelta - ringDelta);
    const extra = Math.max(
      cylinderDepth * Math.max(explodeEnv, strokeEnv),
      tubeLead + restNest * strokeEnv,
    );
    for (const part of headParts) {
      const sample = headClearanceClip.get(part.obj.name)?.evaluate(clipTime);
      if (sample) {
        part.obj.position.set(sample[0] + extra, sample[1], sample[2]);
      } else {
        part.obj.position.set(part.rest.x + extra, part.rest.y, part.rest.z);
      }
    }
  }

  const driven = [
    crankRest,
    ...rods,
    ...rods.flatMap((r) => r.followers),
    ...pushRods,
  ];

  /** Post-multiply node local transform by engine-space delta expressed in its rest frame. */
  function applyDelta(entry, delta) {
    const { obj } = entry;
    _driveMat2.multiplyMatrices(entry.engineRestInv, delta);
    _driveMat2.multiply(entry.engineRest);
    _driveMat.compose(obj.position, obj.quaternion, obj.scale);
    _driveMat.multiply(_driveMat2);
    _driveMat.decompose(obj.position, obj.quaternion, obj.scale);
  }

  /** Parent-space explode offset, sampled from the stripped clip so it does not depend on the mixer write. */
  function addExplosion(entry, clipTime) {
    const clip = drivenClip.get(entry.obj.name);
    if (!clip) return;
    const { obj } = entry;
    if (clip.position) {
      const v = clip.position.evaluate(clipTime);
      obj.position.x += v[0] - entry.position.x;
      obj.position.y += v[1] - entry.position.y;
      obj.position.z += v[2] - entry.position.z;
    }
    if (clip.quaternion) {
      const q = clip.quaternion.evaluate(clipTime);
      _clipQuat.set(q[0], q[1], q[2], q[3]);
      _driveQuat.copy(entry.quaternion).invert();
      _clipQuat.premultiply(_driveQuat);
      obj.quaternion.multiply(_clipQuat);
    }
  }

  const delta = new THREE.Matrix4();
  const spin = new THREE.Quaternion();
  const pin = new THREE.Vector3();
  const pivot = new THREE.Vector3();

  return {
    reset() {
      for (const e of driven) {
        e.obj.position.copy(e.position);
        e.obj.quaternion.copy(e.quaternion);
        e.obj.scale.copy(e.scale);
      }
    },
    apply(clipTime) {
      spin.copy(gearParentQuat).multiply(gear.quaternion).multiply(gearRestInv);

      applyDelta(crankRest, delta.makeRotationFromQuaternion(spin));
      addExplosion(crankRest, clipTime);

      let pistonStroke = 0;
      for (const rod of rods) {
        pin.copy(rod.pin).applyQuaternion(spin);
        const along = pin.x * rod.axis.x + pin.z * rod.axis.z;
        const perpSq = pin.x * pin.x + pin.z * pin.z - along * along;
        const slide = along + Math.sqrt(Math.max(0, rod.length ** 2 - perpSq));
        pivot.set(rod.axis.x * slide, rod.pivot.y, rod.axis.z * slide);

        const dYaw = yawOf(pivot.x - pin.x, pivot.z - pin.z) - rod.yaw0;
        _driveQuat.setFromAxisAngle(_Y_AXIS, dYaw);
        delta
          .makeTranslation(pivot.x, pivot.y, pivot.z)
          .multiply(_driveMat2.makeRotationFromQuaternion(_driveQuat))
          .multiply(
            _driveMat2.makeTranslation(-rod.pivot.x, -rod.pivot.y, -rod.pivot.z),
          );
        applyDelta(rod, delta);
        addExplosion(rod, clipTime);

        _driveVec.subVectors(pivot, rod.pivot);
        for (const f of rod.followers) {
          applyDelta(f, delta.makeTranslation(_driveVec.x, _driveVec.y, _driveVec.z));
          addExplosion(f, clipTime);
        }
        // Same axial shift as the end plate, without the plate's own explode
        // track — the tube already inherits the cooling-fin explosion from its parent.
        if (rod.obj.name === PUSH_ROD_PISTON) {
          pistonStroke =
            _driveVec.x * rod.axis.x + _driveVec.z * rod.axis.z;
          for (const pr of pushRods) {
            applyDelta(
              pr,
              delta.makeTranslation(_driveVec.x, _driveVec.y, _driveVec.z),
            );
          }
        }
      }
      applyHeadClearance(clipTime, pistonStroke);
    },
  };
}

/** @type {ReturnType<typeof createCrankDrive>} */
let crankDrive = null;

/** Reparent push rod nodes under the animated cooling-fin plate (assembled pose at t=0). */
function bindPushRodToCoolingFin(root) {
  const plate = root.getObjectByName(COOLING_FIN_PLATE_NODE);
  if (!plate) return;

  root.updateMatrixWorld(true);
  for (const name of PUSH_ROD_NODES) {
    const rod = root.getObjectByName(name);
    if (rod) plate.attach(rod);
  }
}

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

const connectorSvg = document.createElementNS(
  "http://www.w3.org/2000/svg",
  "svg",
);
connectorSvg.classList.add("part-label-lines");
connectorSvg.setAttribute("aria-hidden", "true");
host.appendChild(connectorSvg);

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

/** @type {Map<string, CSS2DObject>} */
const anchorObjects = new Map();

/** @type {Map<string, HTMLElement>} */
const labelElements = new Map();

/** @type {Map<string, HTMLElement>} */
const anchorElements = new Map();

/** @type {Map<string, SVGLineElement>} */
const connectorLines = new Map();

/** @type {Map<string, THREE.Mesh>} */
const labelMeshes = new Map();

const MAX_VISIBLE_LABELS = 5;

/** World-space offset from part centroid to callout card (kept close to geometry). */
function computeCalloutOffset(centroid, size, hintPosition) {
  const outwardDir = centroid.clone();
  if (outwardDir.lengthSq() > 1e-4) {
    outwardDir.normalize();
  } else {
    outwardDir.copy(hintPosition).normalize();
    if (outwardDir.lengthSq() < 1e-4) {
      outwardDir.set(0, 1, 0);
    }
  }

  const extent = Math.max(size.x, size.y, size.z, 0.04);
  const radial = extent * 0.42 + 0.07;
  const lift = Math.max(size.y * 0.32, 0.05) + 0.04;

  return new THREE.Vector3(
    outwardDir.x * radial,
    lift,
    outwardDir.z * radial,
  );
}

function createPartLabel(config) {
  const anchor = document.createElement("div");
  anchor.className = "part-label part-label-anchor hidden";
  anchor.id = `label-anchor-${config.id}`;
  anchor.innerHTML = `<div class="part-label-dot"></div>`;

  const callout = document.createElement("div");
  callout.className = "part-label part-label-callout hidden";
  callout.id = `label-${config.id}`;
  callout.innerHTML = `
    <div class="part-label-card">
      <p class="part-label-title">${config.title}</p>
      <p class="part-label-desc">${config.desc}</p>
    </div>
  `;

  const anchorObj = new CSS2DObject(anchor);
  anchorObj.position.copy(config.position);
  anchorObj.userData.labelConfig = config;

  const labelObj = new CSS2DObject(callout);
  labelObj.position.copy(config.position);
  labelObj.userData.labelConfig = config;

  anchorObjects.set(config.id, anchorObj);
  labelObjects.set(config.id, labelObj);
  anchorElements.set(config.id, anchor);
  labelElements.set(config.id, callout);

  const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
  line.classList.add("part-label-line");
  line.setAttribute("visibility", "hidden");
  connectorSvg.appendChild(line);
  connectorLines.set(config.id, line);

  return { anchorObj, labelObj };
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

    const { anchorObj, labelObj } = createPartLabel(config);
    scene.add(anchorObj);
    scene.add(labelObj);
  }
}

function meshLocalBoundsWorld(mesh) {
  const box = new THREE.Box3().setFromBufferAttribute(
    mesh.geometry.attributes.position,
  );
  box.applyMatrix4(mesh.matrixWorld);
  return box;
}

/** Vertex mean in world space for one mesh (ignores child line/depth nodes). */
function computeMeshVertexCentroid(mesh) {
  const position = mesh.geometry?.attributes?.position;
  if (!position) {
    return new THREE.Vector3();
  }
  mesh.updateWorldMatrix(true, false);
  const matrix = mesh.matrixWorld;
  const sum = new THREE.Vector3();
  const count = position.count;
  for (let i = 0; i < count; i++) {
    _vertex.fromBufferAttribute(position, i).applyMatrix4(matrix);
    sum.add(_vertex);
  }
  return sum.divideScalar(count);
}

/**
 * Update label positions to follow their associated meshes.
 * Labels are positioned at an offset from their mesh's current position,
 * pushed outward from the model center for better readability.
 */
function updateLabelPositions() {
  for (const [id, labelObj] of labelObjects) {
    const anchorObj = anchorObjects.get(id);
    const mesh = labelMeshes.get(id);

    if (!mesh || !anchorObj) continue;

    const centroid = computeMeshVertexCentroid(mesh);
    anchorObj.position.copy(centroid);

    mesh.updateWorldMatrix(true, false);
    const size = meshLocalBoundsWorld(mesh).getSize(new THREE.Vector3());
    const hint = labelObj.userData.labelConfig?.position ?? new THREE.Vector3();
    const offset = computeCalloutOffset(centroid, size, hint);
    labelObj.position.copy(centroid).add(offset);
  }
}

function updateLabelConnectors() {
  const hostRect = host.getBoundingClientRect();

  for (const [id, line] of connectorLines) {
    const anchorEl = anchorElements.get(id);
    const calloutEl = labelElements.get(id);
    if (
      !anchorEl ||
      !calloutEl ||
      anchorEl.classList.contains("hidden") ||
      calloutEl.classList.contains("hidden")
    ) {
      line.setAttribute("visibility", "hidden");
      continue;
    }

    const dotEl = anchorEl.querySelector(".part-label-dot");
    const cardEl = calloutEl.querySelector(".part-label-card");
    if (!dotEl || !cardEl) {
      line.setAttribute("visibility", "hidden");
      continue;
    }

    const dotRect = dotEl.getBoundingClientRect();
    const cardRect = cardEl.getBoundingClientRect();
    const x1 = dotRect.left + dotRect.width / 2 - hostRect.left;
    const y1 = dotRect.top + dotRect.height / 2 - hostRect.top;

    const corners = [
      { x: cardRect.left, y: cardRect.top },
      { x: cardRect.right, y: cardRect.top },
      { x: cardRect.left, y: cardRect.bottom },
      { x: cardRect.right, y: cardRect.bottom },
    ];

    let x2 = corners[0].x;
    let y2 = corners[0].y;
    let bestDist = Infinity;
    for (const corner of corners) {
      const dx = corner.x - (dotRect.left + dotRect.width / 2);
      const dy = corner.y - (dotRect.top + dotRect.height / 2);
      const dist = dx * dx + dy * dy;
      if (dist < bestDist) {
        bestDist = dist;
        x2 = corner.x;
        y2 = corner.y;
      }
    }

    x2 -= hostRect.left;
    y2 -= hostRect.top;

    line.setAttribute("x1", String(x1));
    line.setAttribute("y1", String(y1));
    line.setAttribute("x2", String(x2));
    line.setAttribute("y2", String(y2));
    line.setAttribute("visibility", "visible");
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

    const anchorEl = anchorElements.get(item.id);
    if (shouldShow) {
      item.element.classList.remove("hidden");
      anchorEl?.classList.remove("hidden");
      visibleCount++;
    } else {
      item.element.classList.add("hidden");
      anchorEl?.classList.add("hidden");
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
controls.addEventListener("start", noteUserActivity);

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

/**
 * An edge sharper than this (degrees between the two face normals) is a real
 * feature — hex flats, hole rims, plate boundaries — and is always drawn.
 * Shallower edges are only the tessellation of a curve. Those draw only where
 * the curve turns into the view silhouette, so a bolt shaft, a hole wall, or a
 * rounded corner gets one outline instead of a line on every facet.
 * Raise it to drop more chamfers; lower it to keep more of the mesh's own edges.
 */
const OUTLINE_CREASE_ANGLE = 36;
/** Ignore triangulation of flat faces. Those edges are not a silhouette. */
const OUTLINE_MIN_ANGLE = 1;

/** @type {THREE.ShaderMaterial[]} */
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
/** @type {number} */
let lastUserActivityAt = -Infinity;

function presentationIdle() {
  return performance.now() - lastUserActivityAt >= IDLE_RESUME_MS;
}

function noteUserActivity() {
  lastUserActivityAt = performance.now();
  playing = false;
}

function themeKey() {
  return document.documentElement.getAttribute("data-theme") === "light"
    ? "light"
    : "dark";
}

function applyLineColors() {
  const material = lineMaterials[0];
  if (material?.uniforms?.diffuse) {
    material.uniforms.diffuse.value.setHex(PALETTE[themeKey()].linePrimary);
  }
}

function updateHeaderLayout() {
  if (!appHeader) return;
  const portrait = window.innerHeight > window.innerWidth;
  appHeader.classList.remove("app-header--stacked", "app-header--inline");
  appHeader.classList.add("app-header--inline");

  const gap = 40;
  const themeW = themeToggle?.offsetWidth ?? 0;
  const infoW = attributionWrap?.offsetWidth ?? 0;
  const titleW = appTitle?.scrollWidth ?? 0;
  const needsStack =
    portrait || window.innerWidth < themeW + titleW + infoW + gap;

  appHeader.classList.toggle("app-header--stacked", needsStack);
  appHeader.classList.toggle("app-header--inline", !needsStack);
}

/** Usable canvas area after top controls and bottom HUD. */
function effectiveViewRect() {
  const fullW = host.clientWidth;
  const fullH = host.clientHeight;
  const headerBottom = appHeader?.getBoundingClientRect().bottom ?? 0;
  const top = headerBottom > 0 ? headerBottom + 12 : 64;
  const hudEl = document.querySelector(".hud");
  const hudTop = hudEl?.getBoundingClientRect().top ?? fullH - 72;
  const bottom = Math.max(64, fullH - hudTop + 12);
  const side = 12;
  const w = Math.max(1, fullW - side * 2);
  const h = Math.max(1, fullH - top - bottom);
  return { fullW, fullH, w, h, top, bottom, side };
}

const _fitBox = new THREE.Box3();
const _fitSize = new THREE.Vector3();
const _fitSphere = new THREE.Sphere();
const _cameraDir = new THREE.Vector3();

function sampleClip(clipTime) {
  if (!mixer) return;
  crankDrive?.reset();
  mixer.setTime(clipTime);
  crankDrive?.apply(clipTime);
}

function applyAnimPose(t) {
  if (mixer) {
    const clipTime =
      (((t % animDuration) + animDuration) % animDuration) * ANIM_PLAYBACK_RATE;
    sampleClip(clipTime);
  }
  if (modelRoot) modelRoot.updateMatrixWorld(true);
}

function objectMaxExtent(root) {
  _fitBox.setFromObject(root);
  _fitBox.getSize(_fitSize);
  return Math.max(_fitSize.x, _fitSize.y, _fitSize.z);
}

/** Midpoint between compact-only and full exploded extent for root scale. */
function maxModelExtentForFrame(root) {
  const saved = animTime;
  applyAnimPose(0);
  const compact = objectMaxExtent(root);

  let exploded = compact;
  if (mixer && animDuration > 0) {
    const samples = [
      animDuration * 0.35,
      animDuration * 0.65,
      animDuration * 0.98,
    ];
    for (const t of samples) {
      applyAnimPose(t);
      exploded = Math.max(exploded, objectMaxExtent(root));
    }
  }

  applyAnimPose(saved);
  return (compact + exploded) / 2;
}

/** World-space target size for the model’s largest dimension from viewport. */
function targetModelExtent() {
  const { w, h, fullW, fullH } = effectiveViewRect();
  const minSide = Math.min(w, h);
  const ref = 720;
  const scale = THREE.MathUtils.clamp(minSide / ref, 0.52, 1.12);
  const portrait = fullH > fullW;
  const narrow = fullW < 420;
  let base = portrait ? 1.75 : 2.2;
  if (narrow) base *= 0.9;
  if (portrait && narrow) base *= 0.88;
  return base * scale;
}

function fitCameraToModel(root) {
  const saved = animTime;
  applyAnimPose(saved);

  _fitBox.setFromObject(root);
  _fitBox.getBoundingSphere(_fitSphere);
  const radius = Math.max(_fitSphere.radius, 0.05);

  const { w, h, fullW, fullH } = effectiveViewRect();
  const fitAspect = w / h;
  const vFov = THREE.MathUtils.degToRad(camera.fov);
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * fitAspect);
  const distV = radius / Math.sin(vFov / 2);
  const distH = radius / Math.sin(hFov / 2);
  const padding = (fullW < 480 ? 1.14 : 1.08) / MODEL_SCREEN_BOOST;
  const distance = Math.max(distV, distH) * padding;

  _cameraDir.copy(camera.position);
  if (_cameraDir.lengthSq() < 1e-6) {
    _cameraDir.set(2.8, 1.6, 3.4);
  }
  _cameraDir.normalize().multiplyScalar(distance);
  camera.position.copy(_cameraDir);
  camera.aspect = fullW / fullH;
  camera.updateProjectionMatrix();
  controls.target.set(0, 0, 0);
  controls.update();
}

function fitRenderer() {
  const w = host.clientWidth;
  const h = host.clientHeight;
  renderer.setSize(w, h, false);
  labelRenderer.setSize(w, h);
  connectorSvg.setAttribute("width", String(w));
  connectorSvg.setAttribute("height", String(h));
  if (modelRoot) {
    fitCameraToModel(modelRoot);
  } else {
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
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
  const saved = animTime;
  root.scale.setScalar(1);
  applyAnimPose(0);
  centerRootOnVertexCentroid(root);

  const maxDim = maxModelExtentForFrame(root);
  if (maxDim > 0) {
    root.scale.setScalar(targetModelExtent() / maxDim);
    root.updateMatrixWorld(true);
    centerRootOnVertexCentroid(root);
  }

  applyAnimPose(saved);
  fitCameraToModel(root);
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

const _outlineNormal = new THREE.Vector3();
const _outlineTriangle = new THREE.Triangle();
const _outlineA = new THREE.Vector3();
const _outlineB = new THREE.Vector3();

const outlineVertexShader = /* glsl */ `
attribute vec3 faceNormalA;
attribute vec3 faceNormalB;
attribute float crease;
varying vec3 vNormalA;
varying vec3 vNormalB;
varying vec3 vViewPosition;
varying float vCrease;

void main() {
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  vViewPosition = mvPosition.xyz;
  vNormalA = normalize(normalMatrix * faceNormalA);
  vNormalB = normalize(normalMatrix * faceNormalB);
  vCrease = crease;
  gl_Position = projectionMatrix * mvPosition;
}
`;

const outlineFragmentShader = /* glsl */ `
uniform vec3 diffuse;
uniform float opacity;
varying vec3 vNormalA;
varying vec3 vNormalB;
varying vec3 vViewPosition;
varying float vCrease;

void main() {
  if (vCrease < 0.5) {
    vec3 toCamera = isOrthographic ? vec3(0.0, 0.0, 1.0) : normalize(-vViewPosition);
    float facing = dot(vNormalA, toCamera) * dot(vNormalB, toCamera);
    // Same sign: both faces see the camera, or both face away. Not an outline.
    if (facing > 0.0) discard;
  }
  gl_FragColor = vec4(diffuse, opacity);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/**
 * Feature edges, plus every smoother edge so the shader can keep the ones
 * that form the silhouette. Face normals stay in mesh-local space.
 */
function buildOutlineGeometry(geometry) {
  const precision = 10 ** 4;
  const creaseDot = Math.cos(THREE.MathUtils.degToRad(OUTLINE_CREASE_ANGLE));
  const minDot = Math.cos(THREE.MathUtils.degToRad(OUTLINE_MIN_ANGLE));

  const indexAttr = geometry.getIndex();
  const positionAttr = geometry.getAttribute("position");
  const indexCount = indexAttr ? indexAttr.count : positionAttr.count;

  const indexArr = [0, 0, 0];
  const vertKeys = ["a", "b", "c"];
  const hashes = ["", "", ""];
  /** @type {Map<string, {index0: number, index1: number, normal: THREE.Vector3}>} */
  const edgeData = new Map();

  const positions = [];
  const normalA = [];
  const normalB = [];
  const crease = [];

  const pushEdge = (v0, v1, n0, n1, isCrease) => {
    positions.push(v0.x, v0.y, v0.z, v1.x, v1.y, v1.z);
    normalA.push(n0.x, n0.y, n0.z, n0.x, n0.y, n0.z);
    normalB.push(n1.x, n1.y, n1.z, n1.x, n1.y, n1.z);
    const flag = isCrease ? 1 : 0;
    crease.push(flag, flag);
  };

  for (let i = 0; i < indexCount; i += 3) {
    if (indexAttr) {
      indexArr[0] = indexAttr.getX(i);
      indexArr[1] = indexAttr.getX(i + 1);
      indexArr[2] = indexAttr.getX(i + 2);
    } else {
      indexArr[0] = i;
      indexArr[1] = i + 1;
      indexArr[2] = i + 2;
    }

    const { a, b, c } = _outlineTriangle;
    a.fromBufferAttribute(positionAttr, indexArr[0]);
    b.fromBufferAttribute(positionAttr, indexArr[1]);
    c.fromBufferAttribute(positionAttr, indexArr[2]);
    _outlineTriangle.getNormal(_outlineNormal);

    hashes[0] = `${Math.round(a.x * precision)},${Math.round(a.y * precision)},${Math.round(a.z * precision)}`;
    hashes[1] = `${Math.round(b.x * precision)},${Math.round(b.y * precision)},${Math.round(b.z * precision)}`;
    hashes[2] = `${Math.round(c.x * precision)},${Math.round(c.y * precision)},${Math.round(c.z * precision)}`;
    if (
      hashes[0] === hashes[1] ||
      hashes[1] === hashes[2] ||
      hashes[2] === hashes[0]
    ) {
      continue;
    }

    for (let j = 0; j < 3; j++) {
      const jNext = (j + 1) % 3;
      const hash = `${hashes[j]}_${hashes[jNext]}`;
      const reverseHash = `${hashes[jNext]}_${hashes[j]}`;
      const v0 = _outlineTriangle[vertKeys[j]];
      const v1 = _outlineTriangle[vertKeys[jNext]];
      const prev = edgeData.get(reverseHash);

      if (prev) {
        const dot = _outlineNormal.dot(prev.normal);
        // dot <= cos(angle): the faces diverge by at least that angle.
        if (dot <= minDot) {
          pushEdge(v0, v1, prev.normal, _outlineNormal, dot <= creaseDot);
        }
        edgeData.delete(reverseHash);
      } else if (!edgeData.has(hash)) {
        edgeData.set(hash, {
          index0: indexArr[j],
          index1: indexArr[jNext],
          normal: _outlineNormal.clone(),
        });
      }
    }
  }

  for (const edge of edgeData.values()) {
    _outlineA.fromBufferAttribute(positionAttr, edge.index0);
    _outlineB.fromBufferAttribute(positionAttr, edge.index1);
    pushEdge(_outlineA, _outlineB, edge.normal, edge.normal, true);
  }

  const outline = new THREE.BufferGeometry();
  outline.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  outline.setAttribute("faceNormalA", new THREE.Float32BufferAttribute(normalA, 3));
  outline.setAttribute("faceNormalB", new THREE.Float32BufferAttribute(normalB, 3));
  outline.setAttribute("crease", new THREE.Float32BufferAttribute(crease, 1));
  return outline;
}

function attachHiddenLine(root) {
  bodyMeshes.length = 0;
  edgeLines.length = 0;
  lineMaterials.length = 0;
  infillMaterials.clear();

  const outlineMat = new THREE.ShaderMaterial({
    uniforms: {
      diffuse: { value: new THREE.Color(PALETTE[themeKey()].linePrimary) },
      opacity: { value: 1 },
    },
    vertexShader: outlineVertexShader,
    fragmentShader: outlineFragmentShader,
    depthTest: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
  });
  lineMaterials.push(outlineMat);

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

    const outline = new THREE.LineSegments(
      buildOutlineGeometry(mesh.geometry),
      outlineMat,
    );
    outline.frustumCulled = false;
    outline.layers.set(LINE_LAYER);
    mesh.add(outline);
    edgeLines.push(outline);
  }
}

function setAnimTime(t) {
  animTime = ((t % animDuration) + animDuration) % animDuration;
  sampleClip(animTime * ANIM_PLAYBACK_RATE);
  const pct = (animTime / animDuration) * 100;
  scrubFill.style.width = `${pct}%`;
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
      const clip = prepareExplosionClip(gltf.animations[0]);
      const action = mixer.clipAction(clip);
      action.play();
      // Keep the action unpaused: mixer.setTime() needs a non-zero effective
      // time scale or scrubbing (scroll) always samples the clip at t = 0.
      animDuration = clip.duration / ANIM_PLAYBACK_RATE;
    }

    setAnimTime(0);
    if (mixer) mixer.update(0);
    modelRoot.updateMatrixWorld(true);
    bindPushRodToCoolingFin(modelRoot);
    if (CRANK_DRIVE_ENABLED) crankDrive = createCrankDrive(modelRoot);
    window.__dbg = { modelRoot, setAnimTime, camera, controls, get crankDrive() { return crankDrive; }, setPlaying(v) { playing = v; lastUserActivityAt = v ? -Infinity : Infinity; }, animDuration };
    fitModel(modelRoot);

    // Initialize part labels after model is loaded and positioned
    initPartLabels(modelRoot);

    fitRenderer();
  },
  undefined,
  (err) => {
    console.error(err);
  },
);

function fitModel(root) {
  frameModel(root);
  fitRenderer();
}

host.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();
    noteUserActivity();
    const delta = (e.deltaY / 1000) * animDuration;
    setAnimTime(animTime + delta);
  },
  { passive: false },
);

host.addEventListener("pointerdown", () => {
  noteUserActivity();
  host.classList.add("grabbing");
});
host.addEventListener("pointerup", () => host.classList.remove("grabbing"));
host.addEventListener("pointerleave", () => host.classList.remove("grabbing"));

window.addEventListener("keydown", (e) => {
  if (e.code === "Space") {
    e.preventDefault();
    const wasPlaying = playing;
    noteUserActivity();
    playing = !wasPlaying;
    return;
  }
  if (
    e.code === "Escape" &&
    infoToggle?.getAttribute("aria-expanded") === "true"
  ) {
    setInfoPanelOpen(false);
    infoToggle.focus();
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

function setInfoPanelOpen(open) {
  if (!infoToggle || !infoPanel) return;
  infoToggle.setAttribute("aria-expanded", open ? "true" : "false");
  infoPanel.hidden = !open;
  if (open) {
    infoPanel.setAttribute("aria-modal", "true");
  } else {
    infoPanel.removeAttribute("aria-modal");
  }
}

infoToggle?.addEventListener("click", (e) => {
  e.stopPropagation();
  const open = infoToggle.getAttribute("aria-expanded") === "true";
  setInfoPanelOpen(!open);
});

document.addEventListener("click", (e) => {
  if (
    infoToggle?.getAttribute("aria-expanded") === "true" &&
    attributionWrap &&
    !attributionWrap.contains(e.target)
  ) {
    setInfoPanelOpen(false);
  }
});

window.addEventListener("resize", () => {
  updateHeaderLayout();
  if (modelRoot) fitModel(modelRoot);
  else fitRenderer();
});

updateHeaderLayout();

const clock = new THREE.Clock();
function tick() {
  requestAnimationFrame(tick);
  const dt = clock.getDelta();
  const idle = presentationIdle();

  if (idle) {
    playing = true;
    if (modelRoot) {
      modelRoot.rotation.y += ((Math.PI * 2) / AUTO_ROTATE_PERIOD_S) * dt;
    }
  }

  if (playing && mixer && idle) {
    setAnimTime(animTime + dt);
  } else if (mixer) {
    sampleClip(animTime * ANIM_PLAYBACK_RATE);
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
  updateLabelConnectors();
}
tick();
