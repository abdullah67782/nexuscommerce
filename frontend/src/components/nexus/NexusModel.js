import * as THREE from 'three';
import { NEXUS_NODES, OUTPUT_IDS, CORE_COLOR, CORE_HOT, DATA_COLOR, clamp01, easeOutCubic } from './nexusConfig';

// Imperative scene graph for the landing-page Nexus — deliberately cheap.
// Budget (desktop): ~17 draw calls, ~40 particles, one small additive sprite,
// no lights (unlit MeshBasic materials), no per-frame buffer uploads except
// the particle matrices. Everything allocated is tracked and disposed.

const tmpV = new THREE.Vector3();
const tmpM = new THREE.Matrix4();

function seeded(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

function haloTexture() {
  const size = 64;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.3, 'rgba(255,255,255,.3)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function circlePoints(radius, segments = 64) {
  const pts = [];
  for (let i = 0; i <= segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    pts.push(new THREE.Vector3(Math.cos(a) * radius, Math.sin(a) * radius, 0));
  }
  return pts;
}

export class NexusModel {
  constructor({ layout, particles = 40, streams = 6, seed = 7 }) {
    this.layout = layout;
    this.disposables = [];
    this.root = new THREE.Group();
    this.hitGroup = new THREE.Group();
    this.rand = seeded(seed);

    this.positions = {};
    for (const key of ['core', ...NEXUS_NODES.map(n => n.id)]) this.positions[key] = new THREE.Vector3(...layout[key]);

    this.buildCore();
    this.buildNodes();
    this.buildLinks();
    this.buildStreams(streams);
    this.buildParticles(particles);
  }

  track(obj) { this.disposables.push(obj); return obj; }

  lineMaterial(color, opacity) {
    return this.track(new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthWrite: false }));
  }

  // ── Core: solid heart + one wireframe shell + one small halo ───────────
  buildCore() {
    const g = new THREE.Group();
    g.position.copy(this.positions.core);
    const heart = new THREE.Mesh(
      this.track(new THREE.IcosahedronGeometry(0.34, 1)),
      this.track(new THREE.MeshBasicMaterial({ color: CORE_HOT, toneMapped: false })),
    );
    const shell = new THREE.LineSegments(
      this.track(new THREE.EdgesGeometry(this.track(new THREE.IcosahedronGeometry(0.95, 1)))),
      this.lineMaterial(CORE_COLOR, 0.6),
    );
    this.haloTex = this.track(haloTexture());
    const halo = new THREE.Sprite(this.track(new THREE.SpriteMaterial({ map: this.haloTex, color: CORE_COLOR, transparent: true, opacity: 0.35, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false })));
    halo.scale.setScalar(2.4);
    g.add(halo, heart, shell);
    this.core = { group: g, heart, shell, halo };
    this.root.add(g);
  }

  // ── Module nodes: unlit solid + one ring; invisible hit sphere ─────────
  buildNodes() {
    const solidGeo = this.track(new THREE.OctahedronGeometry(0.2, 0));
    const ringGeo = this.track(new THREE.BufferGeometry().setFromPoints(circlePoints(0.4)));
    const hitGeo = this.track(new THREE.SphereGeometry(0.7, 8, 6));
    const hitMat = this.track(new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false, colorWrite: false }));
    this.nodes = {};
    for (const n of NEXUS_NODES) {
      const g = new THREE.Group();
      g.position.copy(this.positions[n.id]);
      const solid = new THREE.Mesh(solidGeo, this.track(new THREE.MeshBasicMaterial({ color: n.color, toneMapped: false })));
      const ring = new THREE.LineLoop(ringGeo, this.lineMaterial(n.color, 0.5));
      g.add(solid, ring);
      this.root.add(g);
      const hit = new THREE.Mesh(hitGeo, hitMat);
      hit.userData.nodeId = n.id;
      hit.visible = false; // raycast-only: three's Raycaster ignores `visible`, the renderer skips it
      hit.position.copy(this.positions[n.id]);
      this.hitGroup.add(hit);
      this.nodes[n.id] = { def: n, group: g, solid, ring, hit, hover: 0 };
    }
  }

  curveBetween(a, b, bend, lift) {
    const mid = a.clone().add(b).multiplyScalar(0.5);
    const dir = b.clone().sub(a);
    mid.add(new THREE.Vector3(-dir.y, dir.x, 0).normalize().multiplyScalar(bend * dir.length()));
    mid.z += lift;
    return new THREE.QuadraticBezierCurve3(a.clone(), mid, b.clone());
  }

  buildLinks() {
    const core = this.positions.core;
    this.links = {};
    const make = (id, from, to, color, bend, lift) => {
      const curve = this.curveBetween(from, to, bend, lift);
      const pts = curve.getPoints(48);
      const line = new THREE.Line(this.track(new THREE.BufferGeometry().setFromPoints(pts)), this.lineMaterial(color, 0.45));
      line.userData.count = pts.length;
      this.root.add(line);
      this.links[id] = { curve, line };
    };
    make('inflow', this.positions.data, core, DATA_COLOR, 0.12, 0.4);
    const bends = { signals: -0.16, risks: 0.04, opportunities: 0.18 };
    for (const id of OUTPUT_IDS) make(id, core, this.positions[id], NEXUS_NODES.find(n => n.id === id).color, bends[id], -0.3);
  }

  // A handful of inbound commerce-data streams, merged into one draw call.
  buildStreams(count) {
    const target = this.positions.data;
    this.streams = [];
    const seg = [];
    for (let i = 0; i < count; i++) {
      const t = count > 1 ? i / (count - 1) : 0.5;
      const src = this.layout.portrait
        ? new THREE.Vector3(-4 + t * 8, 9.5, -1 + this.rand() * 2)
        : new THREE.Vector3(-11.5, -3 + t * 6, -2 + this.rand() * 3);
      const curve = this.curveBetween(src, target, (this.rand() - 0.5) * 0.3, (this.rand() - 0.5) * 1.5);
      this.streams.push(curve);
      const pts = curve.getPoints(24);
      for (let k = 0; k < pts.length - 1; k++) seg.push(pts[k], pts[k + 1]);
    }
    this.streamLines = new THREE.LineSegments(this.track(new THREE.BufferGeometry().setFromPoints(seg)), this.lineMaterial(DATA_COLOR, 0.12));
    this.root.add(this.streamLines);
  }

  // Particles: one instanced draw call; colours are set once, never per frame.
  buildParticles(count) {
    const geo = this.track(new THREE.IcosahedronGeometry(1, 0));
    const mat = this.track(new THREE.MeshBasicMaterial({ toneMapped: false }));
    const mesh = new THREE.InstancedMesh(geo, mat, count);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;
    const paths = [
      ...this.streams.map(curve => ({ curve, group: 'streams', color: DATA_COLOR })),
      { curve: this.links.inflow.curve, group: 'inflow', color: CORE_COLOR },
      ...OUTPUT_IDS.map(id => ({ curve: this.links[id].curve, group: id, color: NEXUS_NODES.find(n => n.id === id).color })),
    ];
    const streamPaths = paths.filter(p => p.group === 'streams');
    const nStream = Math.round(count * 0.4);
    const nIn = Math.round(count * 0.2);
    const color = new THREE.Color();
    this.particles = { mesh, data: [] };
    for (let i = 0; i < count; i++) {
      let path;
      if (i < nStream) path = streamPaths[i % streamPaths.length];
      else if (i < nStream + nIn) path = paths.find(p => p.group === 'inflow');
      else path = paths.find(p => p.group === OUTPUT_IDS[i % 3]);
      this.particles.data.push({ path, offset: this.rand(), speed: (path.group === 'streams' ? 0.06 : 0.11) * (0.8 + this.rand() * 0.4), size: 0.035 + this.rand() * 0.02 });
      mesh.setColorAt(i, color.set(path.color));
    }
    mesh.instanceColor.needsUpdate = true;
    this.root.add(mesh);
  }

  // ── Per-frame update ───────────────────────────────────────────────────
  update({ t, dt, w, intro, hovered, camera }) {
    const reveal = (start, span = 0.35) => easeOutCubic(clamp01((intro - start) / span));

    const c = this.core;
    const coreIn = reveal(0.12, 0.4);
    c.group.scale.setScalar(0.4 + 0.6 * coreIn);
    c.shell.rotation.set(t * 0.1, t * 0.15, 0);
    c.shell.material.opacity = (0.35 + 0.45 * w.core) * coreIn;
    c.halo.material.opacity = (0.18 + 0.25 * w.core) * coreIn;

    const order = { data: 0, signals: 1, risks: 2, opportunities: 3 };
    for (const id in this.nodes) {
      const n = this.nodes[id];
      n.hover += ((hovered === id ? 1 : 0) - n.hover) * Math.min(1, dt * 9);
      const nodeIn = reveal(id === 'data' ? 0.05 : 0.3 + order[id] * 0.08, 0.38);
      n.group.position.lerpVectors(this.positions.core, this.positions[id], nodeIn);
      n.hit.position.copy(n.group.position);
      const weight = w[id];
      n.solid.scale.setScalar(Math.max(0.0001, (0.75 + 0.35 * weight + 0.35 * n.hover) * nodeIn));
      n.solid.rotation.set(t * 0.3 + order[id], t * 0.4, 0);
      n.ring.quaternion.copy(camera.quaternion);
      n.ring.scale.setScalar(Math.max(0.0001, (0.85 + 0.25 * weight + 0.3 * n.hover) * nodeIn));
      n.ring.material.opacity = (0.2 + 0.45 * weight + 0.35 * n.hover) * nodeIn;
    }

    const linkIn = { inflow: reveal(0.2, 0.4), signals: reveal(0.42, 0.4), risks: reveal(0.5, 0.4), opportunities: reveal(0.58, 0.4) };
    for (const id in this.links) {
      const l = this.links[id];
      l.line.geometry.setDrawRange(0, Math.max(2, Math.floor(l.line.userData.count * linkIn[id])));
      const lw = id === 'inflow' ? w.inflow : w[id];
      l.line.material.opacity = 0.16 + 0.5 * lw + 0.3 * this.nodes[id === 'inflow' ? 'data' : id].hover;
    }
    this.streamLines.material.opacity = (0.05 + 0.12 * w.streams) * easeOutCubic(clamp01(intro));

    const { mesh, data } = this.particles;
    for (let i = 0; i < data.length; i++) {
      const d = data[i];
      const g = d.path.group;
      const gw = g === 'streams' ? w.streams * reveal(0, 0.5)
        : g === 'inflow' ? w.inflow * linkIn.inflow
        : w.outflow * (0.55 + 0.45 * w[g]) * linkIn[g];
      const tt = (d.offset + t * d.speed) % 1;
      d.path.curve.getPoint(tt, tmpV);
      const s = d.size * gw * (0.35 + 0.65 * Math.sin(Math.PI * tt));
      tmpM.makeScale(s, s, s).setPosition(tmpV);
      mesh.setMatrixAt(i, tmpM);
    }
    mesh.instanceMatrix.needsUpdate = true;
  }

  dispose() {
    // Idempotent; objects stay intact so a StrictMode dev remount can reuse them.
    for (const d of this.disposables) d.dispose?.();
  }
}
