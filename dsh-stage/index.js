/**
 * Host half of `@popo/dsh-stage`.
 *
 * The PoPo stage is a separate web process — `next dev -p 4000` in the PoPo repository,
 * http://localhost:4000. Only that process serves the stage and receives the motions the PoPo
 * MCP server pushes, and nothing else starts it: when only DSH restarts, the stage is simply
 * gone. So this half keeps it available while DSH runs. On activation it starts the server
 * unless something already listens on the stage port (a PoPo started by hand is left alone),
 * and it stops the server it started when the plugin is disposed.
 *
 * Row config, all optional: `autoStart` (default true), `popoDir` (default: the repository
 * around this package), `port` (default 4000, which must match the client's stage URL).
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { createConnection } from 'node:net';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const DEFAULT_PORT = 4000;
/** `next dev` boots in a few seconds; the bound only covers a slow or cold machine. */
const START_TIMEOUT_MS = 120000;
const POLL_MS = 500;
/** Enough of the server's output to show why it stopped. */
const OUTPUT_TAIL_LINES = 30;

/** Read the package name of a directory, or null when it has no readable package.json. */
function packageName(dir) {
  try {
    return JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')).name ?? null;
  } catch {
    return null;
  }
}

/**
 * The PoPo repository this package sits in. The profile links this package through a junction,
 * so follow the link when Node did not, and accept only a directory that really is PoPo.
 */
function defaultPopoDir() {
  const packageDir = path.dirname(fileURLToPath(import.meta.url));
  let realPackageDir = packageDir;
  try {
    realPackageDir = realpathSync(packageDir);
  } catch {
    /* keep the unresolved path */
  }
  for (const dir of new Set([packageDir, realPackageDir])) {
    const parent = path.resolve(dir, '..');
    if (packageName(parent) === 'popo') return parent;
  }
  return path.resolve(packageDir, '..');
}

function resolveSettings(config) {
  const supplied = config && typeof config === 'object' ? config : {};
  const popoDir = typeof supplied.popoDir === 'string' && supplied.popoDir.trim()
    ? path.resolve(supplied.popoDir.trim())
    : defaultPopoDir();
  const port = Number(supplied.port);
  return {
    autoStart: typeof supplied.autoStart === 'boolean' ? supplied.autoStart : true,
    popoDir,
    port: Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_PORT,
  };
}

/** Whether something accepts connections on the stage port of this machine. */
function isListening(port) {
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    const settle = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(1500, () => settle(false));
    socket.once('connect', () => settle(true));
    socket.once('error', () => settle(false));
  });
}

async function waitUntilListening(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isListening(port)) return true;
    await sleep(POLL_MS);
  }
  return false;
}

/**
 * Stop the server and every process it forked: `next dev` runs the actual server in a child,
 * so killing the launcher alone would leave that child holding the port.
 */
function stopServer(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    return;
  }
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    child.kill('SIGTERM');
  }
}

/**
 * Start the PoPo server unless one is already running, and report when it answers.
 * @param ctx - Host plugin context; only its logger is used.
 * @param settings - Resolved row config.
 * @returns a disposer that stops the server this call started.
 */
function ensureStageServer(ctx, settings) {
  const state = { disposed: false, child: undefined };
  const log = (level, message) => ctx.logger?.[level]?.(message);
  const url = `http://localhost:${settings.port}`;

  void (async () => {
    if (await isListening(settings.port)) {
      log('info', `popo-stage: a stage server already listens on port ${settings.port}; using it`);
      return;
    }
    if (state.disposed) return;

    const cli = path.join(settings.popoDir, 'node_modules', 'next', 'dist', 'bin', 'next');
    if (packageName(settings.popoDir) !== 'popo' || !existsSync(cli)) {
      log('warn', `popo-stage: no PoPo checkout at ${settings.popoDir}; start the stage server yourself (${url})`);
      return;
    }

    // The tail of the server's output, shown only if it stops unexpectedly.
    const tail = [];
    const child = spawn(process.execPath, [cli, 'dev', '-p', String(settings.port)], {
      cwd: settings.popoDir,
      // A group of its own elsewhere, for the group kill in stopServer.
      detached: process.platform !== 'win32',
      // On Windows this gives it no console at all, so Ctrl+C in the terminal running DSH
      // reaches DSH alone and its disposers stop the server in turn.
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    state.child = child;
    for (const stream of [child.stdout, child.stderr]) {
      stream.setEncoding('utf8');
      let partial = '';
      stream.on('data', (chunk) => {
        const lines = (partial + chunk).split(/\r?\n/);
        partial = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.trim()) continue;
          tail.push(line);
          if (tail.length > OUTPUT_TAIL_LINES) tail.shift();
        }
      });
    }
    child.once('error', (error) => {
      if (!state.disposed) log('warn', `popo-stage: could not start the stage server: ${error.message}`);
    });
    child.once('exit', (code, signal) => {
      state.child = undefined;
      if (state.disposed || code === 0) return;
      const reason = signal ? `signal ${signal}` : `code ${code}`;
      log('warn', `popo-stage: the stage server stopped (${reason})${tail.length ? `\n${tail.join('\n')}` : ''}`);
    });

    const started = Date.now();
    if (await waitUntilListening(settings.port, START_TIMEOUT_MS)) {
      if (!state.disposed) log('info', `popo-stage: stage server ready at ${url} after ${Date.now() - started} ms`);
    } else if (!state.disposed) {
      log('warn', `popo-stage: the stage server did not answer on port ${settings.port} within ${START_TIMEOUT_MS} ms`);
    }
  })();

  return () => {
    state.disposed = true;
    stopServer(state.child);
    state.child = undefined;
  };
}

export function apply(ctx, config) {
  const settings = resolveSettings(config);
  if (!settings.autoStart) return;
  ctx.effect(() => ensureStageServer(ctx, settings), 'popo-stage: stage server');
}
