import { useVirtualizer } from "@tanstack/react-virtual";
import "@git-diff-view/react/styles/diff-view-pure.css";
import type { WorkspaceBrowserEntry, WorkspaceFilePreview, WorkspaceGitDiff, WorkspaceGitStatus } from "@socrates/core";
import { lazy, Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import PixelIcon from "../PixelIcon";
import { useT } from "../store";
import { workspaceInspectionClient } from "./workspaceInspectionClient";
import type { Handshake } from "../transport";
import type { WorkspaceDockMode } from "./workspaceDockState";
import WorkspaceDockTabs from "./WorkspaceDockTabs";
import PanelResizeHandle from "../layout/PanelResizeHandle";

type TreeRow = WorkspaceBrowserEntry & { depth: number };
const LazyDiffView = lazy(() => import("@git-diff-view/react").then((module) => ({ default: module.DiffView })));

function flattenTree(children: Map<string, WorkspaceBrowserEntry[]>, expanded: Set<string>, parent = "", depth = 0): TreeRow[] {
  const rows: TreeRow[] = [];
  for (const entry of children.get(parent) ?? []) {
    rows.push({ ...entry, depth });
    if (entry.kind === "directory" && expanded.has(entry.relativePath)) rows.push(...flattenTree(children, expanded, entry.relativePath, depth + 1));
  }
  return rows;
}

function patchHunks(patch: string): string[] {
  const first = patch.search(/^@@ /mu);
  if (first < 0) return [];
  return patch.slice(first).split(/(?=^@@ )/mu).filter(Boolean);
}

export default function WorkspaceDock({ handshake, workspaceId, mode, overview, onSelect, onClose, resize }: {
  handshake: Handshake | null;
  workspaceId: string | null;
  mode: Exclude<WorkspaceDockMode, "closed">;
  overview: ReactNode;
  onSelect: (mode: Exclude<WorkspaceDockMode, "closed">) => void;
  onClose: () => void;
  resize?: { size: number; min: number; max: number; label: string; onResize: (size: number) => void; onCommit: (size: number) => void };
}) {
  const t = useT();
  const [children, setChildren] = useState<Map<string, WorkspaceBrowserEntry[]>>(new Map());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [preview, setPreview] = useState<WorkspaceFilePreview | null>(null);
  const [status, setStatus] = useState<WorkspaceGitStatus | null>(null);
  const [diff, setDiff] = useState<WorkspaceGitDiff | null>(null);
  const [selectedDiff, setSelectedDiff] = useState("");
  const [treeTruncated, setTreeTruncated] = useState(false);
  const [truncatedDirectories, setTruncatedDirectories] = useState<Set<string>>(new Set());
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const request = useRef(0);
  const diffRequest = useRef(0);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const id = ++request.current;
    setError(""); setLoading(true); setPreview(null); setDiff(null); setStatus(null); setSelectedDiff(""); setTreeTruncated(false); setTruncatedDirectories(new Set());
    if (mode === "overview") {
      setLoading(false);
      return () => { request.current += 1; };
    }
    if (!handshake || !workspaceId) {
      setError(t("workspace_required_for_tools"));
      setLoading(false);
      return () => { request.current += 1; };
    }
    if (mode === "files") {
      setChildren(new Map()); setExpanded(new Set());
      void workspaceInspectionClient.list(handshake, workspaceId).then((result) => {
        if (id === request.current) { setChildren(new Map([["", result.entries]])); setTreeTruncated(result.truncated); }
      }).catch((cause) => { if (id === request.current) setError(String(cause)); }).finally(() => { if (id === request.current) setLoading(false); });
    } else {
      void workspaceInspectionClient.status(handshake, workspaceId).then((result) => {
        if (id !== request.current) return;
        setStatus(result); setSelectedDiff(result.files[0]?.relativePath ?? "");
      }).catch((cause) => { if (id === request.current) setError(String(cause)); }).finally(() => { if (id === request.current) setLoading(false); });
    }
    return () => { request.current += 1; };
  }, [handshake, workspaceId, mode]);

  useEffect(() => {
    if (mode !== "diff" || !selectedDiff || !handshake || !workspaceId) { setDiff(null); return; }
    const id = ++diffRequest.current;
    setLoading(true); setError("");
    void workspaceInspectionClient.diff(handshake, workspaceId, selectedDiff)
      .then((result) => { if (id === diffRequest.current) setDiff(result); })
      .catch((cause) => { if (id === diffRequest.current) setError(String(cause)); })
      .finally(() => { if (id === diffRequest.current) setLoading(false); });
  }, [handshake, workspaceId, mode, selectedDiff]);

  const rows = useMemo(() => flattenTree(children, expanded), [children, expanded]);
  const virtualizer = useVirtualizer({ count: rows.length, getScrollElement: () => scrollRef.current, estimateSize: () => 30, overscan: 8 });
  const toggleDirectory = async (row: TreeRow) => {
    if (!handshake || !workspaceId) return;
    const next = new Set(expanded);
    if (next.has(row.relativePath)) next.delete(row.relativePath);
    else {
      next.add(row.relativePath);
      if (!children.has(row.relativePath)) {
        try {
          const result = await workspaceInspectionClient.list(handshake, workspaceId, row.relativePath);
          setChildren((current) => new Map(current).set(row.relativePath, result.entries));
          if (result.truncated) setTruncatedDirectories((current) => new Set(current).add(row.relativePath));
        } catch (cause) { setError(String(cause)); return; }
      }
    }
    setExpanded(next);
  };
  const selectFile = async (row: TreeRow) => {
    if (!handshake || !workspaceId) return;
    setLoading(true); setError("");
    try { setPreview(await workspaceInspectionClient.preview(handshake, workspaceId, row.relativePath)); }
    catch (cause) { setError(String(cause)); }
    finally { setLoading(false); }
  };
  const hunks = diff ? patchHunks(diff.patch) : [];

  const label = mode === "overview" ? t("workspace_overview") : mode === "files" ? t("workspace_files") : t("workspace_changes");
  return <aside className="pixel-workspace-dock" aria-label={label}>
    {resize && <PanelResizeHandle edge="start" {...resize} />}
    <header className="pixel-workspace-dock__header">
      <WorkspaceDockTabs mode={mode} hasWorkspace={!!handshake && !!workspaceId} onSelect={onSelect} />
      <button type="button" className="pixel-workspace-dock__close" aria-label={t("close")} onClick={onClose}>×</button>
    </header>
    {error && <div role="alert" className="pixel-workspace-dock__error">{error}</div>}
    {mode !== "overview" && loading && <div className="pixel-workspace-dock__empty">{t("loading")}</div>}
    {mode === "overview" ? <div className="pixel-workspace-dock__overview">{overview}</div> : mode === "files" ? <>
      {children.get("") && children.get("")!.length === 0 && !loading && <div className="pixel-workspace-dock__empty">{t("workspace_empty_folder")}</div>}
      <div ref={scrollRef} className="pixel-workspace-tree" role="tree">
        <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
          {virtualizer.getVirtualItems().map((item) => { const row = rows[item.index]!; return <button key={row.relativePath} type="button" role="treeitem" aria-expanded={row.kind === "directory" ? expanded.has(row.relativePath) : undefined} className="pixel-workspace-tree__row" style={{ paddingLeft: 10 + row.depth * 16, transform: `translateY(${item.start}px)` }} onClick={() => row.kind === "directory" ? void toggleDirectory(row) : void selectFile(row)}><PixelIcon name={row.kind === "directory" ? "folder" : "file"} size={14} /><span>{row.name}</span></button>; })}
        </div>
      </div>
      {(treeTruncated || truncatedDirectories.size > 0) && <p className="pixel-workspace-dock__notice">{t("workspace_truncated")}</p>}
      <div className="pixel-workspace-preview">{preview ? <><div className="pixel-workspace-preview__title">{preview.relativePath}</div><pre>{preview.text}</pre>{preview.truncated && <p>{t("workspace_truncated")}</p>}</> : !loading && <div className="pixel-workspace-dock__empty">{t("workspace_select_file")}</div>}</div>
    </> : <>
      {status?.state === "not_git" ? <div className="pixel-workspace-dock__empty">{t("workspace_not_git")}</div> : <div className="pixel-workspace-diff-list">{status?.files.map((file) => <button key={file.relativePath} type="button" className={selectedDiff === file.relativePath ? "is-selected" : ""} onClick={() => setSelectedDiff(file.relativePath)}><span>{file.status[0]?.toUpperCase()}</span>{file.relativePath}</button>)}</div>}
      {status?.state === "ready" && status.files.length === 0 && !loading && <div className="pixel-workspace-dock__empty">{t("workspace_no_changes")}</div>}
      {status?.truncated && <p className="pixel-workspace-dock__notice">{t("workspace_truncated")}</p>}
      <div className="pixel-workspace-diff-view">{diff?.binary ? <div className="pixel-workspace-dock__empty">{t("workspace_binary_diff")}</div> : diff && hunks.length > 0 ? <Suspense fallback={<div className="pixel-workspace-dock__empty">{t("loading")}</div>}><LazyDiffView data={{ oldFile: { fileName: diff.relativePath }, newFile: { fileName: diff.relativePath }, hunks }} diffViewMode={4} diffViewTheme={document.documentElement.dataset.theme === "dark" ? "dark" : "light"} diffViewWrap diffViewHighlight={false} /></Suspense> : null}{diff?.truncated && <p>{t("workspace_truncated")}</p>}</div>
    </>}
  </aside>;
}
