import { EmailPreview } from "./email-preview";
import React, { useState, useEffect, useRef } from "react";
import { Lock } from "lucide-react";
import { api, ApiError, uploadPhoto } from "./api";
import { preparePhoto } from "./photo";
import {
  Button,
  PageHeading,
  ErrorMessage,
  when,
  go,
  setNavigationGuard,
} from "./ui";
import type { Update, Publication } from "../shared/contracts";
import type { IssueData } from "../shared/contracts";
import { readDraft, writeDraft, removeDraft } from "./draft-store";
export function Composer({
  gid,
  userId,
  data,
  refresh,
}: {
  gid: string;
  userId: string;
  data: IssueData;
  refresh: () => Promise<IssueData | null>;
}) {
  const recoveryKey = userId + ":" + gid + ":" + data.issue.id;
  const [recovery] = useState(() => readDraft(recoveryKey));
  const [update, setUpdate] = useState<Update>(
      recovery?.update ||
        data.contribution?.draft || {
          answers: {},
          photos: [],
          shoutout: "",
          good: "",
        },
    ),
    [revision, setRevision] = useState(data.contribution?.revision || 0),
    [status, setStatus] = useState(
      recovery ? "Recovered on this device" : "Saved",
    ),
    [error, setError] = useState(
      recovery && recovery.revision !== (data.contribution?.revision || 0)
        ? "A recovered draft differs from the saved version. Copy it before reloading, or retry to reconcile."
        : "",
    ),
    [review, setReview] = useState(false),
    [dirty, setDirty] = useState(!!recovery),
    [busy, setBusy] = useState(false);
  const path = "/groups/" + gid + "/issues/" + data.issue.id;
  const [clock, setClock] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const closed = data.issue.state !== "open" || data.issue.deadline <= clock;
  const live = useRef({
    update,
    revision,
    generation: recovery ? 1 : 0,
    saved: 0,
  });
  const uncertain = useRef<{ snapshot: Update; generation: number } | null>(
    null,
  );
  const [acting, setActing] = useState(false);
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
          "Your latest edits have not reached the server. Leave this page before syncing?",
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
      const emailPhoto = await preparePhoto(file, {
        maxPixels: 800,
        maxBytes: 98304,
      });
      const asset = await uploadPhoto(path + "/assets", blob, emailPhoto);
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
        if (
          recovery &&
          recovery.revision !== (data.contribution?.revision || 0) &&
          live.current.saved === 0 &&
          JSON.stringify(recovery.update) !==
            JSON.stringify(data.contribution?.draft)
        )
          throw new Error(
            "This draft changed in another tab. Copy your recovered text before reloading.",
          );
        if (uncertain.current) {
          const remote = await api<IssueData>(path);
          if ((remote.contribution?.revision || 0) !== live.current.revision) {
            if (
              JSON.stringify(remote.contribution?.draft) !==
              JSON.stringify(uncertain.current.snapshot)
            )
              throw new Error(
                "This draft changed in another tab. Copy your recovered text before reloading.",
              );
            live.current.revision = remote.contribution!.revision;
            live.current.saved = uncertain.current.generation;
          }
          uncertain.current = null;
        }
        while (live.current.saved < live.current.generation) {
          const generation = live.current.generation,
            snapshot = structuredClone(live.current.update);
          uncertain.current = { snapshot, generation };
          const r = await api<{ revision: number }>(path + "/contribution", {
            method: "PUT",
            body: { revision: live.current.revision, update: snapshot },
          });
          uncertain.current = null;
          live.current.revision = r.revision;
          live.current.saved = generation;
          setRevision(r.revision);
        }
        setRevision(live.current.revision);
        removeDraft(recoveryKey);
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
    setStatus(
      writeDraft(recoveryKey, next, live.current.revision)
        ? "Unsaved changes"
        : "Local recovery unavailable — keep this page open",
    );
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
    setActing(true);
    try {
      setError("");
      const r = dirty ? await save() : revision;
      try {
        await api(path + "/submit", { method: "POST", body: { revision: r } });
      } catch (e) {
        const remote = await api<IssueData>(path);
        if (
          !remote.contribution?.submitted ||
          JSON.stringify(remote.contribution.submitted) !==
            JSON.stringify(live.current.update)
        )
          throw e;
      }
      await refresh();
      go("/groups/" + gid);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setActing(false);
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
      {data.contribution?.submitted && (
        <p className="notice">
          {JSON.stringify(update) ===
          JSON.stringify(data.contribution.submitted)
            ? "Submitted " +
              when(data.contribution.submittedAt!) +
              ". You can edit until the deadline."
            : "You have private draft changes. Submit changes to replace your previous submission before the deadline."}
        </p>
      )}
      {data.contribution?.submitted && (
        <details className="panel">
          <summary>View the submitted copy</summary>
          {data.questions.map((q) => (
            <div key={q.id}>
              <strong>{q.text}</strong>
              <p className="answer">
                {data.contribution!.submitted!.answers[q.id] || "No answer"}
              </p>
            </div>
          ))}
          <p className="answer">{data.contribution.submitted.shoutout}</p>
          <p className="answer">{data.contribution.submitted.good}</p>
          <div className="photos">
            {data.contribution.submitted.photos.map((p) => (
              <figure key={p.id}>
                <img
                  src={"/api/assets/" + p.id}
                  alt={p.caption || "Submitted photo"}
                />
                <figcaption>{p.caption}</figcaption>
              </figure>
            ))}
          </div>
        </details>
      )}
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
                removeDraft(recoveryKey);
                live.current.saved = live.current.generation;
                location.reload();
              }
            }}
          >
            Reload saved version
          </Button>
        </div>
      )}
      {review && !dirty && !busy && (
        <EmailPreview gid={gid} iid={data.issue.id} />
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
        {busy && <p className="small">Preparing or saving your update…</p>}
        <p className="small">
          Up to three photos, resized privately before uploading. Location
          metadata is stripped. Email copies can be saved or forwarded.
        </p>
        <div className="photos">
          {update.photos.map((photo) => (
            <figure key={photo.id}>
              <img
                src={"/api/assets/" + photo.id}
                alt={photo.caption || "Your private photo"}
              />
              {review && <figcaption>{photo.caption}</figcaption>}
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
              accept="image/jpeg,image/png,image/webp"
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
                <Button onClick={() => void submit()} disabled={busy || acting}>
                  {data.contribution?.submitted
                    ? "Submit changes ✨"
                    : "Looks good — submit ✨"}
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
                disabled={busy || acting}
              >
                Review my update →
              </Button>
            )}
            {data.contribution?.submitted && (
              <Button
                secondary
                disabled={busy || acting || dirty}
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
