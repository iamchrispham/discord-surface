import {
  WATCHER_NOTICE_KIND,
  WATCHER_NOTICE_PROVIDERS,
  type WatcherAddress,
  type WatcherNotice
} from '../src/watcher-notice';
import {
  WATCHER_NOTICE_AUTHORITY,
  WATCHER_NOTICE_RECEIPTS,
  type WatcherNoticeArm
} from '../src/state/watcher-notice';

const address: WatcherAddress = {
  guildId: '100',
  channelId: '101',
  provider: WATCHER_NOTICE_PROVIDERS.CLAUDE,
  nativeId: '22222222-2222-2222-2222-222222222222',
  generation: 1
};
const notice: WatcherNotice = {
  id: 'wn-fixture',
  kind: WATCHER_NOTICE_KIND.NOTICE,
  armKey: 'arm',
  triggerKey: 'trigger',
  source: address,
  target: { ...address, channelId: '102' },
  text: 'fixture'
};
const arm: WatcherNoticeArm = {
  armKey: 'arm',
  authority: WATCHER_NOTICE_AUTHORITY.NOTICE_ONLY,
  provider: WATCHER_NOTICE_PROVIDERS.CLAUDE,
  operatorId: '900',
  source: address,
  target: notice.target,
  workspace: '/tmp',
  endpoint: null,
  sessionRoot: null,
  conductorId: null,
  repoKey: null,
  generation: 1,
  createdAt: '2026-01-01T00:00:00.000Z'
};

const receiptNames: string[] = [WATCHER_NOTICE_RECEIPTS.ARM, WATCHER_NOTICE_RECEIPTS.TRIGGER, WATCHER_NOTICE_RECEIPTS.CONSUMED];
void notice;
void arm;
void receiptNames;
