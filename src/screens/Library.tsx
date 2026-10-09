import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useStore } from '../data/store';
import { useToast } from '../components/Toast';
import { useSync } from '../lib/useSync';
import { TabBar, usePreviewState } from '../components/TabBar';
import { SyncButton } from '../components/SyncButton';
import { SkeletonRows, SourceBadge, StateCard, Thumb } from '../components/Bits';
import { Icon } from '../components/Icons';
import { preserveTypedValue } from '../lib/inputs';
import { useBackClose } from '../lib/back';
import { todayLine } from '../data/helpers';
import type { Recipe, SourceKey } from '../data/types';

const FILTERS: Array<{ key: SourceKey | 'all'; label: string }> = [
  { key: 'all', label: '全部' },
  { key: 'red', label: '小红书' },
  { key: 'bili', label: 'B站' },
  { key: 'douyin', label: '抖音' },
  { key: 'manual', label: '手动' },
];

/** 排序字段：默认（收藏先后）/ 点单次数 / 更新时间 */
type SortKey = 'default' | 'count' | 'updated';
const SORTS: Array<{ key: SortKey; label: string }> = [
  { key: 'default', label: '默认' },
  { key: 'count', label: '点单次数' },
  { key: 'updated', label: '更新时间' },
];

export default function Library() {
  const { db, deleteRecipes } = useStore();
  const sync = useSync();
  const { toast } = useToast();
  const preview = usePreviewState();

  const [active, setActive] = useState<SourceKey | 'all'>('all');
  const [q, setQ] = useState('');
  const [loading, setLoading] = useState(true);
  /* 排序：字段 + 方向（升序 / 降序）；默认保持收藏先后，不排序 */
  const [sortKey, setSortKey] = useState<SortKey>('default');
  const [asc, setAsc] = useState(false);
  /**
   * 长按某条菜谱 → 进入多选模式（而不是在条目上弹一个删除气泡）：
   * 集合里装着已勾选的菜谱 id；null = 不在多选模式。
   * **空集合也是「在多选模式里」**（取消全选、反选到一条不剩时留在原地），
   * 退出多选只有两条路：点左上角 `×`，或按手机返回键。
   */
  const [picked, setPicked] = useState<Set<string> | null>(null);
  /** 点过「删除」但还没确认（二次点击才真删，防手滑） */
  const [confirmDelete, setConfirmDelete] = useState(false);
  const pressTimer = useRef<number | null>(null);
  /**
   * 长按之后浏览器可能补一次 click（也可能不补 —— 安卓长按链接常常只给 contextmenu）。
   * 这一次 click 要吞掉，不然刚勾上的那条会被它自己取消掉。
   * 用「吞一次」而不是「按住一段时间」：下一次真的点按都会先来个 pointerdown，
   * 那时就复位 —— 否则长按没补 click 时，把用户接下来那一次点按也吃掉了。
   */
  const swallowClick = useRef(false);
  /* 最近一次按下的指针类型：只有触摸才算「长按」；鼠标右键不该弹删除气泡 */
  const pressType = useRef('');

  /* 多选模式也是「可关闭的一层」：手机返回键先退出多选，而不是退出应用 */
  useBackClose(picked !== null, () => setPicked(null));

  /* 进场骨架 → 呈现（与设计源 520ms 一致） */
  useEffect(() => {
    const t = window.setTimeout(() => setLoading(false), 520);
    return () => window.clearTimeout(t);
  }, []);

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: db.recipes.length };
    db.recipes.forEach((r) => {
      c[r.source] = (c[r.source] ?? 0) + 1;
    });
    return c;
  }, [db.recipes]);

  const list = useMemo(() => {
    const lq = q.trim().toLowerCase();
    const filtered = db.recipes.filter((r) => {
      if (active !== 'all' && r.source !== active) return false;
      if (!lq) return true;
      return `${r.title} ${r.note} ${r.author}`.toLowerCase().includes(lq);
    });
    if (sortKey === 'default') return filtered;
    const dir = asc ? 1 : -1;
    /* updatedAt 是 `YYYY-MM-DD HH:MM`，按字符串比就是按时序比（老数据的怪串只影响它自己） */
    return [...filtered].sort((a, b) => {
      if (sortKey === 'count') return dir * ((a.orderCount ?? 0) - (b.orderCount ?? 0));
      if (a.updatedAt === b.updatedAt) return 0;
      return (a.updatedAt < b.updatedAt ? -1 : 1) * dir;
    });
  }, [db.recipes, active, q, sortKey, asc]);

  const searching = q.trim().length > 0;

  /** 在多选模式里（`picked` 只在多选模式下非 null） */
  const picking = picked !== null;
  /** 当前筛出来的这几条是不是都勾上了 */
  const allPicked = picking && list.length > 0 && list.every((r) => (picked as Set<string>).has(r.id));
  /** 删除键文案：一条没勾就只写「删除」（此时按钮是禁用的） */
  const deleteLabel = !picked?.size
    ? '删除'
    : confirmDelete
      ? `再点一次，删除 ${picked.size} 道菜`
      : `删除 ${picked.size} 道菜`;

  function retry() {
    setLoading(true);
    void sync.pull();
    window.setTimeout(() => setLoading(false), 700);
  }

  /* ─── 多选删除 ─────────────────────────────────
     长按一条 → 进多选模式并勾上它；之后点任意条目是「勾选 / 取消勾选」，不再进详情。
     按下开始计时（450ms），松手 / 划走 / 滚动就取消 —— 普通点按还是进详情；
     长按之后紧随其后的那次 click 要吞掉，不然会立刻把它自己取消掉。 */
  function cancelPress() {
    if (pressTimer.current !== null) {
      window.clearTimeout(pressTimer.current);
      pressTimer.current = null;
    }
  }

  /** 进入多选模式（长按，或触摸时系统补的那个 contextmenu） */
  function startPicking(r: Recipe) {
    cancelPress();
    swallowClick.current = true;
    setConfirmDelete(false);
    setPicked(new Set([r.id]));
  }

  function startPress(r: Recipe) {
    cancelPress();
    pressTimer.current = window.setTimeout(() => {
      pressTimer.current = null;
      startPicking(r);
    }, 450);
  }

  /** 新一次点按开始：上一次长按留下的「吞一次 click」作废 */
  function armPress() {
    swallowClick.current = false;
  }

  /** 这次 click 是不是长按松手补的？是就吞掉（只吞一次） */
  function eatLongPressClick(): boolean {
    if (!swallowClick.current) return false;
    swallowClick.current = false;
    return true;
  }

  /** 勾选 / 取消勾选一条 */
  function togglePick(id: string) {
    /* 整行可点：长按进来的那一下补的 click 要吞掉，其余一律当勾选 / 取消勾选 */
    if (eatLongPressClick()) return;
    setConfirmDelete(false);
    setPicked((cur) => {
      if (!cur) return cur;
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      /* 反选到一条不剩也留在多选模式（用户要接着选，别把人踢出去） */
      return next;
    });
  }

  function exitPicking() {
    swallowClick.current = false;
    setConfirmDelete(false);
    setPicked(null);
  }

  /** 全选 / 取消全选（只作用于当前筛出来的这几条；取消全选同样留在多选模式里） */
  function toggleAll() {
    setConfirmDelete(false);
    setPicked((cur) => {
      if (!cur) return cur;
      const all = list.length > 0 && list.every((r) => cur.has(r.id));
      return all ? new Set<string>() : new Set(list.map((r) => r.id));
    });
  }

  /** 删除勾选的菜谱：第一次点变成「再点一次确认」，第二次才真删 */
  function removePicked() {
    if (!picked?.size) return;
    const ids = [...picked];
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    deleteRecipes(ids);
    toast(ids.length === 1 ? '已删除 1 道菜' : `已删除 ${ids.length} 道菜`);
    exitPicking();
  }

  return (
    <div className="app s-library">
      {picking ? (
        /* 多选模式：顶栏换成选择条 —— 退出 / 已选几条 / 全选 */
        <header className="topbar selbar">
          <button className="icbtn ghost" aria-label="退出多选" onClick={exitPicking}>
            <Icon name="x" />
          </button>
          <b className="selcount">已选 {picked?.size ?? 0} 项</b>
          <button className="inlinebtn" onClick={toggleAll}>
            {allPicked ? '取消全选' : '全选'}
          </button>
        </header>
      ) : (
        <header className="topbar">
          <p className="greeting">{todayLine()}</p>
          <div className="navrow">
            <h1 className="ptitle" style={{ margin: 0 }}>
              我的菜谱库
            </h1>
            {/* 右上角：点一下立刻同步一次（有本地改动就推，没有就拉），不用特地去设置页 */}
            <SyncButton />
          </div>
        </header>
      )}

      <div className="searchwrap">
        <div className="searchbar">
          <Icon name="search" />
          <input
            type="text"
            autoComplete="off"
            spellCheck={false}
            placeholder="搜菜名、备注或作者"
            aria-label="搜索菜谱"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            {...preserveTypedValue(setQ)}
          />
          {searching && (
            <button className="sclear" aria-label="清除搜索" onClick={() => setQ('')}>
              <Icon name="x" />
            </button>
          )}
        </div>
      </div>

      <nav className="chips" aria-label="按来源筛选">
        {FILTERS.map((f) => {
          const n = counts[f.key] ?? 0;
          if (f.key !== 'all' && !n) return null;
          return (
            <button
              key={f.key}
              className={`chip${active === f.key ? ' on' : ''}`}
              onClick={() => setActive(f.key)}
              aria-pressed={active === f.key}
            >
              {f.label}
              <span className="n">{n}</span>
            </button>
          );
        })}
      </nav>

      {/* 排序：点单次数 / 更新时间都能升序、降序；默认保持收藏先后 */}
      {db.recipes.length > 0 && (
        <nav className="sortbar" aria-label="排序方式">
          <span className="sortlabel">排序</span>
          {SORTS.map((s) => (
            <button
              key={s.key}
              type="button"
              className={`schip${sortKey === s.key ? ' on' : ''}`}
              aria-pressed={sortKey === s.key}
              onClick={() => setSortKey(s.key)}
            >
              {s.label}
            </button>
          ))}
          <button
            type="button"
            className="schip dir"
            disabled={sortKey === 'default'}
            aria-label={asc ? '当前升序，点一下改成降序' : '当前降序，点一下改成升序'}
            onClick={() => setAsc((v) => !v)}
          >
            <Icon name={asc ? 'chevronUp' : 'chevronDown'} />
            {asc ? '升序' : '降序'}
          </button>
        </nav>
      )}

      <main className="scroll">
        <section className="pad feed">
          {loading ? (
            <div className="cardlist" style={{ padding: '6px 16px' }}>
              <SkeletonRows n={5} />
            </div>
          ) : preview === 'error' || (sync.status === 'err' && !db.recipes.length) ? (
            <StateCard
              icon="alert"
              title="菜谱没拉下来"
              desc="连不上仓库：网络不可达或 token 失效。改完设置再拉一次。"
            >
              <button className="btn-primary" onClick={retry}>
                重试
              </button>
            </StateCard>
          ) : preview === 'empty' || !db.recipes.length ? (
            <StateCard
              icon="bag"
              title="还没有菜谱"
              desc="在小红书、B站刷到想学的菜，点中间那个「+」把链接存进来。"
            >
              <Link className="btn-primary" to="/add">
                添加第一条菜谱
              </Link>
            </StateCard>
          ) : !list.length ? (
            <StateCard
              icon="searchOff"
              title={`没找到「${q.trim()}」`}
              desc="换个关键词试试，或直接把它收进菜谱库。"
            >
              <div className="stack" style={{ gap: 10 }}>
                <button className="btn-primary" onClick={() => setQ('')}>
                  清除搜索
                </button>
                <Link className="btn-ghost" to="/add">
                  添加这道菜
                </Link>
              </div>
            </StateCard>
          ) : (
            <>
              {searching && (
                <div className="matchline">
                  <span className="meta">
                    找到 {list.length} 道「{q.trim()}」
                  </span>
                  <button className="sclear" onClick={() => setQ('')}>
                    清除
                  </button>
                </div>
              )}
              <div className="cardlist">
                {list.map((r) => {
                  const row = (
                    <>
                      <span className="thumb">
                        <Thumb art={r.art || null} image={r.image} title={r.title} />
                      </span>
                      <span className="body">
                        <span className="title">{r.title}</span>
                        <span style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                          <SourceBadge source={r.source} />
                          <span className="cnt">点过 {r.orderCount ?? 0} 次</span>
                          {r.note && (
                            <span className="note" style={{ flex: 1 }}>
                              {r.note}
                            </span>
                          )}
                        </span>
                      </span>
                      {picking && (
                        <span className="ck" aria-hidden>
                          <Icon name="check" />
                        </span>
                      )}
                    </>
                  );

                  /* 多选模式里整行是个勾选按钮；平时还是一进去就跳详情的链接 */
                  return picking ? (
                    <button
                      type="button"
                      className={`dishrow pick${picked?.has(r.id) ? ' on' : ''}`}
                      key={r.id}
                      aria-pressed={picked?.has(r.id) ?? false}
                      aria-label={`${r.title}${picked?.has(r.id) ? '（已选）' : ''}`}
                      onPointerDown={armPress}
                      onClick={() => togglePick(r.id)}
                    >
                      {row}
                    </button>
                  ) : (
                    <Link
                      className="dishrow"
                      key={r.id}
                      to={`/recipe/${r.id}`}
                      onPointerDown={(e) => {
                        pressType.current = e.pointerType ?? '';
                        armPress();
                        startPress(r);
                      }}
                      onPointerUp={cancelPress}
                      onPointerLeave={cancelPress}
                      onPointerCancel={cancelPress}
                      onContextMenu={(e) => {
                        /* 这一行是 <a>：安卓上长按链接走的是**系统那条长按路**，平台可能在
                           我们 450ms 定时器到点之前就把指针序列取消掉，于是「按了半天没反应」。
                           系统长按（触摸）会补一个 contextmenu，这里接住它进多选模式（勾上这条）。
                           桌面右键（没有触摸指针）不进这条路，免得右键也进多选。 */
                        e.preventDefault();
                        if (pressType.current !== 'touch') return;
                        startPicking(r);
                      }}
                      onClick={(e) => {
                        if (!eatLongPressClick()) return;
                        /* 长按已经进了多选模式，这一次 click 不算「点开详情」 */
                        e.preventDefault();
                        e.stopPropagation();
                      }}
                    >
                      {row}
                    </Link>
                  );
                })}
              </div>
            </>
          )}
        </section>
      </main>

      {/* 多选模式：底部一条删除条（第一次点变确认，第二次才真删） */}
      {picking && (
        <div className="actionbar">
          {/* 一条没勾时按钮只是摆着（禁用态），不至于让人以为点了能删 */}
          <button className="btn-danger" disabled={!picked?.size} onClick={removePicked}>
            <Icon name="trash" style={{ width: 18, height: 18 }} />
            <span>{deleteLabel}</span>
          </button>
        </div>
      )}

      <TabBar active="library" />
    </div>
  );
}
