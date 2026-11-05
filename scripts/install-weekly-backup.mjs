import { mkdir, writeFile, readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import {
  applicationRoot,
  supportDirectory,
  defaultBackupKeyPath,
  defaultBackupDirectory,
} from "./backup-paths.mjs";
if (process.platform !== "darwin")
  throw new Error(
    "This installer supports macOS launchd. Run backup.mjs from your own scheduler on other systems.",
  );
const label = "com.betterloop.backup",
  target = "gui/" + process.getuid() + "/" + label;
const agentPath = join(homedir(), "Library", "LaunchAgents", label + ".plist");
const xml = (s) =>
  String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&apos;",
      })[c],
  );
const strings = (values) =>
  values.map((v) => "<string>" + xml(v) + "</string>").join("\n");
const args = [
  process.execPath,
  join(applicationRoot, "scripts", "backup.mjs"),
  "create",
  "--scheduled",
  "--directory",
  defaultBackupDirectory,
  "--key-file",
  defaultBackupKeyPath,
  "--r2",
  "betterloop-backups",
];
const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array>${strings(args)}</array>
<key>WorkingDirectory</key><string>${xml(applicationRoot)}</string>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(dirname(process.execPath) + ":/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin")}</string></dict>
<key>StartCalendarInterval</key><dict><key>Weekday</key><integer>0</integer><key>Hour</key><integer>9</integer><key>Minute</key><integer>0</integer></dict>
<key>RunAtLoad</key><true/><key>ProcessType</key><string>Background</string>
<key>LowPriorityIO</key><true/><key>Nice</key><integer>10</integer>
<key>StandardOutPath</key><string>${xml(join(supportDirectory, "backup.log"))}</string>
<key>StandardErrorPath</key><string>${xml(join(supportDirectory, "backup-error.log"))}</string>
</dict></plist>`;
await mkdir(supportDirectory, { recursive: true, mode: 0o700 });
await mkdir(dirname(agentPath), { recursive: true });
try {
  const existing = await readFile(agentPath, "utf8");
  if (!existing.includes("<string>" + label + "</string>"))
    throw new Error("An unrelated launch agent occupies this path.");
  execFileSync("/bin/launchctl", ["bootout", target], { stdio: "ignore" });
} catch (e) {
  if (
    e.code !== "ENOENT" &&
    e.message === "An unrelated launch agent occupies this path."
  )
    throw e;
}
await writeFile(agentPath, plist, { mode: 0o644 });
await mkdir(join(applicationRoot, "ops"), { recursive: true });
await writeFile(join(applicationRoot, "ops", label + ".plist"), plist);
execFileSync("/usr/bin/plutil", ["-lint", agentPath], { stdio: "pipe" });
execFileSync(
  "/bin/launchctl",
  ["bootstrap", "gui/" + process.getuid(), agentPath],
  { stdio: "pipe" },
);

console.log(
  JSON.stringify({
    schedule: "Sunday 09:00, device timezone",
    runner: "This Mac, while logged in",
    destination: defaultBackupDirectory,
    keyFile: defaultBackupKeyPath,
    agent: agentPath,
    cloudBucket: "betterloop-backups",
    initialBackup: "weekly backup check started",
  }),
);
