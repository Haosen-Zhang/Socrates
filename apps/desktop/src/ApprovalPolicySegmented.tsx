import type { ToolApprovalMode } from "@socrates/core";
import type { ApprovalModeOption } from "./approvalPolicyUi";

export default function ApprovalPolicySegmented({
  value,
  options,
  labels,
  descriptions,
  onChange,
}: {
  value: ToolApprovalMode;
  options: ApprovalModeOption[];
  labels: Record<ToolApprovalMode, string>;
  descriptions: Record<ToolApprovalMode, string>;
  onChange: (mode: ToolApprovalMode) => void;
}) {
  return (
    <div className="approval-policy-segmented" data-active={value} role="radiogroup">
      <span className="approval-policy-segmented__thumb" aria-hidden />
      {options.map(({ mode, supported }) => (
        <button
          key={mode}
          type="button"
          className="approval-policy-segmented__option"
          role="radio"
          aria-checked={value === mode}
          aria-label={labels[mode]}
          title={descriptions[mode]}
          disabled={!supported}
          onClick={() => onChange(mode)}
        >
          {labels[mode]}
        </button>
      ))}
    </div>
  );
}
