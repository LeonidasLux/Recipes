import { Link, useSearchParams } from 'react-router-dom';
import { useStore } from '../data/store';
import { Icon, type IconName } from './Icons';

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
 * 底部导航 4 格： [菜谱库] [点单 / 掌勺] [＋添加] [同步]
 *
 * 第二格跟着「本机当前角色」（config.view）走：
 * 角色是点单 → 第二格「点单」（/order）；角色是掌勺 → 第二格「掌勺」（/cook）。
 * 角色本身在「设置」页（/sync）里切换（本地设置，不触发推送）。
 */
export function TabBar({ active }: { active: TabKey }) {
  const { view } = useStore();
  const second = view === 'cook' ? COOK_TAB : ORDER_TAB;

  const tab = (t: TabDef) => (
    <Link key={t.key} to={t.to} className={`tab${t.key === active ? ' active' : ''}`}>
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
      {tab(SYNC_TAB)}
    </nav>
  );
}
