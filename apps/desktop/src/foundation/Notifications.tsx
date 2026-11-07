import { Toast } from "@base-ui/react/toast";

const manager = Toast.createToastManager();

/** Call only after an authoritative operation has succeeded. */
export function notify(title: string): void {
  manager.add({ title, priority: "low" });
}

function NotificationItems({ closeLabel, label }: { closeLabel: string; label?: string }) {
  const { toasts } = Toast.useToastManager();
  return (
    <Toast.Viewport className="foundation-notifications" {...(label ? { "aria-label": label } : {})}>
      {toasts.map((toast) => (
        <Toast.Root key={toast.id} toast={toast} className="foundation-notification">
          <Toast.Title className="foundation-notification__title">{toast.title}</Toast.Title>
          <Toast.Close className="foundation-notification__close" aria-label={closeLabel} aria-hidden={false}>×</Toast.Close>
        </Toast.Root>
      ))}
    </Toast.Viewport>
  );
}

export function Notifications({ closeLabel, label }: { closeLabel: string; label?: string }) {
  return (
    <Toast.Provider toastManager={manager} timeout={4000} limit={3}>
      <NotificationItems closeLabel={closeLabel} label={label} />
    </Toast.Provider>
  );
}
