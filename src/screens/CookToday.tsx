import { useEffect, useState } from 'react';
import { useStore } from '../data/store';
import { useToast } from '../components/Toast';
import { TabBar, usePreviewState } from '../components/TabBar';
import { DaySwitch } from '../components/DaySwitch';
import { LiveSyncPill } from '../components/LiveSyncPill';
import { SkeletonRows, StateCard, StatusChip } from '../components/Bits';
import { Icon } from '../components/Icons';
import { artUrl, initial, itemArt, mealLabel, orderItems } from '../data/helpers';
import { useNames } from '../data/useNames';
import type { Order } from '../data/types';

export default function CookToday() {
  const { db, setOrderStatus, me } = useStore();
  const { toast } = useToast();
  /* 掌勺屏：只做对方点的单；我自己点的那份留在「我点单」里 */
  const names = useNames();
  const preview = usePreviewState();

  const [loading, setLoading] = useState(true);
  const [pendingId, setPendingId] = useState<string | null>(null);

  useEffect(() => {
    const t = window.setTimeout(() => setLoading(false), 460);
    return () => window.clearTimeout(t);
  }, []);

  const cookOrders = db.orders.filter((o) => o.placedBy !== me);
  const orders = preview === 'empty' ? cookOrders.filter((o) => o.status === 'done') : cookOrders;
  const activeOrders = orders.filter((o) => o.status !== 'done');
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

  const interval = db.config?.autoPull ? db.config.intervalSec : 0;
  const noticeLabel = interval
    ? `与仓库同一数据 · 每 ${interval >= 60 ? `${interval / 60} 分钟` : `${interval} 秒`}自动拉取`
    : '与仓库同一数据 · 仅手动同步';

  return (
    <div className="app s-cook">
      <header className="topbar">
        <p className="greeting">{names.meNamed ? `${names.meName} · 掌勺` : '我来掌勺'}</p>
        <div className="navrow" style={{ alignItems: 'flex-end' }}>
          <div>
            <h1 className="ptitle" style={{ margin: 0 }}>
              今日菜单
            </h1>
            <small style={{ display: 'block', fontSize: 13, color: 'var(--muted)', marginTop: 2 }}>
              {names.partnerNamed ? `${names.partnerName}点给你的几道菜` : '点给你的几道菜'}
            </small>
          </div>
          <LiveSyncPill />
        </div>
      </header>

      <DaySwitch active="cook" />

      <main className="scroll">
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
                    />
                  ))}
                </section>
              )}

              {doneOrders.length > 0 && (
                <section>
                  <div className="row-between" style={{ padding: '0 2px' }}>
                    <h2 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>已做完</h2>
                  </div>
                  <div className="stack" style={{ gap: 12, marginTop: 4 }}>
                    {doneOrders.map((o) => (
                      <CookCard
                        key={o.id}
                        order={o}
                        db={db}
                        partner={names.partnerName}
                        pending={false}
                        onAdvance={() => {}}
                      />
                    ))}
                  </div>
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

      <TabBar active="today" />
    </div>
  );
}

function CookCard({
  order,
  db,
  partner,
  pending,
  onAdvance,
}: {
  order: Order;
  db: ReturnType<typeof useStore>['db'];
  /** 点单那个人的昵称（对方点的单由我来做） */
  partner: string;
  pending: boolean;
  onAdvance: () => void;
}) {
  const items = orderItems(order);
  const isDone = order.status === 'done';

  return (
    <div className={`card sticker cookcard${isDone ? ' done' : ''}`}>
      <div className="cch">
        <div style={{ minWidth: 0 }}>
          <div className="tt">
            {mealLabel(order.meal)}单 · {items.length} 道菜
          </div>
          <div className="when">{order.createdAt} 点的单</div>
        </div>
        <StatusChip status={order.status} />
      </div>

      <div className="cc-items">
        {items.map((it, i) => {
          const a = itemArt(it, db);
          return (
            <div className="dit" key={`${it.recipeId ?? 'm'}-${i}`}>
              <div className="da">
                {a ? <img src={artUrl(a)} alt={it.dishName} /> : <span className="mono">{initial(it.dishName)}</span>}
              </div>
              <div className="dn">{it.dishName}</div>
              <span className="qt">1 道</span>
            </div>
          );
        })}
      </div>

      {order.note && (
        <div className="cook-note">
          <Icon name="note" />
          <span>{order.note}</span>
        </div>
      )}

      {isDone ? (
        <span className="doneflag">
          <Icon name="check" />
          做完啦，{partner}已收到
        </span>
      ) : (
        <div className="cc-act">
          {order.status === 'pending' ? (
            <button className="btn-sticker solid" disabled={pending} onClick={onAdvance}>
              {pending ? '正在同步…' : '接下这顿'}
            </button>
          ) : (
            <button className="btn-sticker primary" disabled={pending} onClick={onAdvance}>
              {pending ? '正在同步…' : '全部做好了'}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
