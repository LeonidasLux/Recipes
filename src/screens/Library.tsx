import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useStore } from '../data/store';
import { useToast } from '../components/Toast';
import { useSync } from '../lib/useSync';
import { TabBar, usePreviewState } from '../components/TabBar';
import { SkeletonRows, SourceBadge, StateCard, Thumb } from '../components/Bits';
import { Icon } from '../components/Icons';
import { anchorDeleteTip, DeleteTip, type DeleteTipState } from '../components/DeleteTip';
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

export default function Library() {
  const { db, deleteRecipe } = useStore();
  const sync = useSync();
  const { toast } = useToast();
  const preview = usePreviewState();

  const [active, setActive] = useState<SourceKey | 'all'>('all');
  const [q, setQ] = useState('');
  const [loading, setLoading] = useState(true);
  /* 长按某条菜谱 → 在这条旁边弹一个小 tooltip，里面有删除 */
  const [tip, setTip] = useState<DeleteTipState | null>(null);
  const pressTimer = useRef<number | null>(null);
  const longPressed = useRef(false);

  /* 长按弹出的删除提示是遮罩：手机返回键先收起它，而不是退出应用 */
  useBackClose(tip !== null, closeTip);

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
    return db.recipes.filter((r) => {
      if (active !== 'all' && r.source !== active) return false;
      if (!lq) return true;
      return `${r.title} ${r.note} ${r.author}`.toLowerCase().includes(lq);
    });
  }, [db.recipes, active, q]);

  const searching = q.trim().length > 0;

  function retry() {
    setLoading(true);
    void sync.pull();
    window.setTimeout(() => setLoading(false), 700);
  }

  /* ─── 长按删除 ─────────────────────────────────
     按下开始计时（450ms），松手 / 划走 / 滚动就取消 —— 普通点按还是进详情。
     长按弹出后，紧随其后的那次 click 要吞掉，不然会顺带跳进详情页。 */
  function cancelPress() {
    if (pressTimer.current !== null) {
      window.clearTimeout(pressTimer.current);
      pressTimer.current = null;
    }
  }

  function startPress(el: HTMLElement, r: Recipe) {
    longPressed.current = false;
    cancelPress();
    pressTimer.current = window.setTimeout(() => {
      pressTimer.current = null;
      longPressed.current = true;
      setTip(anchorDeleteTip(el, r.id, r.title));
    }, 450);
  }

  function closeTip() {
    longPressed.current = false;
    setTip(null);
  }

  function removeRecipe(id: string, title: string) {
    deleteRecipe(id);
    closeTip();
    toast(`已删除「${title}」`);
  }

  return (
    <div className="app s-library">
      <header className="topbar">
        <p className="greeting">{todayLine()}</p>
        <div className="navrow">
          <h1 className="ptitle" style={{ margin: 0 }}>
            我的菜谱库
          </h1>
        </div>
      </header>

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

      <main className="scroll" onScroll={closeTip}>
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
                {list.map((r) => (
                  <Link
                    className="dishrow"
                    key={r.id}
                    to={`/recipe/${r.id}`}
                    onPointerDown={(e) => startPress(e.currentTarget, r)}
                    onPointerUp={cancelPress}
                    onPointerLeave={cancelPress}
                    onPointerCancel={cancelPress}
                    onClick={(e) => {
                      if (!longPressed.current) return;
                      /* 长按已经弹了删除提示，这一次 click 不算「点开详情」，
                         但提示要留着 —— 用户还得点里面的删除 */
                      longPressed.current = false;
                      e.preventDefault();
                      e.stopPropagation();
                    }}
                  >
                    <span className="thumb">
                      <Thumb art={r.art || null} title={r.title} />
                    </span>
                    <span className="body">
                      <span className="title">{r.title}</span>
                      <span style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                        <SourceBadge source={r.source} />
                        {r.note && (
                          <span className="note" style={{ flex: 1 }}>
                            {r.note}
                          </span>
                        )}
                      </span>
                    </span>
                  </Link>
                ))}
              </div>
            </>
          )}
        </section>
      </main>

      {tip && <DeleteTip tip={tip} onDelete={() => removeRecipe(tip.id, tip.title)} onClose={closeTip} />}

      <TabBar active="library" />
    </div>
  );
}
