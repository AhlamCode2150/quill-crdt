/**
 * A globally-unique, totally-orderable identifier for a single CRDT node.
 *
 * `counter` is a per-site monotonically increasing sequence number (like a
 * simple Lamport clock scoped to one site). `site` is a random string that
 * uniquely identifies a replica (one per browser tab/session). The pair
 * (site, counter) is unique across all replicas forever, and two IDs can
 * always be compared to produce the same result on every replica -- this is
 * what lets concurrent inserts converge to the same order everywhere.
 */
export interface OpId {
  readonly site: string;
  readonly counter: number;
}

/** Deterministic total order over IDs. Same result on every replica. */
export function compareId(a: OpId, b: OpId): number {
  if (a.counter !== b.counter) return a.counter - b.counter;
  if (a.site < b.site) return -1;
  if (a.site > b.site) return 1;
  return 0;
}

export function idsEqual(a: OpId | null, b: OpId | null): boolean {
  if (a === null || b === null) return a === b;
  return a.site === b.site && a.counter === b.counter;
}

export function idToKey(id: OpId): string {
  return `${id.site}:${id.counter}`;
}

/** Generates short, reasonably-unique per-tab site identifiers. */
export function randomSiteId(): string {
  // crypto.randomUUID is available in all modern browsers and Node 19+.
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID().slice(0, 8);
  }
  return Math.random().toString(36).slice(2, 10);
}
