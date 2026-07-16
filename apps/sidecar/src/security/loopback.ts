export function isAllowedRendererOrigin(origin: string | undefined): boolean {
  if (!origin) return true;
  if (origin === "tauri://localhost" || origin === "http://tauri.localhost" || origin === "https://tauri.localhost") return true;
  try {
    const url = new URL(origin);
    return url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
  } catch {
    return false;
  }
}

export function isAllowedLoopbackHost(host: string | undefined): boolean {
  if (!host) return false;
  const name = host.replace(/:\d+$/u, "").toLowerCase();
  return name === "127.0.0.1" || name === "localhost";
}
