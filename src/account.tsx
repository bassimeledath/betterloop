import React, { useEffect, useState } from "react";
import type { User } from "../server/types";
import { api } from "./api";
import { PageHeading, Button, ErrorMessage, useData, when, go } from "./ui";
type Me = { user: User; csrf: string };
type Job = {
  id: string;
  kind: string;
  group_id: string | null;
  state: string;
  bytes: number;
  created_at: number;
  expires_at: number;
  error_code: string | null;
};
export function ExportsPanel({ groupId }: { groupId?: string }) {
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const { data, error, refresh } = useData<{ exports: Job[] }>("/exports"),
    [failure, setFailure] = useState(""),
    [busy, setBusy] = useState(false);
  const active = data?.exports.some((j) =>
    ["planning", "building"].includes(j.state),
  );
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => void refresh(), 3000);
    return () => clearInterval(timer);
  }, [active, refresh]);
  async function create() {
    setBusy(true);
    setFailure("");
    try {
      await api(groupId ? "/groups/" + groupId + "/exports" : "/me/exports", {
        method: "POST",
        body: { requestId },
      });
      await refresh();
      setRequestId(crypto.randomUUID());
    } catch (e) {
      setFailure((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="panel">
      <h2 className="panel-title">📦 Keep a copy</h2>
      <p className="small">
        {groupId
          ? "Export published issues and their original processed photos. Other people’s private drafts are excluded."
          : "Export your own saved drafts, submitted updates, and photos."}{" "}
        Downloads are private TAR archives and expire after 24 hours.
      </p>
      <ErrorMessage error={error || failure} />
      <Button secondary onClick={() => void create()} disabled={busy || active}>
        {busy
          ? "Requesting…"
          : active
            ? "Preparing an archive…"
            : groupId
              ? "Prepare group export"
              : "Export my contributions"}
      </Button>
      {data?.exports
        .filter((j) =>
          groupId ? j.group_id === groupId : j.kind === "personal",
        )
        .map((j) => (
          <div className="export-row" key={j.id}>
            <div>
              <strong>
                {j.kind === "group" ? "Group archive" : "My contributions"}
              </strong>
              <small>
                {when(j.created_at)} ·{" "}
                {j.expires_at <= Date.now() ? "Expired" : j.state}
                {j.error_code ? " · " + j.error_code.replaceAll("_", " ") : ""}
              </small>
            </div>
            {j.state === "ready" && j.expires_at > Date.now() && (
              <a
                className="download"
                href={"/api/exports/" + j.id + "/download"}
              >
                Download TAR
              </a>
            )}
          </div>
        ))}
      <p className="small export-help">
        An archive may take a few minutes to prepare. You can leave this page
        and come back.
      </p>
    </div>
  );
}
export function ConfirmEmailScreen({
  reload,
}: {
  reload: () => Promise<void>;
}) {
  const [token] = useState(() => {
      const t = new URLSearchParams(location.hash.slice(1)).get("token") || "";
      history.replaceState(null, "", location.pathname);
      return t;
    }),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  async function confirm() {
    setBusy(true);
    try {
      await api("/me/email/confirm", { method: "POST", body: { token } });
      await reload();
      go("/profile");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <span className="kicker">A NEW INBOX</span>
      <PageHeading>Make the move?</PageHeading>
      <div className="panel">
        <p>
          Confirm this address for your existing Betterloop account. Other
          sessions will be signed out; this device stays signed in.
        </p>
        <ErrorMessage error={error} />
        <Button onClick={() => void confirm()} disabled={busy || !token}>
          {busy ? "Confirming…" : "Confirm my new email"}
        </Button>
      </div>
    </>
  );
}
export function ProfileScreen({
  me,
  reload,
  onLogout,
}: {
  me: Me;
  reload: () => Promise<void>;
  onLogout: () => void;
}) {
  const [name, setName] = useState(me.user.name),
    [newEmail, setNewEmail] = useState(""),
    [error, setError] = useState(""),
    [message, setMessage] = useState(""),
    [confirmEmail, setConfirmEmail] = useState(""),
    [removePublished, setRemovePublished] = useState(false),
    [busy, setBusy] = useState(false);
  const sessions = useData<{
    sessions: {
      id: string;
      createdAt: number;
      expiresAt: number;
      current: boolean;
    }[];
  }>("/me/sessions");
  const transfers = useData<{
    transfers: {
      id: string;
      group_id: string;
      name: string;
      expires_at: number;
    }[];
  }>("/me/transfers");
  async function changeEmail(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    try {
      const r = await api<{ message: string }>("/me/email", {
        method: "POST",
        body: { email: newEmail },
      });
      setMessage(r.message);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function deleteAccount(e: React.FormEvent) {
    e.preventDefault();
    if (
      !confirm(
        "Delete your account? Your sessions and private drafts will be removed. Sent email copies cannot be recalled.",
      )
    )
      return;
    setBusy(true);
    try {
      await api("/me", {
        method: "DELETE",
        body: { email: confirmEmail, removePublished },
      });
      onLogout();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <span className="kicker">YOUR ACCOUNT</span>
      <PageHeading>Make this feel like you.</PageHeading>
      <ErrorMessage error={error || sessions.error || transfers.error} />
      {message && (
        <p className="notice" role="status">
          {message}
        </p>
      )}
      <div className="panel">
        <label>
          Display name
          <input
            value={name}
            maxLength={80}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <p className="small">{me.user.email}</p>
        <Button
          onClick={async () => {
            try {
              await api("/me", { method: "PATCH", body: { name } });
              await reload();
              setMessage("Your profile is saved.");
            } catch (e) {
              setError((e as Error).message);
            }
          }}
        >
          Save profile
        </Button>
      </div>
      {transfers.data?.transfers.map((t) => (
        <div className="panel" key={t.id}>
          <h2 className="panel-title">Take over {t.name}?</h2>
          <p className="small">
            The current owner invited you to manage this group. Accept before{" "}
            {when(t.expires_at)}.
          </p>
          <Button
            secondary
            onClick={async () => {
              try {
                await api(
                  "/groups/" + t.group_id + "/transfers/" + t.id + "/accept",
                  { method: "POST" },
                );
                await transfers.refresh();
                setMessage("You are now the group owner.");
              } catch (e) {
                setError((e as Error).message);
              }
            }}
          >
            Accept ownership
          </Button>
        </div>
      ))}
      <form className="panel" onSubmit={changeEmail}>
        <h2 className="panel-title">📬 A new inbox?</h2>
        <p className="small">
          Your current address stays active until you confirm the new one. The
          host verifies new email destinations first.
        </p>
        <label>
          New email address
          <input
            required
            type="email"
            value={newEmail}
            onChange={(e) => setNewEmail(e.target.value)}
          />
        </label>
        <button className="button secondary">Request email change</button>
      </form>
      <div className="panel">
        <h2 className="panel-title">Your signed-in devices</h2>
        {sessions.data?.sessions.map((s) => (
          <div className="member-row" key={s.id}>
            <div>
              <strong>{s.current ? "This device" : "Another session"}</strong>
              <small>
                Signed in {when(s.createdAt)}
                <br />
                Expires {when(s.expiresAt)}
              </small>
            </div>
            {!s.current && (
              <button
                className="quiet"
                onClick={async () => {
                  try {
                    await api("/me/sessions/" + s.id, { method: "DELETE" });
                    await sessions.refresh();
                  } catch (e) {
                    setError((e as Error).message);
                  }
                }}
              >
                Sign out
              </button>
            )}
          </div>
        ))}
        <Button
          secondary
          onClick={async () => {
            try {
              await api("/me/sessions", { method: "DELETE" });
              await sessions.refresh();
              setMessage("Other sessions are signed out.");
            } catch (e) {
              setError((e as Error).message);
            }
          }}
        >
          Sign out other devices
        </Button>
      </div>
      <ExportsPanel />
      <details className="panel">
        <summary>Delete my account</summary>
        <form onSubmit={deleteAccount}>
          <p className="small">
            Transfer or delete any groups you own first. Private drafts are
            removed. You can also remove your published contributions from web
            archives. Previously sent emails cannot be recalled.
          </p>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={removePublished}
              onChange={(e) => setRemovePublished(e.target.checked)}
            />{" "}
            Remove my published contributions and photos too
          </label>
          <label>
            Type your current email to confirm
            <input
              required
              type="email"
              value={confirmEmail}
              onChange={(e) => setConfirmEmail(e.target.value)}
            />
          </label>
          <button className="button danger" disabled={busy}>
            {busy ? "Deleting…" : "Delete account"}
          </button>
        </form>
      </details>
      <Button
        secondary
        onClick={async () => {
          await api("/auth/logout", { method: "POST" });
          onLogout();
        }}
      >
        Sign out
      </Button>
    </>
  );
}
