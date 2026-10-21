import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  export interface ProvidedContext {
    templateDbPath: string;
  }
}

/** Build one migrated template database for the whole integration run. */
export default function setup(project: TestProject) {
  const dir = mkdtempSync(path.join(tmpdir(), "sg-int-"));
  const templateDbPath = path.join(dir, "template.db");

  execFileSync("npx", ["prisma", "migrate", "deploy"], {
    cwd: path.resolve(__dirname, "../.."),
    env: { ...process.env, DATABASE_URL: `file:${templateDbPath}` },
    stdio: "pipe",
  });

  project.provide("templateDbPath", templateDbPath);

  return () => {
    rmSync(dir, { recursive: true, force: true });
  };
}
