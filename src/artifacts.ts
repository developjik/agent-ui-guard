import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { generateReproSpec, parseTrace, traceToMarkdown } from './trace.js';
import type { TraceFile } from './types.js';

export interface ArtifactPaths {
  dir: string;
  trace: string;
  report: string;
  repro: string;
  dom?: string;
  screenshot?: string;
}

function runFolder(trace: TraceFile): string {
  // Milliseconds stay in the stamp — two runs in the same second must not collide.
  const stamp = trace.createdAt.replace(/[-:]/g, '').replace('T', '-').replace(/[.Z]/g, '');
  return `run-${stamp}-seed${trace.seed}${trace.violation ? '-failed' : ''}`;
}

/**
 * Writes everything needed to understand and reproduce a run:
 * `trace.json`, `report.md`, `repro.spec.ts` and — for a failing run — the DOM
 * and a screenshot at the moment of failure.
 */
export async function writeArtifacts(options: {
  outputDir: string;
  trace: TraceFile;
  page?: Page;
  screenshot?: boolean;
}): Promise<ArtifactPaths> {
  // mkdtemp creates the leaf atomically: a same-second/same-seed run or a
  // parallel one gets its own directory instead of silently overwriting the
  // trace/report/repro of an earlier run.
  await mkdir(options.outputDir, { recursive: true });
  const dir = await mkdtemp(path.join(options.outputDir, `${runFolder(options.trace)}-`));

  const tracePath = path.join(dir, 'trace.json');
  const reportPath = path.join(dir, 'report.md');
  const reproPath = path.join(dir, 'repro.spec.ts');

  await writeFile(tracePath, `${JSON.stringify(options.trace, null, 2)}\n`, 'utf8');
  await writeFile(reportPath, traceToMarkdown(options.trace), 'utf8');
  await writeFile(reproPath, generateReproSpec(options.trace), 'utf8');

  const paths: ArtifactPaths = {
    dir,
    trace: tracePath,
    report: reportPath,
    repro: reproPath,
  };

  if (options.page && options.trace.violation) {
    try {
      const domPath = path.join(dir, 'dom.html');
      await writeFile(domPath, await options.page.content(), 'utf8');
      paths.dom = domPath;
    } catch {
      // The page may be closed by the time a violation is reported.
    }
    if (options.screenshot !== false) {
      try {
        const screenshotPath = path.join(dir, 'failure.png');
        await options.page.screenshot({ path: screenshotPath, fullPage: true });
        paths.screenshot = screenshotPath;
      } catch {
        // Same: screenshots are best effort.
      }
    }
  }

  return paths;
}

export async function readTraceFile(filePath: string): Promise<TraceFile> {
  const raw = await readFile(filePath, 'utf8');
  return parseTrace(JSON.parse(raw));
}
