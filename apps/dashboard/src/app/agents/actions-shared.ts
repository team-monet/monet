export type RegisterAgentFormState =
  | {
      status: "idle";
      message?: string;
    }
  | {
      status: "error";
      message: string;
    }
  | {
      status: "success";
      message: string;
      agentId: string;
      apiKey: string;
      mcpUrl: string;
      mcpConfig: string;
    };

export const initialRegisterAgentFormState: RegisterAgentFormState = {
  status: "idle",
};
