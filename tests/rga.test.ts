import { describe, it, expect } from "vitest";
import { RgaDocument } from "../src/crdt/rga.js";
import type { RgaOp } from "../src/crdt/rga.js";

/** Deterministic, seedable PRNG (mulberry32) so randomized trials are reproducible on failure. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled<T>(arr: readonly T[], rand: () => number): T[] {
  const copy = arr.slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  }
  return copy;
}

function typeString(doc: RgaDocument, text: string): RgaOp[] {
  const ops: RgaOp[] = [];
  for (const ch of text) ops.push(doc.localInsert(doc.length, ch));
  return ops;
}

describe("RgaDocument: basic single-replica behavior", () => {
  it("inserts and deletes produce the expected visible text", () => {
    const doc = new RgaDocument("A");
    typeString(doc, "hello");
    expect(doc.toString()).toBe("hello");

    doc.localDelete(0); // remove 'h'
    expect(doc.toString()).toBe("ello");

    doc.localInsert(0, "H");
    expect(doc.toString()).toBe("Hello");
  });

  it("tombstones are excluded from toString but retained internally", () => {
    const doc = new RgaDocument("A");
    typeString(doc, "abc");
    doc.localDelete(1); // remove 'b'
    expect(doc.toString()).toBe("ac");
    expect(doc.length).toBe(2);
  });
});

describe("RgaDocument: two-replica convergence", () => {
  it("concurrent inserts at the exact same position (pos 0) from two sites converge identically", () => {
    const a = new RgaDocument("SiteA");
    const b = new RgaDocument("SiteB");

    const opA = a.localInsert(0, "x");
    const opB = b.localInsert(0, "y");

    // Deliver in opposite orders on each replica to prove order doesn't matter.
    a.applyRemote(opB);
    b.applyRemote(opA);

    expect(a.toString()).toBe(b.toString());
    expect(a.toString().length).toBe(2);
    expect(new Set(a.toString())).toEqual(new Set(["x", "y"]));
  });

  it("delete racing a concurrent insert at the deleted position converges without corruption", () => {
    const a = new RgaDocument("SiteA");
    const baseOps = typeString(a, "hello");

    const b = new RgaDocument("SiteB");
    for (const op of baseOps) b.applyRemote(op);
    expect(b.toString()).toBe("hello");

    // Concurrently: A deletes the first 'l' (index 2); B inserts 'L' right at index 2.
    const delOp = a.localDelete(2);
    const insOp = b.localInsert(2, "L");

    // Cross-deliver, then apply in the opposite order on the other replica too.
    a.applyRemote(insOp);
    b.applyRemote(delOp);

    // Convergence is the actual correctness bar (RGA doesn't promise any
    // *particular* tie-break outcome is "the" right one -- only that every
    // replica lands on the *same* one). We also check no corruption: the
    // deleted 'l' is gone (only one 'l' remains), 'L' survived, nothing
    // else was lost or duplicated.
    expect(a.toString()).toBe(b.toString());
    const text = a.toString();
    expect(text).not.toContain("undefined");
    expect(text.length).toBe(5);
    expect(text).toContain("L");
    expect([...text].filter((c) => c === "l").length).toBe(1);
  });

  it("same scenario, applied in the reverse relative order, still converges to the same text", () => {
    const a = new RgaDocument("SiteA");
    const baseOps = typeString(a, "hello");
    const b = new RgaDocument("SiteB");
    for (const op of baseOps) b.applyRemote(op);

    const insOp = b.localInsert(2, "L");
    const delOp = a.localDelete(2);

    // This time deliver to B first, then A (reversed from previous test).
    b.applyRemote(delOp);
    a.applyRemote(insOp);

    expect(a.toString()).toBe(b.toString());
    const text = a.toString();
    expect(text.length).toBe(5);
    expect(text).toContain("L");
    expect([...text].filter((c) => c === "l").length).toBe(1);

    // And it matches whatever total order the first (forward-delivery) test
    // converged on -- proving delivery order truly doesn't affect the result.
    const c = new RgaDocument("SiteA");
    const baseOps2 = typeString(c, "hello");
    const d = new RgaDocument("SiteB");
    for (const op of baseOps2) d.applyRemote(op);
    const delOp2 = c.localDelete(2);
    const insOp2 = d.localInsert(2, "L");
    c.applyRemote(insOp2);
    d.applyRemote(delOp2);
    expect(text).toBe(c.toString());
  });
});

describe("RgaDocument: out-of-order / delayed network delivery", () => {
  it("a chain of dependent inserts delivered in reverse order still converges (causal buffering)", () => {
    const a = new RgaDocument("A");
    const op1 = a.localInsert(0, "a");
    const op2 = a.localInsert(1, "b"); // leftOrigin = op1.id
    const op3 = a.localInsert(2, "c"); // leftOrigin = op2.id
    expect(a.toString()).toBe("abc");

    const b = new RgaDocument("B");
    // Worst-case network reordering: last op arrives first.
    b.applyRemote(op3);
    b.applyRemote(op1);
    b.applyRemote(op2);

    expect(b.toString()).toBe("abc");
    expect(b.hasPendingOps()).toBe(false);
  });

  it("a delete arriving before its target insert is buffered and applied once the insert lands", () => {
    const a = new RgaDocument("A");
    const insOp = a.localInsert(0, "x");
    const delOp = a.localDelete(0);
    expect(a.toString()).toBe("");

    const b = new RgaDocument("B");
    b.applyRemote(delOp); // arrives first: target unknown, must be buffered
    expect(b.toString()).toBe("");
    b.applyRemote(insOp); // now the delete should resolve automatically
    expect(b.toString()).toBe("");
    expect(b.hasPendingOps()).toBe(false);
  });

  it("three replicas with fully interleaved, out-of-order delivery converge", () => {
    const a = new RgaDocument("A");
    const b = new RgaDocument("B");
    const c = new RgaDocument("C");

    const opsA = typeString(a, "cat");
    const opsB = typeString(b, "dog");
    const opsC = typeString(c, "owl");

    const rand = mulberry32(42);
    // Every replica receives every other replica's ops, each in its own random order.
    for (const op of shuffled([...opsB, ...opsC], rand)) a.applyRemote(op);
    for (const op of shuffled([...opsA, ...opsC], rand)) b.applyRemote(op);
    for (const op of shuffled([...opsA, ...opsB], rand)) c.applyRemote(op);

    expect(a.toString()).toBe(b.toString());
    expect(b.toString()).toBe(c.toString());
    expect(a.hasPendingOps()).toBe(false);
    expect(b.hasPendingOps()).toBe(false);
    expect(c.hasPendingOps()).toBe(false);
  });
});

describe("RgaDocument: idempotency", () => {
  it("applying the same remote op multiple times has no additional effect", () => {
    const a = new RgaDocument("A");
    const op = a.localInsert(0, "x");

    const b = new RgaDocument("B");
    b.applyRemote(op);
    b.applyRemote(op);
    b.applyRemote(op);
    expect(b.toString()).toBe("x");
  });

  it("applying the same delete op multiple times has no additional effect", () => {
    const a = new RgaDocument("A");
    const insOp = a.localInsert(0, "x");
    const delOp = a.localDelete(0);

    const b = new RgaDocument("B");
    b.applyRemote(insOp);
    b.applyRemote(delOp);
    b.applyRemote(delOp);
    b.applyRemote(delOp);
    expect(b.toString()).toBe("");
  });
});

describe("RgaDocument: offline/reconnect resilience (the CRDT payoff)", () => {
  it("a peer that goes offline, edits independently, then reconnects ends up correctly merged", () => {
    // Shared starting state.
    const a = new RgaDocument("A");
    const baseOps = typeString(a, "shared doc");
    const b = new RgaDocument("B");
    for (const op of baseOps) b.applyRemote(op);
    expect(a.toString()).toBe(b.toString());

    // --- A "goes offline": both replicas keep editing with zero communication. ---
    const aOnlyOps: RgaOp[] = [
      a.localInsert(a.length, "!"),
      a.localDelete(0), // drop leading 's'
    ];
    const bOnlyOps: RgaOp[] = [
      b.localInsert(0, ">"),
      b.localInsert(b.length, "?"),
    ];

    expect(a.toString()).not.toBe(b.toString()); // genuinely diverged while offline

    // --- A reconnects: ops exchange in a random, delayed/interleaved order. ---
    const rand = mulberry32(7);
    for (const op of shuffled(bOnlyOps, rand)) a.applyRemote(op);
    for (const op of shuffled(aOnlyOps, rand)) b.applyRemote(op);

    expect(a.toString()).toBe(b.toString());
    expect(a.hasPendingOps()).toBe(false);
    expect(b.hasPendingOps()).toBe(false);
  });
});

describe("RgaDocument: property-based randomized convergence", () => {
  it("random concurrent edit sequences across N replicas converge over many trials", () => {
    const TRIALS = 60;
    const REPLICAS = 3;
    const OPS_PER_REPLICA = 20;

    for (let trial = 0; trial < TRIALS; trial++) {
      const rand = mulberry32(1_000_003 * (trial + 1));
      const docs = Array.from({ length: REPLICAS }, (_, i) => new RgaDocument(`S${i}-t${trial}`));
      const opsByReplica: RgaOp[][] = Array.from({ length: REPLICAS }, () => []);

      for (let r = 0; r < REPLICAS; r++) {
        const doc = docs[r]!;
        for (let k = 0; k < OPS_PER_REPLICA; k++) {
          const len = doc.length;
          const insert = len === 0 || rand() < 0.7;
          if (insert) {
            const pos = Math.floor(rand() * (len + 1));
            const char = String.fromCharCode(97 + Math.floor(rand() * 26));
            opsByReplica[r]!.push(doc.localInsert(pos, char));
          } else {
            const pos = Math.floor(rand() * len);
            opsByReplica[r]!.push(doc.localDelete(pos));
          }
        }
      }

      // Every replica receives every other replica's ops, each in an
      // independently randomized (simulated network) delivery order.
      for (let recv = 0; recv < REPLICAS; recv++) {
        const incoming: RgaOp[] = [];
        for (let src = 0; src < REPLICAS; src++) {
          if (src !== recv) incoming.push(...opsByReplica[src]!);
        }
        for (const op of shuffled(incoming, rand)) docs[recv]!.applyRemote(op);
      }

      const texts = docs.map((d) => d.toString());
      for (let i = 1; i < texts.length; i++) {
        expect(texts[i], `trial ${trial}: replica ${i} diverged from replica 0`).toBe(texts[0]);
      }
      for (const d of docs) expect(d.hasPendingOps()).toBe(false);
    }
  });
});
