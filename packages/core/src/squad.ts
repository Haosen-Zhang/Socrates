/** A reusable project team; rooms retain the revision they explicitly applied. */
export interface SquadMember { agentId: string; responsibility: string }
export interface SquadTemplate {
  id: string;
  workspaceId: string;
  name: string;
  avatar: string | null;
  leaderAgentId: string;
  description: string;
  instructions: string;
  members: SquadMember[];
  activeWorkItemCount?: number;
  routingPreset?: "manual" | import("./routing").RoutingPreset;
  revision: number;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
}
export interface SquadRoomBinding { roomId: string; squadId: string; revision: number; bindingVersion: number; snapshot: SquadTemplate }
