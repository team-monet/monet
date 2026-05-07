export type MemoryMutationActionState = {
  status: "idle" | "success" | "error";
  message: string;
};

export const initialMemoryMutationActionState: MemoryMutationActionState = {
  status: "idle",
  message: "",
};
