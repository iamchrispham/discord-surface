import * as path from 'node:path';
import { sameAddress, validAddress, type AgentAddress } from '../../agent-message';
import { COURIER_RECEIPT_KINDS, COURIER_RESULT_STATUSES, COURIER_ROUTE_STATES } from './constants';
import type { CourierDependencies, CourierMessage, CourierRoute, CourierState, SqlRow } from './types';

function routeInput(deps: CourierDependencies, input: unknown): CourierRoute {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new deps.BindingError('courier route is required');
  const value = input as Record<string, any>;
  const routeId = deps.assertText(value.routeId, 'routeId', 128);
  const parentChannelId = deps.assertText(value.parentChannelId, 'parentChannelId', 128);
  const deliveryChannelId = deps.assertText(value.deliveryChannelId, 'deliveryChannelId', 128);
  const guildId = deps.assertText(value.guildId, 'guildId', 128);
  const routeGeneration = Number(value.routeGeneration);
  if (!Number.isSafeInteger(routeGeneration) || routeGeneration < 1) throw new deps.BindingError('routeGeneration must be a positive integer');
  if (!validAddress(value.target)) throw new deps.BindingError('target must be an agent address');
  const target: AgentAddress = { ...value.target };
  if (target.guildId !== guildId || target.channelId !== deliveryChannelId) {
    throw new deps.BindingError('courier route target must identify its enrolled child');
  }
  const rawCourier = value.courier;
  if (!rawCourier || typeof rawCourier !== 'object' || Array.isArray(rawCourier)) throw new deps.BindingError('courier identity is required');
  const provider = deps.assertProvider(rawCourier.provider);
  const nativeId = deps.assertUuid(rawCourier.nativeId, 'courier.nativeId');
  const workspace = deps.assertText(rawCourier.workspace, 'courier.workspace', 4096);
  if (!path.isAbsolute(workspace)) throw new deps.BindingError('courier.workspace must be absolute');
  const sessionRoot = rawCourier.sessionRoot == null ? null : deps.assertText(rawCourier.sessionRoot, 'courier.sessionRoot', 4096);
  if (sessionRoot !== null && !path.isAbsolute(sessionRoot)) throw new deps.BindingError('courier.sessionRoot must be absolute');
  if (sessionRoot !== null && path.basename(sessionRoot) !== 'sessions') throw new deps.BindingError('courier.sessionRoot must end in sessions');
  const recipientThreadId = deps.assertUuid(rawCourier.recipientThreadId || rawCourier.destinationThreadId, 'courier.recipientThreadId');
  const hostId = rawCourier.hostId == null ? null : deps.assertText(rawCourier.hostId, 'courier.hostId', 128);
  if (provider === target.provider && nativeId === target.nativeId) {
    throw new deps.BindingError('courier identity must differ from parent native identity');
  }
  return {
    schema: 'discord-surface:courier:v1:route',
    routeId,
    routeGeneration,
    status: COURIER_ROUTE_STATES.ACTIVE,
    guildId,
    parentChannelId,
    deliveryChannelId,
    target,
    courier: { provider, nativeId, workspace, sessionRoot, recipientThreadId, hostId }
  };
}

function routeComparable(route: CourierRoute): string {
  return JSON.stringify({
    routeId: route.routeId,
    routeGeneration: route.routeGeneration,
    guildId: route.guildId,
    parentChannelId: route.parentChannelId,
    deliveryChannelId: route.deliveryChannelId,
    target: route.target,
    courier: route.courier
  });
}

interface RouteReceiptRow {
  id: number;
  detail: CourierRoute;
  createdAt: string;
}

function routeRows(deps: CourierDependencies, state: CourierState): RouteReceiptRow[] {
  return state.db.prepare('SELECT id, detail, created_at FROM receipts WHERE kind=? ORDER BY id').all(COURIER_RECEIPT_KINDS.ROUTE)
    .map(row => {
      const raw = row as SqlRow;
      return { id: Number(raw.id), detail: deps.parseJson(raw.detail, null) as CourierRoute, createdAt: String(raw.created_at) };
    })
    .filter(row => row.detail && typeof row.detail.routeId === 'string');
}

export function listRoutes(deps: CourierDependencies, state: CourierState): CourierRoute[] {
  const latest = new Map<string, RouteReceiptRow>();
  for (const row of routeRows(deps, state)) {
    const prior = latest.get(row.detail.routeId);
    if (!prior || row.id > prior.id) latest.set(row.detail.routeId, row);
  }
  return [...latest.values()].map(row => ({ ...row.detail, receiptId: row.id, createdAt: row.createdAt }));
}

export function getRoute(deps: CourierDependencies, state: CourierState, routeId: string): CourierRoute | null {
  deps.assertText(routeId, 'routeId', 128);
  return listRoutes(deps, state).find(route => route.routeId === routeId) || null;
}

function bindingForRoute(deps: CourierDependencies, state: CourierState, route: CourierRoute): { binding: any; enrollment: any } {
  const binding = state.getBinding(route.parentChannelId);
  const enrollment = state.getThreadEnrollment(route.deliveryChannelId);
  if (!binding || !binding.active || binding.guildId !== route.guildId ||
    !enrollment || !enrollment.active || enrollment.parentChannelId !== route.parentChannelId || enrollment.guildId !== route.guildId) {
    throw new deps.BindingError('courier route binding is not active');
  }
  if (enrollment.state !== deps.THREAD_STATES.READY || binding.readiness !== deps.READINESS.READY) {
    throw new deps.BindingError('courier route requires a ready enrolled child');
  }
  const expectedTarget = {
    guildId: binding.guildId,
    channelId: route.deliveryChannelId,
    provider: binding.provider,
    nativeId: binding.nativeId,
    generation: binding.generation
  };
  if (!sameAddress(route.target, expectedTarget)) throw new deps.BindingError('courier route target is stale');
  return { binding, enrollment };
}

export function registerRoute(deps: CourierDependencies, state: CourierState, input: unknown): CourierRoute | null {
  const route = routeInput(deps, input);
  return state.transaction(() => {
    bindingForRoute(deps, state, route);
    const existing = getRoute(deps, state, route.routeId);
    if (existing) {
      if (existing.status === COURIER_ROUTE_STATES.ACTIVE && routeComparable(existing) === routeComparable(route)) return existing;
      if (route.routeGeneration <= existing.routeGeneration) throw new deps.BindingError('courier route generation must advance');
    }
    state.receipt(null, COURIER_RECEIPT_KINDS.ROUTE, { ...route, recordedAt: deps.now() });
    return getRoute(deps, state, route.routeId);
  });
}

export function revokeRoute(deps: CourierDependencies, state: CourierState, routeId: string, reason: string | null = null): CourierRoute | null {
  deps.assertText(routeId, 'routeId', 128);
  if (reason !== null) deps.assertText(reason, 'reason', 512);
  return state.transaction(() => {
    const existing = getRoute(deps, state, routeId);
    if (!existing) throw new deps.BindingError('courier route is unknown');
    if (existing.status === COURIER_ROUTE_STATES.REVOKED) return existing;
    state.receipt(null, COURIER_RECEIPT_KINDS.ROUTE, {
      ...existing,
      status: COURIER_ROUTE_STATES.REVOKED,
      reason: reason || undefined,
      recordedAt: deps.now()
    });
    return getRoute(deps, state, routeId);
  });
}

export interface RouteMatch {
  status: string | null;
  route: CourierRoute | null;
  check?: any;
}

function isHumanMessage(state: CourierState, message: CourierMessage): boolean {
  return !message.agentMessage && message.authorId === state.requireConfig().operatorId;
}

export function isCourierOriginAllowed(state: CourierState, message: CourierMessage): boolean {
  if (message.decisionResult != null) return false;
  try {
    return !state.isInteractionMessage(message.id);
  } catch {
    return false;
  }
}

function childRouteReady(deps: CourierDependencies, state: CourierState, route: CourierRoute): boolean {
  const childRoute = state.getMessageRoute(route.deliveryChannelId);
  return Boolean(childRoute?.enrollment?.active && childRoute.enrollment.parentChannelId === route.parentChannelId &&
    childRoute.enrollment.guildId === route.guildId && childRoute.enrollment.state === deps.THREAD_STATES.READY && childRoute.ready);
}

export function findMatchingRoute(deps: CourierDependencies, state: CourierState, message: CourierMessage, routeId: string | null = null): RouteMatch {
  if (!isCourierOriginAllowed(state, message)) return { status: COURIER_RESULT_STATUSES.NO_ROUTE, route: null };
  const human = isHumanMessage(state, message);
  const allRoutes = listRoutes(deps, state).filter(route => {
    if ((routeId && route.routeId !== routeId) || route.guildId !== message.guildId || route.parentChannelId !== message.channelId) return false;
    return (human && message.deliveryChannelId === message.channelId) || route.deliveryChannelId === message.deliveryChannelId;
  });
  const routes = allRoutes.filter(route => route.status === COURIER_ROUTE_STATES.ACTIVE &&
    (human || sameAddress(route.target, message.agentMessage?.target)));
  if (routes.length !== 1) {
    if (routes.length === 0 && allRoutes.length === 1) {
      const status = allRoutes[0].status === COURIER_ROUTE_STATES.REVOKED
        ? COURIER_RESULT_STATUSES.NO_ROUTE
        : COURIER_RESULT_STATUSES.STALE;
      return { status, route: allRoutes[0] };
    }
    return { status: routes.length > 1 ? COURIER_RESULT_STATUSES.CONFLICT : COURIER_RESULT_STATUSES.NO_ROUTE, route: null };
  }
  const route = routes[0];
  const check = state.currentMessageBinding(message);
  if (!check?.identity || !check.current) return { status: COURIER_RESULT_STATUSES.STALE, route, check };
  if (!check.ready) return { status: COURIER_RESULT_STATUSES.HELD, route, check };
  if (!childRouteReady(deps, state, route)) return { status: COURIER_RESULT_STATUSES.HELD, route, check };
  if (human) return { status: null, route, check };
  const expectedTarget = {
    guildId: check.binding.guildId,
    channelId: message.deliveryChannelId,
    provider: check.binding.provider,
    nativeId: check.binding.nativeId,
    generation: check.binding.generation
  };
  if (!sameAddress(route.target, expectedTarget)) return { status: COURIER_RESULT_STATUSES.STALE, route, check };
  return { status: null, route, check };
}

export { routeInput };
