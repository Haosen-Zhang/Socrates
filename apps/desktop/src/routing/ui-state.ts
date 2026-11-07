import type { RoomCollaborationSettings, RoutingPreset } from "@socrates/core";

/** Legacy rooms have no inferred preset until the user chooses one. */
export function routingPreset(settings: RoomCollaborationSettings): RoutingPreset | null {
  if (settings.assignment.routing.mode === "manual") return "custom";
  if (settings.strategy !== "adaptive") return null;
  return settings.assignment.routing.automaticPolicy === "cost" ? "economy" : settings.assignment.routing.automaticPolicy;
}

export function applyRoutingPreset(settings: RoomCollaborationSettings, preset: RoutingPreset, primaryAgentId: string): RoomCollaborationSettings {
  return {
    ...settings,
    strategy: preset === "custom" ? settings.strategy === "team" ? "team" : "single" : "adaptive",
    assignment: { ...settings.assignment,
      coordinatorAgentId: settings.assignment.coordinatorAgentId ?? primaryAgentId,
      routing: { ...settings.assignment.routing,
        mode: preset === "custom" ? "manual" : "automatic",
        automaticPolicy: preset === "economy" ? "cost" : preset === "custom" ? settings.assignment.routing.automaticPolicy : preset,
      },
    },
    discussion: { ...settings.discussion, enabled: false },
  };
}

/** The legacy empty pool means all current room members. Never serialize an
 * empty list when the user's intention was to deselect the last member. */
export function toggleCallableMember(configured: string[], memberIds: string[], id: string, selected: boolean): string[] {
  const effective = configured.length ? configured : memberIds;
  const next = selected ? [...new Set([...effective, id])] : effective.filter(value => value !== id);
  if (!next.length) throw new Error("route_keep_one_member");
  return next;
}

export function toggleExplicitMember(configured: string[], id: string, selected: boolean): string[] {
  return selected ? [...new Set([...configured, id])] : configured.filter(value => value !== id);
}
