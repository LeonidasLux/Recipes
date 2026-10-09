import { useEffect } from 'react';
import { SourceBadge } from './Bits';
import { Cover } from './Photo';
import { Icon } from './Icons';
import { initial } from '../data/helpers';
import type { DB, OrderItem } from '../data/types';

/**
 * 掌勺页点一道菜弹出来的详情：能看清这道菜长什么样、谁发的、我记过什么备注、原文在哪。
 *
 * 点遮罩、点右上角 × 、按 Esc 都能关掉。临时加的菜（点单时手输的）菜谱库里没有，
 * 就只显示菜名 + 一句说明，不硬凑一个「查看原文」。
 */
export function DishSheet({ item, db, onClose }: { item: OrderItem; db: DB; onClose: () => void }) {
  const recipe = db.recipes.find((r) => r.id === item.recipeId) ?? null;

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="dishsheet" role="dialog" aria-modal="true" aria-label={`${item.dishName} · 菜品详情`}>
      <button type="button" className="ds-mask" aria-label="关闭菜品详情" onClick={onClose} />

      <div className="card sticker ds-card">
        <button type="button" className="ds-close" aria-label="关闭" onClick={onClose}>
          <Icon name="x" />
        </button>

        <div className="ds-hero">
          {recipe && (recipe.image || recipe.art) ? (
            <Cover image={recipe.image} art={recipe.art} title={item.dishName} fetch />
          ) : (
            <span className="mono-fallback">{initial(item.dishName)}</span>
          )}
        </div>

        {recipe ? (
          <>
            <div className="ds-meta">
              <SourceBadge source={recipe.source} />
              {recipe.author.trim() !== '' && (
                <>
                  <span className="meta">{recipe.author}</span>
                  <span className="meta">·</span>
                </>
              )}
              <span className="meta">{recipe.updatedAt} 更新</span>
            </div>

            <h2 className="ds-title">{item.dishName}</h2>

            <div className="ds-note">
              <span className="meta">我的备注</span>
              <p className={recipe.note.trim() ? '' : 'empty'}>
                {recipe.note.trim() || '还没有备注。去菜谱详情里可以补一条。'}
              </p>
            </div>

            <a className="btn-sticker ds-link" href={recipe.url} target="_blank" rel="noreferrer">
              <Icon name="link" />
              查看原文
            </a>
          </>
        ) : (
          <>
            <h2 className="ds-title">{item.dishName}</h2>
            <p className="meta ds-manual">这道菜是点单时临时加的，菜谱库里没有它的做法。</p>
          </>
        )}
      </div>
    </div>
  );
}
