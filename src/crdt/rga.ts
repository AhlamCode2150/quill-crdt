import { type OpId, compareId, idsEqual, idToKey, randomSiteId } from "./id.js";

/**
 * A single node in the RGA sequence. Deleted nodes are kept as tombstones
 * (never physically removed) so that a delete which arrives after a
 * concurrent insert anchored to that node cannot corrupt the structure --
 * the insert's `leftOrigin` reference stays resolvable forever.
 */
export interface RgaNode {
  readonly id: OpId;
  readonly value: string;
  /** id of the node this was inserted immediately after, or null = document start */
  readonly leftOrigin: OpId | null;
  deleted: boolean;
}

/** Wire-format snapshot of a node, used both for live ops and full-state sync. */
export interface NodeSnapshot {
  id: OpId;
  value: string;
  leftOrigin: OpId | null;
  deleted: boolean;
}

export type InsertOp = { kind: "insert"; id: OpId; value: string; leftOrigin: OpId | null };
export type DeleteOp = { kind: "delete"; id: OpId };
export type RgaOp = InsertOp | DeleteOp;

/**
 * Replicated Growable Array (RGA) sequence CRDT for plain text.
 *
 * Implemented from scratch (no Yjs/Automerge/etc). Each character is a node
 * addressed by a unique {site, counter} id and anchored to the node it was
 * inserted after (`leftOrigin`). Concurrent inserts that share the same
 * leftOrigin are ordered deterministically by comparing ids (see
 * `compareId`), so every replica that has received the same set of
 * operations converges to the exact same total order -- regardless of the
 * order those operations actually arrived in.
 *
 * Operations that depend on a node the local replica hasn't seen yet
 * (out-of-order network delivery) are buffered and replayed automatically
 * once the dependency arrives, so `applyRemote` is safe to call in any
 * order, any number of times (idempotent), from any number of peers.
 */
export class RgaDocument {
  readonly siteId: string;
  private counter = 0;
  /** Full sequence in document order, including tombstones. */
  private sequence: RgaNode[] = [];

  /** Inserts buffered because their leftOrigin hasn't arrived yet, keyed by leftOrigin id. */
  private pendingInserts = new Map<string, InsertOp[]>();
  /** Deletes buffered because their target node hasn't arrived yet, keyed by target id. */
  private pendingDeletes = new Map<string, DeleteOp[]>();

  constructor(siteId: string = randomSiteId()) {
    this.siteId = siteId;
  }

  // ---------------------------------------------------------------------
  // Local edits -> ops to broadcast
  // ---------------------------------------------------------------------

  /** Insert `char` (should be a single character) at visible-text position `pos`. */
  localInsert(pos: number, char: string): InsertOp {
    const leftOrigin = this.visibleIdToNodeId(pos);
    const id: OpId = { site: this.siteId, counter: this.counter++ };
    const node: RgaNode = { id, value: char, leftOrigin, deleted: false };
    this.integrateInsert(node);
    return { kind: "insert", id, value: char, leftOrigin };
  }

  /** Delete the visible character at position `pos`. */
  localDelete(pos: number): DeleteOp {
    let visible = 0;
    for (const node of this.sequence) {
      if (node.deleted) continue;
      if (visible === pos) {
        node.deleted = true;
        return { kind: "delete", id: node.id };
      }
      visible++;
    }
    throw new RangeError(`localDelete: position ${pos} out of range`);
  }

  // ---------------------------------------------------------------------
  // Remote merge -- idempotent and order-independent
  // ---------------------------------------------------------------------

  applyRemote(op: RgaOp): void {
    if (op.kind === "insert") {
      this.applyInsert(op);
    } else {
      this.applyDelete(op);
    }
  }

  private applyInsert(op: InsertOp): void {
    if (this.findIndexById(op.id) !== -1) return; // idempotent: already have it

    if (op.leftOrigin !== null && this.findIndexById(op.leftOrigin) === -1) {
      // Causal dependency missing -- buffer until it arrives.
      const key = idToKey(op.leftOrigin);
      const list = this.pendingInserts.get(key) ?? [];
      list.push(op);
      this.pendingInserts.set(key, list);
      return;
    }

    const node: RgaNode = { id: op.id, value: op.value, leftOrigin: op.leftOrigin, deleted: false };
    this.integrateInsert(node);
    this.bumpCounterIfOwnSite(op.id);
    this.drainPendingFor(op.id);
  }

  private applyDelete(op: DeleteOp): void {
    const idx = this.findIndexById(op.id);
    if (idx === -1) {
      // Target not seen yet (delete raced ahead of its insert) -- buffer it.
      const key = idToKey(op.id);
      const list = this.pendingDeletes.get(key) ?? [];
      list.push(op);
      this.pendingDeletes.set(key, list);
      return;
    }
    this.sequence[idx]!.deleted = true; // idempotent: re-setting true is a no-op
  }

  /** After integrating node `id`, unlock any ops that were waiting on it. */
  private drainPendingFor(id: OpId): void {
    const key = idToKey(id);

    const deletes = this.pendingDeletes.get(key);
    if (deletes) {
      this.pendingDeletes.delete(key);
      for (const d of deletes) this.applyDelete(d);
    }

    const inserts = this.pendingInserts.get(key);
    if (inserts) {
      this.pendingInserts.delete(key);
      for (const ins of inserts) this.applyInsert(ins);
    }
  }

  private bumpCounterIfOwnSite(id: OpId): void {
    if (id.site === this.siteId && id.counter >= this.counter) {
      this.counter = id.counter + 1;
    }
  }

  // ---------------------------------------------------------------------
  // Core RGA insertion algorithm
  // ---------------------------------------------------------------------

  /**
   * Inserts `node` into `sequence` at the position dictated by its
   * leftOrigin and, for concurrent siblings anchored to the same origin, by
   * id comparison. This is a pure function of (current sequence, node) --
   * it never consults arrival order -- which is exactly what guarantees all
   * replicas converge to the same order regardless of when/how ops arrive.
   */
  private integrateInsert(node: RgaNode): void {
    const leftIdx = this.findIndexById(node.leftOrigin);
    let i = leftIdx + 1;

    while (i < this.sequence.length) {
      const other = this.sequence[i]!;
      const otherOriginIdx = this.findIndexById(other.leftOrigin);

      if (otherOriginIdx < leftIdx) break; // other belongs to an earlier causal block: stop here
      if (otherOriginIdx === leftIdx) {
        // Concurrent sibling of `node` (both anchored to the same leftOrigin).
        // Break ties deterministically -- higher id wins the leftmost slot.
        if (compareId(node.id, other.id) > 0) break;
      }
      i++;
    }

    this.sequence.splice(i, 0, node);
  }

  private findIndexById(id: OpId | null): number {
    if (id === null) return -1;
    for (let i = 0; i < this.sequence.length; i++) {
      if (idsEqual(this.sequence[i]!.id, id)) return i;
    }
    return -1;
  }

  /** id of the visible node immediately before visible-text position `pos`, or null. */
  private visibleIdToNodeId(pos: number): OpId | null {
    let visible = 0;
    let lastId: OpId | null = null;
    for (const node of this.sequence) {
      if (visible === pos) break;
      if (!node.deleted) {
        lastId = node.id;
        visible++;
      }
    }
    return lastId;
  }

  // ---------------------------------------------------------------------
  // Read model / full-state sync
  // ---------------------------------------------------------------------

  toString(): string {
    let out = "";
    for (const node of this.sequence) {
      if (!node.deleted) out += node.value;
    }
    return out;
  }

  get length(): number {
    let n = 0;
    for (const node of this.sequence) if (!node.deleted) n++;
    return n;
  }

  /** Full document state (including tombstones) for syncing a newly-joined peer. */
  getSnapshot(): NodeSnapshot[] {
    return this.sequence.map((n) => ({ id: n.id, value: n.value, leftOrigin: n.leftOrigin, deleted: n.deleted }));
  }

  /** Merge a snapshot received from a peer (e.g. on initial connection). Idempotent. */
  mergeSnapshot(nodes: readonly NodeSnapshot[]): void {
    for (const n of nodes) {
      if (this.findIndexById(n.id) === -1) {
        this.integrateInsert({ id: n.id, value: n.value, leftOrigin: n.leftOrigin, deleted: n.deleted });
      } else if (n.deleted) {
        const idx = this.findIndexById(n.id);
        if (idx !== -1) this.sequence[idx]!.deleted = true;
      }
      this.bumpCounterIfOwnSite(n.id);
    }
    // Snapshot nodes may unlock buffered ops too (e.g. a live op arrived
    // before the snapshot that satisfies its dependency).
    for (const n of nodes) this.drainPendingFor(n.id);
  }

  /** True once every buffered op has found its dependency (useful for tests/debugging). */
  hasPendingOps(): boolean {
    return this.pendingInserts.size > 0 || this.pendingDeletes.size > 0;
  }
}
