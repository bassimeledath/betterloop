import type { Update } from "../shared/contracts";
const prefix = "betterloop-draft:";
export type Recovery = { update: Update; revision: number; time: number };
export function readDraft(key: string): Recovery | null {
  try {
    const v = JSON.parse(localStorage.getItem(prefix + key) || "null");
    if (
      v &&
      Date.now() - v.time < 7 * 86400000 &&
      v.update?.answers &&
      Array.isArray(v.update.photos)
    )
      return v;
    localStorage.removeItem(prefix + key);
  } catch {}
  return null;
}
export function writeDraft(key: string, update: Update, revision: number) {
  try {
    localStorage.setItem(
      prefix + key,
      JSON.stringify({ update, revision, time: Date.now() }),
    );
    return true;
  } catch {
    return false;
  }
}
export function removeDraft(key: string) {
  try {
    localStorage.removeItem(prefix + key);
  } catch {}
}
export function clearDrafts() {
  try {
    for (const k of Object.keys(localStorage))
      if (k.startsWith(prefix)) localStorage.removeItem(k);
  } catch {}
}
