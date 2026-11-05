import { it, expect } from "vitest";
import { publicationMail } from "../server/mail";
import type { Publication } from "../server/types";
it("keeps short letters inline and safely renders punctuation and markup as text", () => {
  const answer = `Hello <friends> & "welcome" — it's good to see you.`,
    p: Publication = {
      schemaVersion: 1,
      groupName: "Our circle",
      title: "A little update",
      questions: [{ id: "q", text: "How are you?", author_name: "A friend" }],
      contributors: [
        {
          id: "u",
          name: "Reader",
          update: {
            answers: { q: answer },
            photos: [],
            shoutout: "Well done!",
            good: "Sunshine.",
          },
        },
      ],
    },
    mail = publicationMail(
      p,
      "https://betterloop.example.com/groups/g/issues/i",
    );
  expect(mail.text).toContain(answer);
  expect(mail.html).toContain(
    "Hello &lt;friends&gt; &amp; &quot;welcome&quot; — it&#39;s good to see you.",
  );
  expect(mail.html).toContain("How are you?");
  expect(mail.html).toContain("Well done!");
  expect(mail.html).not.toContain("A taste of everyone");
});
it("keeps every contributor in a long email while bounding HTML and protecting private photos", () => {
  const p: Publication = {
    schemaVersion: 1,
    groupName: "Our <table>",
    title: "A long letter",
    questions: Array.from({ length: 10 }, (_, i) => ({
      id: "q" + i,
      text: "A question?",
      author_name: "A friend",
    })),
    contributors: Array.from({ length: 20 }, (_, i) => ({
      id: "u" + i,
      name: "Reader " + i,
      update: {
        answers: Object.fromEntries(
          Array.from({ length: 10 }, (_, j) => ["q" + j, '<>&"'.repeat(250)]),
        ),
        photos: [{ id: "private-photo-" + i, caption: "Our photo" }],
        shoutout: "",
        good: "",
      },
    })),
  };
  const mail = publicationMail(
    p,
    "https://betterloop.example.com/groups/g/issues/i",
  );
  expect(new TextEncoder().encode(mail.html).length).toBeLessThan(80000);
  for (const c of p.contributors) expect(mail.html).toContain(c.name);
  expect(mail.html).toContain("Our &lt;table&gt;");
  expect(mail.html).not.toContain("<img");
  expect(mail.html).not.toContain("private-photo-");
  expect(mail.text).toContain("20 private photos");
  expect(mail.html).toContain("Manage group emails");
});
it("bounds HTML for twenty photo-heavy updates with escaped names and captions", () => {
  const p: Publication = {
    schemaVersion: 1,
    groupName: "&".repeat(80),
    title: "&".repeat(120),
    coverId: "cover",
    coverCaption: "&".repeat(250),
    questions: [
      { id: "q", text: "&".repeat(500), author_name: "&".repeat(80) },
    ],
    contributors: Array.from({ length: 20 }, (_, i) => ({
      id: "u" + i,
      name: "&".repeat(80),
      update: {
        answers: { q: "&".repeat(9250) },
        photos: Array.from({ length: 3 }, (_, j) => ({
          id: `p${i}-${j}`,
          caption: "&".repeat(250),
        })),
        shoutout: "",
        good: "",
      },
    })),
  };
  const sources = Object.fromEntries(
    [
      "cover",
      ...p.contributors.flatMap((c) => c.update.photos.map((a) => a.id)),
    ]
      .slice(0, 32)
      .map((id) => [id, "cid:" + id + "@betterloop"]),
  );
  const mail = publicationMail(
    p,
    "https://betterloop.example.com/groups/g/issues/i",
    sources,
  );
  expect(new TextEncoder().encode(mail.html).byteLength).toBeLessThan(80000);
  expect(mail.html).toContain("cid:cover@betterloop");
  expect(mail.html).toContain("Read your letter");
});
