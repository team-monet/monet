export {
  MonetCore,
  EmbedderMismatchError,
  EmbedderPinUnsatisfiedError,
  EmbedderMigrationValidationError,
  EmbedderMigrationConflictError,
  EmbedderMigrationIncompleteError,
  EmbedderMigrationStartError,
  EmbedderMigrationFailedError,
} from "./engine";
export type {
  Concept,
  SourceConceptRollbackResult,
  SearchCard,
  IngestResult,
  IngestAction,
  StoreOpts,
  SourceStoreOpts,
  MonetCoreOptions,
  Workstream,
  WorkstreamPayload,
  PrewarmState,
  LivingModelCard,
  Contradiction,
  PrewarmContradiction,
  GatherResult,
  GatherCard,
  MemoryOverview,
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
} from "./engine";
export { BetterSqlitePort, StorageExclusiveLockError, readStoredEmbedderPin, readStoredVectorPresence } from "./storage";
export { chooseStoreEmbedder, FreshStoreEmbedderUnavailableError } from "./store-embedder";
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
export type { GraphParams } from "./graph";
export { HashingEmbeddingProvider, cosine } from "./embedding";
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
} from "./sync-types";
