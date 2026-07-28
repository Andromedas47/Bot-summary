/**
 * Canonical integration-boundary module name for future 0049 wiring.
 * Implementation lives in `command-adapter.ts` (same package, no cross-worktree imports).
 */
export {
  PREVIEW_COMMAND_PLACEHOLDERS,
  looksLikeSyntheticThaiProduceHeader,
  openCommandFromActiveSession,
  toPreviewCloseProduceSessionCommand,
  toPreviewOpenProduceSessionCommand,
  type OpenCommandAdapterInput,
} from "./command-adapter";
