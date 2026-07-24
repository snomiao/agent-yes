// Browser replica backend: a channel's ops in LocalStorage (text-only chat fits
// comfortably). Same CRDT semantics as the Node jsonl backend (store.node.ts) —
// merge is a union by id, reads dedup + sort — so a browser tab and a CLI peer
// converge to identical threads. Synchronous (LocalStorage is), wrapped in the
// async ChannelPeerStore shape the peer expects.

import { isValidOp, type Op } from "./op.ts";
import { mergeOps, sortOps } from "./store.ts";
import type { ChannelPeerStore } from "./peer.ts";

const PREFIX = "ay29ch:";

export class LocalStorageStore implements ChannelPeerStore {
  private key: string;
  constructor(
    channelId: string,
    private storage: Storage = globalThis.localStorage,
  ) {
    this.key = PREFIX + channelId;
  }

  private read(): Op[] {
    try {
      const raw = this.storage.getItem(this.key);
      if (!raw) return [];
      const arr = JSON.parse(raw);
      return sortOps((Array.isArray(arr) ? arr : []).filter(isValidOp));
    } catch {
      return [];
    }
  }

  all(): Promise<Op[]> {
    return Promise.resolve(this.read());
  }

  append(ops: Op[]): Promise<Op[]> {
    const { merged, added } = mergeOps(this.read(), ops.filter(isValidOp));
    if (added.length) this.storage.setItem(this.key, JSON.stringify(merged));
    return Promise.resolve(added);
  }
}
