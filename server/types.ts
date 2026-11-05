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
      from: string;
      to: string;
      subject: string;
      html: string;
      text: string;
    }): Promise<{ messageId: string }>;
  };
}
export interface User {
  id: string;
  email: string;
  name: string;
  operator: number;
  group_allowance: number;
  deleted_at: number | null;
  created_at: number;
}
export interface Session {
  user: User;
  csrf: string;
  tokenHash: string;
}
export type App = {
  Bindings: Env;
  Variables: { session: Session; requestId: string };
};
export interface Group {
  id: string;
  name: string;
  description: string;
  owner_id: string;
  timezone: string;
  cadence: "weekly" | "fortnightly" | "monthly";
  recurrence_json: string;
  next_delivery: number;
  paused: number;
  deleted_at: number | null;
  revision: number;
}
export interface Member {
  group_id: string;
  user_id: string;
  role: "owner" | "admin" | "member";
  active: number;
  notify_open: number;
  notify_reminder: number;
  notify_issue: number;
}
export interface Issue {
  id: string;
  group_id: string;
  title: string;
  opens_at: number;
  deadline: number;
  delivery_at: number;
  state:
    "scheduled" | "open" | "closing" | "published" | "skipped" | "cancelled";
  revision: number;
  reminder_at: number;
  reminded_at: number | null;
}
export interface Contribution {
  issue_id: string;
  group_id: string;
  user_id: string;
  draft_json: string;
  submitted_json: string | null;
  revision: number;
  submitted_at: number | null;
  updated_at: number;
}
export interface Update {
  answers: Record<string, string>;
  photos: { id: string; caption: string }[];
  shoutout: string;
  good: string;
}
export interface Publication {
  schemaVersion: 1;
  groupName: string;
  title: string;
  questions: {
    id: string;
    text: string;
    author_name: string;
    author_id?: string | null;
  }[];
  contributors: { id: string; name: string; update: Update }[];
}
