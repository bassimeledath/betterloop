export interface Env {
  DB: D1Database;
  PHOTOS?: R2Bucket;
  BACKUPS?: R2Bucket;
  ASSETS?: Fetcher;
  ENVIRONMENT: "local" | "test" | "production";
  EMAIL_MODE: "capture" | "live" | "disabled";
  OPERATOR_EMAIL: string;
  APP_ORIGIN?: string;
  OUTBOX_KEY: string;
  CF_ACCOUNT_ID?: string;
  CF_EMAIL_TOKEN?: string;
  EMAIL_ROUTING_API?: Fetcher;
  EMAIL_FROM?: string;
  EMAIL?: {
    send(message: {
      from: string | { email: string; name: string };
      to: string;
      subject: string;
      html: string;
      text: string;
      attachments?: import("./email-images").InlineImage[];
    }): Promise<{ messageId: string }>;
  };
}
import type { User, Session } from "../shared/contracts";
export type * from "../shared/contracts";
export type App = {
  Bindings: Env;
  Variables: { session: Session; requestId: string };
};
