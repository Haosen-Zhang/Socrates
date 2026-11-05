import { useMemo } from "react";
import { AGENT_AVATARS, renderAgentAvatarSvg } from "@socrates/core";

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
  const imageSource = useMemo(() => {
    const svg = renderAgentAvatarSvg(src ?? "");
    return svg ? `data:image/svg+xml,${encodeURIComponent(svg)}` : src || AGENT_AVATARS[0];
  }, [src]);
  return (
    <span
      className={`pixel-avatar ${lively ? "pixel-avatar--lively" : ""}`}
      style={{ width: size, height: size }}
      title={label}
    >
      <img src={imageSource} alt={label} style={{ imageRendering: src?.startsWith("data:image/") ? "auto" : "pixelated" }} />
    </span>
  );
}
