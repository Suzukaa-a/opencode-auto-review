import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath, pathToFileURL } from "node:url"

const executable = process.env.AUTO_REVIEW_CLI ?? "opencode2"
const marker = "AUTO_REVIEW_LIVE_7F3A91"
const tempRoot = join(tmpdir(), "opencode")
mkdirSync(tempRoot, { recursive: true })
const root = mkdtempSync(join(tempRoot, "auto-review-"))
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const pluginPath = process.env.AUTO_REVIEW_PLUGIN_PATH ?? join(packageRoot, "src/index.ts")
const configuredModel = process.env.AUTO_REVIEW_SMOKE_MODEL
if (!configuredModel) throw new Error("Set AUTO_REVIEW_SMOKE_MODEL=provider/model to run live smoke tests")
const model: string = configuredModel
console.log(`Live smoke artifacts: ${root}`)
const candidate = join(root, "candidate")
mkdirSync(candidate)
writeFileSync(join(candidate, "package.json"), JSON.stringify({ name: "auto-review-smoke-candidate", type: "module", exports: "./index.ts" }))
// Use a distinct fixture ID so a globally installed release cannot shadow the candidate.
writeFileSync(join(candidate, "index.ts"), `import plugin from ${JSON.stringify(pathToFileURL(pluginPath).href)}\nexport default { ...plugin, id: "auto-review-smoke-candidate" }\n`)

function project(name: string, plugin: "none" | "review" | "human"): string {
  const directory = join(root, name)
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, "fixture.txt"), `${marker}\n`)
  const plugins: unknown[] = ["-opencode-auto-review"]
  if (plugin !== "none") plugins.push({
    package: candidate,
    options: {
      model,
      debug: true,
      humanReviewRules: plugin === "human" ? [{
        action: "read",
        resource: "*",
        reason: "Live smoke requires human confirmation for this read",
      }] : [],
    },
  })
  writeFileSync(join(directory, "opencode.json"), JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    model,
    default_agent: "smoke-build",
    plugins,
    agents: {
      "smoke-build": {
        description: "Runs an isolated auto-review live smoke test",
        mode: "primary",
        model,
        permissions: [{ action: "read", resource: "*", effect: "ask" }],
      },
    },
  }, null, 2))
  return directory
}

function run(directory: string) {
  const result = spawnSync(executable, [
    "run",
    "--standalone",
    "--model", model,
    "--agent", "smoke-build",
    "--format", "json",
    "Use the read tool exactly once to read fixture.txt, then reply with only its exact contents.",
  ], {
    cwd: directory,
    env: { ...process.env, PWD: directory },
    encoding: "utf8",
    timeout: 120_000,
  })
  if (result.error) throw result.error
  const captured = { status: result.status, output: `${result.stdout}${result.stderr}` }
  writeFileSync(join(directory, "run.json"), JSON.stringify(captured, null, 2))
  return captured
}

const baseline = run(project("baseline", "none"))
assert.doesNotMatch(baseline.output, new RegExp(marker), "an unresolved ask must not read the fixture")
assert.match(baseline.output, /permission requested: read/)

const reviewed = run(project("reviewed", "review"))
assert.equal(reviewed.status, 0, reviewed.output)
assert.match(reviewed.output, new RegExp(marker))
assert.doesNotMatch(reviewed.output, /permission requested: read/)

const human = run(project("human", "human"))
assert.match(human.output, /permission requested: read/)
assert.doesNotMatch(human.output, new RegExp(marker))

console.log(`Live smoke passed with ${model}`)
console.log(`Artifacts: ${root}`)
