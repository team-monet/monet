export {
  MonetCore,
  EmbedderMismatchError,
  contextualizeSourceChunk,
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
  SourceConceptRollbackResult,
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
  SourceStoreOpts,
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
export { inspectStoredEmbedderState, StoredEmbedderStateDiagnosticError, inspectLifecycleEdgeIntegrity } from "./diagnostics";
export type {
  StoredDatabaseIntegrity,
  StoredEmbedderDiagnosticFailureReason,
  StoredEmbedderMigration,
  StoredEmbedderPin,
  StoredEmbedderSafetyAssessment,
  StoredEmbedderStateInspection,
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
  gateStats,
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
  GateStats,
  GateStatsOptions,
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
export {
  DEFAULT_SOURCE_SCANNER_LIMITS,
  SOURCE_SCANNER_VERSION,
  computeSourceIngestConfigHash,
  computeSourceManifestHash,
  effectiveSourceScanConfig,
  isMarkdownSourcePath,
  matchesSourceGlob,
  scanSourceSnapshot,
} from "./source-scanner";
export {
  DEFAULT_SOURCE_MAX_CHUNKS,
  SOURCE_CHUNKER_VERSION,
  chunkSourceText,
  canonicalizeSourceChunkMetadata,
  computeSourceContentHash,
  computeSourceIngestFingerprint,
  computeSourceOperationId,
  computeSourceRefOccurrences,
  hashSourceDomain,
  sourceHeadingIdentityKey,
  sourceHeadingAnchor,
} from "./source-chunker";
export type { GitMdSyncOptions, GitMdSyncResult, RepoMdSyncOptions, RepoMdSyncResult } from "./source-sync";
export type { GitCredential, GitCredentialProvider, GitCredentialRequest, RemoteGitOptions } from "./source-git";
export { runRemoteGit } from "./source-git";
export type { StoragePort, Statement, RunResult, PragmaOptions } from "./storage";
export type {
  EffectiveSourceScanConfig,
  EffectiveSourceScanConfigInput,
  ScanSourceSnapshotInput,
  SourceScanDiagnostic,
  SourceScanDiagnosticCode,
  SourceScanFile,
  SourceScanResult,
  SourceScannerLimits,
} from "./source-scanner";
export type {
  ChunkSourceTextInput,
  ChunkSourceTextResult,
  SourceChunk,
  SourceChunkDiagnostic,
  SourceChunkMetadata,
  SourceHeadingIdentity,
} from "./source-chunker";
export type {
  SourceType,
  SourceWriteBack,
  SourceRefreshMode,
  SourceLifecycle,
  SourceStatus,
  SourceTransportScheme,
  SourceAccessPolicy,
  SourceTransportPolicy,
  SourceRefreshPolicy,
  SourceRepoMapping,
  CreateRepoMdSource,
  CreateGitMdSource,
  CreateSourceInput,
  UpdateSourceInput,
  KnowledgeSource,
  SourceListOptions,
  SourceGetOptions,
  SourceAuthorizationContext,
  ConnectorSourceSummary,
  ConnectorSourceStatus,
  ConnectorSourcePath,
  SourceRunFence,
  SourceSyncRunState,
  SourceSyncRunResult,
  SourceChunkWriteState,
  SourceSyncRun,
  BeginSourceRunInput,
  BeginSourceRunResult,
  SourceManifestFileInput,
  SourceManifestChunkInput,
  SourceManifestSkippedFileInput,
  StageSourceManifestInput,
  RecordSourceBindingReceiptInput,
  PublishSourceRunInput,
  SourceFileRecord,
  SourceChunkRecord,
  SourceSkippedFileRecord,
  SourceCleanupItem,
  SourceRemoval,
  SourceRemovalItem,
  SourceScheduleState,
  SourceScheduleStatus,
} from "./source-types";
export { createSourceScheduler, planSourceDue } from "./source-scheduler";
export type {
  PlanSourceDueInput,
  ScheduledSourceCore,
  SourceDuePlan,
  SourceSchedulerHandle,
  SourceSchedulerOptions,
} from "./source-scheduler";
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
  UnsatisfiableEmbedderError,
  LEGACY_ONNX_DEFAULT_MODEL_ID,
} from "./embedding-onnx";
export type { LocalEmbedderSelection, LocalEmbedderWithProvenance } from "./embedding-onnx";
export { DeterministicSynthesizer } from "./synthesis";
export type { Synthesizer } from "./synthesis";
export { createMonetCoreMcpServer } from "./mcp-server";
export type { CreateMonetCoreMcpServerOptions } from "./mcp-server";
export { deriveCircle } from "./circle";
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

/** The gate journal (`docs/design/normative-hierarchy-2026-08-03.md` §1/§5) — the record every
 *  governing mechanism appends what it actually did to, including its declines. Exported because
 *  the mouths live in two repos: core's own gate and stage-lookup write it here, and the host-side
 *  CLI writes it from monet-client. One stream, or the correlation between them is guesswork. */
export {
  GATE_JOURNAL_CONTEXT_MAX_CHARS,
  GATE_JOURNAL_FILENAME,
  GATE_JOURNAL_FORMAT,
  GATE_JOURNAL_MAX_BYTES,
  appendGateJournalLine,
  clipActionContext,
  closeGateJournalEvent,
  gateJournalDisposition,
  openGateJournalEvent,
} from "./gate-journal";
export type {
  GateJournalArrival,
  GateJournalClaimType,
  GateJournalDisposition,
  GateJournalDispositionFields,
  GateJournalHandle,
  GateJournalMouth,
} from "./gate-journal";

/** The conformance pass, cheap half (`normative-hierarchy-2026-08-03.md` §4/§7.3) — what the gate
 *  journal can say about whether a rule changed anything, claiming only what it observes. */
export {
  appendConformanceAnnotations,
  computeConformance,
  retirementCandidates,
  tallyByRule,
} from "./conformance";
export type {
  ConformanceAnnotation,
  ConformanceVerdict,
  JournalDispositionLine,
  RuleConformanceTally,
} from "./conformance";
