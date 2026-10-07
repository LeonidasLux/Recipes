import type { ReactNode } from 'react';
import { Icon, type IconName } from './Icons';
import { artUrl, initial, srcColorVar, srcMeta, statusMeta } from '../data/helpers';
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

/** 网格里那个更小的内联来源点 */
export function SourceDot({ source }: { source: SourceKey }) {
  const m = srcMeta(source);
  return (
    <span className="s" style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2, display: 'flex', alignItems: 'center', gap: 4 }}>
      <i
        style={{
          width: 7,
          height: 7,
          borderRadius: '50%',
          background: srcColorVar(source),
          boxShadow: '0 0 0 1.5px color-mix(in oklch, currentColor 35%, transparent)',
          display: 'inline-block',
        }}
      />
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

export function Thumb({ art, title, alt }: { art: string | null; title: string; alt?: string }) {
  if (art) {
    return <img src={artUrl(art)} alt={alt ?? title} loading="lazy" />;
  }
  return <span className="mono">{initial(title)}</span>;
}

/* ─── 五态占位卡 ─────────────────────────────── */

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
