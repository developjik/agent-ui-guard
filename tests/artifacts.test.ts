import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { writeArtifacts } from '../src/artifacts.js';
import type { TraceFile } from '../src/types.js';

const observations = { consoleErrors: [], pageErrors: [], http5xx: [] };

function makeTrace(overrides: Partial<TraceFile> = {}): TraceFile {
  return {
    version: 1,
    tool: 'agent-ui-guard',
    toolVersion: '0.1.0',
    seed: 7,
    url: 'http://localhost/',
    viewport: null,
    createdAt: '2026-11-22T11:35:42.123Z',
    finishedAt: null,
    steps: [],
    violation: null,
    observations,
    ...overrides,
  };
}

async function tmpOut(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'aug-artifacts-'));
}

describe('writeArtifacts run directory', () => {
  it('gives same-second same-seed runs distinct dirs and never overwrites', async () => {
    const out = await tmpOut();
    try {
      const first = await writeArtifacts({ outputDir: out, trace: makeTrace({ url: 'http://a/' }) });
      const second = await writeArtifacts({ outputDir: out, trace: makeTrace({ url: 'http://b/' }) });

      expect(second.dir).not.toBe(first.dir);
      expect(first.dir).toMatch(/run-\d{8}-\d{9}-seed7-[0-9A-Za-z]{6}$/);

      // The first run's trace, report and repro survive the second run.
      const firstTrace = JSON.parse(await readFile(first.trace, 'utf8')) as TraceFile;
      const secondTrace = JSON.parse(await readFile(second.trace, 'utf8')) as TraceFile;
      expect(firstTrace.url).toBe('http://a/');
      expect(secondTrace.url).toBe('http://b/');
      await expect(readFile(first.report, 'utf8')).resolves.toBeTruthy();
      await expect(readFile(first.repro, 'utf8')).resolves.toContain('http://a/');

      const entries = await readdir(out);
      expect(entries.filter((entry) => entry.startsWith('run-'))).toHaveLength(2);
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  });

  it('keeps parallel writes in separate directories', async () => {
    const out = await tmpOut();
    try {
      const results = await Promise.all(
        Array.from({ length: 6 }, (_, index) =>
          writeArtifacts({ outputDir: out, trace: makeTrace({ url: `http://x/${index}` }) }),
        ),
      );
      expect(new Set(results.map((result) => result.dir)).size).toBe(6);
      for (const [index, result] of results.entries()) {
        const trace = JSON.parse(await readFile(result.trace, 'utf8')) as TraceFile;
        expect(trace.url).toBe(`http://x/${index}`);
      }
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  });
});
