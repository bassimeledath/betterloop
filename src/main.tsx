import React, { useState, useEffect, useCallback, useRef } from "react";
import { createRoot } from "react-dom/client";
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
import { api, setCsrf, ApiError, uploadPhoto } from "./api";
import { preparePhoto } from "./photo";
import {
  Button,
  PageHeading,
  ErrorMessage,
  useData,
  when,
  go,
  setNavigationGuard,
  canNavigate,
} from "./ui";
import { Operator } from "./operator";
import { GroupJoin, SharedLinkPanel } from "./join";
import { ProfileScreen, ConfirmEmailScreen } from "./account";
import { GroupSettingsScreen } from "./owner";
import type {
  Group,
  Issue,
  User,
  Member,
  Update,
  Publication,
} from "../server/types";
import "@fontsource/fraunces/latin-600.css";
import "@fontsource/nunito-sans/latin-400.css";
import "@fontsource/nunito-sans/latin-700.css";
import "./styles.css";
type Me = { user: User; csrf: string };
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
type Q = {
  id: string;
  text: string;
  author_name: string;
  selected: number;
  position: number;
};
type IssueData = {
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
function usePath() {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const on = (e: PopStateEvent) => {
      if (
        !e.state?.betterloopNavigation &&
        location.pathname !== path &&
        !canNavigate()
      ) {
        history.pushState(null, "", path);
        return;
      }
      setPath(location.pathname);
    };
    addEventListener("popstate", on);
    return () => removeEventListener("popstate", on);
  }, [path]);
  return path;
}
function Header({ path }: { path: string }) {
  return (
    <header className="top">
      <button className="wordmark" onClick={() => go("/")}>
        betterloop <span aria-hidden="true">✳</span>
      </button>
      {path === "/" ? (
        <button className="quiet icon-label" onClick={() => go("/profile")}>
          <Settings size={17} /> Profile
        </button>
      ) : (
        <button
          className="quiet icon-label"
          onClick={() =>
            go(
              path.startsWith("/groups/") && path.split("/").length > 3
                ? "/groups/" + path.split("/")[2]
                : "/",
            )
          }
        >
          <ArrowLeft size={17} /> Back
        </button>
      )}
    </header>
  );
}
function App() {
  const path = usePath(),
    [me, setMe] = useState<Me | null>(null),
    [ready, setReady] = useState(false),
    [error, setError] = useState("");
  const load = useCallback(async () => {
    try {
      const m = await api<Me>("/me");
      setCsrf(m.csrf);
      setMe(m);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) setMe(null);
      else setError((e as Error).message);
    } finally {
      setReady(true);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  const local = ["127.0.0.1", "localhost"].includes(location.hostname);
  let content: React.ReactNode;
  if (path === "/auth/confirm") content = <Confirm onDone={load} />;
  else if (path === "/invite")
    content = (
      <Invitation
        me={me}
        onLogin={() =>
          go(
            "/signin#returnPath=" +
              encodeURIComponent("/invite" + location.hash),
          )
        }
      />
    );
  else if (path === "/join")
    content = ready ? (
      <GroupJoin me={me} />
    ) : (
      <p className="muted">Opening your invitation…</p>
    );
  else if (!ready)
    content = <p className="muted">Opening your little corner of the world…</p>;
  else if (!me)
    content = (
      <Signin
        local={local}
        returnPath={
          new URLSearchParams(location.hash.slice(1)).get("returnPath") ||
          path + location.hash
        }
      />
    );
  else if (path === "/profile")
    content = (
      <ProfileScreen
        me={me}
        reload={load}
        onLogout={() => {
          setMe(null);
          go("/");
        }}
      />
    );
  else if (path === "/email/confirm")
    content = <ConfirmEmailScreen reload={load} />;
  else if (path === "/operator") content = <Operator />;
  else if (path === "/groups/new") content = <CreateGroup />;
  else if (path.startsWith("/groups/")) {
    const [, , gid, section, iid] = path.split("/");
    content =
      section === "issues" && iid ? (
        <IssuePage gid={gid} iid={iid} />
      ) : section === "questions" ? (
        <Questions gid={gid} />
      ) : section === "members" ? (
        <Members gid={gid} me={me} />
      ) : section === "settings" || section === "preferences" ? (
        <GroupSettingsScreen gid={gid} />
      ) : (
        <GroupHome gid={gid} />
      );
  } else content = <Home me={me} />;
  return (
    <div className="app">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <Header path={path} />
      <main id="main" tabIndex={-1}>
        <ErrorMessage error={error} />
        {content}
      </main>
      <footer>
        a little letter. a little closer.<span>✳</span>
      </footer>
      {local && <DevInbox onLogin={load} />}
    </div>
  );
}
function Signin({ local, returnPath }: { local: boolean; returnPath: string }) {
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
function Confirm({ onDone }: { onDone: () => Promise<void> }) {
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
function Invitation({ me, onLogin }: { me: Me | null; onLogin: () => void }) {
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
function Home({ me }: { me: Me }) {
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
function CreateGroup() {
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
function GroupHome({ gid }: { gid: string }) {
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
function Questions({ gid }: { gid: string }) {
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
function Members({ gid, me }: { gid: string; me: Me }) {
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
function IssuePage({ gid, iid }: { gid: string; iid: string }) {
  const { data, error, refresh } = useData<IssueData>(
    "/groups/" + gid + "/issues/" + iid,
  );
  if (!data) return <ErrorMessage error={error} />;
  return data.publication ? (
    <Reader
      p={data.publication}
      date={data.issue.delivery_at}
      zone={data.issue.timezone}
    />
  ) : (
    <Composer key={iid} gid={gid} data={data} refresh={refresh} />
  );
}
function Composer({
  gid,
  data,
  refresh,
}: {
  gid: string;
  data: IssueData;
  refresh: () => Promise<IssueData | null>;
}) {
  const [update, setUpdate] = useState<Update>(
      data.contribution?.draft || {
        answers: {},
        photos: [],
        shoutout: "",
        good: "",
      },
    ),
    [revision, setRevision] = useState(data.contribution?.revision || 0),
    [status, setStatus] = useState("Saved"),
    [error, setError] = useState(""),
    [review, setReview] = useState(false),
    [dirty, setDirty] = useState(false),
    [busy, setBusy] = useState(false);
  const path = "/groups/" + gid + "/issues/" + data.issue.id;
  const [clock, setClock] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const closed = data.issue.state !== "open" || data.issue.deadline <= clock;
  const live = useRef({ update, revision, generation: 0, saved: 0 });
  const flight = useRef<Promise<number> | null>(null);
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (live.current.saved < live.current.generation) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    setNavigationGuard(
      () =>
        live.current.saved >= live.current.generation ||
        confirm(
          "Your latest edits have not been saved. Leave this page and lose those edits?",
        ),
    );
    addEventListener("beforeunload", warn);
    return () => {
      setNavigationGuard(null);
      removeEventListener("beforeunload", warn);
    };
  }, []);
  async function addPhoto(file: File) {
    setError("");
    setBusy(true);
    try {
      if (live.current.update.photos.length >= 3)
        throw new Error("You can add up to three photos.");
      const blob = await preparePhoto(file);
      const asset = await uploadPhoto(path + "/assets", blob);
      change({
        ...live.current.update,
        photos: [...live.current.update.photos, { id: asset.id, caption: "" }],
      });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function save(): Promise<number> {
    if (flight.current) return flight.current;
    const run = async () => {
      setBusy(true);
      setStatus("Saving…");
      try {
        while (live.current.saved < live.current.generation) {
          const generation = live.current.generation,
            snapshot = structuredClone(live.current.update);
          const r = await api<{ revision: number }>(path + "/contribution", {
            method: "PUT",
            body: { revision: live.current.revision, update: snapshot },
          });
          live.current.revision = r.revision;
          live.current.saved = generation;
          setRevision(r.revision);
        }
        setDirty(false);
        setStatus("Saved");
        setError("");
        return live.current.revision;
      } catch (e) {
        setStatus("Not saved — keep this page open");
        setError((e as Error).message);
        throw e;
      } finally {
        setBusy(false);
      }
    };
    const task = run();
    flight.current = task;
    void task
      .finally(() => {
        if (flight.current === task) flight.current = null;
      })
      .catch(() => {});
    return task;
  }
  function change(next: Update) {
    setError("");
    live.current.update = next;
    live.current.generation++;
    setUpdate(next);
    setDirty(true);
    setStatus("Unsaved changes");
  }
  function flushOnBlur() {
    if (dirty && !busy && !closed) void save().catch(() => {});
  }
  useEffect(() => {
    if (!dirty || busy || closed || error) return;
    const t = setTimeout(() => {
      void save().catch(() => {});
    }, 1000);
    return () => clearTimeout(t);
  }, [update, dirty, busy, closed, error]);
  async function submit() {
    try {
      setError("");
      const r = dirty ? await save() : revision;
      await api(path + "/submit", { method: "POST", body: { revision: r } });
      await refresh();
      go("/groups/" + gid);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <>
      <span className="kicker">{data.issue.title}</span>
      <PageHeading>
        {review ? "One last look." : "A little life update."}
      </PageHeading>
      <p className="muted">
        {review
          ? "This copy will be shared when the letter publishes."
          : "Everything is optional. Tell us what you feel like sharing."}
      </p>
      <div className="row spread">
        <span className="tag">
          <Lock size={12} /> Only you can see this draft
        </span>
        <span className="small" role="status">
          {status}
        </span>
      </div>
      {closed && (
        <p className="notice" role="alert">
          This issue has closed. Your text remains here; new submissions cannot
          be accepted.
        </p>
      )}
      <ErrorMessage error={error} />
      {dirty && (error || closed) && (
        <div className="stack">
          <Button
            secondary
            disabled={busy || closed}
            onClick={() => void save().catch(() => {})}
          >
            Retry saving
          </Button>
          <Button
            secondary
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(
                  JSON.stringify(live.current.update, null, 2),
                );
                setStatus(
                  "Draft copied. Keep it somewhere safe before reloading.",
                );
              } catch {
                setError(
                  "Clipboard access failed. You can select and copy the text in each field.",
                );
              }
            }}
          >
            Copy my unsaved draft
          </Button>
          <Button
            secondary
            onClick={() => {
              if (
                confirm(
                  "Reload the saved version? Copy any unsaved text first.",
                )
              ) {
                live.current.saved = live.current.generation;
                location.reload();
              }
            }}
          >
            Reload saved version
          </Button>
        </div>
      )}
      <div className="panel">
        <h2>✨ Questions</h2>
        <p className="small">Answers and photo captions share a 10 KB limit.</p>
        {data.questions.map((q) => (
          <label key={q.id}>
            {q.text}
            {review ? (
              <p className="answer">{update.answers[q.id] || "No answer"}</p>
            ) : (
              <textarea
                readOnly={closed}
                value={update.answers[q.id] || ""}
                onChange={(e) =>
                  change({
                    ...update,
                    answers: { ...update.answers, [q.id]: e.target.value },
                  })
                }
                onBlur={flushOnBlur}
              />
            )}
            <small>{q.author_name} asked · Optional</small>
          </label>
        ))}
        <h2>📸 Photo Wall</h2>
        <p className="small">
          Up to three photos, resized privately before uploading. Location
          metadata is stripped.
        </p>
        <div className="photos">
          {update.photos.map((photo) => (
            <figure key={photo.id}>
              <img
                src={"/api/assets/" + photo.id}
                alt={photo.caption || "Your private photo"}
              />
              {!review && (
                <>
                  <label>
                    Caption
                    <input
                      readOnly={closed}
                      maxLength={250}
                      onBlur={flushOnBlur}
                      value={photo.caption}
                      onChange={(e) =>
                        change({
                          ...update,
                          photos: update.photos.map((p) =>
                            p.id === photo.id
                              ? { ...p, caption: e.target.value }
                              : p,
                          ),
                        })
                      }
                    />
                  </label>
                  <button
                    disabled={closed || busy}
                    className="quiet"
                    onClick={async () => {
                      const next = {
                        ...live.current.update,
                        photos: live.current.update.photos.filter(
                          (p) => p.id !== photo.id,
                        ),
                      };
                      change(next);
                      try {
                        await save();
                        if (
                          !data.contribution?.submitted?.photos.some(
                            (p) => p.id === photo.id,
                          )
                        )
                          await api("/assets/" + photo.id, {
                            method: "DELETE",
                          });
                      } catch (e) {
                        setError((e as Error).message);
                      }
                    }}
                  >
                    Remove photo
                  </button>
                </>
              )}
            </figure>
          ))}
        </div>
        {!review && !closed && (
          <label className="upload">
            + Add a photo
            <input
              aria-label="Add a photo"
              type="file"
              accept="image/jpeg,image/png,image/webp,image/heic,image/heif"
              disabled={busy || update.photos.length >= 3}
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                if (f) void addPhoto(f);
              }}
            />
          </label>
        )}
        <h2>📣 Shout-outs</h2>
        <label>
          Who deserves a little love?
          {review ? (
            <p className="answer">{update.shoutout || "No shout-out"}</p>
          ) : (
            <textarea
              readOnly={closed}
              value={update.shoutout}
              onBlur={flushOnBlur}
              onChange={(e) => change({ ...update, shoutout: e.target.value })}
            />
          )}
        </label>
        <h2>🌤️ One Good Thing</h2>
        <label>
          What made you smile?
          {review ? (
            <p className="answer">{update.good || "No good thing added"}</p>
          ) : (
            <textarea
              readOnly={closed}
              value={update.good}
              onBlur={flushOnBlur}
              onChange={(e) => change({ ...update, good: e.target.value })}
            />
          )}
        </label>
        <p className="small">
          Due {when(data.issue.deadline, data.issue.timezone)}
        </p>
        {!closed && (
          <div className="stack">
            {review ? (
              <>
                <Button onClick={() => void submit()} disabled={busy}>
                  Looks good — submit ✨
                </Button>
                <Button secondary onClick={() => setReview(false)}>
                  Keep writing
                </Button>
              </>
            ) : (
              <Button
                onClick={async () => {
                  try {
                    if (dirty) await save();
                    setReview(true);
                  } catch {}
                }}
                disabled={busy}
              >
                Review my update →
              </Button>
            )}
            {data.contribution?.submitted && (
              <Button
                secondary
                onClick={async () => {
                  try {
                    await api(path + "/withdraw", {
                      method: "POST",
                      body: { revision },
                    });
                    await refresh();
                    go("/groups/" + gid);
                  } catch (e) {
                    setError((e as Error).message);
                  }
                }}
              >
                Withdraw submission
              </Button>
            )}
          </div>
        )}
      </div>
    </>
  );
}
function Reader({
  p,
  date,
  zone,
}: {
  p: Publication;
  date: number;
  zone: string;
}) {
  const [person, setPerson] = useState("");
  const contributors = person
    ? p.contributors.filter((c) => c.id === person)
    : p.contributors;
  return (
    <article className="letter">
      <div className="masthead">
        <span className="kicker">A LETTER FROM YOUR PEOPLE</span>
        <div className="banner" aria-hidden="true">
          ✳　✦　✳
        </div>
        <PageHeading>{p.groupName}</PageHeading>
        <p>
          {p.title} ·{" "}
          {new Intl.DateTimeFormat("en-US", {
            dateStyle: "medium",
            timeZone: zone,
          }).format(date)}
        </p>
        <span className="small">Different time zones. Same table.</span>
      </div>
      <label className="reader-filter">
        Read updates from
        <select value={person} onChange={(e) => setPerson(e.target.value)}>
          <option value="">Everyone</option>
          {p.contributors.map((c) => (
            <option value={c.id} key={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </label>
      <section>
        <h2>✨ Questions</h2>
        {p.questions.map((q) => (
          <div className="question-block" key={q.id}>
            <p className="prompt">
              <strong>{q.author_name} asked:</strong> {q.text}
            </p>
            {contributors
              .filter((c) => c.update.answers[q.id])
              .map((c) => (
                <p className="answer" key={c.id}>
                  <strong>{c.name}:</strong> {c.update.answers[q.id]}
                </p>
              ))}
          </div>
        ))}
      </section>
      <section>
        <h2>📸 Photo Wall</h2>
        {contributors
          .filter((c) => c.update.photos.length)
          .map((c) => (
            <div className="question-block" key={c.id}>
              <div className="photos">
                {c.update.photos.map((a) => (
                  <figure key={a.id}>
                    <img
                      src={"/api/assets/" + a.id}
                      alt={a.caption || "Photo shared by " + c.name}
                    />
                    {a.caption && <figcaption>{a.caption}</figcaption>}
                  </figure>
                ))}
              </div>
              <strong>{c.name}</strong>
            </div>
          ))}
      </section>
      {(["shoutout", "good"] as const).map((key, i) => (
        <section key={key}>
          <h2>{["📣 Shout-outs", "🌤️ One Good Thing"][i]}</h2>
          <div className="question-block">
            {contributors
              .filter((c) => c.update[key])
              .map((c) => (
                <p className="answer" key={c.id}>
                  <strong>{c.name}:</strong> {c.update[key]}
                </p>
              ))}
          </div>
        </section>
      ))}
      <p className="small center">
        🖋 Made by {p.contributors.map((c) => c.name).join(", ")}
      </p>
    </article>
  );
}
function DevInbox({ onLogin }: { onLogin: () => Promise<void> }) {
  const [emails, setEmails] = useState<
      { id: string; recipient: string; subject: string; text: string }[]
    >([]),
    [error, setError] = useState("");
  async function refresh() {
    try {
      await api("/dev/tick", { method: "POST" });
      const r = await api<{ emails: typeof emails }>("/dev/inbox");
      setEmails(r.emails);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <details className="devbox">
      <summary>Local email inbox · development only</summary>
      <div className="stack">
        <Button
          secondary
          onClick={async () => {
            try {
              const r = await api<{ email: string }>("/dev/bootstrap", {
                method: "POST",
              });
              await api("/auth/request", {
                method: "POST",
                body: { email: r.email },
              });
              await refresh();
            } catch (e) {
              setError((e as Error).message);
            }
          }}
        >
          Get local host sign-in link
        </Button>
        <Button secondary onClick={() => void refresh()}>
          Refresh captured mail
        </Button>
      </div>
      <ErrorMessage error={error} />
      {emails.map((e) => {
        const match = e.text.match(/https?:\/\/[^\s]+/);
        return (
          <div className="notice" key={e.id}>
            <strong>{e.subject}</strong>
            <small>{e.recipient}</small>
            {match && (
              <Button
                secondary
                onClick={() =>
                  go(new URL(match[0]).pathname + new URL(match[0]).hash)
                }
              >
                Open captured link
              </Button>
            )}
          </div>
        );
      })}
    </details>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
