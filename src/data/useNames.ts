import { useStore } from './store';
import { nicknameOf, partnerOf } from './helpers';

/**
 * 某块屏上「我」和「对方」各叫什么。
 *
 * 昵称随仓库共享（profiles.json），两个人各绑在一个稳定的人槽（a / b）上：
 *  · 谁都能点单、谁都能掌勺，角色由订单方向决定，不再挂在人身上；
 *  · 没设过名字时退回中性称呼「我 / 对方」，不会显示空白。
 */
export function useNames() {
  const { db, me } = useStore();
  const other = partnerOf(me);
  const meName = nicknameOf(db.profiles, me);
  const partnerName = nicknameOf(db.profiles, other);

  return {
    meKey: me,
    partnerKey: other,
    meName: meName || '我',
    partnerName: partnerName || '对方',
    meNamed: Boolean(meName),
    partnerNamed: Boolean(partnerName),
  };
}