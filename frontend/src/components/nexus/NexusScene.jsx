'use client';
import { useEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { NexusModel } from './NexusModel';
import {
  NEXUS_NODES, OUTPUT_IDS, HERO_STATIONS, PORTRAIT_STATIONS,
  layoutFor, focusWeights, stationAt, clamp01, easeOutCubic,
} from './nexusConfig';

const UP = new THREE.Vector3(0, 1, 0);

function focusPoint(name, P, out) {
  if (name === 'center') {
    out.set(0, 0, 0);
    for (const k of ['core', 'data', 'signals', 'risks', 'opportunities']) out.add(P[k]);
    return out.multiplyScalar(1 / 5);
  }
  if (name === 'outputs') {
    out.set(0, 0, 0);
    for (const id of OUTPUT_IDS) out.add(P[id]);
    return out.multiplyScalar(1 / 3);
  }
  return out.copy(P[name]);
}

// Camera position + look target that frame `st.focus` at screen offset (sx, sy).
function stationPose(st, P, fov, aspect, pos, look, scratch) {
  const { focus, fwd, right, up } = scratch;
  focusPoint(st.focus, P, focus);
  pos.set(focus.x + Math.sin(st.azim) * st.dist, focus.y + st.elev, focus.z + Math.cos(st.azim) * st.dist);
  fwd.copy(focus).sub(pos).normalize();
  right.copy(fwd).cross(UP).normalize();
  up.copy(right).cross(fwd).normalize();
  const halfH = st.dist * Math.tan(THREE.MathUtils.degToRad(fov / 2));
  look.copy(focus).addScaledVector(right, -st.sx * halfH * aspect).addScaledVector(up, -st.sy * halfH);
}

// Labels are plain DOM nodes positioned without React renders. The DOM is
// only touched when a label visibly moved, faded or changed hover state.
function paintLabel(el, cache, id, x, y, opacity, hovered) {
  const prev = cache[id] || (cache[id] = { x: -1, y: -1, op: -1, hov: null });
  if (Math.abs(prev.x - x) <= 0.5 && Math.abs(prev.y - y) <= 0.5 && Math.abs(prev.op - opacity) <= 0.01 && prev.hov === hovered) return;
  el.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`;
  el.style.opacity = opacity.toFixed(3);
  if (prev.hov !== hovered) el.classList.toggle('is-hovered', hovered);
  prev.x = x; prev.y = y; prev.op = opacity; prev.hov = hovered;
}

function createRig(reduced) {
  return {
    t: reduced ? 6 : 0, intro: reduced ? 1 : 0, first: true,
    pos: new THREE.Vector3(), look: new THREE.Vector3(), started: false,
    tPos: new THREE.Vector3(), tLook: new THREE.Vector3(),
    aPos: new THREE.Vector3(), aLook: new THREE.Vector3(), bPos: new THREE.Vector3(), bLook: new THREE.Vector3(),
    par: new THREE.Vector2(), proj: new THREE.Vector3(),
    scratch: { focus: new THREE.Vector3(), fwd: new THREE.Vector3(), right: new THREE.Vector3(), up: new THREE.Vector3() },
    perfAcc: 0, perfN: 0, labelState: {},
  };
}

export default function NexusScene({ progressRef, hoveredRef, onHover, labelsRef, pointerRef, reduced, particles, onFirstFrame }) {
  const size = useThree(s => s.size);
  const aspect = size.width / Math.max(1, size.height);
  const portrait = aspect < 0.85;

  const model = useMemo(
    () => new NexusModel({ layout: layoutFor(portrait ? 0.5 : 1.6), particles, streams: portrait ? 4 : 6 }),
    [portrait, particles],
  );
  useEffect(() => () => model.dispose(), [model]);

  // Mutable per-frame state. Created lazily inside the frame loop so nothing
  // is allocated or written during render.
  const rig = useRef(null);
  const reducedRef = useRef(reduced);
  useEffect(() => {
    reducedRef.current = reduced;
    if (reduced && rig.current) { rig.current.intro = 1; rig.current.t = 6; }
  }, [reduced]);

  useFrame((state, delta) => {
    if (!rig.current) rig.current = createRig(reducedRef.current);
    const r = rig.current;
    const dt = Math.min(delta, 1 / 20);
    if (!reduced) { r.t += dt; r.intro = Math.min(1, r.intro + dt / 2.4); }
    const t = r.t;
    const p = clamp01(progressRef?.current ?? 0);
    const cam = state.camera;

    // ── Emphasis
    const w = focusWeights(p);

    // ── Camera target
    const fov = cam.fov;
    const P = model.positions;
    const s = stationAt(portrait ? PORTRAIT_STATIONS : HERO_STATIONS, p);
    if (s.a) {
      stationPose(s.a, P, fov, aspect, r.aPos, r.aLook, r.scratch);
      stationPose(s.b, P, fov, aspect, r.bPos, r.bLook, r.scratch);
      r.tPos.lerpVectors(r.aPos, r.bPos, s.t);
      r.tLook.lerpVectors(r.aLook, r.bLook, s.t);
    } else {
      stationPose(s, P, fov, aspect, r.tPos, r.tLook, r.scratch);
    }

    // Entrance dolly: start further out and settle in.
    const introE = easeOutCubic(r.intro);
    r.scratch.fwd.copy(r.tPos).sub(r.tLook).normalize();
    r.tPos.addScaledVector(r.scratch.fwd, (1 - introE) * 7);

    // Pointer parallax (window-level so overlaid copy doesn't block it).
    if (!reduced && pointerRef?.current) {
      r.par.x += (pointerRef.current.x - r.par.x) * Math.min(1, dt * 2.5);
      r.par.y += (pointerRef.current.y - r.par.y) * Math.min(1, dt * 2.5);
      r.scratch.right.copy(r.scratch.fwd).cross(UP).normalize();
      r.tPos.addScaledVector(r.scratch.right, -r.par.x * 0.55).addScaledVector(UP, r.par.y * 0.35);
    }

    if (!r.started || reduced) { r.pos.copy(r.tPos); r.look.copy(r.tLook); r.started = true; }
    const k = 1 - Math.exp(-dt * 2.6);
    r.pos.lerp(r.tPos, k);
    r.look.lerp(r.tLook, k);
    cam.position.copy(r.pos);
    cam.lookAt(r.look);
    cam.updateMatrixWorld();

    model.update({ t, dt, w, intro: r.intro, hovered: hoveredRef.current, camera: cam });

    // ── DOM labels: project node positions, write transforms directly.
    const W = state.size.width, H = state.size.height;
    // Labels sit just outside each node's ring (ring radius 0.4 world units).
    r.scratch.right.setFromMatrixColumn(cam.matrixWorld, 0);
    for (const n of NEXUS_NODES) {
      const el = labelsRef.current?.[n.id];
      if (!el) continue;
      const node = model.nodes[n.id];
      r.proj.copy(node.group.position).addScaledVector(r.scratch.right, 0.4 * node.ring.scale.x + 0.14).project(cam);
      const visible = r.proj.z < 1 && Math.abs(r.proj.x) < 1.15 && Math.abs(r.proj.y) < 1.15;
      const x = (r.proj.x * 0.5 + 0.5) * W;
      const y = (-r.proj.y * 0.5 + 0.5) * H;
      const weight = w[n.id] ?? 0.5;
      const op = visible ? Math.min(1, (0.4 + weight * 0.7 + node.hover) * easeOutCubic(clamp01((r.intro - 0.55) / 0.4))) : 0;
      const hov = hoveredRef.current === n.id;
      paintLabel(el, r.labelState, n.id, x, y, op, hov);
    }

    // ── Safety valve: if frames run long (slow GPU), drop to DPR 1 once.
    r.perfAcc += delta; r.perfN += 1;
    if (r.perfN >= 120) {
      if (r.perfAcc / r.perfN > 1 / 45 && state.viewport.dpr > 1) state.setDpr(1);
      r.perfAcc = 0; r.perfN = 0;
    }

    if (r.first) { r.first = false; onFirstFrame?.(); }
  });

  const handlers = useMemo(() => ({
    onPointerOver: e => { e.stopPropagation(); onHover?.(e.object.userData.nodeId); document.body.style.cursor = 'pointer'; },
    onPointerOut: e => { e.stopPropagation(); onHover?.(null); document.body.style.cursor = ''; },
  }), [onHover]);

  useEffect(() => () => { document.body.style.cursor = ''; }, []);

  return (
    <>
      <primitive object={model.root} />
      <primitive object={model.hitGroup} {...handlers} />
    </>
  );
}
