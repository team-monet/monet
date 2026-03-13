import { Hono } from "hono";
import type { AppEnv } from "../middleware/context";
import {
  BootstrapTokenError,
  exchangeBootstrapToken,
  getBootstrapStatus,
} from "../services/bootstrap.service";

export const bootstrapRouter = new Hono<AppEnv>();

bootstrapRouter.get("/status", async (c) => {
  const db = c.get("db");
  const status = await getBootstrapStatus(db);
  return c.json(status);
});

bootstrapRouter.post("/exchange", async (c) => {
  const body = await c.req.json().catch(() => null);
  const token =
    body && typeof body === "object" && "token" in body
      ? body.token
      : null;

  if (typeof token !== "string") {
    return c.json(
      { error: "validation_error", message: "Bootstrap token is required" },
      400,
    );
  }

  const db = c.get("db");

  try {
    const result = await exchangeBootstrapToken(db, token);
    return c.json(
      {
        setupSessionToken: result.sessionToken,
        expiresAt: result.expiresAt.toISOString(),
      },
      200,
    );
  } catch (error) {
    if (error instanceof BootstrapTokenError) {
      return c.json(
        { error: "bootstrap_error", message: error.message },
        error.status,
      );
    }

    throw error;
  }
});
