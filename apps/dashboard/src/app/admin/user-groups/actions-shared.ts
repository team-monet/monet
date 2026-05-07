export type UserGroupActionState = {
  status: "idle" | "success" | "error";
  message: string;
};

export const initialUserGroupActionState: UserGroupActionState = { status: "idle", message: "" };

export type MemberActionState = {
  status: "idle" | "success" | "error";
  message?: string;
  action?: "add" | "remove";
  userId?: string;
};
