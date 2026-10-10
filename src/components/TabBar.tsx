import { Link, useSearchParams } from 'react-router-dom';
import { useStore } from '../data/store';
import { useSync } from '../lib/useSync';
import { badgeText, openCookCount } from '../data/helpers';
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
 * 「设置」格图标与菜谱库右上角的同步按钮都自带同步状态：已同步（ok / idle）绿、
 * 失败（err）红、同步中（busy）高亮 + 闪烁 + 转圈，未连接保持原色。
 *
 * 同步状态只在这两枚图标和设置页里体现 —— 点单 / 掌勺屏不挂顶栏 pill，
 * 免得点单、掌勺的时候被同步信息分心，但出了问题又能一眼看见。
 */
export function syncTone(connected: boolean, status: SyncStatus): string {
  if (!connected) return '';
  if (status === 'err') return ' sync-err';
  /* 同步中：点第二格 / 切角色会顺手同步一次，靠这枚图标转起来告诉用户「在同步」 */
  if (status === 'busy') return ' sync-busy';
  if (status === 'ok' || status === 'idle') return ' sync-ok';
  return '';
}

/**
 * 底部导航 4 格： [菜谱库] [点单 / 掌勺] [＋添加] [同步]
 *
 * 第二格跟着「本机当前角色」（config.view）走：
 * 角色是点单 → 第二格「点单」（/order）；角色是掌勺 → 第二格「掌勺」（/cook）。
 * 角色是掌勺、且对方还有没做完的单时，第二格右上角还挂一枚数字红点 ——
 * 与角色开关右上角那枚同源（openCookCount / badgeText，见 data/helpers.ts）。
 * 角色切换贴在这两块屏的右上角（见 components/RoleSwitch.tsx），是本地设置、不触发推送。
 */
export function TabBar({ active }: { active: TabKey }) {
  const { db, me, view, connected } = useStore();
  const { status, syncNow } = useSync();
  const second = view === 'cook' ? COOK_TAB : ORDER_TAB;
  /* 掌勺那边还没做完的单：角色是掌勺时，第二格右上角挂上同一枚数字红点 ——
     角色是点单时第二格是「点单」，不挂红点（那枚只留在角色开关上）。 */
  const cooking = openCookCount(db.orders, me);
  const secondBadge = view === 'cook' && cooking > 0 ? badgeText(cooking) : '';

  const tab = (t: TabDef, extra = '', onClick?: () => void, badge = '') => (
    /* 四格之间互相换屏用 replace：一级页不叠历史，否则按返回会退回「上一次用过的一级页」，
       而不是直接回桌面（返回键规则见 src/lib/back.tsx）。中间那个「＋添加」是二级页，仍走 push。 */
    <Link
      key={t.key}
      to={t.to}
      replace
      className={`tab${extra}${t.key === active ? ' active' : ''}`}
      onClick={onClick}
      aria-label={badge ? `${t.label}（还有 ${cooking} 单没做完）` : undefined}
    >
      <Icon name={t.icon} />
      <span className="lbl">{t.label}</span>
      {badge && (
        <span className="badge" title={`掌勺还有 ${cooking} 单没做完`}>
          {badge}
        </span>
      )}
      <span className="bubble" />
    </Link>
  );

  return (
    <nav className="tabbar" style={{ ['--tabs' as string]: '4' }} aria-label="主导航">
      {tab(LIBRARY_TAB)}
      {/* 第二格（点单 / 掌勺）点一下顺手同步一次：进来看到的单 / 菜单都该是新的 */}
      {tab(second, '', () => {
        if (connected) void syncNow({ toast: false });
      }, secondBadge)}
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
