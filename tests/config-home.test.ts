import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import {
  loadSubagentsUserConfig,
  piSubagentsToAdapter,
  biliConfigFile,
  resolveDelegate,
} from "../src/config.js";

// #2230 config-home: `pi.subagents` in billion-context.json is the primary
// delegate-config source; the four acp.json keys are a deprecated fallback.
// These tests drive the REAL loaders with REAL files on disk (temp HOME, no
// touching the developer's machine config), mirroring delegate-toggle.test.ts.

interface Homes {
  home: string;
  cwd: string;
}

async function withHomes(bili: unknown, acpGlobal: unknown, acpProject: unknown, fn: (h: Homes) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "pi-acp-config-home-"));
  const home = join(root, "home");
  const cwd = join(root, "project");
  const savedHome = process.env.HOME;
  const savedUserProfile = process.env.USERPROFILE;
  const savedBiliFile = process.env.BILI_CONFIG_FILE;
  const savedXdg = process.env.XDG_CONFIG_HOME;
  const savedAcpLog = process.env.ACP_LOG_FILE;
  try {
    await mkdir(join(home, CONFIG_DIR_NAME), { recursive: true });
    await mkdir(join(cwd, CONFIG_DIR_NAME), { recursive: true });
    await mkdir(join(home, ".config", "billion-context"), { recursive: true });
    if (bili !== undefined) {
      await writeFile(join(home, ".config", "billion-context", "billion-context.json"), JSON.stringify(bili));
    }
    if (acpGlobal !== undefined) await writeFile(join(home, CONFIG_DIR_NAME, "acp.json"), JSON.stringify(acpGlobal));
    if (acpProject !== undefined) await writeFile(join(cwd, CONFIG_DIR_NAME, "acp.json"), JSON.stringify(acpProject));
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    delete process.env.BILI_CONFIG_FILE;
    delete process.env.XDG_CONFIG_HOME;
    // Redirect the ACP log (deprecation warnings land there via logWarn) so
    // assertions can read them and the dev machine log stays untouched.
    const logFile = join(root, "acp.log");
    process.env.ACP_LOG_FILE = logFile;
    await fn({ home, cwd });
  } finally {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = savedUserProfile;
    if (savedBiliFile === undefined) delete process.env.BILI_CONFIG_FILE;
    else process.env.BILI_CONFIG_FILE = savedBiliFile;
    if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = savedXdg;
    if (savedAcpLog === undefined) delete process.env.ACP_LOG_FILE;
    else process.env.ACP_LOG_FILE = savedAcpLog;
    await rm(root, { recursive: true, force: true });
  }
}

async function readLog(h: Homes): Promise<string> {
  try {
    return await readFile(join(h.home, "..", "acp.log"), "utf8");
  } catch {
    return "";
  }
}

test("config-home: pi.subagents section is the primary source", async () => {
  await withHomes(
    { pi: { subagents: { enabled: false, maxDepth: 3 } } },
    // no acp.json keys here: the ignored-warning path is covered by its own
    // test below (the one-shot flags are module-global per process)
    undefined,
    undefined,
    async (h) => {
      const cfg = await loadSubagentsUserConfig(h.cwd);
      assert.deepEqual(cfg.delegate, { enabled: false, maxDepth: 3 });
      const policy = resolveDelegate(cfg);
      assert.equal(policy.enabled, false);
      assert.equal(policy.maxDepth, 3);
    },
  );
});

test("config-home: section present + acp.json keys present → acp.json ignored with a deprecation warning", async () => {
  await withHomes(
    { pi: { subagents: { maxDepth: 1 } } },
    { delegate: { maxDepth: 9 }, delegatePrompt: "OLD" },
    undefined,
    async (h) => {
      const cfg = await loadSubagentsUserConfig(h.cwd);
      assert.deepEqual(cfg.delegate, { maxDepth: 1 });
      assert.equal(cfg.delegatePrompt, undefined);
      const log = await readLog(h);
      assert.match(log, /acp-json-delegate-keys-ignored/, "ignored warning logged");
      assert.match(log, /pi\.subagents in billion-context\.json owns the delegate config/);
    },
  );
});

test("config-home: no section → legacy acp.json keys still work, with a deprecation warning", async () => {
  await withHomes(
    { port: 8787 }, // bili file exists but has no pi.subagents section
    { delegate: { maxConcurrent: 4 }, displayUsage: "merged", delegatePrompt: "PROMPT", debug: true },
    undefined,
    async (h) => {
      const cfg = await loadSubagentsUserConfig(h.cwd);
      assert.deepEqual(cfg.delegate, { maxConcurrent: 4 });
      assert.equal(cfg.displayUsage, "merged");
      assert.equal(cfg.delegatePrompt, "PROMPT");
      assert.equal(cfg.debug, true);
      const policy = resolveDelegate(cfg);
      assert.equal(policy.maxConcurrent, 4);
      assert.equal(policy.displayUsage, "merged");
      const log = await readLog(h);
      assert.match(log, /acp-json-delegate-keys-deprecated/, "fallback deprecation warning logged");
    },
  );
});

test("config-home: project acp.json still overrides global in the fallback path", async () => {
  await withHomes(
    undefined,
    { delegate: { maxDepth: 2 } },
    { delegate: { maxDepth: 5 } },
    async (h) => {
      const cfg = await loadSubagentsUserConfig(h.cwd);
      assert.deepEqual(cfg.delegate, { maxDepth: 5 });
    },
  );
});

test("config-home: prompt → delegatePrompt, scoped debug passthrough", async () => {
  await withHomes(
    { pi: { subagents: { prompt: "CUSTOM", debug: true, agents: { reviewer: { model: "foo/bar" } } } } },
    undefined,
    undefined,
    async (h) => {
      const cfg = await loadSubagentsUserConfig(h.cwd);
      assert.equal(cfg.delegatePrompt, "CUSTOM");
      assert.equal(cfg.debug, true);
      assert.deepEqual(cfg.delegate, { agents: { reviewer: { model: "foo/bar" } } });
    },
  );
});

test("config-home: boolean shorthand false disables, true means defaults", async () => {
  await withHomes({ pi: { subagents: false } }, { delegate: { maxDepth: 9 } }, undefined, async (h) => {
    const cfg = await loadSubagentsUserConfig(h.cwd);
    assert.deepEqual(cfg, { delegate: { enabled: false } });
    assert.equal(resolveDelegate(cfg).enabled, false);
  });
  await withHomes({ pi: { subagents: true } }, undefined, undefined, async (h) => {
    const cfg = await loadSubagentsUserConfig(h.cwd);
    assert.deepEqual(cfg, {});
    assert.equal(resolveDelegate(cfg).enabled, true);
  });
});

test("config-home: malformed billion-context.json degrades to the acp.json fallback with a warning", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-acp-config-home-"));
  const savedBiliFile = process.env.BILI_CONFIG_FILE;
  const savedHome = process.env.HOME;
  const savedUserProfile = process.env.USERPROFILE;
  try {
    const file = join(root, "billion-context.json");
    await writeFile(file, "{ not json");
    process.env.BILI_CONFIG_FILE = file;
    // Isolate HOME too: the fallback reads $HOME/.pi/acp.json, which on a dev
    // machine carries real keys and would leak into the assertion.
    process.env.HOME = root;
    process.env.USERPROFILE = root;
    const cfg = await loadSubagentsUserConfig(root);
    assert.deepEqual(cfg, {});
  } finally {
    if (savedBiliFile === undefined) delete process.env.BILI_CONFIG_FILE;
    else process.env.BILI_CONFIG_FILE = savedBiliFile;
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = savedUserProfile;
    await rm(root, { recursive: true, force: true });
  }
});

test("config-home: BILI_CONFIG_FILE and XDG_CONFIG_HOME relocate the file (path parity with bili paths.ts)", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-acp-config-home-"));
  const savedBiliFile = process.env.BILI_CONFIG_FILE;
  const savedXdg = process.env.XDG_CONFIG_HOME;
  try {
    const file = join(root, "explicit.json");
    process.env.BILI_CONFIG_FILE = file;
    assert.equal(biliConfigFile(), file);
    delete process.env.BILI_CONFIG_FILE;
    const xdg = join(root, "xdg");
    process.env.XDG_CONFIG_HOME = xdg;
    assert.equal(biliConfigFile(), join(xdg, "billion-context", "billion-context.json"));
    await mkdir(join(xdg, "billion-context"), { recursive: true });
    await writeFile(biliConfigFile(), JSON.stringify({ pi: { subagents: { maxDepth: 4 } } }));
    const cfg = await loadSubagentsUserConfig(root);
    assert.deepEqual(cfg.delegate, { maxDepth: 4 });
  } finally {
    if (savedBiliFile === undefined) delete process.env.BILI_CONFIG_FILE;
    else process.env.BILI_CONFIG_FILE = savedBiliFile;
    if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = savedXdg;
    await rm(root, { recursive: true, force: true });
  }
});

test("config-home: piSubagentsToAdapter mapping is pure and complete", () => {
  assert.deepEqual(piSubagentsToAdapter(false), { delegate: { enabled: false } });
  assert.deepEqual(piSubagentsToAdapter(true), {});
  assert.deepEqual(piSubagentsToAdapter({}), {});
  assert.deepEqual(
    piSubagentsToAdapter({ enabled: true, prompt: "P", debug: false, maxConcurrent: 2, notifyIfRead: "always", fleetShortcut: "" }),
    { delegate: { enabled: true, maxConcurrent: 2, notifyIfRead: "always", fleetShortcut: "" }, delegatePrompt: "P", debug: false },
  );
  // null prompt removes the appendix (delegatePrompt: null passthrough)
  assert.deepEqual(piSubagentsToAdapter({ prompt: null }), { delegatePrompt: null });
});
