import { useLayoutEffect, useRef, type ReactNode } from "react";

const positions = new Map<string, { top: number; follow: boolean }>();
/** Preserve reading position; only follow a live turn while already at the bottom. */
export default function RoomTimeline({
  roomId,
  children,
  className,
}: {
  roomId: string;
  children: ReactNode;
  className: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const saved = positions.get(roomId);
    follow.current = saved?.follow ?? true;
    node.scrollTop = saved?.top ?? node.scrollHeight;
  }, [roomId]);
  useLayoutEffect(() => {
    const node = ref.current;
    if (node && follow.current) node.scrollTop = node.scrollHeight;
  }, [children]);
  return (
    <div
      ref={ref}
      className={className}
      onScroll={(event) => {
        const node = event.currentTarget;
        follow.current =
          node.scrollHeight - node.scrollTop - node.clientHeight < 80;
        positions.set(roomId, { top: node.scrollTop, follow: follow.current });
      }}
    >
      {children}
    </div>
  );
}
