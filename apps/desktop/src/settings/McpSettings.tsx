import { useEffect, useMemo, useState } from "react";
import type { McpScope, McpServerInput, McpTransport } from "@socrates/core";
import PixelIcon from "../PixelIcon";
import { useStore, useT } from "../store";
import { parseSecretLines } from "./mcpForm";

const stateClass: Record<string, string> = {
  connected: "bg-green-100 text-green-800",
  degraded: "bg-amber-100 text-amber-800",
  connecting: "bg-blue-100 text-blue-800",
  needs_auth: "bg-amber-100 text-amber-800",
  failed: "bg-red-100 text-red-800",
  disabled: "bg-neutral-200 text-neutral-600",
  disconnected: "bg-neutral-200 text-neutral-600",
  stopping: "bg-neutral-200 text-neutral-600",
};

export default function McpSettings() {
  const {
    mcpServers, mcpTools, activeWorkspace, loadMcpServers, saveMcpServer, setMcpEnabled,
    testMcpServer, removeMcpServer, loadMcpTools, setMcpToolPolicy,
  } = useStore();
  const t = useT();
  const [editingId, setEditingId] = useState<string | undefined>();
  const [name, setName] = useState("");
  const [scope, setScope] = useState<McpScope>("global");
  const [transport, setTransport] = useState<McpTransport>("stdio");
  const [endpoint, setEndpoint] = useState("");
  const [args, setArgs] = useState("");
  const [secrets, setSecrets] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  useEffect(() => { void loadMcpServers(); }, [loadMcpServers]);

  const secretDraft = useMemo(() => parseSecretLines(secrets), [secrets]);
  const reset = () => {
    setEditingId(undefined); setName(""); setScope("global"); setTransport("stdio");
    setEndpoint(""); setArgs(""); setSecrets(""); setError(null);
  };
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const config = transport === "stdio"
      ? { transport, command: endpoint, args: args.split("\n").map((item) => item.trim()).filter(Boolean), envKeys: secretDraft.keys }
      : { transport, url: endpoint, headerKeys: secretDraft.keys };
    const server: McpServerInput = { name, scope, workspaceId: scope === "workspace" ? activeWorkspace?.id : null, config };
    try { await saveMcpServer(server, secretDraft.values, editingId); reset(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };

  return (
    <div>
      <h2 className="text-xl font-bold">{t("nav_mcp")}</h2>
      <p className="mb-4 mt-1 text-sm text-neutral-500">{t("mcp_desc")}</p>
      <div className="space-y-3">
        {mcpServers.map((server) => (
          <section key={server.id} className="pixel-card p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <strong>{server.name}</strong>
                  <span className={`pixel-chip ${stateClass[server.state] ?? ""}`}>{t(`mcp_state_${server.state}`)}</span>
                  <span className="pixel-chip">{server.scope}</span>
                  <span className="pixel-chip">gen {server.generation}</span>
                </div>
                <div className="mt-1 truncate text-xs text-neutral-500">
                  {server.config.transport === "stdio" ? `${server.config.command} ${server.config.args.join(" ")}` : server.config.url}
                </div>
                {server.lastError && <div className="mt-2 text-xs text-red-700">{server.lastError}</div>}
              </div>
              <div className="flex shrink-0 flex-wrap gap-2">
                <button className="pixel-button px-2 py-1 text-xs" disabled={busyId === server.id} onClick={() => {
                  setBusyId(server.id); setError(null);
                  void testMcpServer(server.id).catch((cause) => setError(cause instanceof Error ? cause.message : String(cause))).finally(() => setBusyId(null));
                }}>{t("mcp_test")}</button>
                <button className={`pixel-button px-2 py-1 text-xs ${server.enabled ? "pixel-button--primary" : ""}`} disabled={busyId === server.id} onClick={() => {
                  setBusyId(server.id); setError(null);
                  void setMcpEnabled(server.id, !server.enabled).catch((cause) => setError(cause instanceof Error ? cause.message : String(cause))).finally(() => setBusyId(null));
                }}>{server.enabled ? t("mcp_disable") : t("mcp_enable")}</button>
                <button className="pixel-button px-2 py-1 text-xs" onClick={() => {
                  setEditingId(server.id); setName(server.name); setScope(server.scope); setTransport(server.config.transport);
                  setEndpoint(server.config.transport === "stdio" ? server.config.command : server.config.url);
                  setArgs(server.config.transport === "stdio" ? server.config.args.join("\n") : "");
                  setSecrets((server.config.transport === "stdio" ? server.config.envKeys : server.config.headerKeys).join("\n"));
                }}>{t("edit")}</button>
                <button className="pixel-button px-2 py-1 text-xs text-red-700" onClick={() => void removeMcpServer(server.id)}>{t("delete")}</button>
              </div>
            </div>
            {(server.state === "connected" || server.state === "degraded") && (
              <div className="mt-3 border-t border-neutral-200 pt-3">
                <button className="text-xs underline" onClick={() => void loadMcpTools(server.id)}>{t("mcp_tools_show")}</button>
                {(mcpTools[server.id] ?? []).map((tool) => (
                  <div key={tool.name} className="mt-2 flex items-center gap-2 text-xs">
                    <span className="min-w-0 flex-1 truncate" title={tool.namespacedName}>{tool.name} · {tool.description}</span>
                    <span className="pixel-chip">{tool.riskOverride ?? tool.risk}</span>
                    <select className="pixel-input px-2 py-1" value={tool.effect} disabled={!tool.enabled} onChange={(event) => void setMcpToolPolicy(server.id, tool.name, event.target.value as typeof tool.effect)}>
                      <option value="deny">{t("approval_deny")}</option>
                      <option value="ask">{t("mcp_policy_ask")}</option>
                      <option value="allow">{t("mcp_policy_allow")}</option>
                    </select>
                  </div>
                ))}
              </div>
            )}
          </section>
        ))}
      </div>

      <form className="pixel-card mt-5 space-y-3 p-4" onSubmit={submit}>
        <div className="flex items-center gap-2"><PixelIcon name="plug" size={20} /><strong>{editingId ? t("mcp_edit") : t("mcp_add")}</strong></div>
        <div className="grid grid-cols-2 gap-3">
          <label className="text-sm">{t("name")}<input className="pixel-input mt-1 w-full px-3 py-2" required value={name} onChange={(event) => setName(event.target.value.toLowerCase().replace(/[^a-z0-9_-]/gu, "_"))} /></label>
          <label className="text-sm">{t("mcp_scope")}<select className="pixel-input mt-1 w-full px-3 py-2" value={scope} onChange={(event) => setScope(event.target.value as McpScope)}><option value="global">global</option><option value="workspace" disabled={!activeWorkspace}>workspace</option></select></label>
          <label className="text-sm">{t("mcp_transport")}<select className="pixel-input mt-1 w-full px-3 py-2" value={transport} onChange={(event) => setTransport(event.target.value as McpTransport)}><option value="stdio">stdio</option><option value="streamable_http">Streamable HTTP</option></select></label>
          <label className="text-sm">{transport === "stdio" ? t("mcp_command") : "URL"}<input className="pixel-input mt-1 w-full px-3 py-2" required value={endpoint} onChange={(event) => setEndpoint(event.target.value)} /></label>
        </div>
        {transport === "stdio" && <label className="block text-sm">{t("mcp_args")}<textarea className="pixel-input mt-1 min-h-20 w-full px-3 py-2" value={args} onChange={(event) => setArgs(event.target.value)} /></label>}
        <label className="block text-sm">{transport === "stdio" ? t("mcp_env_secrets") : t("mcp_header_secrets")}<textarea className="pixel-input mt-1 min-h-20 w-full px-3 py-2 font-mono" placeholder="TOKEN=..." value={secrets} onChange={(event) => setSecrets(event.target.value)} /><span className="mt-1 block text-xs text-neutral-500">{t("mcp_secret_hint")}</span></label>
        {error && <div role="alert" className="text-xs text-red-700">{error}</div>}
        <div className="flex justify-end gap-2">{editingId && <button type="button" className="pixel-button px-3 py-2 text-sm" onClick={reset}>{t("cancel")}</button>}<button className="pixel-button pixel-button--primary px-4 py-2 text-sm" disabled={scope === "workspace" && !activeWorkspace}>{t("save")}</button></div>
      </form>
    </div>
  );
}
