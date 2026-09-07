import {
  staticConductorMarker,
  topicWithReadiness,
  type Provider,
  type Readiness
} from '../src/topic';

const provider: Provider = 'codex';
const readiness: Readiness = 'ready';

staticConductorMarker({ provider, conductorId: 'typed-conductor', repoKey: 'repo:typed' });
topicWithReadiness('legacy topic', readiness, '2026-09-07T00:00:00.000Z');

// @ts-expect-error unsupported providers must fail at the typed boundary
staticConductorMarker({ provider: 'github', conductorId: 'typed-conductor', repoKey: 'repo:typed' });

// @ts-expect-error unsupported readiness values must fail at the typed boundary
topicWithReadiness('legacy topic', 'online');
