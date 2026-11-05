import type { Env } from "./types";
import { now } from "./security";
import { runScheduler } from "./scheduler";
import { processOutbox } from "./mail";
import { runExportStep } from "./exports";
import { runCleanup } from "./cleanup";
import { runSignupStep } from "./shared-join";
export async function runStages(
  stages: Record<string, () => Promise<unknown>>,
  record: (name: string, ok: boolean) => Promise<unknown>,
) {
  let healthy = true;
  for (const [name, run] of Object.entries(stages)) {
    let ok = true;
    try {
      await run();
    } catch {
      ok = false;
      healthy = false;
    }
    try {
      await record(name, ok);
    } catch {
      healthy = false;
    }
  }
  return healthy;
}
export async function runCron(env: Env) {
  const record = (name: string, ok: boolean) =>
    env.DB.prepare(
      "INSERT INTO service_state(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at",
    )
      .bind(name, ok ? "ok" : "failed", now())
      .run();
  const ok = await runStages(
    {
      schedule: () => runScheduler(env),
      signup: () => runSignupStep(env),
      mail: () => processOutbox(env),
      exports: () => runExportStep(env),
      cleanup: () => runCleanup(env),
    },
    (name, ok) => record("cron:" + name, ok),
  );
  await record("cron", ok);
}
