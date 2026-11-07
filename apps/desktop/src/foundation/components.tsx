import { useId, type ReactNode } from "react";

export type ObjectPageProps = {
  title: string;
  eyebrow?: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
};

export function ObjectPage({ title, eyebrow, description, actions, children, className = "" }: ObjectPageProps) {
  const titleId = useId();
  return (
    <section className={`foundation-object-page ${className}`} aria-labelledby={titleId}>
      <header className="foundation-object-page__header">
        <div className="foundation-object-page__heading">
          {eyebrow && <div className="pixel-kicker">{eyebrow}</div>}
          <h1 id={titleId}>{title}</h1>
          {description && <p>{description}</p>}
        </div>
        {actions && <div className="foundation-object-page__actions">{actions}</div>}
      </header>
      <div className="foundation-object-page__content">{children}</div>
    </section>
  );
}

export type StatusBadgeProps = {
  children: ReactNode;
  tone?: "neutral" | "info" | "success" | "warning" | "danger";
  source?: string;
};

export function StatusBadge({ children, tone = "neutral", source }: StatusBadgeProps) {
  return (
    <span className="foundation-status-badge" data-tone={tone} title={source}>
      {children}
      {source && <span className="foundation-sr-only"> ({source})</span>}
    </span>
  );
}

export type ActivityItem = { id: string; title: string; description?: string; timestamp?: string };

export function ActivityTimeline({ items }: { items: readonly ActivityItem[] }) {
  return (
    <ol className="foundation-activity-timeline">
      {items.map((item) => (
        <li key={item.id}>
          <div className="foundation-activity-timeline__heading">
            <strong>{item.title}</strong>
            {item.timestamp && <time dateTime={item.timestamp}>{item.timestamp}</time>}
          </div>
          {item.description && <p>{item.description}</p>}
        </li>
      ))}
    </ol>
  );
}

export type EmptyStateProps = { title: string; description?: string; action?: ReactNode };

export function EmptyState({ title, description, action }: EmptyStateProps) {
  const titleId = useId();
  return (
    <section className="pixel-empty foundation-empty-state" aria-labelledby={titleId}>
      <h3 id={titleId}>{title}</h3>
      {description && <p>{description}</p>}
      {action && <div className="foundation-empty-state__action">{action}</div>}
    </section>
  );
}

export type ErrorNoticeProps = { message: string; onRetry?: () => void; retryLabel?: string };

export function ErrorNotice({ message, onRetry, retryLabel }: ErrorNoticeProps) {
  return (
    <div className="foundation-error-notice" role="alert">
      <p>{message}</p>
      {onRetry && retryLabel && <button type="button" className="pixel-button foundation-button" onClick={onRetry}>{retryLabel}</button>}
    </div>
  );
}

export function LoadingState({ label }: { label: string }) {
  return (
    <div className="foundation-loading-state" role="status" aria-live="polite" aria-busy="true">
      <span className="foundation-loading-state__indicator" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}
