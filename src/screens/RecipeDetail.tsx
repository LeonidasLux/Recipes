import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useStore } from '../data/store';
import { useToast } from '../components/Toast';
import { SourceBadge, StateCard } from '../components/Bits';
import { Icon } from '../components/Icons';
import { artUrl, initial, recipeInOpenOrder } from '../data/helpers';
import { preserveTypedValue } from '../lib/inputs';

export default function RecipeDetail() {
  const { id = '' } = useParams();
  const { db, updateRecipeNote } = useStore();
  const { toast } = useToast();
  const navigate = useNavigate();

  const recipe = useMemo(() => db.recipes.find((r) => r.id === id) ?? db.recipes[0], [db.recipes, id]);

  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');

  useEffect(() => {
    const t = window.setTimeout(() => setLoading(false), 480);
    return () => window.clearTimeout(t);
  }, []);

  const inOpenOrder = recipe ? recipeInOpenOrder(db.orders, recipe.id) : null;

  function goBack() {
    if (window.history.length > 1) navigate(-1);
    else navigate('/library');
  }

  function startEdit() {
    setDraft(recipe?.note ?? '');
    setEditing(true);
  }

  function saveNote() {
    if (!recipe) return;
    updateRecipeNote(recipe.id, draft.trim());
    setEditing(false);
    toast('备注已保存并同步');
  }

  function openOrderWithThis() {
    if (!recipe) return;
    if (inOpenOrder) {
      toast('这道菜已经在今天的单里了', false);
      return;
    }
    navigate(`/order?add=${encodeURIComponent(recipe.id)}`);
  }

  if (!recipe) {
    return (
      <div className="app s-detail">
        <div className="sheetbar">
          <button className="icbtn ghost" aria-label="返回菜谱库" onClick={goBack} style={{ borderRadius: 16 }}>
            <Icon name="back" />
          </button>
          <h1 className="title" style={{ flex: 1, textAlign: 'center' }}>
            菜谱详情
          </h1>
          <span style={{ width: 44 }} />
        </div>
        <main className="scroll">
          <div className="pad" style={{ paddingTop: 20 }}>
            <StateCard icon="bag" title="这道菜不见了" desc="它可能已经被删掉，回菜谱库看看吧。">
              <Link className="btn-primary" to="/library">
                回菜谱库
              </Link>
            </StateCard>
          </div>
        </main>
      </div>
    );
  }

  const hasNote = recipe.note.trim().length > 0;

  return (
    <div className="app s-detail">
      <div className="sheetbar">
        <button className="icbtn ghost" aria-label="返回菜谱库" onClick={goBack} style={{ borderRadius: 16 }}>
          <Icon name="back" />
        </button>
        <h1 className="title" style={{ flex: 1, textAlign: 'center' }}>
          菜谱详情
        </h1>
        <span style={{ width: 44 }} />
      </div>

      <main className="scroll">
        {loading ? (
          <div className="pad stack" style={{ paddingTop: 6 }}>
            <div className="sk" style={{ aspectRatio: '4 / 3', borderRadius: 22 }} />
            <div className="sk sk-line w60" style={{ height: 16 }} />
            <div className="sk sk-line w40" />
            <div className="sk" style={{ height: 140, borderRadius: 20 }} />
          </div>
        ) : (
          <article>
            <section className="pad" style={{ paddingTop: 6 }}>
              <div className="heroimg">
                {recipe.art ? (
                  <img src={artUrl(recipe.art)} alt="菜谱封面" />
                ) : (
                  <span
                    className="mono-fallback"
                    style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', fontSize: 64 }}
                  >
                    {initial(recipe.title)}
                  </span>
                )}
              </div>
            </section>

            <section className="pad" style={{ paddingTop: 16 }}>
              <div className="meta-row">
                <SourceBadge source={recipe.source} />
                <span className="meta">{recipe.author}</span>
                <span className="meta">·</span>
                <span className="meta">{recipe.updatedAt} 更新</span>
              </div>
              <h1 className="ptitle" style={{ fontSize: 27, marginTop: 10 }}>
                {recipe.title}
              </h1>
            </section>

            <section className="pad" style={{ paddingTop: 14 }}>
              <div className="card linkcard sticker" style={{ padding: '12px 16px' }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 12, color: 'var(--muted)' }}>原文出处</div>
                  <div className="ellip" style={{ fontSize: 13, color: 'var(--fg)', marginTop: 1 }}>
                    {recipe.url}
                  </div>
                </div>
                <a className="btn-sticker" href={recipe.url} target="_blank" rel="noreferrer">
                  <Icon name="link" />
                  查看原文
                </a>
              </div>
            </section>

            <section className="pad" style={{ paddingTop: 14 }}>
              <div className="card sticker notecard" style={{ padding: 16 }}>
                <h3 style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', margin: '0 0 8px' }}>
                  <span>我的备注</span>
                  {/* 两个人谁都能改备注 —— 菜谱库这块不按角色区分 */}
                  {!editing && (
                    <button className="inlinebtn" onClick={startEdit}>
                      <Icon name="pencil" />
                      编辑
                    </button>
                  )}
                </h3>

                <div className={`viewmode${editing ? ' off' : ''}`}>
                  <p className={`note-text${hasNote ? '' : ' empty'}`}>
                    {hasNote
                      ? recipe.note
                      : '还没有备注。做过一次、踩了坑，或「辣椒减半」这种口味备忘，都可以记下来，随时能改。'}
                  </p>
                </div>

                <div className={`editrow${editing ? ' show' : ''}`}>
                  <textarea
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    {...preserveTypedValue(setDraft)}
                    placeholder="做法心得、替代食材、另一半的口味，都可以记在这里。"
                  />
                  <div className="row" style={{ justifyContent: 'flex-end' }}>
                    <button className="btn-sticker" onClick={() => setEditing(false)}>
                      取消
                    </button>
                    <button className="btn-sticker primary" onClick={saveNote}>
                      保存并同步
                    </button>
                  </div>
                </div>
              </div>
            </section>
            <div style={{ height: 8 }} />
          </article>
        )}
      </main>

      {/* 谁都能点单，所以「去点单」对两种身份都常驻 */}
      <div className="actionbar">
        <div className="stack" style={{ gap: 8 }}>
          <button className="btn-primary" onClick={openOrderWithThis} disabled={Boolean(inOpenOrder)}>
            <Icon name="cart" style={{ width: 18, height: 18 }} />
            <span>{inOpenOrder ? '已在今天单里' : '去点单 · 带上这道菜'}</span>
          </button>
          {inOpenOrder && (
            <p className="meta" style={{ textAlign: 'center', margin: 0 }}>
              <Link className="openlink" to="/order">
                已在今天单里 · 去点单查看 →
              </Link>
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
