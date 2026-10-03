import type {
  DirectPostRecoveryDependencies,
  DirectPostRecoveryHandlers,
  DirectPostRecoveryOwnerAlive,
  DirectPostRecoveryState
} from './contracts';

export function createDirectPostRecoveryHandlers(dependencies: DirectPostRecoveryDependencies): DirectPostRecoveryHandlers {
  const { DIRECT_POST_ATTEMPT, DIRECT_POST_OUTCOME } = dependencies;

  function recoverDirectPostReceipts(state: DirectPostRecoveryState, ownerAlive: DirectPostRecoveryOwnerAlive = (pid, expectedIdentity) => {
    if (!Number.isInteger(Number(pid)) || Number(pid) < 1) return false;
    return state.directPostOwnerAlive(pid, expectedIdentity);
  }): number {
    return state.transaction(() => state.recoverDirectPostReceiptsInternal(ownerAlive));
  }

  function recoverDirectPostReceiptsInternal(state: DirectPostRecoveryState, ownerAlive: DirectPostRecoveryOwnerAlive = (pid, expectedIdentity) => {
    if (!Number.isInteger(Number(pid)) || Number(pid) < 1) return false;
    return state.directPostOwnerAlive(pid, expectedIdentity);
  }): number {
    const rows = state.directPostRows();
    const outcomes = new Set(rows.filter(row => row.kind === DIRECT_POST_OUTCOME && row.detail?.attemptId).map(row => row.detail.attemptId));
    let recovered = 0;
    for (const row of rows.filter(item => item.kind === DIRECT_POST_ATTEMPT)) {
      if (outcomes.has(row.detail.attemptId)) continue;
      if (ownerAlive(row.detail.ownerPid, row.detail)) continue;
      state.receipt(null, DIRECT_POST_OUTCOME, {
        ...row.detail,
        outcome: 'unknown',
        reason: 'process stopped before direct post outcome'
      });
      recovered += 1;
    }
    return recovered;
  }

  return { recoverDirectPostReceipts, recoverDirectPostReceiptsInternal };
}
