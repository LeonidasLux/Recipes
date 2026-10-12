import { useEffect, useMemo, useState } from 'react';
import { ClearInput } from './ClearInput';
import { Icon } from './Icons';
import { Thumb } from './Bits';
import { useToast } from './Toast';
import { initial, itemCover, orderItems } from '../data/helpers';
import { Cover } from './Photo';
import { preserveTypedValue } from '../lib/inputs';
import type { DB, Order, OrderItem } from '../data/types';

/** 一道菜的标识：有菜谱看菜谱 id，临时手输的看菜名 */
function keyOf(it: OrderItem): string {
  return it.recipeId ? `r:${it.recipeId}` : `n:${it.dishName}`;
}

/**
 * 掌勺方的「改这顿的菜单」弹层：对**已经接下的单**加菜 / 减菜。
 *
 * 一次可以改好几处（减两道、加一道都行，加减也能混着来），**整批共用一句原因** ——
 * 现实里往往就是同一件事（「这两样没买到，换成这些」），点菜那边一条就读明白了。
 * 原因空着不让提交（标红 + toast，和「菜名必填」同一套）；每道菜各记一条改动记录，
 * 都挂着这句原因（见 `changeOrderDishes`）。
 *
 * 点遮罩 / 点右上角 × / 按 Esc 关掉；手机返回键那一层由调用方用 `useBackClose` 登记（见 §6）。
 */
export function MenuSheet({
  order,
  db,
  onSave,
  onClose,
}: {
  order: Order;
  db: DB;
  /** 整批改动 + 一句原因（组件已经拦过空改动 / 空原因） */
  onSave: (input: { add: OrderItem[]; remove: number[]; reason: string }) => void;
  onClose: () => void;
}) {
  const { toast } = useToast();
  /** 要减掉的那几道（下标） */
  const [removing, setRemoving] = useState<Set<number>>(new Set());
  /** 要加进来的那几道 */
  const [adding, setAdding] = useState<OrderItem[]>([]);
  const [reason, setReason] = useState('');
  /* 原因没写就点了保存 → 当场标红 */
  const [invalid, setInvalid] = useState(false);
  const [q, setQ] = useState('');
  const [manual, setManual] = useState('');

  const items = orderItems(order);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  /* 挑选列表：搜菜名 / 备注，与点单页那套同一口径 */
  const list = useMemo(() => {
    const lq = q.trim().toLowerCase();
    if (!lq) return db.recipes;
    return db.recipes.filter((r) => `${r.title} ${r.note}`.toLowerCase().includes(lq));
  }, [db.recipes, q]);

  /** 这一批改完还剩几道（要减的减掉、要加的加上） */
  const kept = items.length - removing.size + adding.length;

  function toggleRemove(i: number) {
    if (removing.has(i)) {
      const next = new Set(removing);
      next.delete(i);
      setRemoving(next);
      return;
    }
    /* 一次都不能减空：这一批里加了菜也算（「减两样、换两样」是常见用法） */
    if (kept - 1 < 1) {
      toast('一单至少留一道菜（想清空就长按删整单）', false);
      return;
    }
    const next = new Set(removing);
    next.add(i);
    setRemoving(next);
  }

  function toggleAdd(item: OrderItem) {
    const k = keyOf(item);
    if (adding.some((x) => keyOf(x) === k)) {
      setAdding(adding.filter((x) => keyOf(x) !== k));
      return;
    }
    /* 单里已经有的不再加第二遍（标了「要减」的也还在这一批里，想留就先把「要减」取消） */
    if (items.some((it) => keyOf(it) === k)) {
      toast(`「${item.dishName}」已经在单里了`, false);
      return;
    }
    setAdding([...adding, item]);
  }

  function addManual() {
    const v = manual.trim();
    if (!v) {
      toast('先输入一道菜名', false);
      return;
    }
    if (adding.some((x) => !x.recipeId && x.dishName === v)) {
      toast(`「${v}」已经在要加的里面了`, false);
      return;
    }
    setManual('');
    setAdding([...adding, { recipeId: null, dishName: v }]);
  }

  const summary = [removing.size ? `减 ${removing.size} 道` : '', adding.length ? `加 ${adding.length} 道` : '']
    .filter(Boolean)
    .join(' · ');

  function save() {
    if (!removing.size && !adding.length) {
      toast('先加一道或减一道再保存', false);
      return;
    }
    const text = reason.trim();
    if (!text) {
      setInvalid(true);
      toast('写一句为什么，点菜那边得看得懂', false);
      return;
    }
    onSave({ add: adding, remove: [...removing].sort((a, b) => a - b), reason: text });
  }

  return (
    <div className="menusheet" role="dialog" aria-modal="true" aria-label="改这顿的菜单">
      <button type="button" className="ms-mask" aria-label="关闭改菜单" onClick={onClose} />

      <div className="card sticker ms-card">
        <button type="button" className="ms-close" aria-label="关闭" onClick={onClose}>
          <Icon name="x" />
        </button>

        <h2 className="ms-title">改这顿的菜单</h2>
        <p className="ms-sub">
          加减都行、一次改几道也行，改完写一句为什么 —— 点菜那边展开这张单就能看到。
        </p>

        <div className="ms-body">
          <div className="ms-sec">
            <span className="ms-label">这单现在 {items.length} 道菜</span>
            <div className="ms-dishes">
              {items.map((it, i) => {
                const cover = itemCover(it, db);
                const on = removing.has(i);
                return (
                  <div className={`ms-dish${on ? ' on' : ''}`} key={`${it.recipeId ?? 'm'}-${i}`}>
                    <span className="ms-thumb">
                      {cover ? (
                        <Cover image={cover.image} art={cover.art} title={it.dishName} />
                      ) : (
                        <span className="mono">{initial(it.dishName)}</span>
                      )}
                    </span>
                    <span className="ms-name">{it.dishName}</span>
                    <button
                      type="button"
                      className={`ms-toggle${on ? ' on' : ''}`}
                      aria-pressed={on}
                      aria-label={`${on ? '不减' : '减掉'}「${it.dishName}」`}
                      onClick={() => toggleRemove(i)}
                    >
                      {on ? '不减了' : '减掉'}
                    </button>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="ms-sec">
            <span className="ms-label">加一道</span>
            <div className="ms-search">
              <Icon name="search" />
              <input
                type="text"
                autoComplete="off"
                spellCheck={false}
                placeholder="搜菜名或备注"
                aria-label="搜索菜谱库"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                {...preserveTypedValue(setQ)}
              />
              {q.trim() && (
                <button type="button" className="ms-sclear" aria-label="清除搜索" onClick={() => setQ('')}>
                  <Icon name="x" />
                </button>
              )}
            </div>

            <div className="ms-list">
              {!db.recipes.length ? (
                <p className="ms-empty">菜谱库还是空的，下面手输一道也行。</p>
              ) : !list.length ? (
                <p className="ms-empty">没找到「{q.trim()}」，下面手输一道也行。</p>
              ) : (
                list.map((r) => {
                  const item: OrderItem = { recipeId: r.id, dishName: r.title };
                  const picked = adding.some((x) => keyOf(x) === keyOf(item));
                  const inOrder = items.some((it) => it.recipeId === r.id);
                  return (
                    <button
                      type="button"
                      key={r.id}
                      className={`ms-pick${picked ? ' on' : ''}`}
                      disabled={inOrder}
                      aria-pressed={picked}
                      aria-label={
                        inOrder
                          ? `${r.title}（已经在单里）`
                          : picked
                            ? `不加「${r.title}」了`
                            : `加「${r.title}」`
                      }
                      onClick={() => toggleAdd(item)}
                    >
                      <span className="pt">
                        <Thumb art={r.art || null} image={r.image} title={r.title} />
                      </span>
                      <span className="t">{r.title}</span>
                      <span className="tag">{inOrder ? '已在单里' : picked ? '要加' : '加'}</span>
                    </button>
                  );
                })
              )}
            </div>

            <div className="ms-manual">
              <ClearInput
                type="text"
                maxLength={18}
                autoComplete="off"
                spellCheck={false}
                value={manual}
                placeholder="没收藏的菜？自己输菜名"
                aria-label="自己输一道没收藏的菜"
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
              <button type="button" className="btn-sticker" onClick={addManual}>
                加
              </button>
            </div>

            {/* 手输的菜在挑选列表里没有对应那一行，摆成胶囊让人看得见自己排了什么 */}
            {adding.length > 0 && (
              <div className="ms-chips">
                <span className="ms-label">这次要加：</span>
                {adding.map((it) => (
                  <span className="ms-chip" key={keyOf(it)}>
                    {it.dishName}
                    <button
                      type="button"
                      className="x"
                      aria-label={`不加「${it.dishName}」了`}
                      onClick={() => toggleAdd(it)}
                    >
                      <Icon name="x" />
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="ms-foot">
          <span className={`ms-sum${summary ? ' on' : ''}`}>
            {summary ? `这次要改：${summary}` : '还没改：点上面的「减掉」，或挑一道加进来'}
          </span>
          <div className={`field${invalid ? ' invalid' : ''}`}>
            <ClearInput
              className="ms-input"
              type="text"
              maxLength={30}
              autoComplete="off"
              spellCheck={false}
              value={reason}
              placeholder="为什么这么改（必填），点菜那边看得到"
              aria-label="改菜的原因"
              onChange={(e) => setReason(e.target.value)}
              onClear={() => setReason('')}
              {...preserveTypedValue(setReason)}
            />
            <span className="err">得写一句为什么，不然点菜那边看不懂</span>
          </div>
          <div className="ms-ract">
            <button type="button" className="btn-sticker" onClick={onClose}>
              取消
            </button>
            <button type="button" className="btn-sticker primary ms-ok" onClick={save}>
              保存改动
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
