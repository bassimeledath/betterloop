import type { Env } from "./types";
import { local, now, fail } from "./security";
type Address = { id: string; email: string; verified: string | null };
type Envelope<T> = {
  success: boolean;
  result?: T;
  result_info?: { total_pages?: number };
  errors?: { code: number }[];
};
export const enrollmentReady = (env: Env) =>
  !!env.CF_EMAIL_TOKEN &&
  !!env.CF_ACCOUNT_ID &&
  /^[a-f0-9]{32}$/i.test(env.CF_ACCOUNT_ID);
async function api<T>(env: Env, path: string, method = "GET", body?: unknown) {
  if (!enrollmentReady(env))
    fail(
      503,
      "Automatic email setup is not ready. Ask the host to finish setup.",
    );
  const url =
    "https://api.cloudflare.com/client/v4/accounts/" +
    env.CF_ACCOUNT_ID +
    "/email/routing/addresses" +
    path;
  const init = {
    method,
    headers: {
      Authorization: "Bearer " + env.CF_EMAIL_TOKEN,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  };
  const response = await (local(env) && env.EMAIL_ROUTING_API
    ? env.EMAIL_ROUTING_API.fetch(url, init)
    : fetch(url, { ...init, signal: AbortSignal.timeout(10000) }));
  let data: Envelope<T>;
  try {
    data = await response.json();
  } catch {
    fail(
      503,
      "Email verification is temporarily unavailable. Please try again shortly.",
    );
  }
  if (!response.ok || !data!.success || !data!.result)
    fail(
      503,
      "Email verification is temporarily unavailable. Please try again shortly.",
    );
  return data!;
}
function valid(address: Address, email: string) {
  if (
    !address.id ||
    address.id.length > 64 ||
    address.email?.toLowerCase() !== email
  )
    fail(
      503,
      "Email verification could not be confirmed. Please try again shortly.",
    );
  return address;
}
async function remember(env: Env, email: string, address: Address) {
  valid(address, email);
  await env.DB.prepare(
    "INSERT INTO email_destinations(email,verified,checked_at,provider_id) VALUES(?,?,?,?) ON CONFLICT(email) DO UPDATE SET verified=excluded.verified,checked_at=excluded.checked_at,provider_id=excluded.provider_id",
  )
    .bind(email, +!!address.verified, now(), address.id)
    .run();
  return !!address.verified;
}
export async function emailDestination(
  env: Env,
  email: string,
  create: boolean,
) {
  const cached = await env.DB.prepare(
    "SELECT verified,suppressed,provider_id FROM email_destinations WHERE email=?",
  )
    .bind(email)
    .first<{
      verified: number;
      suppressed: number;
      provider_id: string | null;
    }>();
  if (cached?.suppressed)
    fail(403, "This signup cannot continue. Please contact the group host.");
  if (cached?.provider_id) {
    const data = await api<Address>(
      env,
      "/" + encodeURIComponent(cached.provider_id),
    );
    return remember(env, email, data.result!);
  }
  // Verified manually enrolled addresses already have an eligible sending path.
  if (cached?.verified) return true;
  for (let page = 1; page <= 4; page++) {
    const data = await api<Address[]>(env, "?per_page=50&page=" + page);
    const found = data.result!.find((a) => a.email?.toLowerCase() === email);
    if (found) return remember(env, email, found);
    if (
      data.result!.length < 50 ||
      page === (data.result_info?.total_pages || 0)
    )
      break;
    if (page === 4 && !create) return false;
  }
  if (!create) return false;
  const data = await api<Address>(env, "", "POST", { email });
  return remember(env, email, data.result!);
}
