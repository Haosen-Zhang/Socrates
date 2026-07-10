import { AGENT_AVATARS } from "@socrates/core";

export default function AgentAvatar({
  src,
  label,
  size = 48,
  lively = true,
}: {
  src?: string;
  label: string;
  size?: number;
  lively?: boolean;
}) {
  return (
    <span
      className={`pixel-avatar ${lively ? "pixel-avatar--lively" : ""}`}
      style={{ width: size, height: size }}
      title={label}
    >
      <img src={src ?? AGENT_AVATARS[0]} alt={label} />
    </span>
  );
}
