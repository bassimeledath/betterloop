import { clearDrafts } from "./draft-store";
let csrf = "";
export function setCsrf(value: string) {
  csrf = value;
}
export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
export async function uploadPhoto(
  path: string,
  body: Blob,
): Promise<{ id: string }> {
  const r = await fetch("/api" + path, {
    method: "POST",
    headers: { "Content-Type": "image/jpeg", "X-CSRF-Token": csrf },
    body,
    credentials: "same-origin",
  });
  const data = (await r.json()) as { id: string; error?: string };
  if (!r.ok) throw new ApiError(data.error || "Photo upload failed.", r.status);
  return data;
}
export async function api<T = Record<string, unknown>>(
  path: string,
  options: { method?: string; body?: unknown; signal?: AbortSignal } = {},
): Promise<T> {
  const response = await fetch("/api" + path, {
    method: options.method || "GET",
    headers: {
      ...(options.body !== undefined
        ? { "Content-Type": "application/json" }
        : {}),
      ...(options.method && options.method !== "GET"
        ? { "X-CSRF-Token": csrf }
        : {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: options.signal,
    credentials: "same-origin",
  });
  const result = (await response.json()) as T & { error?: string };
  if (!response.ok)
    throw new ApiError(result.error || "Please try again.", response.status);
  if (
    path === "/auth/logout" ||
    (path === "/me" && options.method === "DELETE")
  )
    clearDrafts();
  return result;
}
