export type SetupActionState = {
  status: "idle" | "success" | "error";
  message: string;
};

export const INITIAL_SETUP_ACTION_STATE: SetupActionState = {
  status: "idle",
  message: "",
};
