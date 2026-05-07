// Tracks active claudio wrapper sessions. The PowerShell / bash wrapper
// posts /api/session/heartbeat every ~10s while it's running, and
// /api/session/end on clean exit. We consider a session "active" if we've
// seen a heartbeat within the last STALE_AFTER_MS — so a kill -9 / BSOD
// scenario self-heals within ~half a minute without any cleanup signal.
//
// State is module-level; the standalone Next server is a single Node
// process so this Map persists across requests. On webapp restart, live
// wrappers re-register on their next heartbeat (~10s blip).

const STALE_AFTER_MS = 30_000;

const heartbeats = new Map<string, number>();

export function recordHeartbeat(id: string): void {
  if (!id) return;
  heartbeats.set(id, Date.now());
}

export function endSession(id: string): void {
  if (!id) return;
  heartbeats.delete(id);
}

export function activeSessionCount(): number {
  const cutoff = Date.now() - STALE_AFTER_MS;
  let n = 0;
  for (const [id, ts] of heartbeats) {
    if (ts < cutoff) {
      heartbeats.delete(id);
    } else {
      n++;
    }
  }
  return n;
}
