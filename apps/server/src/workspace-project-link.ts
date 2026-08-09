import { lstat, mkdir, readlink, realpath, symlink } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

export interface EnsureProjectsLinkOptions {
  workspace: string;
  workspaceRoot: string;
  projectsPath: string;
  linkName?: string;
}

/**
 * Prepares a new agent workspace with a stable link to the shared projects.
 * Writes are restricted to descendants of workspaceRoot and existing entries
 * are never replaced.
 */
export async function ensureProjectsLink(options: EnsureProjectsLinkOptions): Promise<string> {
  const workspaceRoot = resolveAbsolute(options.workspaceRoot, "workspaceRoot");
  const workspace = resolveAbsolute(options.workspace, "workspace");
  const projectsPath = resolveAbsolute(options.projectsPath, "projectsPath");
  const linkName = options.linkName ?? "projects";
  if (!linkName || linkName.includes("/") || linkName.includes("\\") || linkName === "." || linkName === "..") {
    throw workspaceError("INVALID_PROJECTS_LINK_NAME", `Invalid projects link name: ${linkName}`);
  }

  assertDescendant(workspaceRoot, workspace);
  await mkdir(workspaceRoot, { recursive: true });
  const rootRealPath = await realpath(workspaceRoot);
  await assertExistingAncestorInsideRoot(workspace, rootRealPath);
  await mkdir(workspace, { recursive: true });
  const workspaceRealPath = await realpath(workspace);
  assertDescendant(rootRealPath, workspaceRealPath);

  const linkPath = resolve(workspaceRealPath, linkName);
  try {
    const existing = await lstat(linkPath);
    if (!existing.isSymbolicLink()) {
      throw workspaceError("PROJECTS_LINK_CONFLICT", `${linkPath} already exists and is not a symbolic link`);
    }
    const currentTarget = await readlink(linkPath);
    const resolvedTarget = resolve(dirname(linkPath), currentTarget);
    if (resolvedTarget !== projectsPath) {
      throw workspaceError("PROJECTS_LINK_CONFLICT", `${linkPath} already points to ${currentTarget}`);
    }
    return linkPath;
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) throw error;
  }

  await symlink(projectsPath, linkPath, "dir");
  return linkPath;
}

function resolveAbsolute(value: string, field: string): string {
  if (!isAbsolute(value)) throw workspaceError("INVALID_WORKSPACE_PATH", `${field} must be an absolute path`);
  return resolve(value);
}

function assertDescendant(root: string, candidate: string): void {
  const pathFromRoot = relative(root, candidate);
  if (!pathFromRoot || pathFromRoot === ".." || pathFromRoot.startsWith(`..${sep}`) || isAbsolute(pathFromRoot)) {
    throw workspaceError("INVALID_WORKSPACE_PATH", `Agent workspace must be a descendant of ${root}`);
  }
}

async function assertExistingAncestorInsideRoot(candidate: string, rootRealPath: string): Promise<void> {
  let current = candidate;
  while (true) {
    try {
      const ancestorRealPath = await realpath(current);
      if (ancestorRealPath !== rootRealPath) assertDescendant(rootRealPath, ancestorRealPath);
      return;
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) throw error;
      const parent = dirname(current);
      if (parent === current) throw workspaceError("INVALID_WORKSPACE_PATH", `Unable to resolve workspace ancestor for ${candidate}`);
      current = parent;
    }
  }
}

function workspaceError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
