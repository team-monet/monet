import { describe, expect, it } from "vitest";
import {
  EmbedderMigrationAbandonRefusedError,
  EmbedderMigrationAbandonUnsupportedError,
  EmbedderMigrationConflictError,
  EmbedderMigrationFailedError,
  EmbedderMigrationIncompleteError,
  EmbedderPinUnsatisfiedError,
  EmbedderWidthConflictError,
  MalformedEmbeddingStoreError,
  type EmbeddingWidthInventory,
} from "../engine";
import { instantiateEmbedderForPin, UnsatisfiableEmbedderError } from "../embedding-onnx";

const emptyWidths: EmbeddingWidthInventory = {
  observationDims: [256],
  conceptDims: [256],
  malformed: {
    nativeObservations: { count: 0, sampleIds: [] },
    nativeConcepts: { count: 0, sampleIds: [] },
  },
};

const forbiddenPrivateGuidance = [
  "scripts/migrate-file-concept.ts",
  "adoptEmbedderPin()",
  "core.ensureEmbedderPin()",
  "upgrade monet-core",
];

describe("shipped recovery error guidance", () => {
  const previewCases: Array<[string, () => Error]> = [
    ["pin mismatch", () => new EmbedderPinUnsatisfiedError("old", "new")],
    ["width conflict", () => new EmbedderWidthConflictError(384, [256], "native")],
    [
      "malformed vectors",
      () => new MalformedEmbeddingStoreError({
        ...emptyWidths.malformed,
        nativeObservations: { count: 1, sampleIds: ["bad"] },
      }),
    ],
  ];

  it.each(previewCases)("%s names doctor and the exact target preview command", (_name, makeError) => {
    const message = makeError().message;
    expect(message).toContain("`monet doctor`");
    expect(message).toContain("`monet repair --target <onnx|hashing|exact-model-id>`");
    for (const forbidden of forbiddenPrivateGuidance) expect(message).not.toContain(forbidden);
  });

  const resumeCases: Array<[string, () => Error, boolean]> = [
    ["conflicting active target", () => new EmbedderMigrationConflictError("new", "active", 123), true],
    ["incomplete sentinel", () => new EmbedderMigrationIncompleteError("active", 123), true],
    [
      "failed migration",
      () => new EmbedderMigrationFailedError({
        targetModelId: "active",
        dryRun: false,
        phases: { complete: { total: 1, completed: 0, failed: 1 } } as any,
        failures: [{ phase: "complete", id: "store", message: "failure" }],
      }),
      false,
    ],
    ["unsafe abandon", () => new EmbedderMigrationAbandonRefusedError("active", 123, emptyWidths), true],
    ["unsupported abandon", () => new EmbedderMigrationAbandonUnsupportedError("active", 123), true],
  ];

  it.each(resumeCases)("%s names the exact active-sentinel command", (_name, makeError, expectsBackup) => {
    const message = makeError().message;
    expect(message).toContain("`monet repair --resume --apply --yes`");
    if (expectsBackup) expect(message).toMatch(/verified backup/i);
    for (const forbidden of forbiddenPrivateGuidance) expect(message).not.toContain(forbidden);
  });

  it("UnsatisfiableEmbedderError directs upgrades to the shipped package", async () => {
    let caught: unknown;
    try {
      await instantiateEmbedderForPin("future-format-without-slash");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(UnsatisfiableEmbedderError);
    expect((caught as Error).message).toContain("@team-monet/monet");
    expect((caught as Error).message).not.toContain("upgrade monet-core");
  });
});
