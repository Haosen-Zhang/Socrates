import { dlopen, FFIType, ptr } from "bun:ffi";
import { closeSync, constants, fchmodSync, fstatSync, openSync } from "node:fs";

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
  getdirentries: {
    args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.ptr],
    returns: FFIType.i64,
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

export function removePinnedWorkspaceTree(parentFd: number, basename: string): void {
  const fd = openPinnedWorkspaceEntry(
    parentFd,
    basename,
    constants.O_RDONLY | (constants.O_NONBLOCK ?? 0),
  );
  let directory = false;
  try {
    const stat = fstatSync(fd);
    if (stat.isDirectory()) {
      directory = true;
      for (const child of listPinnedDirectoryEntries(fd, 10_000)) {
        removePinnedWorkspaceTree(fd, child);
      }
    } else if (stat.isFile()) {
      if (stat.nlink > 1) throw new Error("workspace_hardlink_denied");
    } else {
      throw new Error("workspace_tree_kind_unsupported");
    }
  } finally {
    closeSync(fd);
  }
  unlinkPinnedWorkspaceEntry(parentFd, basename, directory);
}

export function mkdirPinnedWorkspaceEntry(parentFd: number, basename: string): void {
  mkdirAt(parentFd, basename);
}

export function listPinnedDirectoryEntries(directoryFd: number, maxEntries: number): string[] {
  const output: string[] = [];
  const buffer = Buffer.alloc(16 * 1024);
  const base = new BigInt64Array(1);
  while (true) {
    const received = Number(symbols().getdirentries(directoryFd, ptr(buffer), buffer.length, ptr(base)));
    if (received < 0) throw new Error("workspace_path_changed");
    if (received === 0) return output.sort((left, right) => left.localeCompare(right));
    let offset = 0;
    while (offset < received) {
      if (offset + 8 > received) throw new Error("workspace_directory_invalid");
      const recordLength = buffer.readUInt16LE(offset + 4);
      const nameLength = buffer.readUInt8(offset + 7);
      if (recordLength < 8 || offset + recordLength > received || nameLength > recordLength - 8) {
        throw new Error("workspace_directory_invalid");
      }
      const name = buffer.subarray(offset + 8, offset + 8 + nameLength).toString("utf-8");
      if (name !== "." && name !== "..") {
        nativePath(name);
        output.push(name);
        if (output.length > maxEntries) throw new Error("workspace_tree_too_many_entries");
      }
      offset += recordLength;
    }
  }
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

export function renamePinnedWorkspaceEntryExclusiveBetween(
  fromParentFd: number,
  from: string,
  toParentFd: number,
  to: string,
): void {
  const encodedFrom = nativePath(from);
  const encodedTo = nativePath(to);
  const result = symbols().renameatx_np(
    fromParentFd,
    ptr(encodedFrom),
    toParentFd,
    ptr(encodedTo),
    RENAME_EXCL,
  );
  if (result !== 0) throw new Error("workspace_path_changed");
}
