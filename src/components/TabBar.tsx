import { Link, useSearchParams } from 'react-router-dom';
import { Icon, type IconName } from './Icons';

export type TabKey = 'library' | 'today' | 'sync';

interface TabDef {
  key: TabKey;
  to: string;
  label: string;
  icon: IconName;
}

const LIBRARY_TAB: TabDef = { key: 'library', to: '/library', label: '菜谱库', icon: 'book' };
const TODAY_TAB: TabDef = { key: 'today', to: '/order', label: '今天', icon: 'order' };
const SYNC_TAB: TabDef = { key: 'sync', to: '/sync', label: '同步', icon: 'sync' };

/** 五态预览：?state=empty|error，仅用于走查，不影响真实数据 */
export function usePreviewState(): 'populated' | 'empty' | 'error' {
  const [sp] = useSearchParams();
  const s = sp.get('state');
  return s === 'empty' || s === 'error' ? s : 'populated';
}

/**
 * 底部导航 4 格： [菜谱库] [今天] [＋添加] [同步]
 *
 * 「今天」把点单与掌勺合成一格（页内用 DaySwitch 切换）：
 * 两个人谁都能点单、也都能掌勺，角色由订单方向决定，所以不再有按身份分叉的导航。
 */
export function TabBar({ active }: { active: TabKey }) {
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
      {tab(TODAY_TAB)}
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