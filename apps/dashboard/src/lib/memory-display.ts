import type { MemoryEntry, MemoryEntryTier1 } from "@monet/types";

type MemoryAuthorInput = Pick<
  MemoryEntry | MemoryEntryTier1,
  "authorAgentId" | "authorAgentDisplayName"
>;

export function formatMemoryAuthor(memory: MemoryAuthorInput) {
  return memory.authorAgentDisplayName ?? memory.authorAgentId;
}
