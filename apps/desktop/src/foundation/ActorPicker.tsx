import { useId, type ReactNode } from "react";
import { Combobox } from "@base-ui/react/combobox";
import { useImeGuard, usePortalHost } from "./useFoundation";

export type ActorOption = {
  id: string;
  label: string;
  description?: string;
  avatar?: ReactNode;
  disabled?: boolean;
  disabledReason?: string;
};

export type ActorPickerProps = {
  label: string;
  actors: readonly ActorOption[];
  value: string | null;
  onChange: (id: string | null) => void;
  placeholder?: string;
  emptyLabel?: string;
};

export function ActorPicker({ label, actors, value, onChange, placeholder, emptyLabel }: ActorPickerProps) {
  const id = useId();
  const { container, anchorRef } = usePortalHost();
  const ime = useImeGuard();
  const { contains } = Combobox.useFilter();
  const selectedActor = actors.find((actor) => actor.id === value) ?? null;
  return (
    <div
      className="foundation-actor-picker"
      ref={anchorRef}
      onCompositionStart={ime.onCompositionStart}
      onCompositionEnd={ime.onCompositionEnd}
      onKeyDownCapture={ime.onKeyDownCapture}
    >
      <Combobox.Root<ActorOption>
        items={actors}
        value={selectedActor}
        itemToStringLabel={(actor) => actor.label}
        itemToStringValue={(actor) => actor.id}
        isItemEqualToValue={(actor, selected) => actor.id === selected.id}
        filter={(actor, query) => contains(`${actor.label} ${actor.description ?? ""}`, query)}
        autoHighlight
        onValueChange={(actor, details) => {
          if ((details.event instanceof KeyboardEvent && ime.isComposing(details.event)) || actor?.disabled) {
            details.cancel();
            return;
          }
          onChange(actor?.id ?? null);
        }}
        onOpenChange={(nextOpen, details) => {
          if (!nextOpen && details.reason === "escape-key" && ime.isComposing(details.event)) details.cancel();
        }}
      >
        <label htmlFor={id} className="foundation-field-label">{label}</label>
        <Combobox.InputGroup className="foundation-actor-picker__input-group">
          <Combobox.Input id={id} placeholder={placeholder} className="pixel-input foundation-actor-picker__input" autoComplete="off" />
          <Combobox.Trigger className="foundation-actor-picker__trigger" aria-label={label}>
            <span aria-hidden="true">▾</span>
          </Combobox.Trigger>
        </Combobox.InputGroup>
        <Combobox.Portal
          container={container}
          data-dialog-layer="nested"
          onMouseDown={(event) => event.stopPropagation()}
        >
          <Combobox.Positioner sideOffset={6} align="start" className="foundation-picker-positioner">
            <Combobox.Popup className="foundation-picker-popup">
              <Combobox.Empty className="foundation-picker-empty">{emptyLabel ?? placeholder ?? label}</Combobox.Empty>
              <Combobox.List className="foundation-picker-list">
                {(actor: ActorOption) => (
                  <Combobox.Item key={actor.id} value={actor} disabled={actor.disabled} className="foundation-picker-item">
                    {actor.avatar && <span className="foundation-picker-item__avatar" aria-hidden="true">{actor.avatar}</span>}
                    <span className="foundation-picker-item__text">
                      <span className="foundation-picker-item__label">{actor.label}</span>
                      {actor.description && <span className="foundation-picker-item__description">{actor.description}</span>}
                      {actor.disabledReason && <span className="foundation-picker-item__description">{actor.disabledReason}</span>}
                    </span>
                    <Combobox.ItemIndicator className="foundation-picker-item__selected" aria-hidden="true">✓</Combobox.ItemIndicator>
                  </Combobox.Item>
                )}
              </Combobox.List>
            </Combobox.Popup>
          </Combobox.Positioner>
        </Combobox.Portal>
      </Combobox.Root>
    </div>
  );
}
