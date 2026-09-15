import {
  assertGatewayWakeCompatible,
  type GatewayStatus,
  type GatewayStatusReader
} from '../src/ordinary-bind/gateway-capability';

interface GatewayPaths {
  stateDir: string;
  db: string;
  pid: string;
  lock: string;
  bindLock: string;
  provisionLock: string;
}

const paths: GatewayPaths = {
  stateDir: '/tmp/discord-surface',
  db: '/tmp/discord-surface/surface.sqlite',
  pid: '/tmp/discord-surface/runtime.pid',
  lock: '/tmp/discord-surface/runtime.lock',
  bindLock: '/tmp/discord-surface/runtime-bind.lock',
  provisionLock: '/tmp/discord-surface/provision.lock'
};

const status: GatewayStatusReader<GatewayPaths> = receivedPaths => {
  receivedPaths.stateDir satisfies string;
  return { state: 'stopped', pid: null, capabilities: [] };
};

const snapshot: GatewayStatus = assertGatewayWakeCompatible(paths, status);
snapshot.state satisfies string | null | undefined;
snapshot.pid satisfies number | null | undefined;
snapshot.capabilities satisfies readonly string[] | null | undefined;

const mismatchedStatus: GatewayStatusReader<{ stateDir: string; requiredExtra: number }> = () => ({ state: 'stopped' });
// @ts-expect-error the status reader must accept the same path shape as the call
assertGatewayWakeCompatible(paths, mismatchedStatus);
