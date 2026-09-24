import { useSyncExternalStore } from "react";
import { Icon } from "./icons";
import { Button } from "./primitives";

export interface Toast {
  id: number;
  title: string;
  description?: string;
  action?: { label: string; onClick: () => void };
}

let toasts: Toast[] = [];
let seq = 0;
const listeners = new Set<() => void>();
const emit = () => {
  for (const l of listeners) l();
};

export function toast(t: Omit<Toast, "id">, durationMs = 4000) {
  const id = ++seq;
  toasts = [...toasts, { ...t, id }].slice(-4);
  emit();
  setTimeout(() => dismissToast(id), durationMs);
}

export function dismissToast(id: number) {
  toasts = toasts.filter((t) => t.id !== id);
  emit();
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
const snapshot = () => toasts;

export function Toaster({ closeLabel = "Close" }: { closeLabel?: string }) {
  const list = useSyncExternalStore(subscribe, snapshot, snapshot);
  return (
    <div className="toasts" data-surface="elevated">
      {list.map((t) => (
        <div key={t.id} className="toast" role="status">
          <span className="toast__icon">
            <Icon name="check" size={11} />
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="toast__title">{t.title}</div>
            {t.description && <div className="toast__desc">{t.description}</div>}
          </div>
          {t.action && (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                t.action?.onClick();
                dismissToast(t.id);
              }}
            >
              {t.action.label}
            </Button>
          )}
          <Button
            size="sm"
            variant="muted"
            iconOnly
            icon={<Icon name="x" size={12} />}
            onClick={() => dismissToast(t.id)}
            aria-label={closeLabel}
          />
        </div>
      ))}
    </div>
  );
}
