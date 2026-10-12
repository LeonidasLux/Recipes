import { useEffect, useRef, useState } from 'react';
import { useStore } from '../data/store';
import { useToast } from '../components/Toast';
import { TabBar, usePreviewState } from '../components/TabBar';
import { RoleSwitch } from '../components/RoleSwitch';
import { SkeletonRows, StateCard, StatusChip } from '../components/Bits';
import { Icon } from '../components/Icons';
import { DishSheet } from '../components/DishSheet';
import { MenuSheet } from '../components/MenuSheet';
import { OrderChanges } from '../components/OrderChanges';
import { anchorDeleteTip, DeleteTip, type DeleteTipState } from '../components/DeleteTip';
import { dayTag, initial, itemCover, mealLabel, orderChanges, orderDay, orderItems } from '../data/helpers';
import { Cover } from '../components/Photo';
import { useNames } from '../data/useNames';
import { useBackClose } from '../lib/back';
import type { Order, OrderItem } from '../data/types';

export default function CookToday() {
  const { db, deleteOrder, setOrderStatus, restoreOrder, changeOrderDishes, me } = useStore();
  const { toast } = useToast();
  /* 掌勺屏：只做对方点的单；我自己点的那份留在「点单」里 */
  const names = useNames();
  const preview = usePreviewState();

  const [loading, setLoading] = useState(true);
  const [pendingId, setPendingId] = useState<string | null>(null);
  /* 已做完默认折叠：只露数量，点一下才铺开 */
  const [showDone, setShowDone] = useState(false);
  /* 点了哪道菜 → 弹它的详情；null 表示没弹 */
  const [dish, setDish] = useState<OrderItem | null>(null);
  /* 正在给哪张单改菜单（加 / 减菜弹层）；null 表示没弹 */
  const [menuId, setMenuId] = useState<string | null>(null);
  /* 长按某张单的卡头 → 弹删除提示（今日菜单 / 已做完都支持） */
  const [tip, setTip] = useState<DeleteTipState | null>(null);
  const pressTimer = useRef<number | null>(null);

  /* 菜品详情是遮罩：手机返回键先关它，而不是退出应用（点遮罩 / × / Esc 照旧） */
  useBackClose(dish !== null, () => setDish(null));
  /* 改菜单弹层也是遮罩：返回键先关它 */
  useBackClose(menuId !== null, () => setMenuId(null));
  /* 删除提示也是遮罩：返回键先收起它 */
  useBackClose(tip !== null, closeTip);

  useEffect(() => {
    const t = window.setTimeout(() => setLoading(false), 460);
    return () => window.clearTimeout(t);
  }, []);

  const cookOrders = db.orders.filter((o) => o.placedBy !== me);
  const orders = preview === 'empty' ? cookOrders.filter((o) => o.status === 'done') : cookOrders;
  /* 没做完的按「哪天吃」排：今天要做的在最上面，明天 / 后天的跟在后面
     （同一天里保持原来的先后 —— sort 是稳定的） */
  const activeOrders = orders
    .filter((o) => o.status !== 'done')
    .sort((a, b) => orderDay(a).localeCompare(orderDay(b)));
  const doneOrders = orders.filter((o) => o.status === 'done');

  function advance(o: Order) {
    const next = o.status === 'pending' ? 'accepted' : 'done';
    setPendingId(o.id);
    window.setTimeout(() => {
      setOrderStatus(o.id, next);
      setPendingId(null);
      toast(next === 'accepted' ? `已接下 · ${names.partnerName}会看到` : '已标完成 · 已同步');
    }, 600);
  }

  /** 「全部做好了」点错了 / 其实还没做完 → 退回「已接」，卡片回到今天要做的那一摞 */
  function restore(o: Order) {
    setPendingId(o.id);
    window.setTimeout(() => {
      restoreOrder(o.id);
      setPendingId(null);
      toast(`已恢复成没做完 · ${names.partnerName}会看到`);
    }, 600);
  }

  /* ─── 改菜单（加 / 减菜，整批写一句原因）──────────
     只对「已接」的单动：还没接的先接下，做完的去「恢复成没做完」。
     一次可以减几道、加几道（混着来也行），改完整批提交一句原因，点菜那边看得明白。 */
  const menuOrder = menuId ? db.orders.find((o) => o.id === menuId) ?? null : null;

  function saveMenu(input: { add: OrderItem[]; remove: number[]; reason: string }) {
    if (!menuOrder) return;
    const { add, remove, reason } = input;
    changeOrderDishes(menuOrder.id, { add, remove, reason });
    setMenuId(null);
    const parts = [remove.length ? `减 ${remove.length} 道` : '', add.length ? `加 ${add.length} 道` : '']
      .filter(Boolean)
      .join(' · ');
    toast(`菜单改好了（${parts}） · ${names.partnerName}会看到`);
  }

  /* ─── 长按删除 ─────────────────────────────────
     卡头按满 450ms 弹删除提示；松手 / 划走就取消。
     卡头本身没有点击行为，所以不用担心长按顺带触发别的动作。 */
  function cancelPress() {
    if (pressTimer.current !== null) {
      window.clearTimeout(pressTimer.current);
      pressTimer.current = null;
    }
  }

  function startPress(el: HTMLElement, o: Order) {
    cancelPress();
    pressTimer.current = window.setTimeout(() => {
      pressTimer.current = null;
      setTip(anchorDeleteTip(el, o.id, `${dayTag(orderDay(o))}${mealLabel(o.meal)}单`));
    }, 450);
  }

  function closeTip() {
    setTip(null);
  }

  function removeOrder(id: string, title: string) {
    deleteOrder(id);
    closeTip();
    toast(`已删除「${title}」`);
  }

  const interval = db.config?.autoPull ? db.config.intervalSec : 0;
  const noticeLabel = interval
    ? `与仓库同一数据 · 每 ${interval >= 60 ? `${interval / 60} 分钟` : `${interval} 秒`}自动拉取`
    : '与仓库同一数据 · 仅手动同步';

  return (
    <div className="app s-cook">
      <header className="topbar">
        <p className="greeting">{names.meNamed ? `${names.meName} · 掌勺` : '我来掌勺'}</p>
        <div className="navrow">
          <div>
            <h1 className="ptitle" style={{ margin: 0 }}>
              今日菜单
            </h1>
            <small style={{ display: 'block', fontSize: 13, color: 'var(--muted)', marginTop: 2 }}>
              {names.partnerNamed ? `${names.partnerName}点给你的几道菜` : '点给你的几道菜'} · 长按卡片可删除
            </small>
          </div>
          <RoleSwitch />
        </div>
      </header>

      <main className="scroll" onScroll={closeTip}>
        <div className="pad" style={{ display: 'flex', flexDirection: 'column', gap: 14, paddingTop: 14, paddingBottom: 20 }}>
          {loading ? (
            <div className="card sticker" style={{ padding: '8px 16px' }}>
              <SkeletonRows n={3} />
            </div>
          ) : (
            <>
              {!activeOrders.length ? (
                <StateCard
                  icon="potEmpty"
                  title="今天清清闲闲"
                  desc={
                      names.partnerNamed
                        ? `还没有人点单。等${names.partnerName}发出想吃的菜，会整单出现在这里。`
                        : '还没有人点单。等对方发出想吃的菜，会整单出现在这里。'
                  }
                />
              ) : (
                <section style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  {activeOrders.map((o) => (
                    <CookCard
                      key={o.id}
                      order={o}
                      db={db}
                      partner={names.partnerName}
                      pending={pendingId === o.id}
                      onAdvance={() => advance(o)}
                      onRestore={() => restore(o)}
                      onOpenMenu={() => setMenuId(o.id)}
                      onOpenDish={setDish}
                      onPressStart={(el) => startPress(el, o)}
                      onPressEnd={cancelPress}
                    />
                  ))}
                </section>
              )}

              {doneOrders.length > 0 && (
                <section>
                  <button
                    type="button"
                    className={`morebar${showDone ? ' open' : ''}`}
                    aria-expanded={showDone}
                    onClick={() => setShowDone((v) => !v)}
                  >
                    <span className="mb-t">已做完</span>
                    <span className="mb-c">{doneOrders.length} 份</span>
                    <span className="chev">
                      <Icon name="chevronDown" />
                    </span>
                  </button>
                  {showDone && (
                    <div className="stack" style={{ gap: 12, marginTop: 12 }}>
                      {doneOrders.map((o) => (
                        <CookCard
                          key={o.id}
                          order={o}
                          db={db}
                          partner={names.partnerName}
                          pending={pendingId === o.id}
                          onAdvance={() => {}}
                          onRestore={() => restore(o)}
                          onOpenMenu={() => setMenuId(o.id)}
                          onOpenDish={setDish}
                          onPressStart={(el) => startPress(el, o)}
                          onPressEnd={cancelPress}
                        />
                      ))}
                    </div>
                  )}
                </section>
              )}
            </>
          )}
        </div>
      </main>

      <div className="notice meta" style={{ borderTop: '1.5px solid var(--border)' }}>
        <Icon name="sync" />
        {noticeLabel}
      </div>

      <TabBar active="cook" />

      {tip && <DeleteTip tip={tip} onDelete={() => removeOrder(tip.id, tip.title)} onClose={closeTip} />}

      {dish && <DishSheet item={dish} db={db} onClose={() => setDish(null)} />}

      {menuOrder && (
        <MenuSheet
          order={menuOrder}
          db={db}
          onSave={saveMenu}
          onClose={() => setMenuId(null)}
        />
      )}
    </div>
  );
}

function CookCard({
  order,
  db,
  partner,
  pending,
  onAdvance,
  onRestore,
  onOpenMenu,
  onOpenDish,
  onPressStart,
  onPressEnd,
}: {
  order: Order;
  db: ReturnType<typeof useStore>['db'];
  /** 点单那个人的昵称（对方点的单由我来做） */
  partner: string;
  pending: boolean;
  onAdvance: () => void;
  /** 已做完的单 → 恢复成没做完（退回「已接」） */
  onRestore: () => void;
  /** 已接的单 → 弹「改这顿的菜单」（加 / 减菜，每次都要写原因） */
  onOpenMenu: () => void;
  /** 点某道菜 → 上层弹它的详情 */
  onOpenDish: (item: OrderItem) => void;
  /** 按卡头（长按计时起点） */
  onPressStart: (el: HTMLElement) => void;
  /** 松手 / 划走 / 取消长按 */
  onPressEnd: () => void;
}) {
  const items = orderItems(order);
  const isDone = order.status === 'done';

  return (
    <div className={`card sticker cookcard${isDone ? ' done' : ''}`}>
      <div
        className="cch"
        onPointerDown={(e) => onPressStart(e.currentTarget)}
        onPointerUp={onPressEnd}
        onPointerLeave={onPressEnd}
        onPointerCancel={onPressEnd}
      >
        <div style={{ minWidth: 0 }}>
          <div className="tt">
            {dayTag(orderDay(order))}
            {mealLabel(order.meal)}单 · {items.length} 道菜
          </div>
          <div className="when">{order.createdAt} 点的单</div>
        </div>
        <StatusChip status={order.status} />
      </div>

      <div className="cc-items">
        {items.map((it, i) => {
          const cover = itemCover(it, db);
          return (
            <button
              type="button"
              className="dit"
              key={`${it.recipeId ?? 'm'}-${i}`}
              aria-label={`查看「${it.dishName}」的详情`}
              onClick={() => onOpenDish(it)}
            >
              <span className="da">
                {cover ? (
                  <Cover image={cover.image} art={cover.art} title={it.dishName} />
                ) : (
                  <span className="mono">{initial(it.dishName)}</span>
                )}
              </span>
              <span className="dn">{it.dishName}</span>
              <span className="qt">
                1 道
                <Icon name="chevronRight" />
              </span>
            </button>
          );
        })}
      </div>

      {order.note && (
        <div className="cook-note">
          <Icon name="note" />
          <span>{order.note}</span>
        </div>
      )}

      {/* 我自己改过这单的菜单（加 / 减了什么、为什么）—— 与点菜那边看到的是同一块 */}
      <OrderChanges changes={orderChanges(order)} db={db} />

      {isDone ? (
        <div className="donerow">
          <span className="doneflag">
            <Icon name="check" />
            做完啦，{partner}已收到
          </span>
          {/* 点错了 / 其实还没做完：退回「已接」，卡片回到上面那一摞 */}
          <button className="btn-sticker" disabled={pending} onClick={onRestore}>
            <Icon name="sync" />
            {pending ? '正在同步…' : '恢复成没做完'}
          </button>
        </div>
      ) : (
        <div className="cc-act">
          {order.status === 'pending' ? (
            <button className="btn-sticker solid" disabled={pending} onClick={onAdvance}>
              {pending ? '正在同步…' : '接下这顿'}
            </button>
          ) : (
            <>
              {/* 家里缺料 / 多了食材：加减一道，写清为什么 */}
              <button className="btn-sticker" onClick={onOpenMenu}>
                <Icon name="pencil" />
                加减菜
              </button>
              <button className="btn-sticker primary" disabled={pending} onClick={onAdvance}>
                {pending ? '正在同步…' : '全部做好了'}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
