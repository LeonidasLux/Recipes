import { Link, useSearchParams } from 'react-router-dom';
import { useStore } from '../data/store';
import { useSync } from '../lib/useSync';
import { Icon, type IconName } from './Icons';
import type { SyncStatus } from '../data/types';

export type TabKey = 'library' | 'order' | 'cook' | 'sync';

interface TabDef {
  key: TabKey;
  to: string;
  label: string;
  icon: IconName;
}

const LIBRARY_TAB: TabDef = { key: 'library', to: '/library', label: '菜谱库', icon: 'book' };
const ORDER_TAB: TabDef = { key: 'order', to: '/order', label: '点单', icon: 'order' };
const COOK_TAB: TabDef = { key: 'cook', to: '/cook', label: '掌勺', icon: 'pot' };
const SYNC_TAB: TabDef = { key: 'sync', to: '/sync', label: '设置', icon: 'sync' };

/** 五态预览：?state=empty|error，仅用于走查，不影响真实数据 */
export function usePreviewState(): 'populated' | 'empty' | 'error' {
  const [sp] = useSearchParams();
  const s = sp.get('state');
  return s === 'empty' || s === 'error' ? s : 'populated';
}

/**
 * 「设置」格图标自带同步状态色：已同步（ok / idle）绿、失败（err）红，
 * 其余状态（未连接 / 同步中）保持原色。
 *
 * 同步状态只在这枚图标和设置页里体现 —— 其他屏不再挂顶栏 pill，
 * 免得点单、掌勺的时候被同步信息分心，但出了问题又能一眼看见。
 */
function syncTone(connected: boolean, status: SyncStatus): string {
  if (!connected) return '';
  if (status === 'err') return ' sync-err';
  if (status === 'ok' || status === 'idle') return ' sync-ok';
  return '';
}

/**
 * 底部导航 4 格： [菜谱库] [点单 / 掌勺] [＋添加] [同步]
 *
 * 第二格跟着「本机当前角色」（config.view）走：
 * 角色是点单 → 第二格「点单」（/order）；角色是掌勺 → 第二格「掌勺」（/cook）。
 * 角色切换贴在这两块屏的右上角（见 components/RoleSwitch.tsx），是本地设置、不触发推送。
 */
export function TabBar({ active }: { active: TabKey }) {
  const { view, connected } = useStore();
  const { status } = useSync();
  const second = view === 'cook' ? COOK_TAB : ORDER_TAB;

  const tab = (t: TabDef, extra = '') => (
    /* 四格之间互相换屏用 replace：一级页不叠历史，否则按返回会退回「上一次用过的一级页」，
       而不是直接回桌面（返回键规则见 src/lib/back.tsx）。中间那个「＋添加」是二级页，仍走 push。 */
    <Link key={t.key} to={t.to} replace className={`tab${extra}${t.key === active ? ' active' : ''}`}>
      <Icon name={t.icon} />
      <span>{t.label}</span>
      <span className="bubble" />
    </Link>
  );

  return (
    <nav className="tabbar" style={{ ['--tabs' as string]: '4' }} aria-label="主导航">
      {tab(LIBRARY_TAB)}
      {tab(second)}
      <Link to="/add" className="tab add">
        <span className="fab">
          <Icon name="plus" />
        </span>
        <span className="lbl">添加</span>
        <span className="bubble" />
      </Link>
      {tab(SYNC_TAB, syncTone(connected, status))}
    </nav>
  );
}
