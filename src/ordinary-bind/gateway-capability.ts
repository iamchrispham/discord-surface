const { GATEWAY_CAPABILITIES } = require('../../src/ordinary-bind/constants') as {
  GATEWAY_CAPABILITIES: {
    ordinaryBindWake: string;
  };
};

export const GATEWAY_STATES = {
  running: 'running',
  stopped: 'stopped',
  stale: 'stale',
  unknown: 'unknown',
} as const;

export type GatewayState = (typeof GATEWAY_STATES)[keyof typeof GATEWAY_STATES];

export interface GatewayStatus {
  state?: GatewayState | null;
  pid?: number | null;
  capabilities?: readonly string[] | null;
}

export type GatewayStatusReader<TPaths, TStatus extends GatewayStatus = GatewayStatus> =
  (paths: TPaths) => TStatus | null | undefined;

export function assertGatewayWakeCompatible<TPaths, TStatus extends GatewayStatus = GatewayStatus>(
  paths: TPaths,
  status: GatewayStatusReader<TPaths, TStatus>,
  runtime: TStatus | null | undefined = undefined
): TStatus {
  const snapshot = runtime || status(paths);
  if (!snapshot || snapshot.state === GATEWAY_STATES.unknown) {
    throw new Error('Gateway status is unknown; stop or restart it before binding');
  }
  if (snapshot.state !== GATEWAY_STATES.running || !snapshot.pid || snapshot.capabilities?.includes(GATEWAY_CAPABILITIES.ordinaryBindWake)) return snapshot;
  throw new Error('running Gateway does not support ordinary binding wake; stop or restart it before binding');
}
