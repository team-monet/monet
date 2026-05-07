export type QuotaActionState = {
  status: "idle" | "success" | "error";
  message: string;
};

export const initialQuotaActionState: QuotaActionState = {
  status: "idle",
  message: "",
};
