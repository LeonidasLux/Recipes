import { useStore } from '../data/store';
import { useSync } from '../lib/useSync';
import { Icon } from './Icons';
import { syncTone } from './TabBar';

/**
 * 菜谱库标题行右端的同步按钮：点一下立刻同步一次。
 *
 * 之前「手动同步一次」只能在设置页点，或者切角色时顺手来一下 —— 菜谱库是
 * 用得最多的一屏，「对面刚录的新菜怎么还没过来」的疑问就出在这里。
 *
 * 有本地改动就推、没有就拉（与设置页的「立即同步」走同一个 `syncNow`），
 * 完成后照常 toast 一句「同步完成」。图标自带状态（和底部「设置」格那枚一套）：
 * 同步中转圈 + 闪、成功绿、失败红，没连仓库保持原色；没连仓库时点它，
 * `syncNow` 会提醒去设置里连上，不会静默什么都不做。
 */
export function SyncButton() {
  const { connected } = useStore();
  const { status, syncNow } = useSync();

  const busy = status === 'busy';
  const label = !connected ? '同步（还没连接仓库）' : busy ? '正在同步…' : '同步';

  return (
    <button
      type="button"
      className={`icbtn syncbtn${syncTone(connected, status)}`}
      aria-label={label}
      title={label}
      aria-busy={busy}
      onClick={() => void syncNow()}
    >
      <Icon name="sync" />
    </button>
  );
}
