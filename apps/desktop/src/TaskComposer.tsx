import PixelIcon from "./PixelIcon";

type TaskComposerProps = {
  prompt: string;
  summary: string;
  running: boolean;
  title: string;
  settingsLabel: string;
  promptLabel: string;
  placeholder: string;
  startLabel: string;
  runningLabel: string;
  onPromptChange: (value: string) => void;
  onOpenSettings: () => void;
  onSubmit: () => void;
};

export default function TaskComposer({
  prompt,
  summary,
  running,
  title,
  settingsLabel,
  promptLabel,
  placeholder,
  startLabel,
  runningLabel,
  onPromptChange,
  onOpenSettings,
  onSubmit,
}: TaskComposerProps) {
  return (
    <form className="pixel-card space-y-4 p-4" onSubmit={(event) => { event.preventDefault(); onSubmit(); }}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="pixel-kicker">TASK</div>
          <h3 className="font-bold">{title}</h3>
          <p className="mt-1 text-xs text-neutral-500">{summary}</p>
        </div>
        <button type="button" className="pixel-button flex items-center gap-1 px-2 py-1 text-xs" onClick={onOpenSettings}>
          <PixelIcon name="gear" size={14} />{settingsLabel}
        </button>
      </div>
      <textarea
        aria-label={promptLabel}
        className="pixel-input min-h-28 w-full p-3 text-sm"
        value={prompt}
        onChange={(event) => onPromptChange(event.target.value)}
        placeholder={placeholder}
      />
      <button className="pixel-button pixel-button--primary px-4 py-2 text-sm" disabled={running || !prompt.trim()}>
        {running ? runningLabel : startLabel}
      </button>
    </form>
  );
}
