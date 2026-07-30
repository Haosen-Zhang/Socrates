import { dlopen, FFIType, ptr } from "bun:ffi";
import { closeSync, constants, fchmodSync, openSync } from "node:fs";

const AT_REMOVEDIR = 0x80;
const RENAME_EXCL = 0x4;
const O_CLOEXEC = (constants as unknown as Record<string, number>).O_CLOEXEC ?? 0;
const nativeSchema = {
  openat: {
    args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.i32],
    returns: FFIType.i32,
  },
  mkdirat: {
    args: [FFIType.i32, FFIType.ptr, FFIType.u32],
    returns: FFIType.i32,
  },
  unlinkat: {
    args: [FFIType.i32, FFIType.ptr, FFIType.i32],
    returns: FFIType.i32,
  },
  renameatx_np: {
    args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.u32],
    returns: FFIType.i32,
  },
} as const;
const libc = process.platform === "darwin"
  ? dlopen("/usr/lib/libSystem.B.dylib", nativeSchema)
  : null;

export const nativeWorkspaceMutationSupported = process.platform === "darwin";

function symbols() {
  if (!libc) throw new Error("workspace_mutation_platform_unsupported");
  return libc.symbols;
}

function nativePath(value: string): Buffer {
  if (!value || value.includes("/") || value.includes("\0")) throw new Error("workspace_native_path_invalid");
  return Buffer.from(`${value}\0`);
}

function openAt(directoryFd: number, name: string, flags: number, mode = 0): number {
  const encoded = nativePath(name);
  const fd = symbols().openat(directoryFd, ptr(encoded), flags, mode);
  if (fd < 0) throw new Error("workspace_path_changed");
  return fd;
}

function mkdirAt(directoryFd: number, name: string): void {
  const encoded = nativePath(name);
  const result = symbols().mkdirat(directoryFd, ptr(encoded), 0o700);
  if (result !== 0) throw new Error("workspace_path_changed");
}

function withWorkspaceParent<T>(
  canonicalRoot: string,
  relativePath: string,
  createMissing: boolean,
  action: (parentFd: number, basename: string) => T,
): T {
  const segments = relativePath.split("/").filter(Boolean);
  const basename = segments.pop();
  if (!basename) throw new Error("workspace_root_mutation_denied");
  const descriptors = [
    openSync(
      canonicalRoot,
      constants.O_RDONLY
        | (constants.O_DIRECTORY ?? 0)
        | (constants.O_NOFOLLOW ?? 0)
        | O_CLOEXEC,
    ),
  ];
  try {
    for (const segment of segments) {
      const parentFd = descriptors[descriptors.length - 1]!;
      const flags = constants.O_RDONLY
        | (constants.O_DIRECTORY ?? 0)
        | (constants.O_NOFOLLOW ?? 0)
        | O_CLOEXEC;
      let childFd: number;
      try {
        childFd = openAt(parentFd, segment, flags);
      } catch (error) {
        if (!createMissing) throw error;
        mkdirAt(parentFd, segment);
        childFd = openAt(parentFd, segment, flags);
      }
      descriptors.push(childFd);
    }
    return action(descriptors[descriptors.length - 1]!, basename);
  } finally {
    for (const fd of descriptors.reverse()) closeSync(fd);
  }
}

export function withPinnedWorkspaceParent<T>(
  canonicalRoot: string,
  relativePath: string,
  action: (parentFd: number, basename: string) => T,
): T {
  return withWorkspaceParent(canonicalRoot, relativePath, false, action);
}

export function withCreatedPinnedWorkspaceParent<T>(
  canonicalRoot: string,
  relativePath: string,
  action: (parentFd: number, basename: string) => T,
): T {
  return withWorkspaceParent(canonicalRoot, relativePath, true, action);
}

export function openPinnedWorkspaceEntry(
  parentFd: number,
  basename: string,
  flags: number,
  mode = 0,
): number {
  const safeFlags = flags | (constants.O_NOFOLLOW ?? 0) | O_CLOEXEC;
  if (!(flags & constants.O_CREAT)) return openAt(parentFd, basename, safeFlags);

  // Bun FFI cannot express C variadics directly. openat's fourth argument is
  // nevertheless passed in the normal integer register on macOS. Keep the
  // process umask maximally restrictive until fchmod applies the requested
  // mode, so a newly-created descriptor is never externally accessible even
  // if an ABI/runtime regression corrupts that variadic mode value.
  const previousUmask = process.umask(0o777);
  let fd: number;
  try {
    fd = openAt(parentFd, basename, safeFlags, mode);
  } finally {
    process.umask(previousUmask);
  }
  try {
    fchmodSync(fd, mode);
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

export function unlinkPinnedWorkspaceEntry(
  parentFd: number,
  basename: string,
  directory: boolean,
): void {
  const encoded = nativePath(basename);
  const result = symbols().unlinkat(parentFd, ptr(encoded), directory ? AT_REMOVEDIR : 0);
  if (result !== 0) throw new Error("workspace_delete_failed");
}

export function renamePinnedWorkspaceEntryExclusive(
  parentFd: number,
  from: string,
  to: string,
): void {
  const encodedFrom = nativePath(from);
  const encodedTo = nativePath(to);
  const result = symbols().renameatx_np(
    parentFd,
    ptr(encodedFrom),
    parentFd,
    ptr(encodedTo),
    RENAME_EXCL,
  );
  if (result !== 0) throw new Error("workspace_path_changed");
}
