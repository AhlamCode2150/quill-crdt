import Peer, { type DataConnection } from "peerjs";
import type { NodeSnapshot, RgaOp } from "../crdt/rga.js";

/**
 * Wire protocol spoken over each PeerJS WebRTC data channel. All of this
 * flows peer-to-peer once the channel is open -- none of it touches a
 * server we control. `hello`/`sync` exchange full document state so a
 * newly-joined peer catches up; `op` carries live single-character edits.
 */
export type WireMessage =
  | { type: "hello"; peerId: string }
  | { type: "sync"; nodes: NodeSnapshot[] }
  | { type: "op"; op: RgaOp };

export interface RoomEvents {
  onPeerCountChange?: (count: number) => void;
  onRemoteOp?: (op: RgaOp) => void;
  /** Called when a peer's full document snapshot arrives (used to catch up / merge on (re)connect). */
  onRemoteSnapshot?: (nodes: NodeSnapshot[]) => void;
  onStatus?: (status: string) => void;
}

const SLOT_COUNT = 6;

/**
 * Connects browser tabs that share a room code into a WebRTC mesh, using
 * PeerJS's free public cloud broker ONLY for the signaling handshake
 * (exchanging SDP/ICE info to establish a direct connection). Once a
 * DataConnection is open, every document operation flows straight over
 * that peer-to-peer channel -- the broker never sees document content.
 *
 * Peer discovery mechanic: a room code deterministically maps to a small,
 * fixed set of PeerJS IDs ("slots"), e.g. `quillroom-<code>-0` .. `-5`. On
 * joining, a tab tries to *register* itself under the first free slot; if
 * that ID is already taken (another tab got there first) it moves to the
 * next slot. It then attempts an outbound connection to every *other* slot
 * in the room. This lets any number of tabs (up to SLOT_COUNT) that open
 * the same room link find and connect to each other automatically, with no
 * manual copy/paste of connection strings.
 */
export class Room {
  readonly roomCode: string;
  private peer: Peer | null = null;
  private myPeerId: string | null = null;
  private connections = new Map<string, DataConnection>();
  private events: RoomEvents;
  private destroyed = false;
  private offlineMode = false;

  constructor(roomCode: string, events: RoomEvents = {}) {
    this.roomCode = roomCode;
    this.events = events;
  }

  get peerCount(): number {
    return this.connections.size;
  }

  private slotId(n: number): string {
    return `quillroom-${this.roomCode}-${n}`;
  }

  /** Registers this tab under a free slot in the room and starts connecting to peers. */
  async join(): Promise<void> {
    this.events.onStatus?.("connecting");
    for (let slot = 0; slot < SLOT_COUNT; slot++) {
      const ok = await this.tryRegister(this.slotId(slot));
      if (ok) {
        this.myPeerId = this.slotId(slot);
        break;
      }
    }
    if (!this.myPeerId) {
      this.events.onStatus?.("room-full");
      throw new Error("Room is full");
    }
    this.events.onStatus?.("connected");
    // Try connecting outbound to every other slot; slots with no one
    // registered simply fail to connect, which is expected and harmless.
    for (let slot = 0; slot < SLOT_COUNT; slot++) {
      const id = this.slotId(slot);
      if (id !== this.myPeerId) this.connectTo(id);
    }
  }

  private tryRegister(id: string): Promise<boolean> {
    return new Promise((resolve) => {
      const peer = new Peer(id, { debug: 0 });
      let settled = false;
      peer.on("open", () => {
        if (settled) return;
        settled = true;
        this.peer = peer;
        this.wireIncoming(peer);
        resolve(true);
      });
      peer.on("error", (err: { type?: string }) => {
        if (settled) return;
        settled = true;
        // "unavailable-id" means someone else already holds this slot.
        peer.destroy();
        resolve(false);
        if (err?.type && err.type !== "unavailable-id") {
          // Non-fatal for the room-join loop, but surface it for debugging.
          console.warn("PeerJS error while registering", id, err);
        }
      });
    });
  }

  private wireIncoming(peer: Peer): void {
    peer.on("connection", (conn) => {
      if (this.offlineMode) {
        // Reject inbound connections while simulating being offline, so the
        // demo genuinely stops exchanging data rather than just hiding it.
        conn.on("open", () => conn.close());
        return;
      }
      this.setupConnection(conn);
    });
    peer.on("disconnected", () => {
      if (!this.destroyed) peer.reconnect();
    });
  }

  /**
   * Simulate this tab going offline: close every live data channel without
   * tearing down our slot registration. Local edits keep working (they're
   * applied to the local CRDT immediately, offline or not) -- they just
   * stop being sent anywhere until `goOnline()` is called.
   */
  goOffline(): void {
    this.offlineMode = true;
    for (const conn of this.connections.values()) conn.close();
    this.connections.clear();
    this.events.onPeerCountChange?.(0);
    this.events.onStatus?.("offline");
  }

  /** Reconnect to every slot in the room; each new connection triggers a full-state sync. */
  goOnline(): void {
    this.offlineMode = false;
    this.events.onStatus?.("connecting");
    for (let slot = 0; slot < SLOT_COUNT; slot++) {
      const id = this.slotId(slot);
      if (id !== this.myPeerId) this.connectTo(id);
    }
  }

  get isOffline(): boolean {
    return this.offlineMode;
  }

  private connectTo(id: string): void {
    if (!this.peer || this.connections.has(id)) return;
    const conn = this.peer.connect(id, { reliable: true });
    this.setupConnection(conn);
  }

  private setupConnection(conn: DataConnection): void {
    conn.on("open", () => {
      this.connections.set(conn.peer, conn);
      this.events.onPeerCountChange?.(this.peerCount);
      this.events.onStatus?.("connected");
      this.send(conn, { type: "hello", peerId: this.myPeerId ?? "" });
    });

    conn.on("data", (data) => {
      const msg = data as WireMessage;
      if (msg.type === "sync") this.events.onRemoteSnapshot?.(msg.nodes);
      else if (msg.type === "op") this.events.onRemoteOp?.(msg.op);
    });

    conn.on("close", () => {
      this.connections.delete(conn.peer);
      this.events.onPeerCountChange?.(this.peerCount);
    });

    conn.on("error", () => {
      this.connections.delete(conn.peer);
      this.events.onPeerCountChange?.(this.peerCount);
    });
  }

  private send(conn: DataConnection, msg: WireMessage): void {
    if (conn.open) conn.send(msg);
  }

  /** Broadcast a live edit to every currently-connected peer. */
  broadcastOp(op: RgaOp): void {
    for (const conn of this.connections.values()) this.send(conn, { type: "op", op });
  }

  /** Send this replica's full state to a specific peer (used right after connecting, and periodically for catch-up). */
  broadcastSnapshot(nodes: NodeSnapshot[]): void {
    for (const conn of this.connections.values()) this.send(conn, { type: "sync", nodes });
  }

  destroy(): void {
    this.destroyed = true;
    for (const conn of this.connections.values()) conn.close();
    this.connections.clear();
    this.peer?.destroy();
  }
}

/** Reads (or creates + writes) the room code from/into the URL hash, e.g. `#room=abc123`. */
export function getOrCreateRoomCode(): string {
  const match = /room=([a-z0-9]+)/i.exec(location.hash);
  if (match?.[1]) return match[1];
  const code = Math.random().toString(36).slice(2, 8);
  location.hash = `room=${code}`;
  return code;
}
