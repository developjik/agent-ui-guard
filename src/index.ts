/**
 * agent-ui-guard — property-based UI and tool-call invariant testing for
 * streaming AI agent apps.
 *
 * ```ts
 * import { builtinInvariants, runExploration } from 'agent-ui-guard';
 * ```
 */
export * from './types.js';
export * from './contract.js';
export * from './analyze.js';
export * from './actions.js';
export * from './invariants.js';
export * from './rng.js';
export * from './runner.js';
export { Guard } from './guard.js';
export type { GuardOptions, SettleResult, NodeObservations } from './guard.js';
export {
  TraceRecorder,
  parseTrace,
  stepsToPlan,
  traceToMarkdown,
  generateReproSpec,
  errorMessage,
} from './trace.js';
export type { PendingStep, TraceMeta } from './trace.js';
export { writeArtifacts, readTraceFile } from './artifacts.js';
export type { ArtifactPaths } from './artifacts.js';
export {
  installAgentUiGuardRuntime,
  buildRuntimeScript,
  RUNTIME_GLOBAL,
  RUNTIME_VERSION,
} from './runtime.js';
export { TOOL_VERSION } from './version.js';

export * from './transport.js';
