import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
export const applicationRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
);
export const supportDirectory =
  process.platform === "darwin"
    ? join(homedir(), "Library", "Application Support", "Betterloop")
    : join(homedir(), ".local", "share", "betterloop");
export const defaultBackupKeyPath = join(supportDirectory, "backup-key");
export const defaultBackupDirectory = resolve(
  applicationRoot,
  "..",
  "betterloop-backups",
);
export function photoBucket(settings) {
  const bucket = settings.r2_buckets?.find(
    (b) => b.binding === "PHOTOS",
  )?.bucket_name;
  if (!bucket)
    throw new Error("The backup configuration needs a PHOTOS bucket binding.");
  return bucket;
}
