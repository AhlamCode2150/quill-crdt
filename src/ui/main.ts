import { RgaDocument } from "../crdt/rga.js";
import type { RgaOp } from "../crdt/rga.js";
import { Room, getOrCreateRoomCode } from "../net/room.js";

const PEER_COLORS = ["#d1a446", "#4fb3a0", "#e2725b", "#9a8cd6", "#6fa8dc", "#e0a8c0"];

const roomCode = getOrCreateRoomCode();
const doc = new RgaDocument();
const room = new Room(roomCode, {
  onPeerCountChange: (count) => {
    renderPeers(count);
    // Bring anyone who just (re)connected fully up to date. mergeSnapshot on
    // the receiving end is idempotent, so re-broadcasting on every peer
    // change is simple, correct, and -- for editor-sized documents -- cheap.
    room.broadcastSnapshot(doc.getSnapshot());
  },
  onRemoteOp: (op) => {
    doc.applyRemote(op);
    scheduleRender();
    pulsePeers();
  },
  onRemoteSnapshot: (nodes) => {
    doc.mergeSnapshot(nodes);
    scheduleRender();
  },
  onStatus: (status) => setStatus(status),
});

// ---------------------------------------------------------------------
// DOM references
// ---------------------------------------------------------------------

const editor = document.getElementById("editor") as HTMLTextAreaElement;
const peersDots = document.getElementById("peersDots") as HTMLSpanElement;
const peersLabel = document.getElementById("peersLabel") as HTMLSpanElement;
const statusDot = document.getElementById("statusDot") as HTMLSpanElement;
const statusText = document.getElementById("statusText") as HTMLSpanElement;
const roomCodeEl = document.getElementById("roomCode") as HTMLElement;
const copyBtn = document.getElementById("copyLink") as HTMLButtonElement;
const offlineBtn = document.getElementById("offlineToggle") as HTMLButtonElement;

roomCodeEl.textContent = roomCode;

// ---------------------------------------------------------------------
// Editor <-> CRDT wiring
// ---------------------------------------------------------------------

let mirror = ""; // last text we know is reflected in both the CRDT and the textarea

function applyLocalDiff(oldText: string, newText: string): void {
  // Find the shared prefix/suffix around the edit, then translate the
  // remaining middle section into a minimal run of single-char CRDT ops.
  let start = 0;
  const maxStart = Math.min(oldText.length, newText.length);
  while (start < maxStart && oldText[start] === newText[start]) start++;

  let oldEnd = oldText.length;
  let newEnd = newText.length;
  while (oldEnd > start && newEnd > start && oldText[oldEnd - 1] === newText[newEnd - 1]) {
    oldEnd--;
    newEnd--;
  }

  const ops: RgaOp[] = [];
  // Deletions first. Position `start` is stable across the loop: each
  // deletion shifts later characters left by one, so repeatedly deleting at
  // `start` removes exactly the run that changed.
  const deleteCount = oldEnd - start;
  for (let n = 0; n < deleteCount; n++) {
    ops.push(doc.localDelete(start));
  }
  for (let i = start; i < newEnd; i++) {
    ops.push(doc.localInsert(i, newText[i]!));
  }

  for (const op of ops) room.broadcastOp(op);
  mirror = doc.toString();
}

editor.addEventListener("input", () => {
  const newText = editor.value;
  applyLocalDiff(mirror, newText);
});

let renderScheduled = false;
function scheduleRender(): void {
  if (renderScheduled) return;
  renderScheduled = true;
  requestAnimationFrame(() => {
    renderScheduled = false;
    renderFromDoc();
  });
}

/** Reflect the CRDT's current text into the textarea, preserving cursor position as best-effort. */
function renderFromDoc(): void {
  const oldText = mirror;
  const newText = doc.toString();
  if (newText === oldText) return;

  const selStart = editor.selectionStart;
  const selEnd = editor.selectionEnd;

  let common = 0;
  const max = Math.min(oldText.length, newText.length);
  while (common < max && oldText[common] === newText[common]) common++;

  const delta = newText.length - oldText.length;
  const adjust = (pos: number) => (pos > common ? Math.max(common, pos + delta) : pos);

  editor.value = newText;
  mirror = newText;

  const newSelStart = clamp(adjust(selStart), 0, newText.length);
  const newSelEnd = clamp(adjust(selEnd), 0, newText.length);
  editor.setSelectionRange(newSelStart, newSelEnd);
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

// ---------------------------------------------------------------------
// Presence / status UI
// ---------------------------------------------------------------------

function renderPeers(count: number): void {
  peersDots.innerHTML = "";
  for (let i = 0; i < count; i++) {
    const dot = document.createElement("span");
    dot.className = "peer-dot";
    dot.style.background = PEER_COLORS[i % PEER_COLORS.length]!;
    dot.style.color = PEER_COLORS[i % PEER_COLORS.length]!;
    peersDots.appendChild(dot);
  }
  peersLabel.textContent = `${count} peer${count === 1 ? "" : "s"} connected`;
}

function pulsePeers(): void {
  for (const dot of peersDots.querySelectorAll(".peer-dot")) {
    dot.classList.remove("pulse");
    // Force reflow so the animation can restart.
    void (dot as HTMLElement).offsetWidth;
    dot.classList.add("pulse");
  }
}

function setStatus(status: string): void {
  statusText.textContent = status;
  statusDot.classList.remove("online", "offline");
  if (status === "connected") statusDot.classList.add("online");
  else if (status === "offline" || status === "room-full") statusDot.classList.add("offline");
}

// ---------------------------------------------------------------------
// Buttons
// ---------------------------------------------------------------------

copyBtn.addEventListener("click", async () => {
  const url = location.href;
  try {
    await navigator.clipboard.writeText(url);
    const original = copyBtn.textContent;
    copyBtn.textContent = "Link copied!";
    setTimeout(() => (copyBtn.textContent = original), 1600);
  } catch {
    window.prompt("Copy this room link:", url);
  }
});

offlineBtn.addEventListener("click", () => {
  if (room.isOffline) {
    room.goOnline();
    offlineBtn.textContent = "Go offline";
    offlineBtn.classList.remove("is-offline");
  } else {
    room.goOffline();
    offlineBtn.textContent = "Go back online";
    offlineBtn.classList.add("is-offline");
  }
});

// ---------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------

renderPeers(0);
setStatus("connecting");
room.join().catch((err) => {
  console.error(err);
  setStatus("room-full");
});
