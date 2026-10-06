import type { CompositionEvent, FocusEvent } from 'react';

type Field = HTMLInputElement | HTMLTextAreaElement;

/**
 * 文本输入框的「以 DOM 为准」兜底。
 *
 * 手机浏览器 / Android WebView 上，输入框的最终内容未必会补一次 `input` 事件：
 *   · 中文输入法提交候选词时可能只发 compositionend；
 *   · 键盘的自动更正 / 自动填充也可能把值直接落进 DOM。
 * React 的受控 value 因此拿不到刚打进去的字，失焦时还会把 DOM 回写成 state
 * 里的旧值 —— 用户看到的是「刚填完，一失焦内容就没了」，或者框里明明有字、
 * 点保存写回去的却是旧值。
 *
 * 返回的两个处理器都在关键节点拿 DOM 里的**真实值**同步一次 state：
 *   · onCompositionEnd —— 候选词一提交就落库，不指望后面那次 input
 *   · onBlur —— 失焦前最后确认一次（此刻 DOM 里就是用户看到的内容）
 *
 * apply 要与该输入框 onChange 的写法一致（trim / normalize 等一并带上），
 * onBlurExtra 用来保留原有的失焦校验。
 *
 * 用法：<input value={v} onChange={...} {...preserveTypedValue(setV)} />
 */
export function preserveTypedValue(apply: (value: string) => void, onBlurExtra?: (value: string) => void) {
  return {
    onCompositionEnd: (e: CompositionEvent<Field>) => apply(e.currentTarget.value),
    onBlur: (e: FocusEvent<Field>) => {
      const value = e.currentTarget.value;
      apply(value);
      onBlurExtra?.(value);
    },
  };
}
