export type GroupActionState = {
  status: "idle" | "success" | "error";
  message: string;
};

export const initialGroupActionState: GroupActionState = { status: "idle", message: "" };

export type GroupMemberActionState = {
  status: "idle" | "success" | "error";
  message?: string;
  action?: "add" | "remove";
  agentId?: string;
};
