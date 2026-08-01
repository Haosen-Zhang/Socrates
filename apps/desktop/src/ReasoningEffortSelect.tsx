import type { ReasoningEffort, ReasoningProfile } from "@socrates/core";
import PixelIcon from "./PixelIcon";
import { useT } from "./store";

const FAMILY_LABELS: Record<ReasoningProfile["family"], string> = {
  openai: "OpenAI",
  deepseek: "DeepSeek",
  anthropic: "Claude",
  gemini: "Gemini",
  qwen: "Qwen",
  kimi: "Kimi",
  glm: "GLM",
  grok: "Grok",
  llama: "Llama",
  mistral: "Mistral",
  custom: "Custom",
};

export default function ReasoningEffortSelect({
  profile,
  value,
  onChange,
}: {
  profile: ReasoningProfile;
  value: ReasoningEffort;
  onChange: (effort: ReasoningEffort) => void;
}) {
  const t = useT();
  return (
    <label className="reasoning-effort-field md:col-span-2">
      <span className="reasoning-effort-field__heading">
        <span><PixelIcon name="brain" size={17} />{t("reasoning_effort")}</span>
        <span className="pixel-chip">{FAMILY_LABELS[profile.family]}</span>
      </span>
      <span className="reasoning-effort-field__control">
        <select
          className="pixel-input w-full px-3 py-2 text-sm"
          required
          value={value}
          onChange={(event) => onChange(event.target.value as ReasoningEffort)}
        >
          {profile.efforts.map((effort) => (
            <option key={effort} value={effort}>{t(`reasoning_effort_${effort}`)}</option>
          ))}
        </select>
      </span>
      <span className="reasoning-effort-field__hint">
        {t("reasoning_profile_hint", { family: FAMILY_LABELS[profile.family] })}
      </span>
    </label>
  );
}
