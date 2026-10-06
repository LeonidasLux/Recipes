import { useStore } from '../data/store';
import { useSync } from '../lib/useSync';
import { SyncPill } from './Bits';

/** 顶栏同步状态 pill —— 直接反映真实同步状态机 */
export function LiveSyncPill() {
  const { connected } = useStore();
  const { status, lastAt } = useSync();

  if (!connected) return <SyncPill kind="syncoff" label="本地模式" />;

  switch (status) {
    case 'busy':
      return <SyncPill kind="syncing" label="同步中…" />;
    case 'err':
      return <SyncPill kind="syncerr" label="同步失败" />;
    default:
      /* idle 也按「上次同步时间」呈现：本地没有待推改动时这就是实情 */
      return <SyncPill kind="synced" label={`已同步 ${lastAt}`} />;
  }
}
