import type { CSSProperties } from 'react';
import { Icon } from './Icons';

/**
 * 长按条目弹出的删除气泡。
 *
 * 视觉：气泡贴在**条目的右上角**，左下角伸出一个尖角指向条目（`.tip::after`）。
 * 条目上方放不下时（比如列表滚到最顶上）才翻到条目下方，尖角跟着掉头朝上。
 * 菜谱库 / 今日点单 / 今日菜单三处共用这一套，位置和样子完全一致。
 */

export interface DeleteTipState {
  id: string;
  title: string;
  /** 定位到条目的右上角：用 right + bottom 双锚定，不依赖气泡自身尺寸 */
  style: CSSProperties;
  /** 上方空间不够，翻到条目下方（尖角朝上） */
  below: boolean;
}

/** 气泡大致占用的竖向空间：按钮高度 + 尖角 + 间隙，用来判断要不要翻到下方 */
const TIP_SPACE = 64;

/** 按条目的位置算出气泡该贴哪儿（默认右上角） */
export function anchorDeleteTip(el: HTMLElement, id: string, title: string): DeleteTipState {
  const rect = el.getBoundingClientRect();
  const right = Math.max(8, window.innerWidth - rect.right);
  const below = rect.top < TIP_SPACE;
  const style: CSSProperties = below
    ? { right, top: rect.bottom + 8 }
    : { right, bottom: window.innerHeight - rect.top + 8 };
  return { id, title, style, below };
}

export function DeleteTip({
  tip,
  onDelete,
  onClose,
}: {
  tip: DeleteTipState;
  onDelete: () => void;
  onClose: () => void;
}) {
  return (
    <>
      <button type="button" className="tip-mask" aria-label="收起删除提示" onClick={onClose} />
      <div className={`tip${tip.below ? ' below' : ''}`} role="tooltip" style={tip.style}>
        <button
          type="button"
          className="tip-del"
          aria-label={`删除「${tip.title}」`}
          onClick={onDelete}
        >
          <Icon name="trash" />
          删除
        </button>
      </div>
    </>
  );
}
