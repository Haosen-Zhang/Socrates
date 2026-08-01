import type {
  WorkspaceDirectoryListing,
  WorkspaceFilePreview,
  WorkspaceGitDiff,
  WorkspaceGitStatus,
} from "@socrates/core";
import { requireOk, sidecarFetch, type Handshake } from "../transport";

function query(path: string): string {
  return encodeURIComponent(path);
}

export const workspaceInspectionClient = {
  list(hs: Handshake, workspaceId: string, path = "") {
    return sidecarFetch(hs, `/content/workspaces/${workspaceId}/tree?path=${query(path)}`)
      .then(requireOk<WorkspaceDirectoryListing>);
  },
  preview(hs: Handshake, workspaceId: string, path: string) {
    return sidecarFetch(hs, `/content/workspaces/${workspaceId}/file?path=${query(path)}`)
      .then(requireOk<WorkspaceFilePreview>);
  },
  status(hs: Handshake, workspaceId: string) {
    return sidecarFetch(hs, `/content/workspaces/${workspaceId}/git/status`)
      .then(requireOk<WorkspaceGitStatus>);
  },
  diff(hs: Handshake, workspaceId: string, path: string) {
    return sidecarFetch(hs, `/content/workspaces/${workspaceId}/git/diff?path=${query(path)}`)
      .then(requireOk<WorkspaceGitDiff>);
  },
};
