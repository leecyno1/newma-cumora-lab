import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const config = JSON.parse(
  readFileSync(resolve(root, "newma-lab/upstream.json"), "utf8"),
);
const args = new Set(process.argv.slice(2));

if (args.has("--fetch")) {
  git(["fetch", "upstream", config.default_branch, "--tags"]);
}

const upstreamRef = `upstream/${config.default_branch}`;
const originUrl = git(["remote", "get-url", "origin"]);
const upstreamUrl = git(["remote", "get-url", "upstream"]);
const head = git(["rev-parse", "HEAD"]);
const upstream = git(["rev-parse", upstreamRef]);
const mergeBase = git(["merge-base", "HEAD", upstreamRef]);
const ahead = number(git(["rev-list", "--count", `${upstreamRef}..HEAD`]));
const behind = number(git(["rev-list", "--count", `HEAD..${upstreamRef}`]));
const committedFiles = lines(
  git(["diff", "--name-only", `${upstreamRef}...HEAD`], { allowEmpty: true }),
);
const workingFiles = lines(
  git(["status", "--porcelain"], { allowEmpty: true }),
).map((line) => line.slice(3).trim()).filter(Boolean);
const patchFiles = [...new Set([...committedFiles, ...workingFiles])].sort();
const forbiddenFiles = patchFiles.filter(
  (path) => !config.allowed_patch_roots.some((prefix) => allowed(path, prefix)),
);

let mergeable = true;
let mergeDetail = "clean";
try {
  git(["merge-tree", "--write-tree", "HEAD", upstreamRef]);
} catch (error) {
  mergeable = false;
  mergeDetail = error instanceof Error ? error.message.split("\n")[0] : "conflict";
}

const report = {
  schema_version: 1,
  origin: originUrl,
  upstream_repository: upstreamUrl,
  baseline_sha: config.baseline_sha,
  head,
  upstream,
  merge_base: mergeBase,
  ahead,
  behind,
  mergeable,
  merge_detail: mergeDetail,
  patch_files: patchFiles,
  forbidden_files: forbiddenFiles,
};

if (args.has("--json")) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  process.stdout.write(
    [
      `Cumora upstream: ${upstream}`,
      `Newma lab head: ${head}`,
      `Distance: ahead ${ahead}, behind ${behind}`,
      `Mergeable: ${mergeable ? "yes" : "no"}`,
      `Patch boundary: ${forbiddenFiles.length ? "violated" : "clean"}`,
      ...(forbiddenFiles.length
        ? [`Forbidden files: ${forbiddenFiles.join(", ")}`]
        : []),
    ].join("\n") + "\n",
  );
}

const correctUpstream = /(?:github\.com[:/])yetone\/cumora(?:\.git)?$/u.test(
  upstreamUrl,
);
if (!correctUpstream || !mergeable || forbiddenFiles.length) process.exitCode = 1;

function git(argv, { allowEmpty = false } = {}) {
  try {
    return execFileSync("git", ["-C", root, ...argv], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    if (allowEmpty && error?.status === 0) return "";
    const detail = error?.stderr?.toString("utf8").trim();
    throw new Error(detail || `git ${argv.join(" ")} failed`);
  }
}

function lines(value) {
  return value ? value.split(/\r?\n/u).filter(Boolean) : [];
}

function number(value) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error("invalid git count");
  return parsed;
}

function allowed(path, prefix) {
  if (prefix.endsWith("/")) return path.startsWith(prefix);
  if (prefix.endsWith("-")) return path.startsWith(prefix);
  return path === prefix;
}
