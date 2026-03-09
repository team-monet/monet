export type AgentTokenActionState =
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
      apiKey: string;
      mcpUrl: string;
      mcpConfig: string;
    };

export type AgentMutationActionState =
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
    };

export const initialAgentTokenActionState: AgentTokenActionState = {
  status: "idle",
};

export const initialAgentMutationActionState: AgentMutationActionState = {
  status: "idle",
};
