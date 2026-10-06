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
  const { db, updateRecipe, deleteRecipe } = useStore();
  const { toast } = useToast();
  const navigate = useNavigate();

  const recipe = useMemo(() => db.recipes.find((r) => r.id === id) ?? db.recipes[0], [db.recipes, id]);

  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [draft, setDraft] = useState({ title: '', url: '', steps: '', note: '' });

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
    if (!recipe) return;
    setDraft({ title: recipe.title, url: recipe.url, steps: recipe.steps, note: recipe.note });
    setEditing(true);
  }

  function saveEdit() {
    if (!recipe) return;
    const title = draft.title.trim();
    if (!title) {
      toast('菜名不能为空', false);
      return;
    }
    updateRecipe(recipe.id, {
      title,
      url: draft.url.trim(),
      steps: draft.steps.trim(),
      note: draft.note.trim(),
    });
    setEditing(false);
    toast('已保存并同步');
  }

  function removeRecipe() {
    if (!recipe) return;
    const title = recipe.title;
    deleteRecipe(recipe.id);
    toast(`已删除「${title}」`);
    navigate('/library');
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
        <button
          id="editRecipeBtn"
          className="inlinebtn"
          aria-pressed={editing}
          onClick={() => (editing ? setEditing(false) : startEdit())}
        >
          <Icon name={editing ? 'x' : 'pencil'} />
          {editing ? '取消' : '编辑'}
        </button>
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

            {editing ? (
              <section className="pad" style={{ paddingTop: 16 }}>
                <div className="card sticker notecard" style={{ padding: 16 }}>
                  <h3 style={{ margin: '0 0 10px' }}>编辑这道菜</h3>
                  <div className="editrow show">
                    <div className="field">
                      <label htmlFor="editTitle">菜名</label>
                      <input
                        id="editTitle"
                        type="text"
                        maxLength={18}
                        value={draft.title}
                        onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))}
                        {...preserveTypedValue((v) => setDraft((d) => ({ ...d, title: v })))}
                        placeholder="例如：番茄炖牛腩"
                      />
                    </div>
                    <div className="field">
                      <label htmlFor="editUrl">原文出处</label>
                      <input
                        id="editUrl"
                        type="url"
                        inputMode="url"
                        autoComplete="off"
                        spellCheck={false}
                        value={draft.url}
                        onChange={(e) => setDraft((d) => ({ ...d, url: e.target.value }))}
                        {...preserveTypedValue((v) => setDraft((d) => ({ ...d, url: v })))}
                        placeholder="https://…"
                      />
                    </div>
                    <div className="field">
                      <label htmlFor="editSteps">做法</label>
                      <textarea
                        id="editSteps"
                        value={draft.steps}
                        onChange={(e) => setDraft((d) => ({ ...d, steps: e.target.value }))}
                        {...preserveTypedValue((v) => setDraft((d) => ({ ...d, steps: v })))}
                        placeholder="一步一步写，换行分开就行。"
                      />
                    </div>
                    <div className="field">
                      <label htmlFor="editNote">我的备注</label>
                      <textarea
                        id="editNote"
                        value={draft.note}
                        onChange={(e) => setDraft((d) => ({ ...d, note: e.target.value }))}
                        {...preserveTypedValue((v) => setDraft((d) => ({ ...d, note: v })))}
                        placeholder="做法心得、替代食材、另一半的口味，都可以记在这里。"
                      />
                    </div>
                    <div className="row" style={{ justifyContent: 'flex-end' }}>
                      <button className="btn-sticker" onClick={() => setEditing(false)}>
                        取消
                      </button>
                      <button className="btn-sticker primary" onClick={saveEdit}>
                        保存并同步
                      </button>
                    </div>
                  </div>
                </div>
              </section>
            ) : (
              <>
                <section className="pad" style={{ paddingTop: 16 }}>
                  <div className="meta-row">
                    <SourceBadge source={recipe.source} />
                    <span className="meta">{recipe.author}</span>
                  </div>
                  <h1 className="ptitle" style={{ fontSize: 27, marginTop: 10 }}>
                    {recipe.title}
                  </h1>
                  {/* 收藏时间 / 更新时间只在这一页显示（列表页不显示时间） */}
                  <p className="meta" style={{ margin: '8px 0 0' }}>
                    收藏于 {recipe.createdAt} · 更新于 {recipe.updatedAt}
                  </p>
                </section>

                <section className="pad" style={{ paddingTop: 14 }}>
                  <div className="card linkcard sticker" style={{ padding: '12px 16px' }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 12, color: 'var(--muted)' }}>原文出处</div>
                      <div className="ellip" style={{ fontSize: 13, color: 'var(--fg)', marginTop: 1 }}>
                        {recipe.url || '没有填'}
                      </div>
                    </div>
                    {recipe.url && (
                      <a className="btn-sticker" href={recipe.url} target="_blank" rel="noreferrer">
                        <Icon name="link" />
                        查看原文
                      </a>
                    )}
                  </div>
                </section>

                <section className="pad" style={{ paddingTop: 14 }}>
                  {recipe.steps.trim() && (
                    <div className="card sticker notecard" style={{ padding: 16, marginBottom: 14 }}>
                      <h3 style={{ margin: '0 0 8px' }}>做法</h3>
                      <p className="steps-text">{recipe.steps}</p>
                    </div>
                  )}
                  <div className="card sticker notecard" style={{ padding: 16 }}>
                    <h3 style={{ margin: '0 0 8px' }}>我的备注</h3>
                    <div className="viewmode">
                      <p className={`note-text${hasNote ? '' : ' empty'}`}>
                        {hasNote
                          ? recipe.note
                          : '还没有备注。做过一次、踩了坑，或「辣椒减半」这种口味备忘，都可以记下来，随时能改。'}
                      </p>
                    </div>
                  </div>
                </section>

                <section className="pad" style={{ paddingTop: 18 }}>
                  <button
                    className="dang"
                    style={{ margin: '0 auto', display: 'block' }}
                    onClick={() => (confirmDelete ? removeRecipe() : setConfirmDelete(true))}
                    onBlur={() => setConfirmDelete(false)}
                  >
                    {confirmDelete ? '再点一次，确认删除这道菜' : '删除这道菜'}
                  </button>
                </section>
                <div style={{ height: 8 }} />
              </>
            )}
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
