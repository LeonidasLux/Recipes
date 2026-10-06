import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { Icon } from './Icons';

interface ToastItem {
  id: number;
  msg: string;
  ok: boolean;
  show: boolean;
}

interface ToastValue {
  toast(msg: string, ok?: boolean): void;
}

const ToastCtx = createContext<ToastValue | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const seq = useRef(0);
  const timers = useRef<number[]>([]);

  useEffect(() => {
    const list = timers.current;
    return () => list.forEach((t) => window.clearTimeout(t));
  }, []);

  const toast = useCallback((msg: string, ok = true) => {
    const id = ++seq.current;
    setItems((prev) => [...prev.slice(-2), { id, msg, ok, show: false }]);

    const t1 = window.setTimeout(() => {
      setItems((prev) => prev.map((x) => (x.id === id ? { ...x, show: true } : x)));
    }, 16);
    const t2 = window.setTimeout(() => {
      setItems((prev) => prev.map((x) => (x.id === id ? { ...x, show: false } : x)));
    }, 1700);
    const t3 = window.setTimeout(() => {
      setItems((prev) => prev.filter((x) => x.id !== id));
    }, 1950);

    timers.current.push(t1, t2, t3);
  }, []);

  return (
    <ToastCtx.Provider value={{ toast }}>
      {children}
      {items.map((it) => (
        <div
          key={it.id}
          className={`toast${it.ok ? ' ok' : ''}${it.show ? ' show' : ''}`}
          role="status"
          aria-live="polite"
        >
          <Icon name={it.ok ? 'check' : 'alert'} />
          <span>{it.msg}</span>
        </div>
      ))}
    </ToastCtx.Provider>
  );
}

export function useToast(): ToastValue {
  const v = useContext(ToastCtx);
  if (!v) throw new Error('useToast 必须在 <ToastProvider> 内使用');
  return v;
}
