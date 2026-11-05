import React, { useState } from "react";
import { PageHeading } from "./ui";
import type { Publication } from "../shared/contracts";
export function Reader({
  p,
  date,
  zone,
  gid,
}: {
  p: Publication;
  date: number;
  zone: string;
  gid: string;
}) {
  const [person, setPerson] = useState("");
  const contributors = person
    ? p.contributors.filter((c) => c.id === person)
    : p.contributors;
  return (
    <article className="letter">
      <div className="masthead">
        <span className="kicker">A LETTER FROM YOUR PEOPLE</span>
        {p.coverId ? (
          <img
            className="group-cover"
            src={"/api/groups/" + gid + "/covers/" + p.coverId}
            alt={p.coverCaption || p.groupName + " group cover"}
          />
        ) : (
          <div className="banner" aria-hidden="true">
            ✳　✦　✳
          </div>
        )}
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
        {p.questions
          .filter((q) => contributors.some((c) => c.update.answers[q.id]))
          .map((q) => (
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
                    <a
                      href={"/api/assets/" + a.id}
                      target="_blank"
                      rel="noreferrer"
                    >
                      <img
                        src={"/api/assets/" + a.id}
                        alt={a.caption || "Photo shared by " + c.name}
                      />
                    </a>
                    {a.caption && <figcaption>{a.caption}</figcaption>}
                  </figure>
                ))}
              </div>
              <strong>{c.name}</strong>
            </div>
          ))}
      </section>
      {(["shoutout", "good"] as const).map(
        (key, i) =>
          contributors.some((c) => c.update[key]) && (
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
          ),
      )}
      <p className="small center">
        🖋 Made by {p.contributors.map((c) => c.name).join(", ")}
      </p>
    </article>
  );
}
