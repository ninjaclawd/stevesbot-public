const fs = require("node:fs");
const path = require("node:path");
const { parse } = require("yaml");

function repoSyncTargets(root) {
  root = path.resolve(root);
  const reposDir = path.join(root, "repos");
  const manifest = parse(fs.readFileSync(path.join(root, "resources/manifests/repos.yaml"), "utf8"));
  if (!Array.isArray(manifest?.repos) || !manifest.repos.length) throw new Error("No repositories configured for sync.");
  const targets = new Map();
  function add(id, localPath, branch = "-", upstreamRepo = "-") {
    const resolved = path.resolve(root, localPath);
    const relative = path.relative(reposDir, resolved);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`Sync target outside repos directory: ${id}`);
    if ([id, resolved, branch, upstreamRepo].some(value => typeof value !== "string" || /[\t\r\n]/.test(value))) {
      throw new Error("Invalid repository sync target fields.");
    }
    if (!targets.has(resolved)) targets.set(resolved, { id, localPath: resolved, branch, upstreamRepo });
  }
  // Include configured targets even when missing so the runner reports an error.
  for (const repo of manifest.repos) add(repo.id, repo.localPath, repo.branch, `${repo.owner}/${repo.repo}`);
  return [...targets.values()];
}

if (require.main === module) {
  try {
    for (const target of repoSyncTargets(process.argv[2] || process.cwd())) {
      console.log([target.id, target.localPath, target.branch, target.upstreamRepo].join("\t"));
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { repoSyncTargets };
