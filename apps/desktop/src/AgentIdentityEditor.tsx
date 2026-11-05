import { useEffect, useRef, useState } from "react";
import {
  AGENT_AVATAR_ACCEPT, AGENT_AVATARS, isAgentAvatarSource,
  isGeneratedAgentAvatar, randomAgentAvatar, randomUniqueAgentIdentity,
  type AgentIdentity, type AgentNameLanguage,
} from "@socrates/core";
import AgentAvatar from "./AgentAvatar";
import { validateAvatarUpload } from "./agentAvatarUpload";
import { useT } from "./store";
import { useStorePick } from "./selectors";

const choices = () => Array.from({ length: 12 }, () => randomAgentAvatar());

export default function AgentIdentityEditor({ nickname, avatar, existingNicknames, duplicateNickname, onChange, onError, onUploadPending }: {
  nickname: string;
  avatar: string;
  existingNicknames: string[];
  duplicateNickname: boolean;
  onChange: (identity: Partial<AgentIdentity>) => void;
  onError: (error: string | null) => void;
  onUploadPending: (pending: boolean) => void;
}) {
  const t = useT();
  const { lang } = useStorePick("lang");
  const [nameLanguage, setNameLanguage] = useState<AgentNameLanguage>(lang);
  const [style, setStyle] = useState<"generated" | "originals">("generated");
  const [suggestions, setSuggestions] = useState(() =>
    [...(isGeneratedAgentAvatar(avatar) ? [avatar] : []), ...choices()].slice(0, 12),
  );
  const input = useRef<HTMLInputElement>(null);
  const uploadVersion = useRef(0);
  useEffect(() => () => { uploadVersion.current++; onUploadPending(false); }, [onUploadPending]);
  const generated = isGeneratedAgentAvatar(avatar) && !suggestions.includes(avatar)
    ? [avatar, ...suggestions].slice(0, 12)
    : suggestions;
  const avatars = style === "generated" ? generated : AGENT_AVATARS;
  const isUpload = avatar.startsWith("data:image/");

  const selectAvatar = (next: string) => {
    uploadVersion.current++;
    onUploadPending(false);
    onChange({ avatar: next });
    onError(null);
  };
  const shuffleName = (language = nameLanguage) => {
    const identity = randomUniqueAgentIdentity([...existingNicknames, nickname], Math.random, language);
    onChange({ nickname: identity.nickname });
    onError(null);
  };
  const upload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    const version = ++uploadVersion.current;
    const fail = (message: string) => {
      if (version !== uploadVersion.current) return;
      onUploadPending(false);
      onError(message);
    };
    const validation = validateAvatarUpload(file);
    if (validation) {
      fail(t(validation === "size" ? "avatar_too_large" : "avatar_invalid_format"));
      return;
    }
    onUploadPending(true);
    onError(null);
    const reader = new FileReader();
    reader.onerror = () => fail(t("avatar_read_failed"));
    reader.onload = () => {
      const source = reader.result;
      if (typeof source !== "string" || !isAgentAvatarSource(source)) {
        fail(t("avatar_invalid_format"));
        return;
      }
      // Decode as an image before saving: a MIME label alone is not a valid image.
      const image = new Image();
      image.onerror = () => fail(t("avatar_read_failed"));
      image.onload = () => {
        if (version !== uploadVersion.current) return;
        onChange({ avatar: source });
        onUploadPending(false);
        onError(null);
      };
      image.src = source;
    };
    reader.readAsDataURL(file);
  };

  return (
    <div className="pixel-identity-panel persona-editor p-4">
      <div className="persona-editor__preview">
        <AgentAvatar src={avatar} label={nickname} size={104} lively={false} />
        <span className="text-xs text-neutral-500">{t(isUpload ? "avatar_custom" : "avatar_preview")}</span>
      </div>
      <div className="min-w-0 space-y-3">
        <label className="block text-sm">
          {t("nickname")}
          <input className="pixel-input w-full px-3 py-2 text-sm" required aria-invalid={duplicateNickname}
            value={nickname} onChange={event => { onChange({ nickname: event.target.value }); onError(null); }} />
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <select className="pixel-input px-2 py-1.5 text-xs" aria-label={t("name_language")} value={nameLanguage}
            onChange={event => { const language = event.target.value as AgentNameLanguage; setNameLanguage(language); shuffleName(language); }}>
            <option value="en">English</option>
            <option value="zh-CN">简体中文</option>
            <option value="zh-TW">繁體中文</option>
          </select>
          <button type="button" className="pixel-button px-3 py-1.5 text-xs" onClick={() => shuffleName()}>↻ {t("shuffle_name")}</button>
          <span className="text-xs text-neutral-500">{t("identity_hint")}</span>
        </div>
        {duplicateNickname && <p role="alert" className="text-xs text-red-700">{t("nickname_duplicate")}</p>}
        <div className="persona-editor__toolbar">
          <div className="flex gap-1" role="group" aria-label={t("avatar_style")}>
            {(["generated", "originals"] as const).map(value => (
              <button key={value} type="button" className="pixel-button px-2 py-1 text-xs" aria-pressed={style === value} onClick={() => setStyle(value)}>
                {t(value === "generated" ? "avatar_generated" : "avatar_originals")}
              </button>
            ))}
          </div>
          <button type="button" className="pixel-button px-2 py-1 text-xs" onClick={() => {
            const next = choices(); setSuggestions(next); setStyle("generated"); selectAvatar(next[0]);
          }}>↻ {t("avatar_generate")}</button>
        </div>
        <div className="persona-avatar-grid" role="group" aria-label={t("avatar_choices")}>
          {avatars.map((source, index) => (
            <button key={source} type="button" className={`pixel-avatar-choice ${source === avatar ? "is-selected" : ""}`}
              aria-label={t("avatar_choice", { number: index + 1 })} aria-pressed={source === avatar} onClick={() => selectAvatar(source)}>
              <AgentAvatar src={source} label="" size={42} lively={false} />
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className="pixel-button px-3 py-1.5 text-xs" aria-pressed={isUpload}
            onClick={() => input.current?.click()}>↑ {t("avatar_upload")}</button>
          <span className="text-xs text-neutral-500">{t("avatar_upload_hint")}</span>
          <input ref={input} className="sr-only" type="file" tabIndex={-1} aria-hidden="true" accept={AGENT_AVATAR_ACCEPT} onChange={upload} />
        </div>
      </div>
    </div>
  );
}
