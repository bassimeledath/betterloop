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
export interface Group {
  cover_id?: string | null;
  cover_caption?: string;
  selected_questions?: number;
  reminder_offsets_json?: string;
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
  reminder_offsets_json?: string;
  reminder_index?: number;
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
  coverId?: string | null;
  coverCaption?: string;
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
export type Detail = {
  group: Group;
  membership: Member;
  members: { id: string; name: string; role: string }[];
  emptyIssues: number;
  issues: (Issue & {
    submitted_count: number;
    my_submitted_at: number | null;
  })[];
};
export type Q = {
  id: string;
  text: string;
  author_name: string;
  selected: number;
  position: number;
};
export type IssueData = {
  issue: Issue & { timezone: string };
  questions: Q[];
  contribution: {
    draft: Update;
    submitted: Update | null;
    revision: number;
    submittedAt: number | null;
  } | null;
  publication: Publication | null;
};

export type Me = { user: User; csrf: string };
