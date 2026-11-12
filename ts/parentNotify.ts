/** Child-owned durable lifecycle events, independent of parent watcher liveness. */
import { readGlobalPids } from "./globalPidIndex.ts";
import { appendEvent, hostId } from "./notifyStore.ts";
import { stepRouter, type RouterState, type ChildObservation } from "./notifyRouter.ts";

export const PARENT_HEARTBEAT_MS = 60_000;

export async function createParentNotifier(parentPid: number | undefined, wrapperPid: number) {
  if (!parentPid || parentPid === wrapperPid) return null;
  const records = await readGlobalPids();
  const child = records.find((r) => r.wrapper_pid === wrapperPid && r.status !== "exited");
  const parent = records.find((r) => r.wrapper_pid === parentPid && r.status !== "exited");
  // Pin both incarnations: never route an old child's events to a reused pid.
  if (!child || !parent || child.started_at < parent.started_at) return null;
  const identity = {
    pid: child.pid,
    wrapper_pid: wrapperPid,
    started_at: child.started_at,
    parent_pid: parentPid,
    parent_started_at: parent.started_at,
    cli: child.cli,
    cwd: child.cwd,
  };
  let state: RouterState = new Map();
  let lastHeartbeat: number | null = null;
  let exited = false;
  let pending = Promise.resolve();
  return {
    observe(current: string, question: string | null, tail: string | null, now: number) {
      // Serialize ticks and termination, including writes already in flight.
      pending = pending
        .catch(() => {})
        .then(async () => {
          if (exited) return;
          const observation: ChildObservation = { ...identity, state: current, question };
          const stepped = stepRouter(state, [observation], now);
          const events = stepped.events.map((event) => ({
            ...event,
            ts: now,
            host: hostId(),
            tail,
          }));
          const heartbeatDue =
            current !== "stopped" &&
            (lastHeartbeat === null || now - lastHeartbeat >= PARENT_HEARTBEAT_MS);
          for (const event of events) await appendEvent(parentPid, event);
          if (heartbeatDue) {
            await appendEvent(parentPid, {
              ts: now,
              host: hostId(),
              parent_pid: parentPid,
              parent_started_at: parent.started_at,
              child_pid: identity.pid,
              child_wrapper_pid: wrapperPid,
              child_started_at: identity.started_at,
              cli: identity.cli,
              cwd: identity.cwd,
              edge: "heartbeat",
              prev_state: state.get(identity.pid)?.state ?? null,
              state: current,
              question, // Heartbeats describe liveness, never completion.
            });
            lastHeartbeat = now;
          }
          state = stepped.next;
          exited = current === "stopped";
        });
      return pending;
    },
  };
}
