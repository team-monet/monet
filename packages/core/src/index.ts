export {
  MonetCore,
  EmbedderMismatchError,
  ContentExceedsEmbedderWindowError,
  type EmbedderWindowSubject,
  RELIABLE_EMBED_TOKENS,
  NON_LATIN_LETTER_TOLERANCE,
  ContentScriptUnsupportedError,
  EmbedderPinUnsatisfiedError,
  EmbedderWidthConflictError,
  MalformedEmbeddingStoreError,
  EmbedderOutputDimensionError,
  EmbedderOutputNonFiniteError,
  EmbedderIdentityRequiredError,
  EmbedderMigrationReentryError,
  EmbedderRepairOwnershipError,
  EmbedderMigrationValidationError,
  EmbedderMigrationConflictError,
  EmbedderMigrationIncompleteError,
  EmbedderMigrationStartError,
  EmbedderMigrationFailedError,
  EmbedderMigrationAbandonRefusedError,
  EmbedderMigrationAbandonUnsupportedError,
} from "./engine";
export type {
  Concept,
  SearchCard,
  IngestResult,
  IngestAction,
  StoreOpts,
  RuleCaptureOpts,
  RuleBindingChange,
  RuleCorrectionVerdict,
  RuleSuccession,
  DeclareInput,
  DeclareResult,
  DeclareAdvisory,
  RatifyInput,
  RatifyResult,
  SkeletonEntry,
  SkeletonBody,
  SkeletonBreadth,
  StageView,
  MonetCoreOptions,
  Workstream,
  WorkstreamPayload,
  PrewarmState,
  LivingModelCard,
  Contradiction,
  PrewarmContradiction,
  MemoryOverview,
  ResolutionStats,
  EntityHub,
  ConnectedConcept,
  MemoryListEntry,
  ReassignResult,
  ObservationEntry,
  DetachResult,
  PossibleDuplicatePair,
  RenameCircleResult,
  MergeCircleResult,
  MergeConceptResult,
  BatchReassignResult,
  EmbedderMigrationValidationReason,
  EmbeddingMigrationPhase,
  EmbeddingMigrationProgress,
  EmbeddingMigrationItemFailure,
  EmbeddingMigrationPhaseReport,
  EmbeddingMigrationReport,
  EmbeddingWidthInventory,
  MalformedEmbeddingInventory,
  MalformedEmbeddingPopulation,
} from "./engine";
export {
  BetterSqlitePort,
  StorageExclusiveLockError,
  VerifiedBackupDestinationExistsError,
  VerifiedBackupVerificationError,
  readStoredEmbedderPin,
  readStoredVectorPresence,
} from "./storage";
export type { VerifiedBackupResult } from "./storage";
export {
  inspectStoredEmbedderState,
  inspectNonLatinContent,
  StoredEmbedderStateDiagnosticError,
  inspectLifecycleEdgeIntegrity,
} from "./diagnostics";
export type {
  StoredDatabaseIntegrity,
  StoredEmbedderDiagnosticFailureReason,
  StoredEmbedderMigration,
  StoredEmbedderPin,
  StoredEmbedderSafetyAssessment,
  StoredEmbedderStateInspection,
  StoredNonLatinContent,
  NonLatinReadDb,
  DanglingLifecycleEdge,
  DanglingRatification,
  LifecycleEdgeIntegrityReport,
  LifecycleEdgeReadDb,
} from "./diagnostics";
/** Normative substrate: derivation / provenance / supersession as first-class objects, plus the
 *  span scheme a provenance edge addresses. Engine-internal today — exported so the slices adding
 *  rule capture and ratification flows build against a fixed API rather than reaching into engine. */
export {
  LIFECYCLE_EDGE_BIRTHS,
  LIFECYCLE_EDGE_FAMILIES,
  LIFECYCLE_EDGE_SCHEMA_SQL,
  RATIFICATION_VERDICTS,
} from "./lifecycle-edges";
export type {
  AddLifecycleEdgeInput,
  GetLifecycleEdgesOptions,
  LifecycleEdgeBirth,
  LifecycleEdgeDirection,
  LifecycleEdgeFamily,
  LifecycleEdgeRow,
  RatificationRow,
  RatificationVerdict,
  RecordRatificationInput,
} from "./lifecycle-edges";
/** The gate substrate: stages, rule bindings, and the deterministic firing path. The pattern
 *  matcher is exported deliberately — the host-side CLI that reads the gate mirror has to match
 *  with the SAME code the store matches with, or the offline answer and the live answer disagree.
 *  `evaluateGateFromMirror` is that offline answer itself: the pure, no-db evaluator a 4b-C CLI
 *  stands on. */
export {
  GATE_SCHEMA_SQL,
  MODEL_TAG_MAX_CHARS,
  RULE_BINDING_ORIGINS,
  RULE_SCOPES,
  RULE_SEVERITIES,
  STAGE_INDEX_CAP,
  STAGE_LOOKUP_BODY_CAP,
  STAGE_LOOKUP_OUTLINE_CAP,
  STAGE_LOOKUP_REASON_CAP,
  STAGE_LOOKUP_RULES_CAP,
  STAGE_NAME_MAX_CHARS,
  STAGE_ORIGINS,
  COMMAND_BOUNDARY,
  GATE_MIRROR_FORMAT,
  assertNoUnacknowledgedDenies,
  bumpGateGeneration,
  clampActionContext,
  createGateSchema,
  formatTriggerPattern,
  commitGateWrites,
  evaluateGate,
  evaluateGateFromMirror,
  evaluateStageLookup,
  gateGeneration,
  gateQuery,
  gateCoverage,
  hasLiveBinding,
  hasLineBreak,
  hasNoReason,
  inspectSidecar,
  listGateMirrorEntries,
  listGateMirrorStages,
  liveBlockingRulesForStage,
  liveStageIndex,
  materializeGateMirror,
  matchesTriggerPattern,
  normalizeMatchToken,
  normalizeStageName,
  parseActionContext,
  parseTriggerPatterns,
  ruleOutlineForStage,
  seedTriggerPattern,
  serializeTriggerPatterns,
  stageLookup,
} from "./gates";
export type {
  ActionContext,
  BindRuleResult,
  GateMatcher,
  GateMirror,
  GateMirrorCircleAlias,
  GateMirrorEntry,
  GateMirrorStage,
  GateQueryOptions,
  GateResult,
  GateRule,
  GateStageRef,
  GateCoverage,
  GateCoverageOptions,
  LiveStageIndexResult,
  PendingGateWrites,
  RuleBindingOrigin,
  RuleBindingRow,
  RuleOutlineEntry,
  RuleScope,
  RuleSeverity,
  SidecarMaterialization,
  SidecarStaleness,
  SidecarWriteOutcome,
  StageLookupOptions,
  StageLookupResult,
  StageLookupRule,
  StageOrigin,
  StageRow,
  TriggerPattern,
} from "./gates";
export {
  CLAUDE_CODE_HOST,
  SPAN_SCHEME,
  formatClaudeCodeAnchor,
  formatSpan,
  isSpanRef,
  parseClaudeCodeAnchor,
  parseSpan,
} from "./spans";
export type { ClaudeCodeAnchor, TranscriptSpan } from "./spans";
export type {
  EmbeddingPopulationName,
  LiveEmbeddingPopulationInspection,
  StoredEmbeddingPopulationInspection,
  StoredEmbeddingPopulations,
} from "./embedding-state";
export { MONET_SCHEMA_VERSION } from "./schema-version";
/** The unit split (observations retrieve, concepts deliver): search's native-card emission floor.
 *  It is why a query can legitimately return fewer cards than its limit, including zero. */
export { NATIVE_SCORE_FLOOR } from "./retrieval";
export type { NativeObservationMatch } from "./retrieval";
/** Store-time resolution: find by evidence, confirm by identity. The DECISION is pure and exported
 *  so a host can reason about (or test against) the exact bands its stores resolve under. */
export { DECIDED_RESOLUTION_MODES, isDecidedResolutionMode, resolveIncoming } from "./resolution";
export type {
  ResolutionCentroidCandidate,
  ResolutionDecision,
  ResolutionInput,
  ResolutionMode,
  ResolutionNomination,
  ResolutionThresholds,
} from "./resolution";
export { chooseStoreEmbedder, FreshStoreEmbedderUnavailableError, PinnedStoreEmbedderUnavailableError } from "./store-embedder";
export type { StoragePort, Statement, RunResult, PragmaOptions } from "./storage";
export { renderOverview } from "./render-overview";
export { extractEntities } from "./extract-entities";
export type { ExtractedEntity, EntityKind } from "./extract-entities";
export { HashingEmbeddingProvider, cosine, validateEmbeddingProviderOutput } from "./embedding";
export type { EmbeddingProvider, EmbeddingThresholds } from "./embedding";
export {
  OnnxEmbeddingProvider,
  createLocalEmbedder,
  createLocalEmbedderWithProvenance,
  instantiateEmbedderForPin,
  parseHashingEmbedderPin,
  knownModelProfileIds,
  UnsatisfiableEmbedderError,
  LEGACY_ONNX_DEFAULT_MODEL_ID,
} from "./embedding-onnx";
export type { LocalEmbedderSelection, LocalEmbedderWithProvenance } from "./embedding-onnx";
export { DeterministicSynthesizer } from "./synthesis";
export type { Synthesizer } from "./synthesis";
export { createMonetCoreMcpServer } from "./mcp-server";
// Re-exported for the CLI's gate payload, which must not emit a circle longer than the value
// `stage_lookup` will accept — restating the number there would let the two drift apart.
export { CIRCLE_NAME_MAX_CHARS } from "./mcp-server";
export type { CreateMonetCoreMcpServerOptions } from "./mcp-server";
export { deriveCircle } from "./circle";

/** The startup failure record (#13) — a server that dies before the transport connects has no
 *  protocol channel to say why, so the cause is written beside the store instead. Exported because
 *  the writers are the ENTRY POINTS, which live in the CLI package, and the reader is `monet
 *  doctor`, which lives there too. */
export {
  STARTUP_FAILURE_FORMAT,
  STARTUP_FAILURE_SUFFIX,
  inStartupPhase,
  markStartupPhase,
  readStartupFailure,
  recordStartupFailure,
  startupFailurePath,
  startupPhaseOf,
} from "./startup-diagnosis";
export type {
  RecordStartupFailureOptions,
  StartupFailureRead,
  StartupFailureRecord,
  StartupPhase,
} from "./startup-diagnosis";

export type {
  GraftPayload,
  GraftResult,
  SyncConceptRow,
  SyncObservationRow,
  SyncRevisionRow,
  SyncContradictionRow,
  SyncEdgeRow,
  SyncFirstBlockRow,
  SyncCircleAliasRow,
  SyncEntityRow,
  SyncConceptEntityRow,
  SyncConceptTombstoneRow,
  SyncConceptRestorationRow,
  SyncSessionRow,
  SyncLifecycleEdgeRow,
  SyncRatificationRow,
  SyncStageRow,
  SyncRuleBindingRow,
} from "./sync-types";

/** The governed-moment record — the unit is an instant where an agent is about to act and the gate
 *  has jurisdiction. The spool is the append-only sink every writer can reach (including the
 *  standalone host hook, which can open no store); the ledger is what the fold makes queryable.
 *  Exported because the writers live in more than one process, and a second record shape would put
 *  the two populations beyond joining. */
export {
  MOMENT_ACTION_RENDERING_MAX_CHARS,
  MOMENT_SPOOL_FILENAME,
  MOMENT_SPOOL_FORMAT,
  appendMomentRecord,
  mintMomentId,
  outcomeSha256,
  parseMomentSpoolLine,
  readMomentSpool,
  renderAction,
  spoolAnswer,
  spoolAsk,
  spoolInterception,
  spoolOutcome,
  spoolRuleRead,
  startMomentRun,
} from "./moment-spool";
export type {
  MomentAnswer,
  MomentDisposition,
  MomentInterception,
  MomentInterceptionFields,
  MomentRun,
  MomentSpoolEnvelope,
  MomentSpoolRead,
  MomentSpoolRecord,
  MomentWriterRole,
} from "./moment-spool";
export {
  MOMENT_SCHEMA_SQL,
  UnknownMomentError,
  attachMomentAnswer,
  attachMomentAsk,
  createMomentTables,
  foldMomentSpool,
  momentConformance,
  momentsOwingAQuestion,
  observedMomentLosses,
  readGovernedMoment,
} from "./moment-ledger";
export type { GovernedMomentRow, MomentConformance, MomentFoldResult, MomentLoss } from "./moment-ledger";


export {
  connectorPopulation,
  dropRetiredSourceResidue,
  isRetirementDisposed,
  RetiredResidueNotEmptyError,
  retirementData,
  hybridConnectorConcepts,
  purgeConnectorPopulation,
  RETIRED_SOURCE_TABLES,
} from "./source-retirement";
export type { ConnectorPopulation, RetirementData } from "./source-retirement";
