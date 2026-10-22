#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '..');
export const DEFAULT_TARGET_DIR = path.join(
  os.homedir(),
  '.recruiting-agents/scheduling-pilot/app',
);

export const WORKER_RUNTIME_FILES = [
  'pilot.mjs',
  'gate.mjs',
  'ledger.mjs',
  'roster.mjs',
  'prompt.md',
  'shadow.mjs',
  'executor-tick.mjs',
];

function sha256Buffer(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function collectSrcFiles(dirRel = 'src', repoRoot = REPO_ROOT) {
  const fullDir = path.join(repoRoot, dirRel);
  const out = [];
  assertNotSymlink(fullDir);
  if (!fs.existsSync(fullDir)) return out;
  const entries = fs.readdirSync(fullDir, { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const relPath = path.join(dirRel, entry.name);
    const absPath = path.join(repoRoot, relPath);
    const stat = fs.lstatSync(absPath);
    if (stat.isSymbolicLink()) {
      throw new Error(`Refusing symbolic link in source tree: ${absPath}`);
    }
    if (stat.isDirectory()) {
      out.push(...collectSrcFiles(relPath, repoRoot));
    } else if (stat.isFile() && /\.(ts|mjs|js|json)$/.test(entry.name)) {
      out.push(relPath);
    }
  }
  return out;
}

/**
 * Builds the manifest of `{ sourceAbs, targetRel }` pairs to deploy into `targetDir`.
 * Includes:
 * - `worker/{pilot.mjs,gate.mjs,ledger.mjs,roster.mjs,prompt.md,shadow.mjs,executor-tick.mjs}`
 *   at `worker/<name>` (for `../src/` relative imports), plus sibling-only worker files at
 *   top-level `<name>` (for `app/pilot.mjs` plist compatibility).
 * - `src/**` at `src/**`
 * - `.claude/hooks/send-gate.mjs` at `.claude/hooks/send-gate.mjs`
 */
export function buildRuntimeManifest(repoRoot = REPO_ROOT) {
  assertNotSymlink(repoRoot);
  assertNotSymlink(path.join(repoRoot, 'worker'));
  const items = [];

  for (const name of WORKER_RUNTIME_FILES) {
    const srcAbs = path.join(repoRoot, 'worker', name);
    if (!fs.existsSync(srcAbs)) {
      throw new Error(`Missing required worker runtime file: ${srcAbs}`);
    }
    if (fs.lstatSync(srcAbs).isSymbolicLink()) {
      throw new Error(`Refusing symbolic link in worker runtime source: ${srcAbs}`);
    }
    items.push({
      sourceAbs: srcAbs,
      targetRel: path.join('worker', name),
    });
    if (name !== 'executor-tick.mjs') {
      items.push({
        sourceAbs: srcAbs,
        targetRel: name,
      });
    }
  }

  for (const rel of collectSrcFiles('src', repoRoot)) {
    const srcAbs = path.join(repoRoot, rel);
    items.push({
      sourceAbs: srcAbs,
      targetRel: rel,
    });
  }

  assertNotSymlink(path.join(repoRoot, '.claude'));
  assertNotSymlink(path.join(repoRoot, '.claude/hooks'));
  const sendGateAbs = path.join(repoRoot, '.claude/hooks/send-gate.mjs');
  if (fs.existsSync(sendGateAbs)) {
    if (fs.lstatSync(sendGateAbs).isSymbolicLink()) {
      throw new Error(`Refusing symbolic link in source: ${sendGateAbs}`);
    }
    items.push({
      sourceAbs: sendGateAbs,
      targetRel: path.join('.claude', 'hooks', 'send-gate.mjs'),
    });
  }

  return items;
}

function assertNotSymlink(targetPath) {
  let lst;
  try {
    lst = fs.lstatSync(targetPath);
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }
  if (lst.isSymbolicLink()) {
    throw new Error(`Refusing symbolic link in target runtime path: ${targetPath}`);
  }
  return lst;
}

function ensurePrivateDirectoryTree(rootDir, targetSubDir) {
  assertNotSymlink(path.dirname(rootDir));
  assertNotSymlink(rootDir);
  fs.mkdirSync(rootDir, { recursive: true, mode: 0o700 });
  assertNotSymlink(rootDir);
  fs.chmodSync(rootDir, 0o700);

  const rel = path.relative(rootDir, targetSubDir);
  if (!rel || rel === '.') return;
  const parts = rel.split(path.sep).filter(Boolean);
  let current = rootDir;
  for (const part of parts) {
    current = path.join(current, part);
    assertNotSymlink(current);
    fs.mkdirSync(current, { recursive: true, mode: 0o700 });
    assertNotSymlink(current);
    fs.chmodSync(current, 0o700);
  }
}

function atomicCopyPrivateFile(sourceAbs, destAbs) {
  assertNotSymlink(sourceAbs);
  assertNotSymlink(destAbs);
  const content = fs.readFileSync(sourceAbs);
  const tmpPath = `${destAbs}.${process.pid}.${crypto.randomUUID()}.tmp`;
  let fd = null;
  try {
    fd = fs.openSync(tmpPath, 'wx', 0o600);
    fs.writeFileSync(fd, content);
    fs.fchmodSync(fd, 0o600);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tmpPath, destAbs);
    fs.chmodSync(destAbs, 0o600);
  } catch (err) {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // Ignore close error on cleanup
      }
    }
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // Ignore unlink error if tmpPath was not created
    }
    throw err;
  }
}

/**
 * Checks whether `targetDir` is in sync with the repo runtime files and has strict `0700`/`0600` modes.
 */
export function checkRuntimeDeployment({
  targetDir = DEFAULT_TARGET_DIR,
  repoRoot = REPO_ROOT,
} = {}) {
  const resolvedTarget = path.resolve(targetDir);
  const drift = [];
  const manifest = buildRuntimeManifest(repoRoot);

  const rootStat = assertNotSymlink(resolvedTarget);
  if (!rootStat || !rootStat.isDirectory()) {
    drift.push(`Missing target runtime directory: ${resolvedTarget}`);
    return {
      ok: false,
      target_dir: resolvedTarget,
      checked_files: manifest.length,
      drift,
    };
  }
  if ((rootStat.mode & 0o777) !== 0o700) {
    drift.push(
      `Directory permission drift on ${resolvedTarget}: expected 0700, got 0${(rootStat.mode & 0o777).toString(8)}`,
    );
  }

  const checkedDirs = new Set([resolvedTarget]);

  for (const item of manifest) {
    const destAbs = path.join(resolvedTarget, item.targetRel);
    const parentDir = path.dirname(destAbs);

    // Check every directory in the chain from resolvedTarget to parentDir
    const relDir = path.relative(resolvedTarget, parentDir);
    if (relDir && relDir !== '.') {
      let cur = resolvedTarget;
      for (const seg of relDir.split(path.sep).filter(Boolean)) {
        cur = path.join(cur, seg);
        if (checkedDirs.has(cur)) continue;
        checkedDirs.add(cur);
        const dStat = assertNotSymlink(cur);
        if (!dStat || !dStat.isDirectory()) {
          drift.push(`Missing directory: ${cur}`);
        } else if ((dStat.mode & 0o777) !== 0o700) {
          drift.push(
            `Directory permission drift on ${cur}: expected 0700, got 0${(dStat.mode & 0o777).toString(8)}`,
          );
        }
      }
    }

    const fStat = assertNotSymlink(destAbs);
    if (!fStat || !fStat.isFile()) {
      drift.push(`Missing runtime file: ${item.targetRel}`);
      continue;
    }
    if ((fStat.mode & 0o777) !== 0o600) {
      drift.push(
        `File permission drift on ${item.targetRel}: expected 0600, got 0${(fStat.mode & 0o777).toString(8)}`,
      );
    }

    const srcHash = sha256Buffer(fs.readFileSync(item.sourceAbs));
    const dstHash = sha256Buffer(fs.readFileSync(destAbs));
    if (srcHash !== dstHash) {
      drift.push(`Content drift on ${item.targetRel}`);
    }
  }

  return {
    ok: drift.length === 0,
    target_dir: resolvedTarget,
    checked_files: manifest.length,
    drift,
  };
}

/**
 * Atomically deploys runtime files (`worker/` and `src/` + `.claude/hooks/send-gate.mjs`)
 * into `targetDir` with `0700` directory permissions and `0600` file permissions,
 * refusing any symbolic links.
 */
export function deployRuntime({
  targetDir = DEFAULT_TARGET_DIR,
  repoRoot = REPO_ROOT,
} = {}) {
  const resolvedTarget = path.resolve(targetDir);
  const manifest = buildRuntimeManifest(repoRoot);

  ensurePrivateDirectoryTree(resolvedTarget, resolvedTarget);

  const deployedFiles = [];
  for (const item of manifest) {
    const destAbs = path.join(resolvedTarget, item.targetRel);
    ensurePrivateDirectoryTree(resolvedTarget, path.dirname(destAbs));
    atomicCopyPrivateFile(item.sourceAbs, destAbs);
    deployedFiles.push(item.targetRel);
  }

  const verification = checkRuntimeDeployment({
    targetDir: resolvedTarget,
    repoRoot,
  });
  if (!verification.ok) {
    throw new Error(
      `Post-deploy verification failed: ${verification.drift.join('; ')}`,
    );
  }

  return {
    ok: true,
    target_dir: resolvedTarget,
    deployed_count: deployedFiles.length,
    deployed_files: deployedFiles,
  };
}

export function runDeployCli(argv = process.argv.slice(2)) {
  let targetDir = DEFAULT_TARGET_DIR;
  let checkOnly = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--target-dir') {
      if (!argv[i + 1] || argv[i + 1].startsWith('-')) {
        throw new Error('Missing value for --target-dir');
      }
      targetDir = path.resolve(argv[++i]);
    } else if (arg === '--check') {
      checkOnly = true;
    } else {
      throw new Error(
        `Unknown argument '${arg}'. Usage: node tools/deploy-runtime.mjs [--target-dir <dir>] [--check]`,
      );
    }
  }

  if (checkOnly) {
    return checkRuntimeDeployment({ targetDir });
  }
  return deployRuntime({ targetDir });
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  try {
    const res = runDeployCli(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
    if (!res.ok) {
      process.exitCode = 1;
    }
  } catch (err) {
    process.stderr.write(`deploy-runtime failed: ${err?.message ?? err}\n`);
    process.exitCode = 1;
  }
}
