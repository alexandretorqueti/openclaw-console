import assert from "node:assert/strict";
import { mkdtemp, mkdir, readlink, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ensureProjectsLink } from "./workspace-project-link.js";

test("creates an idempotent projects link in a new workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "console-workspaces-"));
  const workspace = join(root, "workspace-new-agent");
  const projectsPath = "/data/workspace/projects";

  const first = await ensureProjectsLink({ workspace, workspaceRoot: root, projectsPath });
  const second = await ensureProjectsLink({ workspace, workspaceRoot: root, projectsPath });

  assert.equal(first, join(workspace, "projects"));
  assert.equal(second, first);
  assert.equal(await readlink(first), projectsPath);
});

test("does not replace an existing projects entry", async () => {
  const root = await mkdtemp(join(tmpdir(), "console-workspaces-"));
  const workspace = join(root, "workspace-new-agent");
  await mkdir(workspace);
  await writeFile(join(workspace, "projects"), "keep me");

  await assert.rejects(
    ensureProjectsLink({ workspace, workspaceRoot: root, projectsPath: "/data/workspace/projects" }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "PROJECTS_LINK_CONFLICT",
  );
});

test("rejects workspaces outside the configured root", async () => {
  const root = await mkdtemp(join(tmpdir(), "console-workspaces-"));
  await assert.rejects(
    ensureProjectsLink({ workspace: join(root, "..", "outside"), workspaceRoot: root, projectsPath: "/data/workspace/projects" }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "INVALID_WORKSPACE_PATH",
  );
});

test("rejects an existing ancestor symlink that escapes the configured root", async () => {
  const root = await mkdtemp(join(tmpdir(), "console-workspaces-"));
  const outside = await mkdtemp(join(tmpdir(), "console-outside-"));
  const escaped = join(root, "escaped");
  await symlink(outside, escaped, "dir");

  await assert.rejects(
    ensureProjectsLink({ workspace: join(escaped, "agent"), workspaceRoot: root, projectsPath: "/data/workspace/projects" }),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "INVALID_WORKSPACE_PATH",
  );
});
