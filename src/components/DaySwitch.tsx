import { useNavigate } from 'react-router-dom';

/**
 * 「今天」这一格里的页内切换：我点单 / 我掌勺。
 *
 * 两个人谁都能点单、也都能掌勺，所以点单屏与今日菜单屏对谁都一样；
 * 这一对按钮只是在两屏之间来回走，不再代表「我的身份」。
 */
export function DaySwitch({ active }: { active: 'order' | 'cook' }) {
  const navigate = useNavigate();
  return (
    <div className="seg dayseg" role="group" aria-label="切换点单与掌勺">
      <button
        type="button"
        className={active === 'order' ? 'on' : ''}
        aria-pressed={active === 'order'}
        onClick={() => navigate('/order')}
      >
        我点单
      </button>
      <button
        type="button"
        className={active === 'cook' ? 'on' : ''}
        aria-pressed={active === 'cook'}
        onClick={() => navigate('/cook')}
      >
        我掌勺
      </button>
    </div>
  );
}