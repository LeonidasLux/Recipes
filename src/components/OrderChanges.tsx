import { Icon } from './Icons';
import { changeText, meOf, nicknameOf } from '../data/helpers';
import type { DB, OrderChange } from '../data/types';

/**
 * 这张单被改过什么：谁、什么时候、改了什么、为什么。
 *
 * 两边都会记 —— 掌勺方改菜单（必须写原因）与点菜方改自己的单（原因可不填）。
 * **一次改动一行**：减了几道、加了几道、餐次 / 「给掌勺的话」动没动都写在这一行里，
 * 写了原因就接在后面。点菜页与掌勺页的订单卡共用这一块（按时间顺序排：最早改的在上，
 * 读下来就是「这张单怎么变成现在这样」）。没有记录时什么都不渲染。
 */
export function OrderChanges({ changes, db }: { changes: OrderChange[]; db: DB }) {
  if (!changes.length) return null;
  const me = meOf(db.config);

  return (
    <div className="ochanges">
      <span className="oc-t">
        <Icon name="pencil" />
        这单改过
      </span>
      <ul className="oc-list">
        {changes.map((c, i) => (
          <li key={`${c.at}-${i}`}>
            <span className="oc-at">{c.at}</span>
            <b>{c.by === me ? '我' : nicknameOf(db.profiles, c.by) || '对方'}</b>
            {changeText(c)}
            {/* 原因可能空着（点菜方改单不必写）—— 那就别留一个孤零零的冒号 */}
            {c.reason ? <span className="oc-why">：{c.reason}</span> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
