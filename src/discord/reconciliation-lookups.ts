/**
 * Reconciliation lookup single-flight owner.
 *
 * Keeps exactly one in-flight `client.channels.fetch` promise per destination id
 * (channel/thread). Every caller attaches to the same unresolved promise. A
 * caller's own bounded wait may expire without cancelling, replacing, polling,
 * or deleting that promise.
 *
 * Settlement offers a one-use channel snapshot to each still-current waiter,
 * with validity evaluated at settlement time, so a stale continuation from a
 * retired lifecycle epoch is inert. Retries are never scheduled here: a failed
 * lookup drops only its own entry, and a later genuine lifecycle/observer
 * invocation starts a fresh lookup.
 *
 * The scope owner is the Discord client object, so a reconnect that constructs
 * a new gateway against the same client attaches to the same unresolved
 * operation instead of starting an overlapping fetch.
 */

export interface ReconciliationLookupWaiter {
  /** Evaluated at settlement time, never at registration time. */
  isCurrent: () => boolean;
  /** Offers the one-use settled channel snapshot exactly once when current. */
  settled: (channel: unknown) => void;
  /** Reports the lookup failure exactly once when still current. */
  failed: (error: unknown) => void;
}

interface ReconciliationLookupEntry {
  promise: Promise<unknown>;
  waiters: Set<ReconciliationLookupWaiter>;
}

interface ReconciliationScope {
  lookups: Map<string, ReconciliationLookupEntry>;
  /** One-use settled snapshots awaiting their exact continuation. */
  settled: Map<string, unknown>;
}

const scopes = new WeakMap<object, ReconciliationScope>();

function snapshotKey(destinationId: string, consumerId: string): string {
  return `${destinationId}\u0000${consumerId}`;
}

function scopeFor(owner: object): ReconciliationScope {
  let scope = scopes.get(owner);
  if (!scope) {
    scope = { lookups: new Map(), settled: new Map() };
    scopes.set(owner, scope);
  }
  return scope;
}

function currentWaiters(entry: ReconciliationLookupEntry): ReconciliationLookupWaiter[] {
  const current: ReconciliationLookupWaiter[] = [];
  for (const waiter of entry.waiters) {
    let valid = false;
    try { valid = waiter.isCurrent() === true; } catch { valid = false; }
    if (valid) current.push(waiter);
  }
  entry.waiters.clear();
  return current;
}

/** True when a lookup is already in flight for this destination. */
export function hasReconciliationLookup(owner: object, destinationId: string): boolean {
  return scopeFor(owner).lookups.has(destinationId);
}

/** Returns the already in-flight lookup promise for a destination, if any. */
export function getReconciliationLookup(owner: object, destinationId: string): Promise<unknown> | null {
  return scopeFor(owner).lookups.get(destinationId)?.promise ?? null;
}

/**
 * Returns the single in-flight lookup for a destination, starting it with
 * `startFetch` only when none exists. A one-use snapshot left by an earlier
 * settlement for this exact consumer is consumed here instead of starting a
 * speculative second fetch. The promise is stored before any settlement can run
 * and is removed only by its own settlement.
 */
export function startReconciliationLookup(
  owner: object,
  destinationId: string,
  consumerId: string,
  startFetch: () => Promise<unknown>
): Promise<unknown> {
  const scope = scopeFor(owner);
  const key = snapshotKey(destinationId, consumerId);
  if (scope.settled.has(key)) {
    const channel = scope.settled.get(key);
    scope.settled.delete(key);
    return Promise.resolve(channel);
  }
  const existing = scope.lookups.get(destinationId);
  if (existing) return existing.promise;
  const entry: ReconciliationLookupEntry = { promise: Promise.resolve(), waiters: new Set() };
  const promise = Promise.resolve().then(startFetch).then(
    channel => {
      if (scope.lookups.get(destinationId) === entry) scope.lookups.delete(destinationId);
      for (const waiter of currentWaiters(entry)) {
        try { waiter.settled(channel); } catch { /* a waiter must not break settlement */ }
      }
      return channel;
    },
    error => {
      if (scope.lookups.get(destinationId) === entry) scope.lookups.delete(destinationId);
      for (const waiter of currentWaiters(entry)) {
        try { waiter.failed(error); } catch { /* a waiter must not break settlement */ }
      }
      throw error;
    }
  );
  entry.promise = promise;
  scope.lookups.set(destinationId, entry);
  // Some callers may have already stopped waiting; keep the shared rejection
  // observed so it cannot surface as an unhandled rejection.
  promise.catch(() => {});
  return promise;
}

/**
 * Records a one-use settled snapshot for the exact continuation (destination +
 * consumer) that will call `startReconciliationLookup` next. Removed when
 * consumed or invalidated, so it is a handoff, never a permanent cache.
 */
export function storeReconciliationSnapshot(
  owner: object,
  destinationId: string,
  consumerId: string,
  channel: unknown
): void {
  scopeFor(owner).settled.set(snapshotKey(destinationId, consumerId), channel);
}

/**
 * Registers a waiter against a destination's in-flight lookup. Each call keeps
 * its OWN registration, even for the same waiter id: a later reconciliation
 * pass that adopts the same unresolved lookup must not displace the earlier
 * pass's settlement interest, or a late success would be dropped. The returned
 * release function only unregisters this waiter; it never cancels the lookup.
 */
export function attachReconciliationWaiter(
  owner: object,
  destinationId: string,
  waiter: ReconciliationLookupWaiter
): () => void {
  const entry = scopeFor(owner).lookups.get(destinationId);
  if (!entry) return () => {};
  entry.waiters.add(waiter);
  return () => { entry.waiters.delete(waiter); };
}

/**
 * Drops only registrations whose `isCurrent()` is not exactly true (or throws)
 * from every in-flight lookup, using the same validity semantics as settlement.
 * In-flight entries and one-use settled snapshots are preserved so a shared
 * client's other gateway keeps its lookup and pending continuation.
 */
export function pruneReconciliationWaiters(owner: object): void {
  for (const entry of scopeFor(owner).lookups.values()) {
    for (const waiter of entry.waiters) {
      let valid = false;
      try { valid = waiter.isCurrent() === true; } catch { valid = false; }
      if (!valid) entry.waiters.delete(waiter);
    }
  }
}

/**
 * Makes every currently registered waiter inert without awaiting any lookup.
 * In-flight entries are retained so a reconnect attaches to the same
 * unresolved operation; one-use snapshots are dropped so a retired scope cannot
 * authorize a later reply.
 */
export function invalidateReconciliationWaiters(owner: object): void {
  const scope = scopeFor(owner);
  for (const entry of scope.lookups.values()) entry.waiters.clear();
  scope.settled.clear();
}
