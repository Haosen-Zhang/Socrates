import { memo, useMemo, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { WorkspaceRecord } from "@socrates/core";
import { open } from "@tauri-apps/plugin-dialog";
import type { SettingsSection } from "../settings/settingsOverlay";
import { ROOM_SIDEBAR_KEYS, useStorePick } from "../selectors";
import { useStore, useT } from "../store";
import PixelIcon from "../PixelIcon";
import ModeSegmented from "./ModeSegmented";
import PanelResizeHandle from "../layout/PanelResizeHandle";
import { searchSidebar, topLevelRooms, workspaceGroups, type SidebarRoom } from "./sidebarLists";
import { taskStatusKey } from "../taskSurface";
import { SidebarEntityMenu, RenameDialog, type MenuState, type RenameTarget } from "./SidebarActions";

type SidebarEntityKind = "room" | "session" | "workspace";
type SidebarEntry = SidebarRoom & { source: "room" | "session" };
export type RoomCreation = false | { presetWorkspaceId: string | null };
export default memo(function RoomSidebar({onCreate,onOpenSettings,onCollab,onNavigateRoom,width,maxWidth,onResize,onCommit}: {
  onCreate: Dispatch<SetStateAction<RoomCreation>>;
  onOpenSettings: (section?: SettingsSection) => void;
  onCollab: (id: string) => void;
  onNavigateRoom: () => void;
  width: number; maxWidth: number; onResize: (width: number) => void; onCommit: (width: number) => void;
}) {
  const {rooms,agents,sessions,workspaces,activeWorkspace,currentRoomId,currentSessionId,config,selectRoom,selectAgentSession,setActiveWorkspace,roomNavigation,setAppMode} = useStorePick(...ROOM_SIDEBAR_KEYS);
  const mode=roomNavigation.mode, collapsed=config?.sidebar.collapsed ?? false;
  const t=useT();
  const [menu,setMenu]=useState<MenuState|null>(null);
  const [renameTarget,setRenameTarget]=useState<RenameTarget|null>(null);
  const [sidebarError,setSidebarError]=useState<string|null>(null);
  const [archivedByMode,setArchivedByMode]=useState({chat:false,cowork:false});
  const showArchived=archivedByMode[mode];
  const setShowArchived=(value:SetStateAction<boolean>)=>setArchivedByMode(current=>({...current,[mode]:typeof value === "function" ? value(current[mode]) : value}));
  const [queries,setQueries]=useState({chat:"",cowork:""});
  const query=queries[mode];
  const setQuery=(value:string)=>setQueries(current=>({...current,[mode]:value}));
  const [foldedGroups,setFoldedGroups]=useState<string[]>([]);
  // 侧栏统一视图：历史 rooms 与 workspace sessions 折算成同一种行，
  // source 决定点击走 selectRoom 还是 selectAgentSession。
  const allEntries = useMemo<SidebarEntry[]>(() => [
    ...rooms.filter(room=>!sessions.some(session=>session.id === room.id || session.legacyRoomId === room.id)).map((room) => ({ id: room.id, name: room.name, kind: "chat" as const, workspaceId: null, archived: room.archived, source: "room" as const })),
    ...sessions.map((session) => ({ id: session.id, name: session.title, kind: session.kind, workspaceId: session.workspaceId, archived: session.archived, source: "session" as const })),
  ], [rooms, sessions]);

  const entries=useMemo(()=>allEntries.filter(entry=>entry.kind === mode),[allEntries,mode]);
  const memberNamesByRoom = useMemo(() => {
    const named = (ids: string[]) => ids.map((id) => agents.find((agent) => agent.id === id)?.nickname ?? "");
    return Object.fromEntries([
      ...rooms.map((room) => [room.id, named(room.agentIds)] as const),
      ...sessions.map((session) => [session.id, named(session.agents.map((agent) => agent.agentId))] as const),
    ]);
  }, [rooms, sessions, agents]);

  const openEntry = (entry: SidebarEntry) =>
    void (entry.source === "room" ? selectRoom(entry.id) : selectAgentSession(entry.id))
      .then(onNavigateRoom).catch(cause=>setSidebarError(String(cause)));

  const searchHits = searchSidebar(query, {
    rooms: entries,
    workspaces: (mode === "cowork" ? workspaces : []).map((workspace) => ({ ...workspace, path: workspace.canonicalPath })),
    memberNamesByRoom,
  });
  const topLevelEntries = useMemo(() => topLevelRooms(entries, workspaces) as SidebarEntry[], [entries, workspaces]);
  const projectGroups = useMemo(() => mode === "cowork" ? workspaceGroups(entries, workspaces) : [], [entries, workspaces,mode]);

  const archivedRooms = mode === "chat" ? rooms.filter((r) => r.archived && !sessions.some(session=>session.id === r.id || session.legacyRoomId === r.id)) : [];
  const archivedSessions = sessions.filter((session) => session.archived && session.kind === mode);
  const archivedWorkspaces = mode === "cowork" ? workspaces.filter((workspace) => workspace.archived) : [];

  const entryRow = (entry: SidebarEntry) => {
    const active = entry.id === (entry.source === "room" ? currentRoomId : currentSessionId);
    const menuKind: SidebarEntityKind = entry.source;
    const roomStatus=sessions.find(session=>session.id===entry.id)?.status;
    return (
      <div
        key={`${entry.source}-${entry.id}`}
        className={`pixel-room-row group flex cursor-pointer items-center gap-2 px-2 py-2 text-sm ${active ? "is-active" : ""} ${entry.archived ? "opacity-60" : ""}`}
        onClick={() => openEntry(entry)}
        title={collapsed ? entry.name : undefined}
        onContextMenu={(event) => {
          event.preventDefault();
          setMenu({ kind: menuKind, id: entry.id, x: event.clientX, y: event.clientY });
        }}
      >
        <PixelIcon name="robot" size={18} />
        {!collapsed && (
          <>
            <span className="min-w-0 flex-1 truncate font-medium">{entry.name}</span>
            {roomStatus && !["idle","completed"].includes(roomStatus) && <span className="text-[9px] text-neutral-500">{t(taskStatusKey(roomStatus === "failed" ? "failed" : roomStatus === "awaiting_approval" ? "awaiting_tool_approval" : roomStatus === "interrupted" ? "paused" : roomStatus === "cancelled" ? "cancelled" : "executing"))}</span>}
            <button
              title={t("room_menu")}
              className={`pixel-room-more shrink-0 px-1 text-sm opacity-0 group-hover:opacity-100 ${menu?.id === entry.id ? "opacity-100" : ""}`}
              onClick={(event) => {
                event.stopPropagation();
                const rect = event.currentTarget.getBoundingClientRect();
                setMenu({ kind: menuKind, id: entry.id, x: rect.right - 176, y: rect.bottom + 4 });
              }}
            >
              ⋯
            </button>
          </>
        )}
      </div>
    );
  };

  // 从工作区分组的「＋」建房：直接锁定该工作区，不再走全局 activeWorkspace、不让重选
  const createInWorkspace = (workspaceId: string) => onCreate({ presetWorkspaceId: workspaceId });

  /** 工作区分组；展开与选中互不影响（展开状态由 foldedGroups 单独持有）。 */
  const workspaceGroup = (group: { workspace: WorkspaceRecord; rooms: SidebarRoom[] }) => {
    const { workspace } = group;
    const folded = foldedGroups.includes(workspace.id);
    return (
      <section key={workspace.id} className={`pixel-project-group ${activeWorkspace?.id === workspace.id ? "is-current" : ""}`}>
        <div className="pixel-project-heading group flex items-center gap-1 px-1 py-1.5">
          <button
            className="flex min-w-0 flex-1 items-center gap-2 text-left text-xs font-bold"
            title={workspace.canonicalPath}
            aria-expanded={!folded}
            onClick={() => setFoldedGroups((current) => current.includes(workspace.id) ? current.filter((id) => id !== workspace.id) : [...current, workspace.id])}
          >
            <PixelIcon name="folder" size={18} />
            {!collapsed && (
              <>
                <span className="truncate">{workspace.label}</span>
                {group.rooms.length > 0 && <span className="text-[10px] font-normal text-neutral-400">{group.rooms.length}</span>}
              </>
            )}
          </button>
          {!collapsed && <button className="pixel-project-action" title={t("new_room")} aria-label={t("new_room")} onClick={() => createInWorkspace(workspace.id)}><PixelIcon name="plus" size={15} /></button>}
          {!collapsed && <button className="pixel-project-action" title={t("room_menu")} aria-label={t("room_menu")} onClick={(event) => { event.stopPropagation(); const rect = event.currentTarget.getBoundingClientRect(); setMenu({ kind: "workspace", id: workspace.id, x: rect.right - 176, y: rect.bottom + 4 }); }}>⋯</button>}
        </div>
        {!folded && (
          <div className="space-y-1 px-1 pb-2">
            {(group.rooms as SidebarEntry[]).map(entryRow)}
            {group.rooms.length === 0 && !collapsed && <p className="px-2 py-1 text-[10px] text-neutral-400">{t("project_empty")}</p>}
          </div>
        )}
      </section>
    );
  };

  return <>
      <aside
        data-navigation-sidebar="true"
        className={`pixel-room-sidebar flex shrink-0 flex-col p-3 ${collapsed ? "is-hidden" : ""}`}
        aria-hidden={collapsed}
        inert={collapsed ? true : undefined}
      >
        {!collapsed && <PanelResizeHandle edge="end" size={width} min={180} max={maxWidth} label={t("resize_sidebar")} onResize={onResize} onCommit={onCommit} />}
        <div className="pixel-sidebar-brand" data-tauri-drag-region>
          <span>Socrates</span>
        </div>
        <div className="mb-3"><ModeSegmented mode={mode} onChange={next=>{void setAppMode(next).catch(cause=>setSidebarError(String(cause)));}} labels={{chat:"Chat",cowork:"Work"}}/></div>
        <button
          className="pixel-new-room-button flex min-w-0 items-center justify-center gap-2 px-3 py-2.5 text-sm font-bold"
          onClick={() => onCreate({ presetWorkspaceId: mode === "cowork" ? activeWorkspace?.id ?? null : null })}
        >
          <PixelIcon name="plus" size={20} />
          {t("new_room")}
        </button>

        {mode === "cowork" && <button className="pixel-button mt-2 px-3 py-2 text-xs" onClick={()=>{void open({directory:true,multiple:false,title:t("new_project")}).then(async selected=>{if(typeof selected !== "string") return;const workspace=await useStore.getState().registerWorkspacePath(selected);onCreate({presetWorkspaceId:workspace.id});}).catch(cause=>setSidebarError(String(cause)));}}>+ {t("new_project")}</button>}
        {!collapsed && (
          <input
            type="search"
            className="pixel-input mt-3 w-full px-2 py-1.5 text-xs"
            placeholder={t("sidebar_search_placeholder")}
            aria-label={t("sidebar_search_placeholder")}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        )}
        {sidebarError && <div role="alert" className="mt-2 border border-red-300 bg-red-50 px-2 py-1 text-[10px] text-red-700">{sidebarError}</div>}

        <div className="pixel-room-list mt-3 flex-1 overflow-y-auto pr-1">
          {query.trim() ? (
            searchHits.length === 0 ? (
              <p className="px-2 py-1 text-[10px] text-neutral-400">{t("sidebar_search_empty")}</p>
            ) : (
              <div className="space-y-1 px-1">
                {searchHits.map((hit) =>
                  hit.kind === "room" ? (
                    entryRow(hit.room as SidebarEntry)
                  ) : (
                    <button
                      key={`ws-${hit.workspaceId}`}
                      className="pixel-room-row flex w-full items-center gap-2 px-2 py-2 text-left text-sm"
                      onClick={() => void setActiveWorkspace(hit.workspaceId).catch((error: unknown) => setSidebarError(error instanceof Error ? error.message : String(error)))}
                    >
                      <PixelIcon name="folder" size={18} />
                      <span className="truncate">{hit.label}</span>
                    </button>
                  ),
                )}
              </div>
            )
          ) : (
            <div className="space-y-2">
              {topLevelEntries.length > 0 && (
                <div className="space-y-1 px-1">
                  {topLevelEntries.map(entryRow)}
                </div>
              )}
              {projectGroups.map((group) => workspaceGroup({
                ...group,
                workspace: workspaces.find((item) => item.id === group.workspace.id)!,
              }))}
              {topLevelEntries.length === 0 && projectGroups.length === 0 && (
                <p className="px-2 py-1 text-[10px] text-neutral-400">{t("project_empty")}</p>
              )}
            </div>
          )}
        </div>
        <div className="pixel-archive-dock mt-3 pt-3">
          {!collapsed && showArchived && archivedRooms.length + archivedSessions.length + archivedWorkspaces.length > 0 && (
            <div className="pixel-archive-panel mb-2 max-h-56 space-y-1 overflow-y-auto p-2">
              {(entries.filter((entry) => entry.archived) as SidebarEntry[]).map(entryRow)}
              {/* 归档的工作区自己成一行（可能没有房间）——否则它只加计数却不显示 */}
              {archivedWorkspaces.map((workspace) => (
                <div
                  key={`ws-${workspace.id}`}
                  className="pixel-room-row group flex items-center gap-2 px-2 py-2 text-sm opacity-60"
                  onContextMenu={(event) => {
                    event.preventDefault();
                    setMenu({ kind: "workspace", id: workspace.id, x: event.clientX, y: event.clientY });
                  }}
                >
                  <PixelIcon name="folder" size={18} />
                  <span className="min-w-0 flex-1 truncate font-medium">{workspace.label}</span>
                  <button
                    title={t("room_menu")}
                    className="pixel-room-more shrink-0 px-1 text-sm opacity-0 group-hover:opacity-100"
                    onClick={(event) => {
                      event.stopPropagation();
                      const rect = event.currentTarget.getBoundingClientRect();
                      setMenu({ kind: "workspace", id: workspace.id, x: rect.right - 176, y: rect.bottom + 4 });
                    }}
                  >
                    ⋯
                  </button>
                </div>
              ))}
            </div>
          )}
          <button
            className="pixel-archive-button flex w-full items-center gap-2 px-3 py-2 text-left text-xs"
            onClick={() => setShowArchived((v) => !v)}
            title={t("archived_section", { n: archivedRooms.length + archivedSessions.length + archivedWorkspaces.length })}
          >
            <PixelIcon name="archive" size={20} />
            {!collapsed && (
              <>
                <span className="min-w-0 flex-1">{t("archived_section", { n: archivedRooms.length + archivedSessions.length + archivedWorkspaces.length })}</span>
                <span>{showArchived ? "▾" : "▸"}</span>
              </>
            )}
          </button>
          <button className="pixel-archive-button mt-2 flex w-full items-center gap-2 px-3 py-2 text-left text-xs" title={t("agents_title")} onClick={()=>onOpenSettings("bots")}><PixelIcon name="robot" size={20}/>{!collapsed && <span>{t("agents_title")}</span>}</button>
          {/* Settings 固定在左下角；打开的是 overlay，不改变当前房间导航状态 */}
          <button
            className="pixel-archive-button mt-2 flex w-full items-center gap-2 px-3 py-2 text-left text-xs"
            onClick={()=>onOpenSettings()}
            title={`${t("settings_title")} (⌘,)`}
          >
            <PixelIcon name="gear" size={20} />
            {!collapsed && <span className="min-w-0 flex-1">{t("settings_title")}</span>}
          </button>
        </div>
      </aside>
      {renameTarget && <RenameDialog target={renameTarget} onClose={() => setRenameTarget(null)} />}
      {menu && <SidebarEntityMenu menu={menu} onClose={() => setMenu(null)} onRename={setRenameTarget} onCollab={onCollab} onError={setSidebarError} />}
  </>;
});
