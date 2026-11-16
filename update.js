import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR = path.join(ROOT, "logs");
const LOG_FILE = path.join(LOG_DIR, "update.log");
fs.mkdirSync(LOG_DIR, { recursive: true });

const STATUS_FILE = path.join(LOG_DIR, "update-status.json");

function setStatus(status, message) {
  try {
    fs.writeFileSync(STATUS_FILE, JSON.stringify({
      status, message, updatedAt: new Date().toISOString()
    }, null, 2));
  } catch (error) {
    process.stderr.write("[update] Could not save status: " + error.message + "\n");
  }
}

function log(...parts) {
  const line = new Date().toISOString() + " " + parts.join(" ") + "\n";
  process.stdout.write(line);
  try { fs.appendFileSync(LOG_FILE, line); } catch {}
}

function git(args, timeout = 120000) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd: ROOT, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", settled = false;
    const timer = setTimeout(() => {
      try { child.kill("SIGTERM"); } catch {}
      setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 2000).unref();
      if (!settled) { settled = true; reject(new Error("git " + args[0] + " timed out")); }
    }, timeout);
    child.stdout.on("data", chunk => { stdout = (stdout + chunk).slice(-30000); });
    child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-30000); });
    child.once("error", error => {
      clearTimeout(timer);
      if (!settled) { settled = true; reject(error); }
    });
    child.once("close", code => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      if (code === 0) resolve(stdout.trim());
      else reject(new Error((stderr || stdout || "git command failed").trim()));
    });
  });
}

async function restoreLocalChanges(stashRef) {
  if (!stashRef) return;
  log("[update] Restoring the automatic local-change backup", stashRef + "…");
  try {
    await git(["stash", "apply", "--index", stashRef]);
    await git(["stash", "drop", stashRef]);
    log("[update] Local changes restored successfully.");
  } catch (error) {
    setStatus(
      "restore_needed",
      "The update was installed, but some local changes could not be merged automatically. Your backup is saved in Git stash; no local changes were deleted. Resolve the conflict and run: git stash list"
    );
    throw new Error("Update installed, but restoring local changes needs conflict resolution. Your backup is still saved in Git stash. " + error.message);
  }
}

async function main() {
  setStatus("checking", "Checking for updates and protecting local changes…");
  log("[update] Starting update check.");
  const inside = await git(["rev-parse", "--is-inside-work-tree"]);
  if (inside !== "true") throw new Error("This folder is not a Git repository.");

  const changes = await git(["status", "--porcelain"]);
  let localStash = null;

  if (changes) {
    const previousStash = await git(["rev-parse", "-q", "--verify", "refs/stash"]).catch(() => "");
    log("[update] Local changes found. Saving them automatically before updating.");
    await git(["stash", "push", "-u", "-m", "local-control automatic update backup"]);
    const currentStash = await git(["rev-parse", "-q", "--verify", "refs/stash"]).catch(() => "");
    const remaining = await git(["status", "--porcelain"]);
    if (remaining) {
      throw new Error("Could not safely prepare all local changes for the update. Nothing was overwritten. Remaining changes: " + remaining);
    }
    if (currentStash && currentStash !== previousStash) {
      localStash = "stash@{0}";
      log("[update] Local changes safely backed up in", localStash + ".");
    } else {
      throw new Error("Git could not create a backup of the local changes. No update was applied.");
    }
  }

  try {
    const upstream = await git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
    if (!upstream || !upstream.includes("/")) throw new Error("No Git upstream is configured for this branch.");

    log("[update] Fetching latest GitHub changes from", upstream + "…");
    await git(["fetch", "--prune", "origin"], 180000);

    const count = await git(["rev-list", "--count", "HEAD.." + upstream]);
    if (Number(count) === 0) {
      log("[update] Already up to date. No restart needed.");
      if (localStash) await restoreLocalChanges(localStash);
      setStatus("up_to_date", "Already up to date. Your local changes were preserved.");
      return;
    }

    log("[update] Found", count, "new commit(s). Installing with fast-forward only.");
    await git(["pull", "--ff-only", "origin", upstream.split("/").slice(1).join("/")], 180000);

    if (localStash) await restoreLocalChanges(localStash);

    log("[update] Files updated. Asking the server to restart under the watchdog.");
    setStatus("updated", "Update installed successfully. Your local changes were preserved. Restarting the server…");

    // The updater is a child of server.js. The watchdog will relaunch the server
    // after this signal, loading the newly downloaded code.
    try { process.kill(process.ppid, "SIGTERM"); }
    catch (error) { throw new Error("Files updated, but could not signal the server to restart: " + error.message); }
  } catch (error) {
    if (localStash) {
      try {
        const status = await git(["status", "--porcelain"]);
        if (!status) await restoreLocalChanges(localStash);
      } catch (restoreError) {
        log("[update] Automatic restoration after update failure also needs attention:", restoreError.message);
      }
    }
    throw error;
  }
}

main().catch(error => {
  log("[update] FAILED:", error.message);
  setStatus("failed", error.message);
  process.exitCode = 1;
});
