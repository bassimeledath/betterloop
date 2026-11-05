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
} from "../shared/contracts";
import "@fontsource/fraunces/latin-600.css";
import "@fontsource/nunito-sans/latin-400.css";
import "@fontsource/nunito-sans/latin-700.css";
import "./styles.css";
import { Composer } from "./composer";
import { Reader } from "./reader";
import type { Me } from "../shared/contracts";
import { Signin, Confirm, Invitation } from "./auth-screens";
import {
  Home,
  CreateGroup,
  GroupHome,
  Questions,
  Members,
} from "./group-screens";
import type { Detail, Q, IssueData } from "../shared/contracts";
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
        <IssuePage gid={gid} iid={iid} userId={me.user.id} />
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
function IssuePage({
  gid,
  iid,
  userId,
}: {
  gid: string;
  iid: string;
  userId: string;
}) {
  const { data, error, refresh } = useData<IssueData>(
    "/groups/" + gid + "/issues/" + iid,
  );
  const [showDraft, setShowDraft] = useState(false);
  if (!data) return <ErrorMessage error={error} />;
  return data.publication && !showDraft ? (
    <>
      <Button secondary onClick={() => setShowDraft(true)}>
        View my saved draft
      </Button>
      <Reader
        p={data.publication}
        date={data.issue.delivery_at}
        zone={data.issue.timezone}
      />
    </>
  ) : (
    <Composer
      key={iid}
      gid={gid}
      userId={userId}
      data={data}
      refresh={refresh}
    />
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
