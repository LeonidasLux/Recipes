import { useLocation, useNavigate } from 'react-router-dom';
import { useStore } from '../data/store';
import { useToast } from './Toast';
import type { ViewRole } from '../data/types';

/**
 * 角色切换：决定底部第二格是「点单」还是「掌勺」。
 *
 * 它贴在「第二格那块屏」的右上角（点单屏 / 掌勺屏各有一个），切完顺手跳到
 * 对应的屏 —— 否则你人还停在原来那屏，而底部第二格已经指向别处了。
 * 只改本机的 `config.view`，是本地设置，不触发推送。
 */
export function RoleSwitch() {
  const { db, me, view, setView } = useStore();
  const { toast } = useToast();
  const navigate = useNavigate();
  const { search } = useLocation();

  /* 掌勺那边还没做完的单：对方点的、状态不是「已完成」。数字挂在开关右上角，
     这样停在点单屏也能一眼看到「那边还有活」。 */
  const cooking = db.orders.filter((o) => o.placedBy !== me && o.status !== 'done').length;

  function pick(next: ViewRole) {
    if (next === view) return;
    setView(next);
    toast(next === 'cook' ? '已切到「掌勺」· 底部第二格换成掌勺' : '已切到「点单」· 底部第二格换成点单');
    /* 点单 / 掌勺同属一级页：换屏用 replace，不叠历史（返回键不该在一级页之间来回，见 src/lib/back.tsx） */
    navigate(`${next === 'cook' ? '/cook' : '/order'}${search}`, { replace: true });
  }

  const seg = (key: ViewRole, label: string) => (
    <button
      type="button"
      className={view === key ? 'on' : ''}
      aria-pressed={view === key}
      aria-label={key === 'cook' && cooking > 0 ? `${label}（还有 ${cooking} 单没做完）` : undefined}
      onClick={() => pick(key)}
    >
      {label}
    </button>
  );

  return (
    <div className="rolesw" role="group" aria-label="切换本机角色">
      {seg('order', '点单')}
      {seg('cook', '掌勺')}
      {cooking > 0 && (
        <span className="badge" title={`掌勺还有 ${cooking} 单没做完`}>
          {cooking > 99 ? '99+' : cooking}
        </span>
      )}
    </div>
  );
}
