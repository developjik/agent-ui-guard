# Changelog

## 0.1.1

- `writeArtifacts`: run directories now keep the timestamp's milliseconds and are created atomically with `mkdtemp`, so a same-second/same-seed run — or a parallel one — can no longer silently overwrite an earlier run's `trace.json`/`report.md`/`repro.spec.ts` (DEV-48).

## 0.1.0

- Initial release: invariant guards for agent-driven UI runs, deterministic seeded runner, trace + markdown report + replay spec artifacts.
