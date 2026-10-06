import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useStore } from '../data/store';
import { useSync } from '../lib/useSync';
import { TabBar, usePreviewState } from '../components/TabBar';
import { LiveSyncPill } from '../components/LiveSyncPill';
import { SkeletonRows, SourceBadge, StateCard, Thumb } from '../components/Bits';
import { Icon } from '../components/Icons';
import { preserveTypedValue } from '../lib/inputs';
import { todayLine } from '../data/helpers';
import type { SourceKey } from '../data/types';

const FILTERS: Array<{ key: SourceKey | 'all'; label: string }> = [
  { key: 'all', label: '全部' },
  { key: 'red', label: '小红书' },
  { key: 'bili', label: 'B站' },
  { key: 'douyin', label: '抖音' },
];

export default function Library() {
  const { db } = useStore();
  const sync = useSync();
  const preview = usePreviewState();

  const [active, setActive] = useState<SourceKey | 'all'>('all');
  const [q, setQ] = useState('');
  const [loading, setLoading] = useState(true);

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

  return (
    <div className="app s-library">
      <header className="topbar">
        <p className="greeting">{todayLine()}</p>
        <div className="navrow">
          <h1 className="ptitle" style={{ margin: 0 }}>
            我的菜谱库
          </h1>
          <LiveSyncPill />
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
                {list.map((r) => (
                  <Link className="dishrow" key={r.id} to={`/recipe/${r.id}`}>
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
                    <span className="when meta">{r.updatedAt}</span>
                  </Link>
                ))}
              </div>
            </>
          )}
        </section>
      </main>

      <TabBar active="library" />
    </div>
  );
}
