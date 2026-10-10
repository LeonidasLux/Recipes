import type { ComponentProps } from 'react';
import { Icon } from './Icons';

/** 清空按钮那点共用属性 */
type ClearProps = {
  /** 点右端那枚 × 时调用：把这格的值清掉 */
  onClear: () => void;
  /** 读屏用的名字，默认「清空」 */
  clearLabel?: string;
};

/**
 * 内容输入格右端的「一键清空」：**格子有内容时才出现**，点一下把这格清空。
 *
 * 全应用要打字的地方都走这里 —— text / password / url 用 `ClearInput`，
 * 做法、备注、粘贴的分享文案这类多行输入用 `ClearArea`。
 * （原来只有菜谱库与点单挑选网格那两处搜索框自带清除按钮，别处只能一个字符一个字符删。）
 *
 * 外面那层 `.clearwrap` 只负责给按钮定位：贴的是**输入框自己的盒子**，
 * 不是外层的 `.field`（那个盒子还含 label 与错误提示，居中会跑偏）。
 * 所以「label + 输入框」的结构没变，各处的既有输入样式照旧生效。
 */
export function ClearInput({
  value,
  onClear,
  clearLabel = '清空',
  ...rest
}: Omit<ComponentProps<'input'>, 'value'> & { value: string } & ClearProps) {
  return (
    <span className="clearwrap">
      <input value={value} {...rest} />
      {value !== '' && <ClearX label={clearLabel} onClear={onClear} />}
    </span>
  );
}

/** 多行输入格：按钮贴右上角，跟第一行文字平齐（居中会落在两行中间） */
export function ClearArea({
  value,
  onClear,
  clearLabel = '清空',
  ...rest
}: Omit<ComponentProps<'textarea'>, 'value'> & { value: string } & ClearProps) {
  return (
    <span className="clearwrap">
      <textarea value={value} {...rest} />
      {value !== '' && <ClearX label={clearLabel} onClear={onClear} top />}
    </span>
  );
}

function ClearX({ label, onClear, top = false }: { label: string; onClear: () => void; top?: boolean }) {
  return (
    <button
      type="button"
      className={top ? 'clearx top' : 'clearx'}
      aria-label={label}
      title={label}
      /* 别把焦点从输入框上抢走：清空之后光标还在原处，手机上软键盘也不会收起来 */
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClear}
    >
      <Icon name="x" />
    </button>
  );
}
