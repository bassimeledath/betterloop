import React, { useState } from "react";
import { api } from "./api";
import { PageHeading, ErrorMessage, useData, when } from "./ui";
type Support = {
  destinations: { email: string; verified: number; suppressed: number }[];
  messages: {
    id: string;
    recipient: string;
    kind: string;
    state: string;
    error_code: string;
  }[];
  users: { id: string; email: string; group_allowance: number }[];
  mailMode: string;
  heartbeat: { value: string; updated_at: number } | null;
  storage: { photos: number; exports: number };
  backups: {
    status: string;
    lastReadyAt: number | null;
    bytes: number;
    readyCount: number;
    pendingCount: number;
  } | null;
  work: { state: string; count: number }[];
  dueWork: Record<
    "issues" | "emails" | "exports",
    { count: number; oldest_at: number | null }
  >;
};
export function Operator() {
  const { data, error, refresh } = useData<Support>("/operator"),
    [failure, setFailure] = useState("");
  async function act(path: string, body: unknown) {
    try {
      setFailure("");
      await api(path, { method: "PATCH", body });
      await refresh();
    } catch (e) {
      setFailure((e as Error).message);
    }
  }
  return (
    <>
      <span className="kicker">HOST SUPPORT</span>
      <PageHeading>A little care behind the scenes.</PageHeading>
      <ErrorMessage error={error || failure} />
      <div className="notice">
        Email mode: {data?.mailMode}
        <br />
        Last scheduler run:{" "}
        {data?.heartbeat
          ? data.heartbeat.value + " · " + when(data.heartbeat.updated_at)
          : "Waiting for the first scheduled run"}
        {data?.heartbeat &&
          Date.now() - data.heartbeat.updated_at > 5 * 60000 && (
            <p role="alert">
              The scheduler has not completed recently. Check Cloudflare logs.
            </p>
          )}
      </div>
      {data?.dueWork && (
        <div className="panel">
          <h2 className="panel-title">Waiting work</h2>
          <p className="small">
            Work eligible to run now. Check these dates alongside the scheduler
            heartbeat when investigating a delay.
          </p>
          {(
            [
              ["issues", "Issue steps"],
              ["emails", "Emails"],
              ["exports", "Exports"],
            ] as const
          ).map(([key, label]) => (
            <p key={key}>
              {label}: {data.dueWork[key].count}
              {data.dueWork[key].oldest_at !== null && (
                <>
                  <br />
                  Oldest waiting since {when(data.dueWork[key].oldest_at!)}
                </>
              )}
            </p>
          ))}
        </div>
      )}
      {data?.backups && (
        <div className="panel">
          <h2 className="panel-title">Encrypted cloud backups</h2>
          <p>
            {data.backups.lastReadyAt
              ? "Last verified upload: " + when(data.backups.lastReadyAt)
              : "Waiting for a verified cloud backup"}
            <br />
            {data.backups.readyCount} ready · {data.backups.pendingCount}{" "}
            incomplete · {(data.backups.bytes / 1000000).toFixed(1)} MB of the
            4,000 MB backup cap
          </p>
          <p className="small">
            The weekly job runs from the host’s Mac on Sunday at 9 AM. The Mac
            needs to be available and signed in. Backups are encrypted before
            reaching the private R2 bucket; the recovery key stays separate.
          </p>
          {(data.backups.status === "unreadable" ||
            !data.backups.lastReadyAt ||
            Date.now() - data.backups.lastReadyAt > 8 * 86400000) && (
            <p className="error" role="alert">
              Check the backup runner and its logs. A recent verified cloud
              backup is unavailable.
            </p>
          )}
        </div>
      )}
      {data && data.storage.photos + data.storage.exports >= 4000000000 && (
        <p role="alert" className="notice">
          Storage is above 80% of the app's 5 GB cap. Review retained photos and
          exports; new photos stop at the cap. Other applications share the
          account's Cloudflare allowances.
        </p>
      )}
      <div className="panel">
        <h2 className="panel-title">Storage & delivery</h2>
        <p>
          {((data?.storage.photos || 0) / 1000000).toFixed(1)} MB of photos
          <br />
          {((data?.storage.exports || 0) / 1000000).toFixed(1)} MB reserved for
          exports
          <br />
          5,000 MB app storage cap
        </p>
        {data?.work.map((w) => (
          <span className="tag" key={w.state}>
            {w.count} {w.state}
          </span>
        ))}
      </div>
      <div className="panel">
        <h2 className="panel-title">Email enrollment</h2>
        <p className="small">
          Add the address under Cloudflare Email Routing → Destination
          addresses. The person must open Cloudflare’s verification email.
          Confirm here only after Cloudflare reports it verified. Suppression
          stops app mail immediately.
        </p>
        <a href="https://dash.cloudflare.com/" target="_blank" rel="noreferrer">
          Open Cloudflare Email Routing ↗
        </a>
        {data?.destinations.map((d) => (
          <div className="question-row" key={d.email}>
            <p>
              {d.email}
              <small>
                {d.verified ? "Verified" : "Pending verification"}
                {d.suppressed ? " · Suppressed" : ""}
              </small>
            </p>
            <div className="row">
              <button
                className="quiet"
                onClick={() => {
                  if (
                    !d.verified &&
                    !confirm(
                      "Have you checked this exact address is verified in Cloudflare?",
                    )
                  )
                    return;
                  void act("/operator/destinations", {
                    email: d.email,
                    verified: !d.verified,
                    suppressed: !!d.suppressed,
                  });
                }}
              >
                {d.verified ? "Disable" : "Confirm verified"}
              </button>
              <button
                className="quiet"
                onClick={() =>
                  void act("/operator/destinations", {
                    email: d.email,
                    verified: !!d.verified,
                    suppressed: !d.suppressed,
                  })
                }
              >
                {d.suppressed ? "Allow mail" : "Suppress"}
              </button>
            </div>
          </div>
        ))}
      </div>
      <div className="panel">
        <h2 className="panel-title">Group capacity</h2>
        <p className="small">
          The pilot allows five groups in total, with twenty members each. This
          setting controls how many groups a person may create.
        </p>
        {data?.users.map((u) => (
          <label key={u.id}>
            {u.email}
            <select
              aria-label={"Group allowance for " + u.email}
              value={u.group_allowance}
              onChange={(e) =>
                void act("/operator/users/" + u.id, {
                  groupAllowance: Number(e.target.value),
                })
              }
            >
              {[0, 1, 2, 3, 4, 5].map((n) => (
                <option key={n} value={n}>
                  {n} groups
                </option>
              ))}
            </select>
          </label>
        ))}
      </div>
      <div className="panel">
        <h2 className="panel-title">Delivery review</h2>
        <p className="small">
          For an uncertain send, check the provider’s activity log before
          acting. Retrying an accepted message can create a duplicate. Request a
          fresh sign-in or email-change link instead of retrying one here.
        </p>
        {data?.messages.map((m) => (
          <div className="question-row" key={m.id}>
            <p>
              {m.recipient}
              <small>
                {m.kind} · {m.state} · {m.error_code || "Waiting"}
              </small>
            </p>
            {["failed", "uncertain"].includes(m.state) &&
              !["login", "email_change"].includes(m.kind) && (
                <div className="row">
                  {(["accepted", "retry"] as const).map((action) => (
                    <button
                      key={action}
                      className="quiet"
                      onClick={async () => {
                        if (
                          !confirm(
                            action === "retry"
                              ? "I checked the provider log and this message was NOT accepted. Retry it?"
                              : "I verified this message was accepted by the provider. Record that outcome?",
                          )
                        )
                          return;
                        try {
                          await api("/operator/outbox/" + m.id + "/resolve", {
                            method: "POST",
                            body: { action, confirmedProviderCheck: true },
                          });
                          await refresh();
                        } catch (e) {
                          setFailure((e as Error).message);
                        }
                      }}
                    >
                      {action === "retry"
                        ? "Retry after review"
                        : "Mark accepted"}
                    </button>
                  ))}
                </div>
              )}
          </div>
        ))}
      </div>
    </>
  );
}
