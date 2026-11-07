import { memo, useId } from "react";
import { useT } from "../store";
import { nextWorkContext, WORK_CONTEXTS, type WorkContext } from "./workNavigation";

export default memo(function WorkContextBar({ context, project, onChange }: {
  context: WorkContext; project?: string; onChange: (context: WorkContext) => void;
}) {
  const t = useT(), id = useId();
  return <div className="work-context-bar">
    <div className="work-project-identity"><span className="pixel-kicker">WORK</span><strong>{project ?? t("work_project")}</strong></div>
    <div role="tablist" aria-label={t("work_context")}>
      {WORK_CONTEXTS.map(value => <button key={value} type="button" role="tab" id={`${id}-${value}`} aria-selected={context === value} tabIndex={context === value ? 0 : -1}
        onClick={() => onChange(value)} onKeyDown={event => {
          const next = nextWorkContext(value, event.key, event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229);
          if (!next) return;
          event.preventDefault(); onChange(next); document.getElementById(`${id}-${next}`)?.focus();
        }}>{t(`work_${value}`)}</button>)}
    </div>
  </div>;
});
