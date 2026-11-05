import React, { useState, useEffect, useRef, useCallback } from "react";
import {
  ArrowLeft,
  Settings,
  PlusCircle,
  Image as ImageIcon,
  MoreHorizontal,
  Mail,
  Lock,
  Flower2,
} from "lucide-react";
import { api, setCsrf, ApiError } from "./api";
import { Button, PageHeading, ErrorMessage, useData, when, go } from "./ui";
import type {
  Me,
  Detail,
  Q,
  Group,
  Issue,
  User,
  Member,
  Update,
  Publication,
} from "../shared/contracts";
export function Signin({
  local,
  returnPath,
}: {
  local: boolean;
  returnPath: string;
}) {
  const [email, setEmail] = useState(""),
    [message, setMessage] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const r = await api<{ message: string }>("/auth/request", {
        method: "POST",
        body: { email, returnPath },
      });
      setMessage(r.message);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <span className="kicker">YOUR INBOX IS YOUR KEY</span>
      <PageHeading>Your people saved you a spot.</PageHeading>
      <p className="muted">
        A few questions. Your photos and stories. One letter that brings
        everyone together.
      </p>
      <form className="panel" onSubmit={submit}>
        <h2 className="panel-title">Sign in</h2>
        <p className="small">
          Use the same email to return to your existing account on this device.
          No password needed.
        </p>
        <label>
          Email address
          <input
            type="email"
            required
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>
        <ErrorMessage error={error} />
        {message ? (
          <p role="status" className="notice">
            {message}
          </p>
        ) : (
          <p className="small">
            No password. Your sign-in link expires after 15 minutes.
          </p>
        )}
        <button className="button" disabled={busy}>
          {busy ? "Sending…" : "Email me a sign-in link"}
        </button>
      </form>
      {local && (
        <p className="small">
          Local development captures mail below. No email is sent.
        </p>
      )}
    </>
  );
}
export function Confirm({ onDone }: { onDone: () => Promise<void> }) {
  const [{ secret, joining, retryPath }] = useState(() => {
      const params = new URLSearchParams(location.hash.slice(1));
      const value = {
        secret: params.get("token") || "",
        joining: (params.get("joining") || "").slice(0, 80),
        retryPath: /^\/join#token=[a-f0-9]{64}&signup=[a-f0-9]{64}$/.test(
          params.get("returnPath") || "",
        )
          ? params.get("returnPath")!
          : "/signin",
      };
      history.replaceState(null, "", location.pathname);
      return value;
    }),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  async function consume() {
    setBusy(true);
    try {
      const r = await api<{ csrf: string; returnPath: string }>(
        "/auth/consume",
        { method: "POST", body: { token: secret } },
      );
      setCsrf(r.csrf);
      await onDone();
      go(r.returnPath);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <span className="kicker">
        {joining ? "ONE LAST STEP" : "WELCOME BACK"}
      </span>
      <PageHeading>Come on in.</PageHeading>
      <div className="panel">
        <p>
          {joining ? (
            <>
              Confirm your email to join <strong>{joining}</strong>. You’ll be
              added automatically and can read the group’s past issues.
            </>
          ) : (
            "Confirm that you want to sign in to Betterloop on this device."
          )}
        </p>
        <ErrorMessage error={error} />
        {error ? (
          <Button to={joining ? retryPath : "/signin"}>
            Request a fresh link
          </Button>
        ) : (
          <Button onClick={consume} disabled={busy || !secret}>
            {busy
              ? "Signing in…"
              : joining
                ? "Confirm & join"
                : "Confirm sign-in"}
          </Button>
        )}
      </div>
    </>
  );
}
export function Invitation({
  me,
  onLogin,
}: {
  me: Me | null;
  onLogin: () => void;
}) {
  const [token] = useState(
    () => new URLSearchParams(location.hash.slice(1)).get("token") || "",
  );
  const [data, setData] = useState<{
      invitation: {
        name: string;
        description: string;
        email: string;
        verified: number;
      };
    } | null>(null),
    [error, setError] = useState(""),
    [failure, setFailure] = useState("");
  useEffect(() => {
    let active = true;
    void api<{
      invitation: {
        name: string;
        description: string;
        email: string;
        verified: number;
      };
    }>("/invitations/inspect", { method: "POST", body: { token } })
      .then((value) => {
        if (active) setData(value);
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [token]);
  async function accept() {
    try {
      const r = await api<{ groupId: string }>("/invitations/accept", {
        method: "POST",
        body: { token },
      });
      go("/groups/" + r.groupId);
    } catch (e) {
      setFailure((e as Error).message);
    }
  }
  return (
    <>
      <span className="kicker">A SEAT AT THE TABLE</span>
      <PageHeading>{data?.invitation.name || "Your invitation"}</PageHeading>
      <ErrorMessage error={error || failure} />
      {data && (
        <div className="panel">
          <p>{data.invitation.description}</p>
          <p>Invited as {data.invitation.email}</p>
          <p className="small">
            After joining you can read past issues. Submitted stories may be
            copied into the group’s emails. Drafts remain private.
          </p>
          {!data.invitation.verified && (
            <p className="notice">
              Your host needs to verify your email destination first. Look for a
              verification email from Cloudflare.
            </p>
          )}
          <Button onClick={me ? accept : onLogin}>
            {me ? "Accept invitation" : "Sign in to accept"}
          </Button>
        </div>
      )}
    </>
  );
}
