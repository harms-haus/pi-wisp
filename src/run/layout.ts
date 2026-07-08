/**
 * pi-wisp run directory layout helpers.
 *
 * All filesystem operations are synchronous (node:fs) so a run directory can
 * be fully materialised before any async execution begins.
 */

import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { GraphIR } from "../types.js";
import {
  RUN_GRAPH_FILE,
  RUN_PROFILES_SUBDIR,
  RUN_SESSIONS_DIR,
  RUN_WORKFLOW_FILE,
} from "../constants.js";
import { kebabCase, timecode } from "../utils.js";

/**
 * Create the run directory tree under `runsDir` with subdirectories
 * `artifacts/`, `artifacts/profiles/`, and `sessions/`.
 *
 * The directory is named `<timecode>-<kebab-title>`. When that path already
 * exists (e.g. two same-minute / same-title calls) a `-2`, `-3`, … suffix is
 * appended until a free name is found, guaranteeing distinct directories.
 * Returns the full path to the created run directory.
 */
export function createRunDir(runsDir: string, title: string): string {
  const base = `${timecode()}-${kebabCase(title)}`;
  let runDir = join(runsDir, base);
  for (let counter = 2; existsSync(runDir); counter++) {
    runDir = join(runsDir, `${base}-${counter}`);
  }
  // recursive:true creates each parent as needed, so creating the deepest
  // subdirectories also brings the runDir and artifacts/ into existence.
  mkdirSync(join(runDir, RUN_PROFILES_SUBDIR), { recursive: true });
  mkdirSync(join(runDir, RUN_SESSIONS_DIR), { recursive: true });
  return runDir;
}

/**
 * Copy a source workflow file into the run's `artifacts/workflow.ts`.
 */
export function copyWorkflowArtifact(src: string, runDir: string): void {
  copyFileSync(src, join(runDir, RUN_WORKFLOW_FILE));
}

/**
 * Write the compiled graph IR as `artifacts/graph.json` (pretty-printed).
 */
export function writeGraph(runDir: string, ir: GraphIR): void {
  writeFileSync(join(runDir, RUN_GRAPH_FILE), JSON.stringify(ir, null, 2), "utf-8");
}
