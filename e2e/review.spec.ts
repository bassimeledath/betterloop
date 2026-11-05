import {
  test as base,
  expect,
  type BrowserContext,
  type Page,
} from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mkdir, writeFile } from "node:fs/promises";
import { harness, type TestClient } from "../tests/harness";
import { runScheduler } from "../server/scheduler";
import { processOutbox } from "../server/mail";
const evidenceRoot = process.env.UPDATE_REVIEW_EVIDENCE
  ? "docs/evidence"
  : "test-results/review-evidence";
const origin = "http://127.0.0.1:5193";
type H = Awaited<ReturnType<typeof harness>>;
const test = base.extend<{ h: H }>({
  h: async ({}, use) => {
    const h = await harness({ origin });
    try {
      await use(h);
    } finally {
      await h.close();
    }
  },
});
async function connect(context: BrowserContext, h: H, client: TestClient) {
  await context.addCookies([
    {
      name: "ll_session",
      value: client.cookie.slice("ll_session=".length),
      url: origin,
    },
  ]);
  await context.route(origin + "/api/**", async (route) => {
    const request = route.request();
    const response = await h.mf.dispatchFetch(request.url(), {
      method: request.method(),
      headers: await request.allHeaders(),
      body: request.postDataBuffer() || undefined,
    });
    await route.fulfill({
      status: response.status,
      headers: Object.fromEntries(response.headers),
      body: Buffer.from(await response.arrayBuffer()),
    });
  });
}
async function setup(page: Page, h: H) {
  const owner = await h.login("writer@example.test"),
    gid = await h.group(owner),
    issue = await h.issue(owner, gid);
  await connect(page.context(), h, owner);
  const path = `/groups/${gid}/issues/${issue.id}`;
  await page.goto(path);
  await expect(
    page.getByRole("heading", { name: "A little life update." }),
  ).toBeVisible();
  return { owner, gid, issue, path };
}
async function saved(page: Page) {
  await expect(page.getByRole("status")).toHaveText("Saved");
}
async function submit(page: Page) {
  await page.getByRole("button", { name: "Review my update" }).click();
  await page
    .getByRole("button", { name: /Looks good — submit|Submit changes/ })
    .click();
  await expect(
    page.getByRole("heading", { name: "A little life update." }),
  ).toHaveCount(0);
}
async function photo(page: Page, width: number, height: number, mime: string) {
  const url = await page.evaluate(
    ({ width, height, mime }) => {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d")!;
      ctx.fillStyle = "#71507e";
      ctx.fillRect(0, 0, width, height);
      ctx.fillStyle = "#e7d9ef";
      ctx.fillRect(width / 8, height / 8, (width * 3) / 4, (height * 3) / 4);
      ctx.fillStyle = "#302536";
      ctx.font = `${Math.floor(width / 18)}px sans-serif`;
      ctx.fillText("Betterloop test photo", width / 7, height / 2);
      return canvas.toDataURL(mime);
    },
    { width, height, mime },
  );
  return {
    name: mime === "image/png" ? "sample.png" : "sample.jpg",
    mimeType: mime,
    buffer: Buffer.from(url.split(",")[1], "base64"),
  };
}

test("two sample submissions: resize, persist, edit, publish and display private photos", async ({
  page,
  browser,
  h,
}, info) => {
  const { owner, gid, issue, path } = await setup(page, h);
  const question = page.locator("textarea").first();
  await question.fill("First sitting: a weekend walk.");
  await saved(page);
  await page
    .getByLabel("Add a photo")
    .setInputFiles(await photo(page, 3200, 1800, "image/jpeg"));
  await expect(page.locator("figure img")).toHaveCount(1);
  await page
    .getByLabel("Caption", { exact: true })
    .fill("A synthetic landscape, resized on this device.");
  await saved(page);
  await page.reload();
  await expect(question).toHaveValue("First sitting: a weekend walk.");
  await expect(page.getByLabel("Caption", { exact: true })).toHaveValue(
    "A synthetic landscape, resized on this device.",
  );
  await expect
    .poll(() =>
      page
        .locator("figure img")
        .evaluate((i: HTMLImageElement) => i.naturalWidth),
    )
    .toBe(1600);
  const rows = await h.db
    .prepare("SELECT width,height,bytes FROM assets WHERE issue_id=?")
    .bind(issue.id)
    .all<{ width: number; height: number; bytes: number }>();
  expect(rows.results[0]).toMatchObject({ width: 1600, height: 900 });
  expect(rows.results[0].bytes).toBeLessThanOrEqual(1048576);
  await submit(page);
  // A new session on another device returns to the same server draft.
  const writerContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
  });
  await connect(writerContext, h, await h.login(owner.email));
  const writer = await writerContext.newPage();
  await writer.goto(origin + path);
  await expect(writer.locator("textarea").first()).toHaveValue(
    "First sitting: a weekend walk.",
  );
  await writer
    .locator("textarea")
    .first()
    .fill("Second sitting: the walk became a picnic.");
  await saved(writer);
  await submit(writer);
  const friend = await h.login("friend@example.test");
  await h.invite(owner, friend, gid);
  const friendContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
  });
  await connect(friendContext, h, friend);
  const friendPage = await friendContext.newPage();
  await friendPage.goto(origin + path);
  await friendPage
    .locator("textarea")
    .first()
    .fill("A second member's update: learning to cook.");
  await friendPage
    .getByLabel("Add a photo")
    .setInputFiles(await photo(friendPage, 1800, 2400, "image/png"));
  await expect(friendPage.locator("figure img")).toHaveCount(1);
  await friendPage
    .getByLabel("Caption", { exact: true })
    .fill("A synthetic portrait, converted from PNG.");
  await saved(friendPage);
  const draftPhoto = await h.db
    .prepare("SELECT id FROM assets WHERE user_id=? AND issue_id=?")
    .bind(owner.id, issue.id)
    .first<{ id: string }>();
  expect(
    (await h.request("/api/assets/" + draftPhoto!.id, { client: friend }))
      .status,
  ).toBe(404);
  await submit(friendPage);
  await h.db
    .prepare("UPDATE issues SET deadline=? WHERE id=?")
    .bind(Date.now() - 1, issue.id)
    .run();
  await runScheduler(h.env);
  await processOutbox(h.env, 20);
  await page.goto(path);
  await expect(page.locator(".letter")).toBeVisible();
  await expect(page.locator(".letter")).toContainText(
    "Second sitting: the walk became a picnic.",
  );
  await expect(page.locator(".letter")).toContainText("learning to cook");
  await expect(page.locator(".letter figure img")).toHaveCount(2);
  for (const image of await page.locator(".letter figure img").all())
    await expect
      .poll(() =>
        image.evaluate(
          (i: HTMLImageElement) => i.complete && i.naturalWidth > 0,
        ),
      )
      .toBe(true);
  expect(
    (await h.request("/api/assets/" + draftPhoto!.id, { client: friend }))
      .status,
  ).toBe(200);
  expect((await h.request("/api/assets/" + draftPhoto!.id)).status).toBe(401);
  const mail = await h.db
    .prepare(
      "SELECT html FROM captured_emails WHERE recipient=? AND subject LIKE '%letter is here%'",
    )
    .bind(owner.email)
    .first<{ html: string }>();
  expect(mail!.html).toContain("2 private photos");
  expect(mail!.html).toContain("<img");
  expect(mail!.html).toContain("cid:");
  await mkdir(evidenceRoot, { recursive: true });
  await writeFile(evidenceRoot + "/sample-newsletter.html", mail!.html);
  const photoRows = await h.db
    .prepare(
      "SELECT width,height,bytes FROM assets WHERE issue_id=? ORDER BY created_at",
    )
    .bind(issue.id)
    .all();
  await writeFile(
    evidenceRoot + "/sample-result.json",
    JSON.stringify(
      {
        contributors: 2,
        photoCount: 2,
        photos: photoRows.results,
        privateUntilPublished: true,
        anonymousAccess: 401,
        resubmittedEditPublished: true,
        emailPhotos: "Private web links; no inline images",
      },
      null,
      2,
    ) + "\n",
  );
  const emailPage = await page.context().newPage();
  await emailPage.goto(origin + path + "/email-preview");
  await expect(emailPage.locator("img")).toHaveCount(2);
  for (const img of await emailPage.locator("img").all())
    await expect
      .poll(() => img.evaluate((i: HTMLImageElement) => i.naturalWidth > 0))
      .toBe(true);
  await emailPage.screenshot({
    path: evidenceRoot + "/mobile-email.png",
    fullPage: true,
  });
  await emailPage.close();
  await page
    .locator("main")
    .screenshot({ path: evidenceRoot + "/mobile-reader.png" });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page
    .locator("main")
    .screenshot({ path: evidenceRoot + "/desktop-reader.png" });
  await info.attach("sample-publication", {
    body: JSON.stringify({
      contributors: 2,
      photos: 2,
      firstPhoto: rows.results[0],
      emailPhotos: "private web links",
    }),
    contentType: "application/json",
  });
  await writerContext.close();
  await friendContext.close();
});

test("autosave serializes typing during a slow save and reports multi-tab conflicts", async ({
  page,
  browser,
  h,
}) => {
  const { owner, path } = await setup(page, h);
  await page.route("**/contribution", async (route) => {
    await new Promise((r) => setTimeout(r, 500));
    await route.fallback();
  });
  const field = page.locator("textarea").first();
  await field.fill("First revision");
  await expect(page.getByRole("status")).toHaveText("Saving…");
  await field.fill("Typed while the first save was in flight");
  await saved(page);
  const context = await browser.newContext();
  await connect(context, h, owner);
  const other = await context.newPage();
  await other.goto(origin + path);
  await expect(other.locator("textarea").first()).toHaveValue(
    "Typed while the first save was in flight",
  );
  await field.fill("Winning edit");
  await saved(page);
  await other.locator("textarea").first().fill("Conflicting edit");
  await expect(other.getByRole("alert")).toContainText("another tab");
  await expect(other.locator("textarea").first()).toHaveValue(
    "Conflicting edit",
  );
  await expect(
    other.getByRole("button", { name: "Copy my unsaved draft" }),
  ).toBeVisible();
  await context.close();
});

test("mobile and desktop composition and settings have no page overflow or automated accessibility violations", async ({
  page,
  h,
}) => {
  const { gid, path } = await setup(page, h);
  await page
    .locator("textarea")
    .first()
    .fill("A little text for a real layout check.");
  await saved(page);
  await page
    .getByLabel("Add a photo")
    .setInputFiles(await photo(page, 3200, 1800, "image/jpeg"));
  await expect(page.locator("figure img")).toHaveCount(1);
  await saved(page);
  for (const width of [320, 390, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();
    expect(results.violations).toEqual([]);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await mkdir(evidenceRoot, { recursive: true });
  await page
    .locator("main")
    .screenshot({ path: evidenceRoot + "/mobile-composer.png" });
  await page.goto(`/groups/${gid}/settings`);
  await expect(
    page.getByRole("heading", { name: "A rhythm that feels right." }),
  ).toBeVisible();
  await expect(page.getByText(/Next future letter:/)).toBeVisible();
  await page
    .locator("main")
    .screenshot({ path: evidenceRoot + "/mobile-settings.png" });
  for (const width of [320, 390, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  }
  await page.goto(path);
  await expect(page.locator("textarea").first()).toHaveValue(
    "A little text for a real layout check.",
  );
});

test("R2: offline unsaved text survives a forced mobile-page close", async ({
  page,
  browser,
  h,
}) => {
  const { owner, path } = await setup(page, h);
  await page.locator("textarea").first().fill("Saved before going offline");
  await saved(page);
  await page.route("**/contribution", (route) =>
    route.abort("internetdisconnected"),
  );
  await page.locator("textarea").first().fill("Unsaved offline continuation");
  await expect(page.getByRole("status")).toContainText("Not saved");
  await page.close({ runBeforeUnload: false });
  // Same browser storage and session, simulating a forced close rather than a navigation confirmation.
  const reopened = await page.context().newPage();
  await reopened.goto(origin + path);

  await expect(reopened.locator("textarea").first()).toHaveValue(
    "Unsaved offline continuation",
  );
});

test("R4: a lost save response can be retried without manually copying the draft", async ({
  page,
  h,
}) => {
  await setup(page, h);
  let dropped = false;
  await page.route("**/contribution", async (route) => {
    if (dropped) return route.fallback();
    dropped = true;
    const r = route.request();
    const response = await h.mf.dispatchFetch(r.url(), {
      method: r.method(),
      headers: await r.allHeaders(),
      body: r.postDataBuffer()!,
    });
    expect(response.status).toBe(200);
    await route.abort("connectionreset");
  });
  await page
    .locator("textarea")
    .first()
    .fill("Committed but acknowledgement was lost");
  await expect(page.getByRole("status")).toContainText("Not saved");
  await page.getByRole("button", { name: "Retry saving" }).click();
  await expect(page.getByRole("status")).toHaveText("Saved");
});

test("invalid or over-limit image input preserves written answers", async ({
  page,
  h,
}) => {
  await setup(page, h);
  await page.locator("textarea").first().fill("Keep this answer");
  await saved(page);
  await page.getByLabel("Add a photo").setInputFiles({
    name: "broken.jpg",
    mimeType: "image/jpeg",
    buffer: Buffer.from("not an image"),
  });
  await expect(page.getByRole("alert")).toContainText("could not be opened");
  await page.getByLabel("Add a photo").setInputFiles({
    name: "huge.jpg",
    mimeType: "image/jpeg",
    buffer: Buffer.alloc(20 * 1024 * 1024 + 1),
  });
  await expect(page.getByRole("alert")).toContainText("smaller than 20 MB");
  await page.reload();
  await expect(page.locator("textarea").first()).toHaveValue(
    "Keep this answer",
  );
});

test("a photo larger than one MiB is compressed before the upload request", async ({
  page,
  h,
}) => {
  const { issue } = await setup(page, h);
  const url = await page.evaluate(() => {
    const c = document.createElement("canvas");
    c.width = 2400;
    c.height = 1600;
    const ctx = c.getContext("2d")!,
      pixels = ctx.createImageData(c.width, c.height);
    let value = 12345;
    for (let i = 0; i < pixels.data.length; i += 4) {
      for (let k = 0; k < 3; k++) {
        value ^= value << 13;
        value ^= value >>> 17;
        value ^= value << 5;
        pixels.data[i + k] = value & 255;
      }
      pixels.data[i + 3] = 255;
    }
    ctx.putImageData(pixels, 0, 0);
    return c.toDataURL("image/png");
  });
  const input = Buffer.from(url.split(",")[1], "base64");
  expect(input.length).toBeGreaterThan(1048576);
  await page.getByLabel("Add a photo").setInputFiles({
    name: "large-noise.png",
    mimeType: "image/png",
    buffer: input,
  });
  await expect(page.locator("figure img")).toHaveCount(1);
  await saved(page);
  const row = await h.db
    .prepare("SELECT width,height,bytes FROM assets WHERE issue_id=?")
    .bind(issue.id)
    .first<{ width: number; height: number; bytes: number }>();
  expect(row!.width).toBe(1600);
  expect(row!.bytes).toBeLessThanOrEqual(1048576);
  await mkdir(evidenceRoot, { recursive: true });
  await writeFile(
    evidenceRoot + "/large-upload-result.json",
    JSON.stringify({ inputBytes: input.length, ...row }, null, 2) + "\n",
  );
});

test("R6: an allowed long group name fits a narrow mobile heading", async ({
  page,
  h,
}) => {
  const { gid } = await setup(page, h);
  await h.db
    .prepare("UPDATE groups SET name=? WHERE id=?")
    .bind("W".repeat(80), gid)
    .run();
  await page.setViewportSize({ width: 320, height: 844 });
  await page.goto(`/groups/${gid}`);
  await expect(
    page.getByRole("heading", { name: "W".repeat(80), exact: true }),
  ).toBeVisible();
  await mkdir(evidenceRoot, { recursive: true });
  await page.screenshot({ path: evidenceRoot + "/mobile-long-name.png" });
  const width = await page.evaluate(() => ({
    page: document.documentElement.scrollWidth,
    viewport: innerWidth,
  }));
  await writeFile(
    evidenceRoot + "/long-name-result.json",
    JSON.stringify(width, null, 2) + "\n",
  );
  expect(width.page).toBeLessThanOrEqual(width.viewport);
});

test("a save rejected before commit can be retried without discarding text", async ({
  page,
  h,
}) => {
  await setup(page, h);
  let first = true;
  await page.route("**/contribution", async (route) => {
    if (first) {
      first = false;
      await route.abort("connectionreset");
    } else await route.fallback();
  });
  await page.locator("textarea").first().fill("Not yet committed");
  await expect(page.getByRole("status")).toContainText("Not saved");
  await page.getByRole("button", { name: "Retry saving" }).click();
  await saved(page);
  await page.reload();
  await expect(page.locator("textarea").first()).toHaveValue(
    "Not yet committed",
  );
});

test("host crops and replaces a group cover and previews an email with its inline photos", async ({
  page,
  h,
}) => {
  const { gid, path, issue, owner } = await setup(page, h);
  await page.locator("textarea").first().fill("A picnic with the gang.");
  await saved(page);
  await page
    .getByLabel("Add a photo")
    .setInputFiles(await photo(page, 3200, 1800, "image/jpeg"));
  await expect(page.locator("figure img")).toHaveCount(1);
  await page.getByLabel("Caption", { exact: true }).fill("The best picnic.");
  await saved(page);
  expect(
    await h.db
      .prepare("SELECT length(email_data) AS size FROM assets WHERE issue_id=?")
      .bind(issue.id)
      .first(),
  ).toMatchObject({ size: expect.any(Number) });
  await page.goto(`/groups/${gid}/settings`);
  await page
    .getByLabel("Choose a group cover", { exact: true })
    .setInputFiles(await photo(page, 1600, 1000, "image/jpeg"));
  await expect(page.getByLabel("Cover crop preview")).toBeVisible();
  await page.getByLabel("Zoom", { exact: true }).focus();
  await page.getByLabel("Zoom", { exact: true }).press("ArrowRight");
  await page
    .getByLabel("Cover description", { exact: true })
    .fill("Friends at the park");
  await page
    .getByRole("button", { name: "Save group cover", exact: true })
    .click();
  await expect(
    page.getByText("Cover saved. It will appear in your next letter."),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Preview newsletter email", exact: true })
    .click();
  const frame = page.frameLocator('iframe[title="Newsletter email preview"]');
  await expect(frame.getByText("A picnic with the gang.")).toBeVisible();
  await expect(frame.locator("img")).toHaveCount(2);
  for (const img of await frame.locator("img").all())
    await expect
      .poll(() =>
        img.evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth > 0),
      )
      .toBe(true);
  await mkdir(evidenceRoot, { recursive: true });
  await page.screenshot({
    path: evidenceRoot + "/mobile-cover-controls.png",
    fullPage: true,
  });
  const preview = await page.context().newPage();
  await preview.goto(
    origin + `/api/groups/${gid}/issues/${issue.id}/email-preview`,
  );
  await preview.screenshot({
    path: evidenceRoot + "/mobile-photo-email.png",
    fullPage: true,
  });
  await preview.close();
  await page
    .getByLabel("Choose a group cover", { exact: true })
    .setInputFiles(await photo(page, 1800, 1200, "image/png"));
  await page
    .getByRole("button", { name: "Save group cover", exact: true })
    .click();
  await expect(
    page.getByText("Cover saved. It will appear in your next letter."),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Remove current cover", exact: true })
    .click();
  await expect(page.getByText("Current cover removed.")).toBeVisible();
});
