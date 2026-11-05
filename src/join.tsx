import React, { useState, useEffect } from "react";
import { api } from "./api";
import { PageHeading, Button, ErrorMessage, useData, go } from "./ui";
import type { User } from "../shared/contracts";
type LinkInfo = { enabled: boolean; configured: boolean; url: string | null };
export function SharedLinkPanel({ gid }: { gid: string }) {
  const { data, error, refresh } = useData<LinkInfo>(
      "/groups/" + gid + "/join-link",
    ),
    [failure, setFailure] = useState(""),
    [busy, setBusy] = useState(false),
    [copied, setCopied] = useState(false);
  async function change(action: "enable" | "rotate" | "disable") {
    if (
      action === "rotate" &&
      !confirm(
        "Replace the group link? The old link and unfinished signups will stop working.",
      )
    )
      return;
    if (
      action === "disable" &&
      !confirm(
        "Close the group link? Existing members keep access. New friends will need a new link or a personal invitation.",
      )
    )
      return;
    setBusy(true);
    setFailure("");
    setCopied(false);
    try {
      await api("/groups/" + gid + "/join-link", {
        method: action === "disable" ? "DELETE" : "POST",
        ...(action !== "disable"
          ? { body: { rotate: action === "rotate" } }
          : {}),
      });
      await refresh();
    } catch (e) {
      setFailure((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="panel">
      <h2 className="panel-title">One link for your people.</h2>
      <p>
        Post this link in your WhatsApp group. Friends enter their own email,
        confirm it, and join automatically.
      </p>
      <p className="small">
        Anyone with the link can join and read past issues. Your group has room
        for 20 members. You can close or replace the link at any time.
      </p>
      <ErrorMessage error={error || failure} />
      {data && !data.configured && (
        <p className="notice">
          Automatic email signup needs one setup step from the host before this
          link can be enabled.
        </p>
      )}
      {data?.enabled && data.url ? (
        <>
          <label>
            Share your group link
            <input
              readOnly
              value={data.url}
              onFocus={(e) => e.target.select()}
            />
          </label>
          <div className="row">
            <Button
              disabled={busy || !data.configured}
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(data.url!);
                  setCopied(true);
                } catch {
                  setFailure("Select the group link above and copy it.");
                }
              }}
            >
              {copied ? "Copied ✓" : "Copy group link"}
            </Button>
            <button
              className="quiet"
              disabled={busy}
              onClick={() => void change("rotate")}
            >
              Replace link
            </button>
            <button
              className="quiet"
              disabled={busy}
              onClick={() => void change("disable")}
            >
              Close link
            </button>
          </div>
        </>
      ) : (
        <Button
          disabled={busy || !data?.configured}
          onClick={() => void change("enable")}
        >
          {busy ? "Creating…" : "Create group link"}
        </Button>
      )}
    </div>
  );
}
export function GroupJoin({ me }: { me: { user: User } | null }) {
  const [fragment, setFragment] = useState(location.hash),
    [info, setInfo] = useState<{
      name: string;
      description: string;
      full: boolean;
    } | null>(null),
    [name, setName] = useState(""),
    [email, setEmail] = useState(""),
    [requestId, setRequestId] = useState(() => crypto.randomUUID()),
    [stage, setStage] = useState("starting"),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const params = new URLSearchParams(fragment.slice(1)),
    token = params.get("token") || "",
    signup = params.get("signup") || "";
  useEffect(() => {
    const update = () => setFragment(location.hash);
    window.addEventListener("hashchange", update);
    window.addEventListener("popstate", update);
    return () => {
      window.removeEventListener("hashchange", update);
      window.removeEventListener("popstate", update);
    };
  }, []);
  useEffect(() => {
    let active = true;
    setInfo(null);
    setError("");
    void api<{ name: string; description: string; full: boolean }>(
      "/join/inspect",
      { method: "POST", body: { token } },
    )
      .then((r) => {
        if (active) setInfo(r);
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [token]);
  async function check(resend = false) {
    try {
      setError("");
      const r = await api<{ stage: string }>(
        "/join/" + (resend ? "resend" : "status"),
        { method: "POST", body: { ticket: signup } },
      );
      setStage(r.stage);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  useEffect(() => {
    if (!signup || me) return;
    let active = true;
    const started = Date.now();
    const poll = async () => {
      if (!active || document.hidden || Date.now() - started > 10 * 60000)
        return;
      try {
        const r = await api<{ stage: string }>("/join/status", {
          method: "POST",
          body: { ticket: signup },
        });
        if (active) {
          setStage(r.stage);
          setError("");
        }
      } catch (e) {
        if (active) setError((e as Error).message);
      }
    };
    void poll();
    const timer = setInterval(() => {
      if (stage !== "email" && stage !== "joined") void poll();
    }, 15000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [signup, !!me, stage === "email" || stage === "joined"]);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const r = await api<{ ticket: string; stage: string }>("/join/register", {
        method: "POST",
        body: { token, email, name, requestId },
      });
      const next = "#token=" + token + "&signup=" + r.ticket;
      history.replaceState(null, "", "/join" + next);
      setFragment(next);
      setStage(r.stage);
      setRequestId(crypto.randomUUID());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function accept() {
    setBusy(true);
    setError("");
    try {
      const r = await api<{ groupId: string }>("/join/accept", {
        method: "POST",
        body: { token },
      });
      go("/groups/" + r.groupId);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <span className="kicker">THERE'S A PLACE FOR YOU</span>
      <PageHeading>{info?.name || "Join your people."}</PageHeading>
      <ErrorMessage error={error} />
      {info && (
        <div className="panel">
          <p>{info.description}</p>
          <p className="small">
            Joining gives you access to the group’s past issues. Submitted
            stories may be copied into members’ emails. Your drafts stay
            private.
          </p>
          {me ? (
            <>
              <p>
                Signed in as <strong>{me.user.name}</strong>.
              </p>
              <Button onClick={accept} disabled={busy}>
                {busy ? "Joining…" : "Join this group"}
              </Button>
            </>
          ) : signup ? (
            <>
              <h2 className="panel-title">Check your inbox.</h2>
              <p role="status">
                {stage === "email"
                  ? "Your Betterloop sign-in email is on its way. Confirm it and you’ll join automatically."
                  : stage === "retry"
                    ? "Email setup is taking a little longer. Check again in a minute, or contact your host."
                    : stage === "joined"
                      ? "You’ve joined. Open your Betterloop sign-in email to continue."
                      : "First, open Cloudflare’s verification email and confirm your address. Return here after confirming; your Betterloop sign-in email will follow."}
              </p>
              <p className="small">
                You may receive two emails the first time. After Cloudflare
                verifies your address, use the Betterloop email to finish
                joining. No approval from the host is needed.
              </p>
              <div className="row">
                <Button secondary onClick={() => void check(false)}>
                  Check email status
                </Button>
                <button className="quiet" onClick={() => void check(true)}>
                  {stage === "email"
                    ? "Send a fresh sign-in email"
                    : "Try verification again"}
                </button>
              </div>
            </>
          ) : info.full ? (
            <>
              <p>This group is full. Ask the host for a place.</p>
              <Button
                secondary
                to={
                  "/signin#returnPath=" + encodeURIComponent("/join" + fragment)
                }
              >
                Already a member? Sign in
              </Button>
            </>
          ) : (
            <form onSubmit={submit}>
              <h2 className="panel-title">Come join the group.</h2>
              <label>
                Your name
                <input
                  required
                  maxLength={80}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  autoComplete="name"
                />
              </label>
              <label>
                Email address
                <input
                  required
                  type="email"
                  maxLength={90}
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  autoComplete="email"
                />
              </label>
              <p className="small">
                Already use Betterloop? Enter the same email. We’ll confirm it
                before adding you to this group.
              </p>
              <p className="small">
                You may receive a Cloudflare verification email first, then a
                Betterloop sign-in email. Confirm both to join automatically.
              </p>
              <button className="button" disabled={busy}>
                {busy ? "Starting…" : "Confirm my email & join"}
              </button>
            </form>
          )}
        </div>
      )}
    </>
  );
}
