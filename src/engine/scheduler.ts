// ═══════════════════════════════════════════════════════════════════════════
// Concurrency-pool scheduler — AND-semantics layered pools (S28 / PLAN §9).
//
// Pure pool accounting — NO spawning, NO adapter interaction. For a node, the
// scheduler determines which pools it belongs to from the *resolved* profile
// (agentType / provider / model) and the configured limits:
//
//   pools = [global]                                            (always)
//         + byAgentType[agentType]   (if a limit is defined)
//         + byProvider[provider]     (if a limit is defined)
//         + byModel[modelKey]        (if a limit is defined)
//           modelKey = "provider/model" if that key has a limit,
//                      else bare "model" if that key has a limit,
//                      else no model pool (PLAN §22 key fallback)
//
// AND semantics: tryAcquire(node) returns true ONLY if EVERY pool the node
// belongs to has a free slot; on success it increments ALL of them atomically.
// release(node) decrements ALL of them.
// acquire(node, signal) is an async variant that queues the caller when pools
// are full and resolves once a release makes capacity available (or when the
// signal aborts).
//
// Pools are created lazily (on first membership resolution) rather than
// pre-populated from config: a configured-but-never-mapped limit key must not
// appear in usage(). This is verified by the scheduler tests.
// ═══════════════════════════════════════════════════════════════════════════

import type { PoolSlot, PoolUsage, WispConfig } from "../types.js";
import { CONFIG_DEFAULTS, DEFAULT_AGENT_TYPE } from "../constants.js";

// ─── SchedulableNode ──────────────────────────────────────────────

export interface SchedulableNode {
  agentType?: string;
  provider?: string;
  model?: string;
}

// ─── Scheduler contract ──────────────────────────────────────────

export interface Scheduler {
  tryAcquire(node: SchedulableNode): boolean;
  acquire(node: SchedulableNode, signal?: AbortSignal): Promise<boolean>;
  release(node: SchedulableNode): void;
  usage(): PoolUsage;
}

// ─── Factory ──────────────────────────────────────────────────────

type PoolRecord = Record<string, PoolSlot>;
interface WaiterEntry {
  node: SchedulableNode;
  resolve: (value: boolean) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

/** Scan the waiter queue (FIFO) and wake the first compatible waiter. */
function wakeFirstCompatibleWaiter(
  waitQueue: WaiterEntry[],
  poolsOf: (n: SchedulableNode) => PoolSlot[],
  acquireSlots: (n: SchedulableNode) => boolean,
): boolean {
  for (let i = 0; i < waitQueue.length; i++) {
    const entry = waitQueue[i];
    if (entry === undefined) continue;
    const pools = poolsOf(entry.node);
    let ok = true;
    for (const pool of pools) {
      if (pool.used >= pool.cap) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    acquireSlots(entry.node);
    waitQueue.splice(i, 1);
    if (entry.signal && entry.onAbort) entry.signal.removeEventListener("abort", entry.onAbort);
    entry.resolve(true);
    return true;
  }
  return false;
}

export function createScheduler(
  config?: Pick<WispConfig, "maxAgentConcurrency" | "limits">,
): Scheduler {
  const mc = config?.maxAgentConcurrency ?? CONFIG_DEFAULTS.maxAgentConcurrency;
  const agentTypeLimits = config?.limits?.byAgentType ?? {};
  const providerLimits = config?.limits?.byProvider ?? {};
  const modelLimits = config?.limits?.byModel ?? {};
  const global: PoolSlot = { used: 0, cap: mc };
  const byAgentType: PoolRecord = {};
  const byProvider: PoolRecord = {};
  const byModel: PoolRecord = {};
  const waitQueue: WaiterEntry[] = [];

  function resolveModelKey(node: SchedulableNode): string | undefined {
    if (node.model === undefined) return undefined;
    const composite = node.provider !== undefined ? `${node.provider}/${node.model}` : undefined;
    if (composite !== undefined && modelLimits[composite] !== undefined) return composite;
    if (modelLimits[node.model] !== undefined) return node.model;
    return undefined;
  }
  function poolFor(
    record: PoolRecord,
    key: string,
    limits: Record<string, number>,
  ): PoolSlot | undefined {
    const cap = limits[key];
    if (cap === undefined) return undefined;
    if (record[key] !== undefined) return record[key];
    const slot: PoolSlot = { used: 0, cap };
    record[key] = slot;
    return slot;
  }
  function nodePools(node: SchedulableNode): PoolSlot[] {
    const pools: PoolSlot[] = [global];
    const agentSlot = poolFor(byAgentType, node.agentType ?? DEFAULT_AGENT_TYPE, agentTypeLimits);
    if (agentSlot !== undefined) pools.push(agentSlot);
    if (node.provider !== undefined) {
      const providerSlot = poolFor(byProvider, node.provider, providerLimits);
      if (providerSlot !== undefined) pools.push(providerSlot);
    }
    const modelKey = resolveModelKey(node);
    if (modelKey !== undefined) {
      const modelSlot = poolFor(byModel, modelKey, modelLimits);
      if (modelSlot !== undefined) pools.push(modelSlot);
    }
    return pools;
  }
  function tryAcquire(node: SchedulableNode): boolean {
    const pools = nodePools(node);
    if (!pools.every((p) => p.used < p.cap)) return false;
    pools.forEach((p) => {
      p.used += 1;
    });
    return true;
  }
  function release(node: SchedulableNode): void {
    const pools = nodePools(node);
    pools.forEach((p) => {
      if (p.used > 0) p.used -= 1;
    });
    wakeFirstCompatibleWaiter(waitQueue, nodePools, tryAcquire);
  }
  function acquire(node: SchedulableNode, signal?: AbortSignal): Promise<boolean> {
    if (tryAcquire(node)) return Promise.resolve(true);
    if (signal?.aborted) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      const entry: WaiterEntry = { node, resolve };
      if (signal) {
        const onAbort = (): void => {
          const idx = waitQueue.indexOf(entry);
          if (idx !== -1) waitQueue.splice(idx, 1);
          resolve(false);
        };
        entry.onAbort = onAbort;
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) {
          signal.removeEventListener("abort", onAbort);
          resolve(false);
          return;
        }
      }
      waitQueue.push(entry);
    });
  }
  function snapshot(record: PoolRecord): PoolRecord {
    const out: PoolRecord = {};
    for (const [key, slot] of Object.entries(record)) out[key] = { used: slot.used, cap: slot.cap };
    return out;
  }
  function usage(): PoolUsage {
    return {
      global: { used: global.used, cap: global.cap },
      byAgentType: snapshot(byAgentType),
      byProvider: snapshot(byProvider),
      byModel: snapshot(byModel),
    };
  }
  return { tryAcquire, acquire, release, usage };
}
