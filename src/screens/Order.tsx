import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useStore } from '../data/store';
import { useToast } from '../components/Toast';
import { TabBar, usePreviewState } from '../components/TabBar';
import { RoleSwitch } from '../components/RoleSwitch';
import { SkeletonRows, StateCard, StatusChip, Thumb } from '../components/Bits';
import { ClearInput } from '../components/ClearInput';
import { Icon } from '../components/Icons';
import { anchorDeleteTip, DeleteTip, type DeleteTipState } from '../components/DeleteTip';
import { initial, isTodayOrder, itemCover, mealLabel, orderCover, orderItems, orderMain, orderSummary, todayLine } from '../data/helpers';
import { Cover } from '../components/Photo';
import { useNames } from '../data/useNames';
import { preserveTypedValue } from '../lib/inputs';
import { useBackClose } from '../lib/back';
import type { DB, Meal, Order, OrderItem } from '../data/types';

export default function OrderScreen() {
  const { db, addOrder, deleteOrder, me } = useStore();
  const { toast } = useToast();
  /* 点单屏：下单的人是「我」，做饭的是对方 */
  const names = useNames();
  const preview = usePreviewState();
  const [sp, setSp] = useSearchParams();

  const [meal, setMeal] = useState<Meal>('lunch');
  const [selected, setSelected] = useState<OrderItem[]>([]);
  const [manual, setManual] = useState('');
  /* 挑选网格的搜索词：菜谱多了以后靠它找菜 */
  const [pickQ, setPickQ] = useState('');
  /* 给掌勺的话（可不填），随这一单一起发出去 */
  const [note, setNote] = useState('');
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  /* 历史点单默认折叠：只露数量，点一下才铺开 */
  const [showHistory, setShowHistory] = useState(false);
  /* 长按某张单 → 弹删除提示（今日点单 / 历史点单都支持） */
  const [tip, setTip] = useState<DeleteTipState | null>(null);
  const pressTimer = useRef<number | null>(null);
  const longPressed = useRef(false);

  const preselected = useRef(false);

  /* 长按弹出的删除提示是遮罩：手机返回键先收起它，而不是退出应用 */
  useBackClose(tip !== null, closeTip);

  /* 详情页「去点单 · 带上这道菜」带过来的 ?add=id */
  useEffect(() => {
    if (preselected.current) return;
    const addId = sp.get('add');
    if (!addId) return;
    preselected.current = true;
    const r = db.recipes.find((x) => x.id === addId);
    if (r) {
      setSelected([{ recipeId: r.id, dishName: r.title }]);
      const next = new URLSearchParams(sp);
      next.delete('add');
      setSp(next, { replace: true });
    }
  }, [sp, db.recipes, setSp]);

  useEffect(() => {
    const t = window.setTimeout(() => setLoading(false), 480);
    return () => window.clearTimeout(t);
  }, []);

  const selIndex = (recipeId: string | null) => selected.findIndex((s) => s.recipeId === recipeId);

  function toggleRecipe(recipeId: string, title: string) {
    const i = selIndex(recipeId);
    if (i !== -1) setSelected(selected.filter((_, idx) => idx !== i));
    else setSelected([...selected, { recipeId, dishName: title }]);
  }

  function removeAt(i: number) {
    setSelected(selected.filter((_, idx) => idx !== i));
  }

  function randomAdd() {
    const pool = db.recipes.filter((r) => selIndex(r.id) === -1);
    if (!pool.length) {
      toast('菜谱库都挑完啦，先发出去或自己输一道', false);
      return;
    }
    const r = pool[Math.floor(Math.random() * pool.length)];
    setSelected([...selected, { recipeId: r.id, dishName: r.title }]);
    toast(`随机加了「${r.title}」`);
  }

  function addManual() {
    const v = manual.trim();
    if (!v) {
      toast('先输入一道菜名', false);
      return;
    }
    if (selected.some((s) => !s.recipeId && s.dishName === v)) {
      toast(`「${v}」已经在里面了`, false);
      return;
    }
    setSelected([...selected, { recipeId: null, dishName: v }]);
    setManual('');
  }

  function send() {
    if (!selected.length) {
      toast('先选几道菜再发', false);
      return;
    }
    setSending(true);
    const items = selected;
    const mealNow = meal;
    const noteNow = note.trim();
    window.setTimeout(() => {
      addOrder({ meal: mealNow, items, note: noteNow });
      setSelected([]);
      setNote('');
      setSending(false);
      toast(`已发给${names.partnerName} · 等待接单`);
    }, 720);
  }

  function toggleOpen(id: string) {
    const next = new Set(open);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setOpen(next);
  }

  /* ─── 长按删除 ─────────────────────────────────
     按下开始计时（450ms），松手 / 划走 / 滚动就取消 —— 普通点按还是展开这张单。
     长按弹出后，紧随其后的那次 click 要吞掉，不然会顺带把这张单展开。 */
  function cancelPress() {
    if (pressTimer.current !== null) {
      window.clearTimeout(pressTimer.current);
      pressTimer.current = null;
    }
  }

  function startPress(el: HTMLElement, o: Order) {
    longPressed.current = false;
    cancelPress();
    pressTimer.current = window.setTimeout(() => {
      pressTimer.current = null;
      longPressed.current = true;
      setTip(anchorDeleteTip(el, o.id, orderSummary(o)));
    }, 450);
  }

  function closeTip() {
    longPressed.current = false;
    setTip(null);
  }

  function removeOrder(id: string, title: string) {
    deleteOrder(id);
    closeTip();
    toast(`已删除「${title}」`);
  }

  function onCardClick(id: string) {
    if (longPressed.current) {
      longPressed.current = false;
      return;
    }
    toggleOpen(id);
  }

  /* 点单页只看我点的单；对方点的那些在「掌勺」里等我做 */
  const myOrders = useMemo(
    () => (preview === 'empty' ? [] : db.orders.filter((o) => o.placedBy === me)),
    [db.orders, preview, me],
  );
  const todayOrders = useMemo(() => myOrders.filter(isTodayOrder), [myOrders]);
  const historyOrders = useMemo(() => myOrders.filter((o) => !isTodayOrder(o)), [myOrders]);

  const canSend = selected.length > 0 && !sending;

  /* 挑选网格：搜索词命中菜名 / 备注，与菜谱库那套同一口径 */
  const pickSearching = pickQ.trim().length > 0;
  const pickList = useMemo(() => {
    const lq = pickQ.trim().toLowerCase();
    if (!lq) return db.recipes;
    return db.recipes.filter((r) => `${r.title} ${r.note}`.toLowerCase().includes(lq));
  }, [db.recipes, pickQ]);

  return (
    <div className="app s-order">
      <header className="topbar">
        <p className="greeting">{todayLine()}</p>
        <div className="navrow">
          <h1 className="ptitle" style={{ margin: 0 }}>
            点一顿饭
          </h1>
          <RoleSwitch />
        </div>
      </header>

      <section className="composer">
        <div className="crow">
          <div className="clabel">
            <b>{meal === 'lunch' ? '今天中午' : '今天晚上'}</b>
            <span>从菜谱库挑几道，凑成一顿</span>
          </div>
          <div className="seg ony" role="group" aria-label="选择午晚餐">
            <button type="button" className={meal === 'lunch' ? 'on' : ''} onClick={() => setMeal('lunch')}>
              午餐
            </button>
            <button type="button" className={meal === 'dinner' ? 'on' : ''} onClick={() => setMeal('dinner')}>
              晚餐
            </button>
          </div>
        </div>

        <div className="selchips" aria-live="polite">
          {selected.length === 0 ? (
            <span className="ph">还没选菜 · 点下面任意一道试试</span>
          ) : (
            selected.map((s, i) => (
              <span className="sel" key={`${s.recipeId ?? 'm'}-${i}`} title="点一下移除">
                {s.dishName}
                <button className="x" aria-label={`移除 ${s.dishName}`} onClick={() => removeAt(i)}>
                  <Icon name="x" />
                </button>
              </span>
            ))
          )}
        </div>

        <ClearInput
          className="ordernote"
          type="text"
          value={note}
          maxLength={30}
          autoComplete="off"
          spellCheck={false}
          placeholder="给掌勺的话（可不填）"
          aria-label="给掌勺的话"
          onChange={(e) => setNote(e.target.value)}
          onClear={() => setNote('')}
          {...preserveTypedValue(setNote)}
        />

        <button className="sendbtn" disabled={!canSend} onClick={send}>
          {sending ? (
            <>
              <span className="spinner" aria-hidden /> 正在发送…
            </>
          ) : (
            <>
              <Icon name="send" />
              <span>
                {selected.length
                  ? `发给${names.partnerName} · ${mealLabel(meal)} · ${selected.length} 道`
                  : '先选几道菜'}
              </span>
            </>
          )}
        </button>
      </section>

      <main className="scroll" onScroll={closeTip}>
        <div className="pad" style={{ display: 'flex', flexDirection: 'column', gap: 18, paddingTop: 14, paddingBottom: 22 }}>
          <section>
            <div className="sechead">
              <div>
                <h2 className="h3">从菜谱库挑选</h2>
                <p className="hint">
                  {pickSearching ? `找到 ${pickList.length} 道「${pickQ.trim()}」` : '可多选 · 已选中的会堆到上面'}
                </p>
              </div>
              <button className="btn-sticker solid" onClick={randomAdd}>
                <Icon name="shuffle" />
                随机加一道
              </button>
            </div>

            {/* 库里一道菜都没有时不摆搜索框 —— 那时该看到的是下面的空态引导 */}
            {db.recipes.length > 0 && (
              <div className="picksearch">
                <Icon name="search" />
                <input
                  type="text"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="搜菜名或备注"
                  aria-label="搜索菜谱库"
                  value={pickQ}
                  onChange={(e) => setPickQ(e.target.value)}
                  {...preserveTypedValue(setPickQ)}
                />
                {pickSearching && (
                  <button type="button" className="sclear" aria-label="清除搜索" onClick={() => setPickQ('')}>
                    <Icon name="x" />
                  </button>
                )}
              </div>
            )}

            <div className="dishgrid">
              {!db.recipes.length ? (
                <div className="card statecard grid-empty">
                  <p style={{ margin: '0 0 4px', fontSize: 16, fontWeight: 600 }}>菜谱库还是空的</p>
                  <p className="meta" style={{ margin: '0 0 12px' }}>
                    先去收藏几道菜，才能点单呀。
                  </p>
                  <Link className="btn-sticker primary" to="/add" style={{ minWidth: 140 }}>
                    去添加
                  </Link>
                </div>
              ) : !pickList.length ? (
                <div className="card statecard grid-empty">
                  <p style={{ margin: '0 0 4px', fontSize: 16, fontWeight: 600 }}>没找到「{pickQ.trim()}」</p>
                  <p className="meta" style={{ margin: '0 0 12px' }}>
                    换个关键词，或者用下面那栏自己输一道。
                  </p>
                  <button className="btn-sticker primary" style={{ minWidth: 140 }} onClick={() => setPickQ('')}>
                    清除搜索
                  </button>
                </div>
              ) : (
                pickList.map((r) => {
                  const on = selIndex(r.id) !== -1;
                  return (
                    <button
                      type="button"
                      key={r.id}
                      className={`pick${on ? ' on' : ''}`}
                      aria-pressed={on}
                      onClick={() => toggleRecipe(r.id, r.title)}
                    >
                      <span className="pt">
                        <Thumb art={r.art || null} image={r.image} title={r.title} />
                      </span>
                      <span className="info">
                        <span className="t">{r.title}</span>
                      </span>
                      <span className="ck">
                        <Icon name="check" />
                      </span>
                    </button>
                  );
                })
              )}
            </div>

            <div className="manualrow">
              <ClearInput
                type="text"
                maxLength={18}
                autoComplete="off"
                placeholder="还想吃某道没收藏的？自己输"
                aria-label="自己加一道没收藏的"
                value={manual}
                onChange={(e) => setManual(e.target.value)}
                onClear={() => setManual('')}
                {...preserveTypedValue(setManual)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    addManual();
                  }
                }}
              />
              <button className="btn-sticker" onClick={addManual}>
                加进这顿
              </button>
            </div>
          </section>

          <section>
            <div className="sechead">
              <div>
                <h2 className="h3">今日点单</h2>
                <p className="hint">点一张单可展开看里面每道菜 · 长按可删除</p>
              </div>
              <span className="meta">{todayOrders.length} 份</span>
            </div>

            <div className="stack" style={{ gap: 12 }}>
              {loading ? (
                <div className="card sticker" style={{ padding: '8px 16px' }}>
                  <SkeletonRows n={3} />
                </div>
              ) : !todayOrders.length ? (
                <StateCard
                  icon="pot"
                  title="今天还没下过单"
                  desc={`在上面挑几道菜，发给${names.partnerName}，对方打开「掌勺」就能接单。`}
                />
              ) : (
                todayOrders.map((o) => (
                  <OrderCard
                    key={o.id}
                    order={o}
                    db={db}
                    partner={names.partnerName}
                    open={open.has(o.id)}
                    onToggle={() => onCardClick(o.id)}
                    onPressStart={(el) => startPress(el, o)}
                    onPressEnd={cancelPress}
                  />
                ))
              )}
            </div>
          </section>

          {!loading && historyOrders.length > 0 && (
            <section>
              <button
                type="button"
                className={`morebar${showHistory ? ' open' : ''}`}
                aria-expanded={showHistory}
                onClick={() => setShowHistory((v) => !v)}
              >
                <span className="mb-t">历史点单</span>
                <span className="mb-c">{historyOrders.length} 份</span>
                <span className="chev">
                  <Icon name="chevronDown" />
                </span>
              </button>
              {showHistory && (
                <div className="stack" style={{ gap: 12, marginTop: 12 }}>
                  {historyOrders.map((o) => (
                    <OrderCard
                      key={o.id}
                      order={o}
                      db={db}
                      partner={names.partnerName}
                      open={open.has(o.id)}
                      onToggle={() => onCardClick(o.id)}
                      onPressStart={(el) => startPress(el, o)}
                      onPressEnd={cancelPress}
                    />
                  ))}
                </div>
              )}
            </section>
          )}
        </div>
      </main>

      {tip && <DeleteTip tip={tip} onDelete={() => removeOrder(tip.id, tip.title)} onClose={closeTip} />}

      <TabBar active="order" />
    </div>
  );
}

/* ─── 单张订单卡（可展开）───────────────────── */

function OrderCard({
  order,
  db,
  partner,
  open,
  onToggle,
  onPressStart,
  onPressEnd,
}: {
  order: Order;
  db: DB;
  /** 做饭的那个人的昵称（我下的单由对方掌勺） */
  partner: string;
  open: boolean;
  onToggle: () => void;
  /** 按下这张单的卡头（长按计时起点） */
  onPressStart: (el: HTMLElement) => void;
  /** 松手 / 划走 / 取消长按 */
  onPressEnd: () => void;
}) {
  const items = orderItems(order);
  const cover = orderCover(order, db);
  const main = orderMain(order);

  return (
    <div className={`card sticker ocard${order.status === 'done' ? ' done' : ''}${open ? ' open' : ''}`}>
      <button
        className="osum"
        aria-expanded={open}
        onPointerDown={(e) => onPressStart(e.currentTarget)}
        onPointerUp={onPressEnd}
        onPointerLeave={onPressEnd}
        onPointerCancel={onPressEnd}
        onClick={onToggle}
      >
        <span className="omt">
          {cover ? (
            <Cover image={cover.image} art={cover.art} title={main} />
          ) : (
            <span className="mono">{initial(main)}</span>
          )}
        </span>
        <span className="ob">
          {/* 标题（尤其是剪藏来的长视频标题）按两行截断，见 .s-order .osum .ob .t */}
          <span className="t">{orderSummary(order)}</span>
          <span className="m">
            {mealLabel(order.meal)} · {order.createdAt} · <StatusChip status={order.status} />
          </span>
        </span>
        <span className="chev">
          <Icon name="chevronDown" />
        </span>
      </button>

      <div className="odetail">
        {items.map((it, i) => {
          const cover = itemCover(it, db);
          return (
            <div className="dit" key={`${it.recipeId ?? 'm'}-${i}`}>
              <div className="da">
                {cover ? (
                  <Cover image={cover.image} art={cover.art} title={it.dishName} />
                ) : (
                  <span className="mono">{initial(it.dishName)}</span>
                )}
              </div>
              <div className="dn">{it.dishName}</div>
            </div>
          );
        })}

        {order.note && <div className="onote">给掌勺的话：{order.note}</div>}

        <div className="foot">
          {order.status === 'done' ? (
            <>
              <Icon name="check" />
              {partner}已做完这顿 · {order.updatedAt}
            </>
          ) : (
            `${partner}回传状态后，这里会自动更新（每 1 分钟拉取）`
          )}
        </div>
      </div>
    </div>
  );
}
