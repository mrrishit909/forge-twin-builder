"use client";
// The twin: assets of the active branch drawn from the library, live telemetry driving their motion through bindings, a
// gizmo with grid / angle / connector snapping, the recorded simulation's parts flowing through the line, collaborators'
// world-space cursors, and camera bookmarks. The canvas renders store state; edits go back through store actions.
import { Canvas, useFrame, useThree, type ThreeEvent } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js";
import { shortestAngle } from "@forge/motion";
import { LIBRARY, MachineSim, DEMO_MACHINES, simulate, portWorld, type Asset, type Scene, type SimResult, type V3 } from "@forge/domain";
import { addAsset, commitTransform, get, select, sendPresence, set, useApp } from "../store.ts";
import { live, pump } from "../live.ts";
import { introScroll, orchestrator, playback, telemetry } from "../runtime.ts";
import { BOOKMARKS, isIntro, type Cam } from "../journey.ts";
import { projectAnchors, sceneApi } from "./overlay.ts";

const SPIN_SCALE = 1 / 40; // spindles are drawn at 1/40 of their real speed (3,200 rpm would alias at 60 frames a second)
// heat glow relative to the machine's own limit: none below 40 °C, rising quadratically to a restrained orange-red at maxTempC
const HEAT = new THREE.Color("#ff5a1f");
const heat = (c: number, max = 85) => Math.max(0, Math.min(1, (c - 40) / Math.max(1, max - 40))) ** 2;

/** The scene the canvas shows: the template during the intro, the active branch afterwards. */
function useShownScene(): Scene | null {
  const view = useApp((s) => s.view), tpl = useApp((s) => s.template), active = useApp((s) => s.scenes[s.active]);
  return isIntro(view) || !active ? tpl : active;
}

/** Preview telemetry for the intro (before any connector exists): the same machine simulator, stepped locally. */
const preview = DEMO_MACHINES.map((m, k) => new MachineSim({ ...m, faultAtS: null }, 7 + k));
const previewVals: Record<string, ReturnType<MachineSim["step"]>> = {};
let previewAcc = 0;

function AssetMesh({ a, index, total }: { a: Asset; index: number; total: number }) {
  const g = useRef<THREE.Group>(null), spindle = useRef<THREE.Mesh>(null), body = useRef<THREE.Mesh>(null), lamp = useRef<THREE.Mesh>(null), arm = useRef<THREE.Group>(null), belt = useRef<THREE.Mesh>(null);
  const selected = useApp((s) => s.selected === a.id);
  const spec = LIBRARY[a.type];
  const [w, h, d] = spec.size;
  const bodyMat = useMemo(() => new THREE.MeshStandardMaterial({ color: a.type === "machine" ? "#4a6a8a" : a.type === "robot" ? "#d8a03c" : a.type === "buffer" ? "#5d6b7a" : a.type === "conveyor" ? "#2f3742" : "#3e5f4f", roughness: 0.6, metalness: 0.3 }), [a.type]);
  const beltTex = useMemo(() => {
    if (a.type !== "conveyor") return null;
    const c = document.createElement("canvas"); c.width = 64; c.height = 8;
    const x = c.getContext("2d")!; x.fillStyle = "#1b1f25"; x.fillRect(0, 0, 64, 8); x.fillStyle = "#47505c"; for (let i = 0; i < 64; i += 8) x.fillRect(i, 0, 3, 8);
    const t = new THREE.CanvasTexture(c); t.wrapS = THREE.RepeatWrapping; t.repeat.set(6, 1); return t;
  }, [a.type]);
  useFrame((_, dt) => {
    const s = get();
    const grp = g.current; if (!grp) return;
    // intro assembly: each asset drops into place in flow order as the first chapter scrolls by
    const f = s.reduced ? Math.round(introScroll.f) : introScroll.f;
    const intro = isIntro(s.view);
    const k = intro ? Math.max(0, Math.min(1, f * (total + 2) / 1.0 - index)) : 1;
    const e = k * k * (3 - 2 * k);
    grp.position.set(a.transform.position[0], a.transform.position[1] + (1 - e) * 6, a.transform.position[2]);
    grp.rotation.set(...(a.transform.rotation.map((x) => (x * Math.PI) / 180) as V3));
    grp.scale.set(...(a.transform.scale.map((x) => x * Math.max(0.001, e)) as V3));
    grp.visible = e > 0.001;
    // live values: bindings (sandbox) or the local preview (intro chapters 2-3)
    const b = intro ? (f >= 1.5 ? previewVals[a.id] && { spindleRpm: previewVals[a.id].rpm, temperatureC: previewVals[a.id].temperature, vibration: previewVals[a.id].vibration, status: previewVals[a.id].status } : undefined) : live.bound.get(a.id);
    const moving = !s.reduced && !s.motionPaused;
    if (spindle.current && b?.spindleRpm !== undefined && moving) spindle.current.rotation.y += ((b.spindleRpm / 60) * 2 * Math.PI * SPIN_SCALE) * dt;
    if (body.current) (body.current.material as THREE.MeshStandardMaterial).emissive.copy(HEAT).multiplyScalar(b?.temperatureC !== undefined ? heat(b.temperatureC, a.props.maxTempC) * 0.6 : 0);
    if (lamp.current) (lamp.current.material as THREE.MeshBasicMaterial).color.set(b?.status === undefined ? "#59606b" : b.status >= 1.5 ? "#ff4d3d" : b.status >= 0.5 ? "#ffb454" : "#5ef2c2");
    if (body.current && b?.vibration !== undefined && moving) { const amp = Math.min(0.03, Math.max(0, b.vibration - 2) * 0.006); body.current.position.x = (Math.random() - 0.5) * amp; }
    if (beltTex && moving && !intro) beltTex.offset.x -= ((a.props.speedMps ?? 0.2) / (a.props.lengthM ?? 4)) * 6 * dt;
    if (arm.current && moving) arm.current.rotation.y = Math.sin(performance.now() / 1000 * (2 * Math.PI / (a.props.cycleS ?? 20)) * 4) * 0.9;
  });
  const onClick = (ev: ThreeEvent<MouseEvent>) => { if (isIntro(get().view) || get().commentMode || get().placing) return; ev.stopPropagation(); select(a.id); };
  return (
    <group ref={g} name={`asset:${a.id}`} userData={{ assetId: a.id }} onClick={onClick}>
      {a.type === "conveyor" ? (
        <>
          <mesh ref={body} position={[0, 0.35, 0]} material={bodyMat} castShadow><boxGeometry args={[w, 0.7, d * 0.9]} /></mesh>
          <mesh ref={belt} position={[0, 0.72, 0]}><boxGeometry args={[w, 0.04, d * 0.7]} /><meshStandardMaterial map={beltTex ?? undefined} /></mesh>
        </>
      ) : a.type === "machine" ? (
        <>
          <mesh ref={body} position={[0, h / 2, 0]} material={bodyMat} castShadow><boxGeometry args={[w, h, d]} /></mesh>
          <mesh ref={spindle} position={[0.2, h + 0.25, 0]}><cylinderGeometry args={[0.22, 0.22, 0.5, 16]} /><meshStandardMaterial color="#c9d2dc" metalness={0.8} roughness={0.3} /></mesh>
          <mesh position={[0.2, h + 0.25, 0.23]}><boxGeometry args={[0.08, 0.4, 0.02]} /><meshBasicMaterial color="#222" /></mesh>
          <mesh ref={lamp} position={[-w / 2 + 0.2, h + 0.15, d / 2 - 0.2]}><sphereGeometry args={[0.12, 12, 8]} /><meshBasicMaterial color="#59606b" /></mesh>
        </>
      ) : a.type === "robot" ? (
        <>
          <mesh ref={body} position={[0, 0.3, 0]} material={bodyMat} castShadow><cylinderGeometry args={[0.6, 0.7, 0.6, 20]} /></mesh>
          <group ref={arm} position={[0, 0.6, 0]}>
            <mesh position={[0, 0.5, 0]} material={bodyMat}><boxGeometry args={[0.25, 1, 0.25]} /></mesh>
            <mesh position={[0.45, 1.0, 0]} material={bodyMat}><boxGeometry args={[0.9, 0.2, 0.2]} /></mesh>
          </group>
        </>
      ) : (
        <mesh ref={body} position={[0, h / 2, 0]} material={bodyMat} castShadow><boxGeometry args={[w, h, d]} /></mesh>
      )}
      {selected ? <mesh position={[0, 0.02, 0]} rotation={[-Math.PI / 2, 0, 0]}><ringGeometry args={[Math.max(w, d) * 0.62, Math.max(w, d) * 0.68, 48]} /><meshBasicMaterial color="#5ef2c2" /></mesh> : null}
    </group>
  );
}

function Assets({ scene }: { scene: Scene }) {
  return <>{scene.assets.map((a, k) => <AssetMesh key={a.id} a={a} index={k} total={scene.assets.length} />)}</>;
}

/** Links between connectors, drawn as thin lines a little above the floor. */
function Links({ scene }: { scene: Scene }) {
  const geo = useMemo(() => {
    const pts: THREE.Vector3[] = [];
    for (const l of scene.links) {
      const a = scene.assets.find((x) => x.id === l.from), b = scene.assets.find((x) => x.id === l.to);
      const p = a && portWorld(a, "out"), q = b && portWorld(b, "in");
      if (p && q) pts.push(new THREE.Vector3(p.pos[0], 0.06, p.pos[2]), new THREE.Vector3(q.pos[0], 0.06, q.pos[2]));
    }
    return new THREE.BufferGeometry().setFromPoints(pts);
  }, [scene]);
  return <lineSegments geometry={geo}><lineBasicMaterial color="#5ef2c2" transparent opacity={0.7} /></lineSegments>;
}

/** Parts of the recorded simulation run, moving station to station (conveyors carry them along their length). */
function Parts({ scene, run }: { scene: Scene; run: SimResult | null }) {
  const mesh = useRef<THREE.InstancedMesh>(null);
  const tracks = useMemo(() => {
    const m = new Map<number, [number, string][]>();
    for (const [t, id, st] of run?.moves ?? []) { const a = m.get(id) ?? []; a.push([t, st]); m.set(id, a); }
    return [...m.values()];
  }, [run]);
  const pos = useMemo(() => new Map(scene.assets.map((a) => [a.id, a])), [scene]);
  const tmp = useMemo(() => new THREE.Object3D(), []);
  useFrame((_, dt) => {
    const s = get(), im = mesh.current;
    if (!im) return;
    const intro = isIntro(s.view);
    const showing = (intro && introScroll.f >= 2.5) || s.view === "simulate";
    if (playback.playing && !s.motionPaused && !s.reduced) playback.t = (playback.t + dt * playback.rate) % 3600;
    if (intro && !s.reduced) playback.t = (playback.t + dt * 60) % 3600;
    let n = 0;
    if (showing) {
      const t = playback.t;
      const occ = new Map<string, number>();
      for (const tr of tracks) {
        let i = -1;
        for (let k = 0; k < tr.length && tr[k][0] <= t; k++) i = k;
        if (i < 0 || n >= 400) continue;
        const [t0, st] = tr[i], a = pos.get(st);
        if (!a || a.type === "sink") continue;
        const slot = occ.get(st) ?? 0; occ.set(st, slot + 1);
        const p = a.transform.position;
        if (a.type === "conveyor") {
          const inn = portWorld(a, "in")!.pos, out = portWorld(a, "out")!.pos, travel = (a.props.lengthM ?? 4) / (a.props.speedMps ?? 0.2);
          const u = Math.min(1, (t - t0) / travel);
          tmp.position.set(inn[0] + (out[0] - inn[0]) * u, 0.9, inn[2] + (out[2] - inn[2]) * u);
        } else tmp.position.set(p[0], (a.type === "buffer" ? 0.3 : LIBRARY[a.type].size[1] + 0.1) + slot * 0.32, p[2] + (a.type === "machine" ? 0.9 : 0));
        tmp.updateMatrix();
        im.setMatrixAt(n++, tmp.matrix);
      }
    }
    im.count = n;
    im.instanceMatrix.needsUpdate = true;
  });
  return <instancedMesh ref={mesh} args={[undefined, undefined, 400]} frustumCulled={false}><boxGeometry args={[0.3, 0.3, 0.3]} /><meshStandardMaterial color="#ffd36e" /></instancedMesh>;
}

/** Factory campus for the stress test: 2,000 assets, instanced, with a near (detailed) and far (box) level of detail. */
function Campus() {
  const near = useRef<THREE.InstancedMesh>(null), far = useRef<THREE.InstancedMesh>(null), spin = useRef<THREE.InstancedMesh>(null);
  const items = useMemo(() => {
    const out: { p: THREE.Vector3; s: THREE.Vector3; machine: boolean }[] = [];
    for (let line = 0; line < 250; line++) for (let k = 0; k < 8; k++) {
      const machine = k === 2 || k === 5;
      out.push({ p: new THREE.Vector3(-40 + k * 2.6 + Math.floor(line / 50) * 26, 0, -60 + (line % 50) * 3.2), s: new THREE.Vector3(machine ? 2 : 1.4, machine ? 2 : 0.8, machine ? 1.6 : 0.8), machine });
    }
    return out;
  }, []);
  const tmp = useMemo(() => new THREE.Object3D(), []);
  const last = useRef(0);
  useFrame(({ camera, clock }) => {
    if (!near.current || !far.current || !spin.current) return;
    if (clock.elapsedTime - last.current < 0.1) return; // LOD sets refresh at 10 Hz
    last.current = clock.elapsedTime;
    let n = 0, f = 0, sp = 0;
    for (const it of items) {
      const d = it.p.distanceTo(camera.position);
      tmp.position.set(it.p.x, it.s.y / 2, it.p.z); tmp.scale.copy(it.s); tmp.rotation.set(0, 0, 0); tmp.updateMatrix();
      if (d < 30) { near.current.setMatrixAt(n++, tmp.matrix); if (it.machine) { tmp.position.set(it.p.x + 0.2, it.s.y + 0.25, it.p.z); tmp.scale.set(1, 1, 1); tmp.rotation.set(0, clock.elapsedTime * 2, 0); tmp.updateMatrix(); spin.current.setMatrixAt(sp++, tmp.matrix); } }
      else far.current.setMatrixAt(f++, tmp.matrix);
    }
    near.current.count = n; far.current.count = f; spin.current.count = sp;
    for (const m of [near.current, far.current, spin.current]) m.instanceMatrix.needsUpdate = true;
    set({ stressInfo: { near: n, far: f } });
  });
  return (
    <>
      <instancedMesh ref={near} args={[undefined, undefined, 2000]} frustumCulled={false}><boxGeometry args={[1, 1, 1, 2, 2, 2]} /><meshStandardMaterial color="#4a6a8a" /></instancedMesh>
      <instancedMesh ref={spin} args={[undefined, undefined, 500]} frustumCulled={false}><cylinderGeometry args={[0.22, 0.22, 0.5, 16]} /><meshStandardMaterial color="#c9d2dc" /></instancedMesh>
      <instancedMesh ref={far} args={[undefined, undefined, 2000]} frustumCulled={false}><boxGeometry args={[1, 1, 1]} /><meshLambertMaterial color="#3c5068" /></instancedMesh>
    </>
  );
}

/** Gizmo on the selected asset: translate / rotate / scale with the library's snap steps; commit on release. */
function Gizmo({ scene, orbit }: { scene: Scene; orbit: React.RefObject<OrbitControls | null> }) {
  const { camera, gl, scene: three } = useThree();
  const sel = useApp((s) => s.selected), tool = useApp((s) => s.tool), view = useApp((s) => s.view);
  useEffect(() => {
    if (!sel || isIntro(view)) return;
    const obj = three.getObjectByName(`asset:${sel}`);
    if (!obj) return;
    const tc = new TransformControls(camera, gl.domElement);
    tc.setMode(tool);
    tc.setTranslationSnap(0.5); tc.setRotationSnap(THREE.MathUtils.degToRad(15)); tc.setScaleSnap(0.1);
    if (tool === "rotate") { tc.showX = false; tc.showZ = false; }
    tc.attach(obj);
    const helper = tc.getHelper();
    three.add(helper);
    const onDrag = (e: { value: unknown }) => { if (orbit.current) orbit.current.enabled = !e.value; if (!e.value) {
      commitTransform(sel, { position: [obj.position.x, Math.max(0, obj.position.y), obj.position.z], rotation: [obj.rotation.x, obj.rotation.y, obj.rotation.z].map((r) => (r * 180) / Math.PI) as V3, scale: [obj.scale.x, obj.scale.y, obj.scale.z] });
    } };
    tc.addEventListener("dragging-changed", onDrag as never);
    return () => { tc.removeEventListener("dragging-changed", onDrag as never); tc.detach(); three.remove(helper); tc.dispose(); };
  }, [sel, tool, view, camera, gl, three, orbit, scene]);
  return null;
}

/** Camera: orbit controls for the user, bookmarks and fly-to tweens (orchestrator) for views; reduced motion jumps. */
function CameraRig({ orbit, scene }: { orbit: React.RefObject<OrbitControls | null>; scene: Scene | null }) {
  const { camera, gl, size } = useThree();
  const lastKey = useRef("");
  useEffect(() => {
    const oc = new OrbitControls(camera, gl.domElement);
    oc.enableDamping = true; oc.maxPolarAngle = Math.PI * 0.48; oc.minDistance = 3; oc.maxDistance = 160;
    orbit.current = oc;
    return () => oc.dispose();
  }, [camera, gl, orbit]);
  const toCam = (c: Cam) => ({ target: new THREE.Vector3(c[0], c[1], c[2]), pos: new THREE.Vector3(c[0] + c[3] * Math.cos(c[5]) * Math.sin(c[4]), c[1] + c[3] * Math.sin(c[5]), c[2] + c[3] * Math.cos(c[5]) * Math.cos(c[4])) });
  useFrame((_, dt) => {
    const s = get(), oc = orbit.current;
    orchestrator.policy.reduced = s.reduced; orchestrator.policy.paused = s.motionPaused;
    orchestrator.tick(Math.min(100, dt * 1000));
    telemetry.frame(performance.now());
    // preview telemetry for the intro: 4 simulated seconds per second
    previewAcc += dt * 4;
    while (previewAcc >= 1) { previewAcc--; preview.forEach((p) => { previewVals[p.m.id] = p.step(); }); }
    pump();
    let key: string = s.view, target: Cam | null = null;
    if (isIntro(s.view)) {
      const f = s.reduced ? Math.round(introScroll.f) : introScroll.f, i = Math.floor(f), w = f - i;
      const a = BOOKMARKS[`intro${Math.min(3, i)}`], b = BOOKMARKS[`intro${Math.min(3, i + 1)}`];
      target = a.map((x, k) => x + (b[k] - x) * w * w * (3 - 2 * w)) as Cam;
      orchestrator.set("cam", target);
      key = "intro";
    } else if (s.view === "inspect" && s.selected) {
      const a = scene?.assets.find((x) => x.id === s.selected);
      if (a) { target = [a.transform.position[0], 1, a.transform.position[2], 8, 0.5, 0.45]; key = `inspect:${a.id}`; }
    } else {
      const bm = s.bookmark;
      target = s.stress ? [0, 0, 0, 90, 0.6, 0.7] : BOOKMARKS[bm] ?? BOOKMARKS.overview;
      key = `${s.view}:${bm}:${s.stress}`;
    }
    if (target && key !== lastKey.current && key !== "intro") {
      const cur = orchestrator.get("cam") as Cam | undefined;
      if (cur) target[4] = shortestAngle(cur[4], target[4]);
      orchestrator.to("cam", target, 1400);
      lastKey.current = key;
    } else if (key === "intro") lastKey.current = "intro";
    const c = orchestrator.get("cam") as Cam | undefined;
    if (c && (orchestrator.busy("cam") || isIntro(s.view))) {
      const { target: t, pos } = toCam(c);
      camera.position.copy(pos); if (oc) oc.target.copy(t); camera.lookAt(t);
    }
    if (oc) { oc.enabled = !isIntro(s.view) && !orchestrator.busy("cam"); if (oc.enabled) oc.update(); }
    projectAnchors(camera, size.width, size.height);
  });
  return null;
}

function Floor() {
  const { camera, gl, raycaster } = useThree();
  const plane = useMemo(() => new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), []);
  useEffect(() => {
    const hit = new THREE.Vector3();
    sceneApi.pickFloor = (x, y) => {
      const r = gl.domElement.getBoundingClientRect();
      raycaster.setFromCamera(new THREE.Vector2(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1), camera);
      return raycaster.ray.intersectPlane(plane, hit) ? [hit.x, 0, hit.z] : null;
    };
    sceneApi.project = (p) => { const v = new THREE.Vector3(...p).project(camera), r = gl.domElement.getBoundingClientRect(); return v.z < 1 ? [r.left + ((v.x + 1) / 2) * r.width, r.top + ((1 - v.y) / 2) * r.height] : null; };
  }, [camera, gl, raycaster, plane]);
  const onMove = (e: ThreeEvent<PointerEvent>) => sendPresence([+e.point.x.toFixed(2), 0, +e.point.z.toFixed(2)]);
  const onClick = (e: ThreeEvent<MouseEvent>) => {
    const s = get();
    if (isIntro(s.view)) return;
    if (s.placing) { addAsset(s.placing, [e.point.x, 0, e.point.z]); return; }
    if (s.commentMode) { set({ pendingComment: { position: [+e.point.x.toFixed(2), 0.1, +e.point.z.toFixed(2)], assetId: s.selected } }); return; }
    select(null);
  };
  return (
    <>
      <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow onPointerMove={onMove} onClick={onClick}><planeGeometry args={[400, 400]} /><meshStandardMaterial color="#14181e" /></mesh>
      <gridHelper args={[60, 120, "#2a3340", "#1c222b"]} position={[0, 0.005, 0]} />
    </>
  );
}

function Telemetry() {
  const { gl } = useThree();
  useEffect(() => {
    requestAnimationFrame(() => telemetry.mark("sceneLoadMs", performance.now()));
    const el = gl.domElement;
    const lost = (e: Event) => { e.preventDefault(); telemetry.contextLost(); set({ webgl: "lost" }); };
    const restored = () => set({ webgl: "ok" });
    el.addEventListener("webglcontextlost", lost); el.addEventListener("webglcontextrestored", restored);
    const iv = setInterval(() => { const i = gl.info; telemetry.sample({ calls: i.render.calls, triangles: i.render.triangles, points: i.render.points, geometries: i.memory.geometries, textures: i.memory.textures, programs: i.programs?.length ?? 0 }, get().stress ? 2000 : get().scenes[get().active]?.assets.length ?? 0); }, 500);
    const flush = setInterval(() => telemetry.flush(), 30000);
    return () => { clearInterval(iv); clearInterval(flush); el.removeEventListener("webglcontextlost", lost); el.removeEventListener("webglcontextrestored", restored); };
  }, [gl]);
  return null;
}

let introRun: SimResult | null = null;
export default function Scene3D() {
  const scene = useShownScene();
  const run = useApp((s) => s.sims[s.active]?.playback ?? null);
  const stress = useApp((s) => s.stress);
  const orbit = useRef<OrbitControls | null>(null);
  const tpl = useApp((s) => s.template);
  if (tpl && !introRun) { try { introRun = simulate(tpl, { hours: 1, warmupH: 1, seed: 1000, recordS: 3600 }); } catch { introRun = null; } }
  const view = useApp((s) => s.view);
  return (
    <Canvas className="twin" shadows dpr={[1, 2]} camera={{ fov: 45, near: 0.1, far: 800, position: [20, 30, 20] }} gl={{ antialias: true, preserveDrawingBuffer: true }}
      onCreated={({ gl, scene: s, camera }) => { gl.setClearColor("#0b0e13"); const t0 = performance.now(); gl.compile(s, camera); telemetry.mark("shaderCompileMs", performance.now() - t0); }}>
      <Telemetry />
      <hemisphereLight args={["#cfd8e6", "#1a1f27", 0.7]} />
      <directionalLight position={[10, 18, 8]} intensity={1.6} castShadow shadow-mapSize={[1024, 1024]} />
      <Floor />
      {stress ? <Campus /> : scene ? (
        <>
          <Assets scene={scene} />
          <Links scene={scene} />
          <Parts scene={scene} run={isIntro(view) ? introRun : run} />
          <Gizmo scene={scene} orbit={orbit} />
        </>
      ) : null}
      <CameraRig orbit={orbit} scene={scene} />
    </Canvas>
  );
}
