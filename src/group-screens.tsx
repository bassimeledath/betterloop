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
import { SharedLinkPanel } from "./join";
export function Home({ me }: { me: Me }) {
  const { data, error } = useData<{
    groups: (Group & {
      role: string;
      member_count: number;
      publication_count: number;
      active_issue: string | null;
      submitted_at: number | null;
    })[];
  }>("/groups");
  return (
    <>
      <span className="kicker">YOUR PEOPLE, IN ONE PLACE</span>
      <PageHeading>🏡 Home</PageHeading>
      <ErrorMessage error={error} />
      <div className="group-grid">
        {data?.groups.map((g) => (
          <article className="group-card" key={g.id}>
            <div
              className="collage"
              role="img"
              aria-label="Group cover illustration"
            >
              <span aria-hidden="true">✳</span>
              <span aria-hidden="true">✦</span>
              <span aria-hidden="true">☕</span>
              <span aria-hidden="true">✳</span>
            </div>
            <h2>{g.name}</h2>
            <p className="small center">
              {g.member_count} {g.member_count === 1 ? "person" : "people"} ·{" "}
              {g.publication_count} published{" "}
              {g.publication_count === 1 ? "letter" : "letters"}
            </p>
            <p className="small center">
              {g.paused
                ? "Taking a little break"
                : "Next letter: " + when(g.next_delivery, g.timezone)}
            </p>
            <div className="stack">
              <Button
                to={
                  g.active_issue
                    ? "/groups/" + g.id + "/issues/" + g.active_issue
                    : "/groups/" + g.id + "/questions"
                }
              >
                {g.active_issue
                  ? g.submitted_at
                    ? "View your update"
                    : "Write your update"
                  : "Submit a question"}
              </Button>
              <Button secondary to={"/groups/" + g.id}>
                View details
              </Button>
            </div>
          </article>
        ))}
        {me.user.group_allowance > 0 && (
          <button className="create-card" onClick={() => go("/groups/new")}>
            <PlusCircle />
            <strong>Create a group</strong>
            <span>A new table for another circle.</span>
          </button>
        )}
      </div>
      {data?.groups.length === 0 && (
        <p className="notice">
          Your groups will appear here. Accept an invitation or create your
          first group.
        </p>
      )}
      {!!me.user.operator && (
        <Button secondary to="/operator">
          Host support
        </Button>
      )}
    </>
  );
}
export function CreateGroup() {
  const [requestId] = useState(() => crypto.randomUUID());
  const [name, setName] = useState(""),
    [description, setDescription] = useState(""),
    [cadence, setCadence] = useState("monthly"),
    [day, setDay] = useState(3),
    [time, setTime] = useState("17:00"),
    [zone, setZone] = useState(
      Intl.DateTimeFormat().resolvedOptions().timeZone,
    ),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const [h, m] = time.split(":").map(Number);
      const r = await api<{ id: string }>("/groups", {
        method: "POST",
        body: {
          requestId,
          name,
          description,
          timezone: zone,
          cadence,
          recurrence: { day, hour: h, minute: m, weekday: 7 },
        },
      });
      go("/groups/" + r.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <span className="kicker">A NEW CIRCLE</span>
      <PageHeading>Make a little room.</PageHeading>
      <form className="panel" onSubmit={submit}>
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
          A note for your friends
          <textarea
            maxLength={500}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </label>
        <label>
          How often?
          <select value={cadence} onChange={(e) => setCadence(e.target.value)}>
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
              value={day}
              onChange={(e) => setDay(Number(e.target.value))}
            />
          </label>
        ) : (
          <p className="small">Delivered on Sundays.</p>
        )}
        <label>
          Delivery time
          <input
            required
            type="time"
            value={time}
            onChange={(e) => setTime(e.target.value)}
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
        <ErrorMessage error={error} />
        <button className="button" disabled={busy}>
          {busy ? "Creating…" : "Create my group ✨"}
        </button>
      </form>
    </>
  );
}
export function GroupHome({ gid }: { gid: string }) {
  const [requestId, setRequestId] = useState(() => crypto.randomUUID()),
    [opening, setOpening] = useState(false);
  const { data, error, refresh } = useData<Detail>("/groups/" + gid),
    [failure, setFailure] = useState(""),
    [title, setTitle] = useState("A little life lately"),
    [delivery, setDelivery] = useState("");
  if (!data) return <ErrorMessage error={error} />;
  const g = data.group,
    active = data.issues.find((i) =>
      ["scheduled", "open", "closing"].includes(i.state),
    ),
    host = data.membership.role !== "member";
  async function open(e: React.FormEvent) {
    e.preventDefault();
    setOpening(true);
    setFailure("");
    try {
      await api("/groups/" + gid + "/issues", {
        method: "POST",
        body: { requestId, title, deliveryAt: new Date(delivery).getTime() },
      });
      await refresh();
      setRequestId(crypto.randomUUID());
      document.querySelector<HTMLElement>("main h1")?.focus();
    } catch (e) {
      setFailure((e as Error).message);
    } finally {
      setOpening(false);
    }
  }
  return (
    <>
      <span className="kicker">YOUR LITTLE CORNER OF THE WORLD</span>
      <PageHeading>{g.name}</PageHeading>
      {g.selected_questions === 0 && (
        <p className="notice">
          The next issue is waiting for a question. Ask an administrator to
          select at least one in Questions.
        </p>
      )}
      <p className="muted">{g.description}</p>
      <div className="avatars">
        {data.members.map((m) => (
          <span
            role="img"
            aria-label={m.name}
            title={m.name}
            className="avatar"
            key={m.id}
          >
            {m.name[0]}
          </span>
        ))}
      </div>
      {active ? (
        <div className="hero">
          <span className="tag">
            {active.state === "closing"
              ? "Coming together"
              : active.my_submitted_at
                ? "Your update is submitted"
                : "Time for a little update"}
          </span>
          <h2>{active.title}</h2>
          <p className="small">
            Due {when(active.deadline, g.timezone)} · {active.submitted_count}{" "}
            submitted
          </p>
          <Button to={"/groups/" + gid + "/issues/" + active.id}>
            {active.my_submitted_at ? "View your update" : "Write your update"}
          </Button>
        </div>
      ) : (
        <div className="hero">
          <h2>Got a question for the group?</h2>
          <p>Something big, something silly, or just “how are you, really?”</p>
          <p className="small">
            {g.paused
              ? "The group is paused."
              : "Next letter: " + when(g.next_delivery, g.timezone)}
          </p>
          <Button to={"/groups/" + gid + "/questions"}>
            Add your question ✍️
          </Button>
        </div>
      )}
      <div className="menu">
        {[
          ["✍️ Questions", "questions"],
          ["🌿 Members", "members"],
          ["🗓️ Schedule & preferences", "settings"],
        ].map(([t, s]) => (
          <button key={s} onClick={() => go("/groups/" + gid + "/" + s)}>
            {t}
            <span>›</span>
          </button>
        ))}
      </div>
      {host && data.emptyIssues >= 3 && !g.paused && (
        <p className="notice">
          The last {data.emptyIssues} issues had no submissions. A slower
          schedule or a pause might suit the group. You can change this in
          Schedule & preferences.
        </p>
      )}
      <Archive gid={gid} zone={g.timezone} />
      {host && !active && (
        <form className="panel" onSubmit={open}>
          <span className="kicker">HOST CONTROLS</span>
          <h2 className="panel-title">Open an issue now</h2>
          <label>
            Issue title
            <input
              required
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </label>
          <label>
            Delivery deadline
            <input
              required
              type="datetime-local"
              value={delivery}
              onChange={(e) => setDelivery(e.target.value)}
            />
          </label>
          <ErrorMessage error={failure} />
          <button className="button secondary" disabled={opening}>
            {opening ? "Opening…" : "Open with selected questions"}
          </button>
        </form>
      )}
    </>
  );
}
function Archive({ gid, zone }: { gid: string; zone: string }) {
  const [cursor, setCursor] = useState(""),
    [rows, setRows] = useState<
      { id: string; title: string; delivery_at: number }[]
    >([]),
    [next, setNext] = useState<string | null>(null);
  const { data, error } = useData<{ issues: typeof rows; next: string | null }>(
    "/groups/" +
      gid +
      "/archive" +
      (cursor ? "?before=" + encodeURIComponent(cursor) : ""),
  );
  useEffect(() => {
    if (data) {
      setRows((previous) =>
        cursor
          ? [
              ...previous,
              ...data.issues.filter(
                (i) => !previous.some((p) => p.id === i.id),
              ),
            ]
          : data.issues,
      );
      setNext(data.next);
    }
  }, [data, cursor]);
  return (
    <>
      <h2>📚 Past issues</h2>
      <ErrorMessage error={error} />
      {rows.length ? (
        rows.map((i) => (
          <button
            className="issue-row"
            key={i.id}
            onClick={() => go("/groups/" + gid + "/issues/" + i.id)}
          >
            <strong>{i.title}</strong>
            <span>{when(i.delivery_at, zone)} →</span>
          </button>
        ))
      ) : (
        <p className="small">Your first published letter will appear here.</p>
      )}
      {next && (
        <Button secondary onClick={() => setCursor(next)}>
          Older letters
        </Button>
      )}
    </>
  );
}
export function Questions({ gid }: { gid: string }) {
  const { data, error, refresh } = useData<{ questions: Q[] }>(
      "/groups/" + gid + "/questions",
    ),
    detail = useData<Detail>("/groups/" + gid),
    [text, setText] = useState(""),
    [failure, setFailure] = useState("");
  const host = detail.data && detail.data.membership.role !== "member";
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    try {
      await api("/groups/" + gid + "/questions", {
        method: "POST",
        body: { text },
      });
      setText("");
      await refresh();
    } catch (e) {
      setFailure((e as Error).message);
    }
  }
  async function select(q: Q) {
    try {
      await api("/groups/" + gid + "/questions/" + q.id, {
        method: "PATCH",
        body: { selected: !q.selected, position: q.position },
      });
      await refresh();
    } catch (e) {
      setFailure((e as Error).message);
    }
  }
  return (
    <>
      <span className="kicker">FOR YOUR NEXT LETTER</span>
      <PageHeading>Ask something good.</PageHeading>
      <p className="muted">
        Curious, serious, completely unserious. The best questions sound like
        you.
      </p>
      <ErrorMessage error={error || failure} />
      <form className="panel" onSubmit={submit}>
        <label>
          Your question
          <textarea
            required
            minLength={3}
            maxLength={500}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        </label>
        <p className="small">
          The host chooses questions for the next issue. Open issues keep their
          existing questions.
        </p>
        <button className="button">Send to the question pile ✍️</button>
      </form>
      <div className="panel">
        {data?.questions.map((q) => (
          <div className="question-row" key={q.id}>
            <p>
              {q.text}
              <small>{q.author_name || "The group"}</small>
            </p>
            {host ? (
              <label className="checkbox">
                <input
                  aria-label={"Use " + q.text}
                  type="checkbox"
                  checked={!!q.selected}
                  onChange={() => void select(q)}
                />{" "}
                Next issue
              </label>
            ) : (
              !!q.selected && <span className="tag">Next issue</span>
            )}
          </div>
        ))}
      </div>
    </>
  );
}
export function Members({ gid, me }: { gid: string; me: Me }) {
  const { data, error, refresh } = useData<{
      members: { id: string; name: string; email?: string; role: string }[];
      invitations: {
        id: string;
        email: string;
        verified: number;
        expires_at: number;
        revoked_at: number | null;
        accepted_at: number | null;
      }[];
    }>("/groups/" + gid + "/members"),
    detail = useData<Detail>("/groups/" + gid),
    [email, setEmail] = useState(""),
    [link, setLink] = useState(""),
    [failure, setFailure] = useState("");
  const host = !!detail.data && detail.data.membership.role !== "member",
    owner = detail.data?.membership.role === "owner";
  async function invite(e: React.FormEvent) {
    e.preventDefault();
    try {
      const r = await api<{ url: string }>("/groups/" + gid + "/invitations", {
        method: "POST",
        body: { email },
      });
      setLink(r.url);
      await refresh();
    } catch (e) {
      setFailure((e as Error).message);
    }
  }
  async function remove(id: string) {
    if (
      !confirm(
        "Remove this member? Archive access and future group emails stop immediately.",
      )
    )
      return;
    try {
      await api("/groups/" + gid + "/members/" + id, { method: "DELETE" });
      await refresh();
    } catch (e) {
      setFailure((e as Error).message);
    }
  }
  return (
    <>
      <span className="kicker">THE WHOLE SQUAD</span>
      <PageHeading>Your people, everywhere.</PageHeading>
      <ErrorMessage error={error || failure} />
      {host && <SharedLinkPanel gid={gid} />}
      <div className="panel">
        {data?.members.map((m) => (
          <div className="member-row" key={m.id}>
            <span className="avatar">{m.name[0]}</span>
            <div>
              <strong>{m.name}</strong>
              <small>{m.role}</small>
            </div>
            {m.id !== me.user.id && m.role !== "owner" && host && (
              <button className="quiet" onClick={() => void remove(m.id)}>
                Remove
              </button>
            )}
            {owner && m.role !== "owner" && (
              <button
                className="quiet"
                onClick={async () => {
                  try {
                    await api("/groups/" + gid + "/members/" + m.id, {
                      method: "PATCH",
                      body: { role: m.role === "member" ? "admin" : "member" },
                    });
                    await refresh();
                  } catch (e) {
                    setFailure((e as Error).message);
                  }
                }}
              >
                {m.role === "member" ? "Make admin" : "Make member"}
              </button>
            )}
          </div>
        ))}
      </div>
      {host && (
        <form className="panel" onSubmit={invite}>
          <h2 className="panel-title">Save someone a spot.</h2>
          <label>
            Friend’s email
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </label>
          <button className="button">Create an invitation</button>
          {link && (
            <label>
              Share this private invitation
              <input readOnly value={link} onFocus={(e) => e.target.select()} />
              <small>
                The link doesn’t grant access until the invited person signs in
                and accepts.
              </small>
            </label>
          )}
          <p className="small">
            Your host verifies new email destinations once before app email can
            arrive.
          </p>
        </form>
      )}
      {data?.invitations
        .filter((i) => !i.accepted_at && !i.revoked_at)
        .map((i) => (
          <div className="notice" key={i.id}>
            {i.email}
            <br />
            <span className="small">
              {i.verified ? "Email verified" : "Waiting for host verification"}{" "}
              ·{" "}
              {i.expires_at <= Date.now()
                ? "Expired"
                : "Expires " + when(i.expires_at)}
            </span>
            {host && (
              <div className="row">
                <button
                  className="quiet"
                  onClick={async () => {
                    try {
                      const r = await api<{ url: string }>(
                        "/groups/" + gid + "/invitations",
                        { method: "POST", body: { email: i.email } },
                      );
                      setLink(r.url);
                      await refresh();
                    } catch (e) {
                      setFailure((e as Error).message);
                    }
                  }}
                >
                  Replace invitation
                </button>
                <button
                  className="quiet"
                  onClick={async () => {
                    try {
                      await api("/groups/" + gid + "/invitations/" + i.id, {
                        method: "DELETE",
                      });
                      await refresh();
                    } catch (e) {
                      setFailure((e as Error).message);
                    }
                  }}
                >
                  Revoke
                </button>
              </div>
            )}
          </div>
        ))}
    </>
  );
}
