export type PlatformActionState = {
  status: "idle" | "success" | "error";
  message: string;
};

export const initialPlatformActionState: PlatformActionState = {
  status: "idle",
  message: "",
};
