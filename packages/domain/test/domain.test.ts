import { describe, expect, it } from "vitest";
import {
  templateFactory, newAsset, snapTransform, snapToConnector, portWorld, serialize, parseScene, canonical, SceneError, LIBRARY,
  compile, ExprError, MachineSim, PlantSim, DEMO_MACHINES, TelemetryQueue, topicMatches, backoffMs, SimBroker, SimConnector, topicOf,
  vibrationAlarm, simulate, replicate, compare, sizeBuffer, stationsFromScene, estimate, branchFrom, diff, merge, Replica, rng,
  type Scene, type Reading, type Op,
} from "../src/index.ts";
import { connectorContract } from "./contract.ts";

const factory = templateFactory();
const withExpansion = (s: Scene): Scene => {
  const ex = structuredClone(s);
  ex.assets.push({ ...newAsset("machine", "m1b", [-7, 0, 3], "CNC mill M1b"), props: { ...s.assets.find((a) => a.id === "m1")!.props } });
  ex.links.push({ from: "c1", to: "m1b" }, { from: "m1b", to: "b1" });
  return ex;
};

describe("scene: snapping", () => {
  it("snaps to the grid, to 15 degrees and to 0.1 scale steps", () => {
    const t = snapTransform({ position: [1.26, -0.3, 2.74], rotation: [0, 98, 367], scale: [1.04, 7, 0.2] });
    expect(t).toEqual({ position: [1.5, 0, 2.5], rotation: [0, 105, 0], scale: [1, 4, 0.5] });
  });
  it("connector-aware snapping lines the new machine's in-port up with the conveyor's free out-port", () => {
    const s = templateFactory();
    s.assets = s.assets.filter((a) => a.id === "c1");
    s.links = [];
    const out = portWorld(s.assets[0], "out")!;
    const m = { ...newAsset("machine", "mx", [out.pos[0] + 1.6, 0, out.pos[2] + 0.4]), transform: { position: [out.pos[0] + 1.6, 0, out.pos[2] + 0.4], rotation: [0, 20, 0], scale: [1, 1, 1] } } as typeof s.assets[0];
    const hit = snapToConnector({ ...s, assets: [...s.assets, m] }, m)!;
    expect(hit.link).toEqual({ from: "c1", to: "mx" });
    const snapped = portWorld({ ...m, transform: hit.transform }, "in")!;
    expect(Math.hypot(snapped.pos[0] - out.pos[0], snapped.pos[2] - out.pos[2])).toBeLessThan(1e-6);
    expect(hit.transform.rotation[1]).toBe(0);
    // too far: no snap; a port already used: no snap
    expect(snapToConnector({ ...s, assets: [...s.assets, { ...m, transform: { ...m.transform, position: [out.pos[0] + 5, 0, 0] } }] }, { ...m, transform: { ...m.transform, position: [out.pos[0] + 5, 0, 0] } })).toBeNull();
    expect(snapToConnector({ ...s, assets: [...s.assets, m], links: [{ from: "c1", to: "other" }] }, m)?.link.from).not.toBe("c1");
  });
  it("snaps from the other side too (a conveyor dropped upstream of a machine) and turns it to face the port", () => {
    const m = newAsset("machine", "m", [0, 0, 0]);
    m.transform.rotation = [0, 90, 0];
    const inn = portWorld(m, "in")!;
    const c = newAsset("conveyor", "c", [inn.pos[0] - 1.7, 0, inn.pos[2] + 0.4]); // its out-port lands 0.5 m from the machine's in-port
    const hit = snapToConnector({ ...factory, assets: [m, c], links: [] }, c)!;
    expect(hit.link).toEqual({ from: "c", to: "m" });
    const p = portWorld({ ...c, transform: hit.transform }, "out")!;
    expect(Math.hypot(p.pos[0] - inn.pos[0], p.pos[2] - inn.pos[2])).toBeLessThan(1e-6);
    expect(hit.transform.rotation[1]).toBe(90);
  });
  it("the template line is laid out port to port", () => {
    for (const l of factory.links) {
      const a = portWorld(factory.assets.find((x) => x.id === l.from)!, "out")!, b = portWorld(factory.assets.find((x) => x.id === l.to)!, "in")!;
      expect(Math.abs(a.pos[0] - b.pos[0])).toBeLessThan(1e-6);
    }
  });
});

describe("scene: serialization round trip", () => {
  it("parse(serialize(s)) is s, and the bytes do not depend on key order (property test over random scenes)", () => {
    const r = rng(5);
    const types = Object.keys(LIBRARY) as (keyof typeof LIBRARY)[];
    for (let k = 0; k < 200; k++) {
      const assets = Array.from({ length: r.int(1, 12) }, (_, i) => ({ ...newAsset(r.pick(types), `a${i}`, [r.range(-20, 20), 0, r.range(-20, 20)]), name: `asset ${i} ✓` }));
      const s: Scene = { version: 1, id: `s${k}`, name: "random", assets, links: assets.slice(1).map((a, i) => ({ from: assets[i].id, to: a.id })), bindings: [], comments: [{ id: "c", author: "x", assetId: null, position: [1, 2, 3], text: "hi \"there\"", at: "2026-10-06T00:00:00Z" }] };
      const text = serialize(s);
      expect(parseScene(text)).toEqual(s);
      expect(serialize(parseScene(text))).toBe(text);
      const reverseKeys = (v: unknown): unknown => Array.isArray(v) ? v.map(reverseKeys) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).reverse().map(([k, x]) => [k, reverseKeys(x)])) : v;
      expect(serialize(reverseKeys(s) as Scene)).toBe(text);
    }
    expect(canonical({ b: 1, a: [{ d: 2, c: undefined }] })).toBe('{"a":[{"d":2}],"b":1}');
  });
  it("refuses broken scenes", () => {
    const bad = (mut: (s: Scene) => void) => { const s = structuredClone(factory); mut(s); return () => parseScene(serialize(s)); };
    expect(bad((s) => { (s as { version: number }).version = 2; })).toThrow(SceneError);
    expect(bad((s) => { s.assets[1].id = s.assets[0].id; })).toThrow(/duplicate/);
    expect(bad((s) => { (s.assets[0] as { type: string }).type = "laser"; })).toThrow(/unknown asset type/);
    expect(bad((s) => { s.assets[0].transform.scale = [0, 1, 1]; })).toThrow(/scale/);
    expect(bad((s) => { s.links.push({ from: "src", to: "nope" }); })).toThrow(/dangling/);
    expect(bad((s) => { s.assets[2].props.processS = Number.NaN; })).toThrow(/bad prop/);
    expect(bad((s) => { s.bindings.push({ id: "b", assetId: "ghost", connectorId: "c", sourcePath: "x", targetProperty: "rpm", transform: "value", unit: "" }); })).toThrow(/binding/);
    expect(() => parseScene("{}")).toThrow();
  });
});

describe("binding expressions", () => {
  it("evaluates arithmetic and functions", () => {
    expect(compile("value / 60")(3000)).toBe(50);
    expect(compile("-value + 2 * (3 - 1)")(1)).toBe(3);
    expect(compile("clamp(value, 20, 120)")(150)).toBe(120);
    expect(compile("max(abs(value), 1.5e1)")(-3)).toBe(15);
    expect(compile(" min( value , .5 ) ")(2)).toBe(0.5);
  });
  it("cannot run code", () => {
    for (const src of ["process.exit()", "value; fetch('x')", "constructor", "this", "value[0]", "`x`", "clamp(value)", "value value", "(", "a".repeat(200)])
      expect(() => compile(src)).toThrow(ExprError);
  });
});

describe("telemetry", () => {
  it("the simulator is deterministic, and the faulty machine trips", () => {
    const a = new MachineSim(DEMO_MACHINES[1], 3), b = new MachineSim(DEMO_MACHINES[1], 3);
    const xs = Array.from({ length: 4000 }, () => a.step()), ys = Array.from({ length: 4000 }, () => b.step());
    expect(ys).toEqual(xs);
    expect(xs[1000].status).not.toBe(2);
    expect(xs[3999].status).toBe(2);
    expect(xs[3999].rpm).toBe(0);
    const mean = (a: { vibration: number; status: number }[]) => { const r = a.filter((x) => x.status === 0); return r.reduce((t, x) => t + x.vibration, 0) / r.length; };
    expect(mean(xs.slice(3700, 3890))).toBeGreaterThan(2 * mean(xs.slice(100, 1400)));
    const out: Reading[] = [];
    new PlantSim("site", DEMO_MACHINES, 1).tick(0, (r) => out.push(r));
    expect(out.map((r) => r.topic)).toContain(topicOf("site", "m2", "vibration"));
    expect(out).toHaveLength(10);
  });
  it("backpressure: a bounded queue keeps the latest value per topic and drops the oldest when full", () => {
    const q = new TelemetryQueue(256);
    for (let i = 0; i < 10000; i++) q.push({ topic: `t/${i % 400}`, ts: i, value: i, unit: "" });
    expect(q.size).toBeLessThanOrEqual(256);
    expect(q.dropped + q.coalesced).toBe(10000 - 256);
    const drained = q.drain();
    expect(drained.at(-1)!.value).toBe(9999);
    expect(new Set(drained.map((r) => r.topic)).size).toBe(drained.length);
    expect(q.size).toBe(0);
    const small = new TelemetryQueue(2);
    small.push({ topic: "a", ts: 1, value: 1, unit: "" }); small.push({ topic: "a", ts: 2, value: 2, unit: "" });
    expect(small.coalesced).toBe(1);
    expect(small.drain(1)).toHaveLength(1);
  });
  it("topic filters and backoff", () => {
    expect(topicMatches("forge/+/m1/#", "forge/site/m1/rpm")).toBe(true);
    expect(topicMatches("forge/+/m1/rpm", "forge/site/m2/rpm")).toBe(false);
    expect(topicMatches("forge/site", "forge/site/m1")).toBe(false);
    const ms = Array.from({ length: 10 }, (_, k) => backoffMs(k, () => 1));
    expect(ms).toEqual([500, 1000, 2000, 4000, 8000, 8000, 8000, 8000, 8000, 8000]);
    expect(backoffMs(3, () => 0)).toBe(0);
  });
  it("the default scheduler is called as a plain function (browsers throw 'Illegal invocation' otherwise)", async () => {
    const broker = new SimBroker(), c = new SimConnector(broker, () => 0);
    c.subscribe("forge/#", () => {});
    await c.connect();
    const bound = { setTimeout };
    const spy = (globalThis as { setTimeout: typeof setTimeout }).setTimeout;
    let thisArg: unknown = "unset";
    (globalThis as { setTimeout: unknown }).setTimeout = function (this: unknown, fn: () => void, ms: number) { thisArg = this; return spy(fn, ms); };
    try { broker.cut(); } finally { (globalThis as { setTimeout: unknown }).setTimeout = bound.setTimeout; }
    expect(thisArg).toBeUndefined();
    broker.restore();
    await new Promise((ok) => setTimeout(ok, 20));
    expect(c.state).toBe("connected");
  });
  it("the in-browser broker passes the connector contract (reconnect + retained replay)", async () => {
    const broker = new SimBroker();
    await connectorContract({
      make: () => new SimConnector(broker, () => 0.2), publish: (r) => broker.publish(r), cut: () => broker.cut(), restore: () => broker.restore(),
      wait: (ms) => new Promise((ok) => setTimeout(ok, ms)),
    });
  });
});

describe("predictive maintenance", () => {
  it("flags the bearing fault before the trip and stays quiet on a healthy machine", () => {
    const series = (faultAtS: number | null, seed: number, n: number) => {
      const m = new MachineSim({ id: "m", ratedRpm: 1450, maxTempC: 80, faultAtS, failAfterS: 2400 }, seed);
      return Array.from({ length: n }, (_, i) => { const v = m.step(); return { t: i + 1, vibration: v.vibration, running: v.status === 0 }; });
    };
    for (const seed of [1, 2, 3]) {
      const a = vibrationAlarm(series(1500, seed, 3900)).alarmAt!;
      expect(a).toBeGreaterThan(1500);
      expect(3900 - a).toBeGreaterThan(15 * 60);
    }
    expect(vibrationAlarm(series(null, 9, 4 * 3600)).alarmAt).toBeNull();
    expect(vibrationAlarm(series(null, 9, 100)).baseline.median).toBe(0); // not enough data to learn a baseline
  });
});

describe("discrete-event simulation", () => {
  it("replays identically for a fixed seed, and differently for another", () => {
    const a = simulate(factory, { hours: 8, warmupH: 1, seed: 7 }), b = simulate(factory, { hours: 8, warmupH: 1, seed: 7 }), c = simulate(factory, { hours: 8, warmupH: 1, seed: 8 });
    expect(b).toEqual(a);
    expect(c.traceHash).not.toBe(a.traceHash);
  });
  it("conserves parts and obeys Little's law", () => {
    for (const s of [factory, withExpansion(factory)]) {
      const r = simulate(s, { hours: 40, warmupH: 0, seed: 3 });
      expect(r.released).toBe(r.sunk + r.wipEnd);
      expect(Math.abs(r.wipAvg - (r.throughputPerH / 3600) * r.cycleMeanS) / r.wipAvg).toBeLessThan(0.05);
    }
  });
  it("matches the analytic answer on a deterministic one-machine line", () => {
    const s: Scene = { ...factory, assets: [newAsset("source", "s", [0, 0, 0]), { ...newAsset("machine", "m", [3, 0, 0]), props: { processS: 60, cv: 0, mtbfH: 0, mttrMin: 0 } }, newAsset("sink", "k", [6, 0, 0])], links: [{ from: "s", to: "m" }, { from: "m", to: "k" }] };
    s.assets[0].props.interarrivalS = 5; // always more raw material than the machine can take
    const r = simulate(s, { hours: 10, warmupH: 1, seed: 1 });
    expect(Math.abs(r.throughputPerH - 60)).toBeLessThanOrEqual(0.2);
    expect(r.stations[0].busy).toBeGreaterThan(0.999);
    expect(r.bottleneck).toBe("m");
  });
  it("finds the bottleneck, and the expansion moves it with a confidence interval on the gain", () => {
    const base = replicate(factory, 10);
    expect(base.bottleneck[0]).toEqual({ id: "m1", share: 1 });
    expect(base.throughputPerH.lo).toBeLessThan(base.throughputPerH.mean);
    const c = compare(factory, withExpansion(factory), 10);
    expect(c.significant).toBe(true);
    expect(c.throughputDiff.lo).toBeGreaterThan(5);
    expect(c.branch.bottleneck[0].id).toBe("m2"); // busiest station...
    expect(c.base.supplyLimitedShare).toBe(0);
    expect(c.branch.supplyLimitedShare).toBeGreaterThan(0.5); // ...but the expanded line is held back by raw-material release
    expect(c.branch.releaseRatePerH).toBe(72);
    expect(c.base.assumptions.length).toBeGreaterThan(3);
    expect(estimate([1, 1, 1]).hi).toBe(1);
    expect(estimate([5]).lo).toBe(5);
  });
  it("sizes a buffer and refuses an unconnected line", () => {
    const r = sizeBuffer(factory, "b1", 4, 3);
    expect(r.rows).toHaveLength(5);
    expect(r.rows[r.chosen].throughputPerH).toBeGreaterThanOrEqual(r.best * 0.99);
    expect(() => stationsFromScene({ ...factory, links: factory.links.filter((l) => l.from !== "m2") })).toThrow(/not connected/);
    expect(() => stationsFromScene({ ...factory, links: factory.links.slice(0, 3) })).toThrow(/not connected/);
    // equipment placed but not wired in is left out of the run, not an error
    const extra = { ...factory, assets: [...factory.assets, newAsset("conveyor", "loose", [0, 0, 8]), newAsset("robot", "loose-r", [3, 0, 8])], links: [...factory.links, { from: "loose", to: "loose-r" }] };
    expect(simulate(extra, { hours: 2, warmupH: 0, seed: 1 }).ignored).toEqual(["loose", "loose-r"]);
    expect(() => stationsFromScene({ ...factory, links: factory.links.slice(1) })).toThrow(/sink is reachable|not connected/);
    expect(() => stationsFromScene({ ...factory, assets: factory.assets.filter((a) => a.type !== "sink"), links: [] })).toThrow(/sink/);
    expect(() => stationsFromScene({ ...factory, assets: factory.assets.filter((a) => a.type !== "source"), links: [] })).toThrow(/source/);
  });
});

describe("branches", () => {
  it("diffs and merges an expansion branch into production", () => {
    const prod = branchFrom(factory, "production", "production", "ana");
    const exp = branchFrom(prod, "expansion", "expansion", "ana");
    exp.scene = withExpansion(exp.scene);
    exp.scene.assets.find((a) => a.id === "b1")!.props.capacity = 6;
    const d = diff(exp.base, exp.scene);
    expect(d.filter((c) => c.kind === "added")).toHaveLength(1);
    expect(d.filter((c) => c.kind === "linked")).toHaveLength(2);
    expect(d).toContainEqual({ kind: "changed", id: "b1", field: "props.capacity", from: 4, to: 6 });
    const m = merge(exp.base, prod.scene, exp.scene);
    expect(m.conflicts).toEqual([]);
    expect(m.scene.assets.map((a) => a.id)).toContain("m1b");
    expect(diff(m.scene, exp.scene)).toEqual([]);
  });
  it("reports conflicting edits and edits to removed assets", () => {
    const base = factory;
    const ours = structuredClone(base), theirs = structuredClone(base);
    ours.assets.find((a) => a.id === "b1")!.props.capacity = 2;
    theirs.assets.find((a) => a.id === "b1")!.props.capacity = 8;
    theirs.assets.find((a) => a.id === "r1")!.name = "Robot R1 (new gripper)";
    ours.assets = ours.assets.filter((a) => a.id !== "c2"); ours.links = ours.links.filter((l) => l.from !== "c2" && l.to !== "c2");
    theirs.assets.find((a) => a.id === "c2")!.props.speedMps = 0.3;
    theirs.assets = theirs.assets.filter((a) => a.id !== "m2"); theirs.links = theirs.links.filter((l) => l.from !== "m2" && l.to !== "m2");
    const m = merge(base, ours, theirs);
    expect(m.conflicts).toContainEqual({ id: "b1", field: "props.capacity", ours: 2, theirs: 8 });
    expect(m.conflicts.some((c) => c.id === "c2")).toBe(true);
    expect(m.scene.assets.find((a) => a.id === "r1")!.name).toBe("Robot R1 (new gripper)");
    expect(m.scene.assets.find((a) => a.id === "b1")!.props.capacity).toBe(2);
    expect(m.scene.assets.some((a) => a.id === "m2")).toBe(false);
  });
});

describe("multiplayer convergence", () => {
  it("any delivery order (with duplicates) gives the same scene", () => {
    const r = rng(11);
    const meta = { version: 1 as const, id: factory.id, name: factory.name, links: factory.links, bindings: [], comments: [] };
    for (let trial = 0; trial < 50; trial++) {
      const a = new Replica("ana", factory), b = new Replica("ben", factory);
      const ops: Op[] = [];
      for (let k = 0; k < 30; k++) {
        const who = r.u() < 0.5 ? a : b, id = r.pick(["m1", "b1", "r1", "m2"]);
        const x = r.u();
        if (x < 0.7) ops.push(who.local({ kind: "set", id, field: "position", value: [r.int(-10, 10), 0, r.int(-3, 3)] }));
        else if (x < 0.85) ops.push(who.local({ kind: "set", id, field: "props.processS", value: r.int(30, 70) }));
        else if (x < 0.95) ops.push(who.local({ kind: "add", asset: newAsset("buffer", `x${trial}-${k}`, [0, 0, 5]) }));
        else ops.push(who.local({ kind: "remove", id }));
      }
      const replicas = [0, 1, 2].map((s) => {
        const rep = new Replica(`r${s}`, factory), order = [...ops, ...ops.slice(0, 5)];
        for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(rng(trial * 10 + s).u() * (i + 1)) % (i + 1); [order[i], order[j]] = [order[j], order[i]]; }
        order.forEach((o) => rep.apply(o));
        return rep.digest(meta);
      });
      for (const o of ops) { a.apply(o); b.apply(o); }
      expect(replicas[1]).toBe(replicas[0]);
      expect(replicas[2]).toBe(replicas[0]);
      expect(a.digest(meta)).toBe(replicas[0]);
      expect(b.digest(meta)).toBe(replicas[0]);
    }
  });
  it("a removal beats an edit it has seen, a later re-add brings the asset back", () => {
    const a = new Replica("ana", factory), b = new Replica("ben", factory);
    const meta = { version: 1 as const, id: "x", name: "x", links: [], bindings: [], comments: [] };
    const e = a.local({ kind: "set", id: "m1", field: "name", value: "renamed" });
    b.apply(e);
    const rm = b.local({ kind: "remove", id: "m1" });
    a.apply(rm);
    expect(a.scene(meta).assets.some((x) => x.id === "m1")).toBe(false);
    const re = a.local({ kind: "add", asset: newAsset("machine", "m1", [0, 0, 0], "back") });
    b.apply(re);
    expect(b.scene(meta).assets.find((x) => x.id === "m1")!.name).toBe("back");
  });
});
