import { useMemo, type ReactNode } from 'react';
import { Icon, type IconName } from './Icons';
import { Cover } from './Photo';
import { srcMeta, statusMeta } from '../data/helpers';
import { localStorageBroken } from '../lib/storage';
import type { OrderStatus, SourceKey } from '../data/types';

/* ─── 骨架屏 ─────────────────────────────────── */

export function SkeletonRows({ n = 4 }: { n?: number }) {
  return (
    <>
      {Array.from({ length: n }, (_, i) => (
        <div className="sk-row" key={i}>
          <div className="sk sk-thumb" />
          <div style={{ minWidth: 0 }}>
            <div className="sk sk-line w60" />
            <div className="sk sk-line w40" />
          </div>
        </div>
      ))}
    </>
  );
}

/* ─── 来源徽章 ───────────────────────────────── */

export function SourceBadge({ source, solid }: { source: SourceKey; solid?: boolean }) {
  const m = srcMeta(source);
  return (
    <span className={`src ${m.cls}${solid ? ' solid' : ''}`}>
      <i />
      {m.label}
    </span>
  );
}

/* ─── 状态 chip ──────────────────────────────── */

const STATUS_ICON: Record<OrderStatus, IconName> = {
  pending: 'clock',
  accepted: 'pot',
  done: 'check',
};

export function StatusChip({ status }: { status: OrderStatus }) {
  const m = statusMeta(status);
  return (
    <span className={`st ${m.cls}`}>
      <Icon name={STATUS_ICON[status]} />
      {m.label}
    </span>
  );
}

/* ─── 缩略图 / 首字占位 ──────────────────────── */

export function Thumb({
  art,
  image,
  title,
  alt,
}: {
  art: string | null;
  /** 菜谱照片的仓库路径；有缓存就显示照片，没有就退回插画 */
  image?: string;
  title: string;
  alt?: string;
}) {
  return <Cover image={image} art={art} title={alt ?? title} />;
}

/* ─── 五态占位卡 ─────────────────────────────── */

/**
 * 本机存不下数据时的提示（无痕模式 / 关浏览器就清站点数据）。
 *
 * token / 仓库 / DeepSeek Key 只在本机 localStorage 里，存不了就等于**每次
 * 进来都要重填** —— 这属于环境问题，不是应用忘了保存，得当场说清楚。
 * （另一种「换了地址就看不见数据」的情况在页面里无法判断，见 src/lib/storage.ts。）
 */
export function StorageWarning() {
  const blocked = useMemo(localStorageBroken, []);
  if (!blocked) return null;
  return (
    <div className="warnbanner" role="alert">
      <Icon name="alert" />
      <span>
        这个浏览器不让本站保存数据（无痕窗口，或开了「关闭浏览器时清除站点数据」）：
        token、仓库名、DeepSeek Key 每次进来都得重填。换个普通窗口打开，或把本站
        从「关闭时清理」的名单里去掉。
      </span>
    </div>
  );
}

interface StateCardProps {
  icon: IconName;
  title: string;
  desc: string;
  children?: ReactNode;
  className?: string;
}

export function StateCard({ icon, title, desc, children, className }: StateCardProps) {
  return (
    <div className={`card sticker statecard${className ? ` ${className}` : ''}`}>
      <div className="art">
        <Icon name={icon} />
      </div>
      <h2 className="h2">{title}</h2>
      <p className="desc">{desc}</p>
      {children}
    </div>
  );
}
