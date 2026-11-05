import React, { useEffect, useState } from "react";
import { api } from "./api";
import { PageHeading, Button, ErrorMessage, useData, when, go } from "./ui";
import { ExportsPanel } from "./account";
import type { Detail } from "./main";
type Rule = { day: number; hour: number; minute: number; weekday: number };
function ScheduleEditor({
  data,
  reload,
}: {
  data: Detail;
  reload: () => Promise<Detail | null>;
}) {
  const g = data.group,
    original = JSON.parse(g.recurrence_json) as Rule;
  const [name, setName] = useState(g.name),
    [description, setDescription] = useState(g.description),
    [cadence, setCadence] = useState(g.cadence),
    [zone, setZone] = useState(g.timezone),
    [rule, setRule] = useState(original),
    [preview, setPreview] = useState<number | null>(null),
    [error, setError] = useState(""),
    [message, setMessage] = useState("");
  const body = { name, description, cadence, timezone: zone, recurrence: rule };
  useEffect(() => {
    let current = true;
    const timer = setTimeout(() => {
      void api<{ delivery: number }>("/groups/" + g.id + "/schedule-preview", {
        method: "POST",
        body,
      })
        .then((r) => {
          if (current) setPreview(r.delivery);
        })
        .catch(() => {
          if (current) setPreview(null);
        });
    }, 500);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [name, description, cadence, zone, rule, g.id]);
  async function save(e: React.FormEvent) {
    e.preventDefault();
    try {
      await api("/groups/" + g.id, {
        method: "PATCH",
        body: { ...body, revision: g.revision },
      });
      await reload();
      setMessage(
        "Future schedule saved. Any open issue keeps its current deadline.",
      );
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <form className="panel" onSubmit={save}>
      <h2 className="panel-title">🗓️ Group details & schedule</h2>
      <label>
        Group name
        <input
          required
          maxLength={80}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      <label>
        About this group
        <textarea
          maxLength={500}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </label>
      <label>
        How often?
        <select
          value={cadence}
          onChange={(e) => setCadence(e.target.value as typeof cadence)}
        >
          <option value="monthly">Monthly</option>
          <option value="fortnightly">Every two weeks</option>
          <option value="weekly">Weekly</option>
        </select>
      </label>
      {cadence === "monthly" ? (
        <label>
          Day of the month
          <input
            type="number"
            min={1}
            max={31}
            required
            value={rule.day}
            onChange={(e) => setRule({ ...rule, day: Number(e.target.value) })}
          />
          <small>Months with fewer days use their last day.</small>
        </label>
      ) : (
        <label>
          Delivery day
          <select
            value={rule.weekday}
            onChange={(e) =>
              setRule({ ...rule, weekday: Number(e.target.value) })
            }
          >
            {[
              "Monday",
              "Tuesday",
              "Wednesday",
              "Thursday",
              "Friday",
              "Saturday",
              "Sunday",
            ].map((day, i) => (
              <option key={day} value={i + 1}>
                {day}
              </option>
            ))}
          </select>
        </label>
      )}
      <label>
        Delivery time
        <input
          required
          type="time"
          value={
            String(rule.hour).padStart(2, "0") +
            ":" +
            String(rule.minute).padStart(2, "0")
          }
          onChange={(e) => {
            const [hour, minute] = e.target.value.split(":").map(Number);
            setRule({ ...rule, hour, minute });
          }}
        />
      </label>
      <label>
        Group timezone
        <input
          required
          value={zone}
          onChange={(e) => setZone(e.target.value)}
        />
      </label>
      <p className="notice">
        {preview
          ? "Next future letter: " + when(preview, zone)
          : "Complete a valid schedule to preview the next delivery."}
        <br />
        Answers open seven days before delivery.
      </p>
      <ErrorMessage error={error} />
      {message && (
        <p role="status" className="notice">
          {message}
        </p>
      )}
      <button className="button secondary">Save group schedule</button>
    </form>
  );
}
function DeliveryPanel({ gid, issueId }: { gid: string; issueId: string }) {
  const { data, error } = useData<{
    messages: {
      id: string;
      name: string;
      kind: string;
      state: string;
      attempts: number;
      error_code: string | null;
    }[];
  }>("/groups/" + gid + "/issues/" + issueId + "/delivery");
  return (
    <div className="panel">
      <h2 className="panel-title">📬 Email status</h2>
      <p className="small">
        Accepted means the email service took the message. It does not prove
        inbox delivery. The private issue is available independently.
      </p>
      <ErrorMessage error={error} />
      {data?.messages.length ? (
        data.messages.map((m) => (
          <p key={m.id}>
            <strong>{m.name}</strong>
            <small>
              {m.kind} · {m.state} · {m.attempts}{" "}
              {m.attempts === 1 ? "attempt" : "attempts"}
              {m.error_code ? " · " + m.error_code.replaceAll("_", " ") : ""}
            </small>
          </p>
        ))
      ) : (
        <p className="small">No messages recorded yet.</p>
      )}
    </div>
  );
}
export function GroupSettingsScreen({ gid }: { gid: string }) {
  const { data, error, refresh } = useData<Detail>("/groups/" + gid),
    [failure, setFailure] = useState(""),
    [message, setMessage] = useState(""),
    [pauseCurrent, setPauseCurrent] = useState("finish"),
    [extension, setExtension] = useState(""),
    [newOwner, setNewOwner] = useState(""),
    [deletionName, setDeletionName] = useState(""),
    [deliveryIssue, setDeliveryIssue] = useState("");
  if (!data) return <ErrorMessage error={error} />;
  const m = data.membership,
    host = m.role !== "member",
    owner = m.role === "owner",
    active = data.issues.find((i) => ["open", "scheduled"].includes(i.state));
  async function prefs(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    try {
      await api("/groups/" + gid + "/preferences", {
        method: "PATCH",
        body: {
          opening: f.has("opening"),
          reminder: f.has("reminder"),
          publication: f.has("publication"),
        },
      });
      setMessage("Your inbox preferences are saved.");
    } catch (e) {
      setFailure((e as Error).message);
    }
  }
  async function extend(e: React.FormEvent) {
    e.preventDefault();
    try {
      await api("/groups/" + gid + "/issues/" + active!.id, {
        method: "PATCH",
        body: { action: "extend", deadline: new Date(extension).getTime() },
      });
      await refresh();
      setMessage("The deadline and reminder timing have been updated.");
    } catch (e) {
      setFailure((e as Error).message);
    }
  }
  return (
    <>
      <span className="kicker">MAKE IT YOURS</span>
      <PageHeading>A rhythm that feels right.</PageHeading>
      <ErrorMessage error={failure} />
      {message && (
        <p className="notice" role="status">
          {message}
        </p>
      )}
      <form className="panel" onSubmit={prefs}>
        <h2 className="panel-title">🔔 Your inbox</h2>
        {[
          ["opening", "Let me know when an issue opens", m.notify_open],
          ["reminder", "Remind me before the deadline", m.notify_reminder],
          ["publication", "Email me the finished letter", m.notify_issue],
        ].map(([name, text, value]) => (
          <label className="checkbox" key={String(name)}>
            <input
              type="checkbox"
              name={String(name)}
              defaultChecked={!!value}
            />
            {text}
          </label>
        ))}
        <button className="button secondary">Save preferences</button>
      </form>
      {host && (
        <>
          <ScheduleEditor
            key={data.group.revision}
            data={data}
            reload={async () => {
              const d = await refresh();
              if (d)
                setMessage(
                  "Future schedule saved. Any open issue keeps its current deadline.",
                );
              return d;
            }}
          />
          {active && (
            <form className="panel" onSubmit={extend}>
              <h2 className="panel-title">The current issue</h2>
              <p>
                {active.title}
                <small>
                  Closes {when(active.deadline, data.group.timezone)}
                </small>
              </p>
              <label>
                Extend until
                <input
                  required
                  type="datetime-local"
                  value={extension}
                  onChange={(e) => setExtension(e.target.value)}
                />
                <small>
                  This input uses your device timezone. The saved deadline is
                  shown in the group timezone.
                </small>
              </label>
              <button className="button secondary">Extend this deadline</button>
              <button
                type="button"
                className="quiet danger-link"
                onClick={async () => {
                  if (
                    !confirm(
                      "Cancel this issue? Submissions will not be published. Private drafts are retained for 30 days.",
                    )
                  )
                    return;
                  try {
                    await api("/groups/" + gid + "/issues/" + active.id, {
                      method: "PATCH",
                      body: { action: "cancel" },
                    });
                    await refresh();
                    setMessage(
                      "Issue cancelled. Private drafts are retained for 30 days.",
                    );
                  } catch (e) {
                    setFailure((e as Error).message);
                  }
                }}
              >
                Cancel this issue
              </button>
            </form>
          )}
          <div className="panel">
            <h2 className="panel-title">
              {data.group.paused ? "A little break" : "Need a little break?"}
            </h2>
            {!data.group.paused && active && (
              <label>
                What happens to the current issue?
                <select
                  value={pauseCurrent}
                  onChange={(e) => setPauseCurrent(e.target.value)}
                >
                  <option value="finish">
                    Let it finish on its current deadline
                  </option>
                  <option value="cancel">
                    Cancel it and retain drafts for 30 days
                  </option>
                </select>
              </label>
            )}
            <p className="small">
              Pausing stops new issues and reminders until you resume.
            </p>
            <Button
              secondary
              onClick={async () => {
                try {
                  await api("/groups/" + gid + "/pause", {
                    method: "POST",
                    body: { paused: !data.group.paused, current: pauseCurrent },
                  });
                  await refresh();
                } catch (e) {
                  setFailure((e as Error).message);
                }
              }}
            >
              {data.group.paused ? "Resume group" : "Pause this group"}
            </Button>
          </div>
          <div className="panel">
            <label>
              Inspect email status
              <select
                value={deliveryIssue}
                onChange={(e) => setDeliveryIssue(e.target.value)}
              >
                <option value="">Choose an issue</option>
                {data.issues.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.title} · {i.state}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {deliveryIssue && (
            <DeliveryPanel
              key={deliveryIssue}
              gid={gid}
              issueId={deliveryIssue}
            />
          )}
        </>
      )}
      {owner && (
        <>
          <ExportsPanel groupId={gid} />
          <div className="panel">
            <h2 className="panel-title">Hand over the table</h2>
            <p className="small">
              You remain the owner until the selected member accepts from their
              profile.
            </p>
            <label>
              New group owner
              <select
                value={newOwner}
                onChange={(e) => setNewOwner(e.target.value)}
              >
                <option value="">Choose a member</option>
                {data.members
                  .filter((x) => x.id !== m.user_id)
                  .map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.name}
                    </option>
                  ))}
              </select>
            </label>
            <Button
              secondary
              disabled={!newOwner}
              onClick={async () => {
                try {
                  await api("/groups/" + gid + "/transfers", {
                    method: "POST",
                    body: { userId: newOwner },
                  });
                  setMessage(
                    "Ownership transfer requested. The member can accept from their profile.",
                  );
                } catch (e) {
                  setFailure((e as Error).message);
                }
              }}
            >
              Request ownership transfer
            </Button>
          </div>
          <details className="panel">
            <summary>Delete this group</summary>
            <p className="small">
              Access stops immediately, pending emails are cancelled, and group
              data is removed within 30 days. Sent email copies cannot be
              recalled.
            </p>
            <label>
              Type “{data.group.name}” to confirm
              <input
                value={deletionName}
                onChange={(e) => setDeletionName(e.target.value)}
              />
            </label>
            <Button
              secondary
              disabled={deletionName !== data.group.name}
              onClick={async () => {
                if (!confirm("Delete this entire group and its archive?"))
                  return;
                try {
                  await api("/groups/" + gid, {
                    method: "DELETE",
                    body: { name: deletionName },
                  });
                  go("/");
                } catch (e) {
                  setFailure((e as Error).message);
                }
              }}
            >
              Delete group
            </Button>
          </details>
        </>
      )}
      <Button
        secondary
        onClick={async () => {
          if (
            !confirm(
              "Leave this group? You will lose archive access and future group emails.",
            )
          )
            return;
          try {
            await api("/groups/" + gid + "/members/" + m.user_id, {
              method: "DELETE",
            });
            go("/");
          } catch (e) {
            setFailure((e as Error).message);
          }
        }}
      >
        Leave this group
      </Button>
    </>
  );
}
