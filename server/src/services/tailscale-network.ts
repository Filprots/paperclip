import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const STATE_PREFIX = "paperclip-tailscale-state-v1:";
const MAX_STATE_BYTES = 2 * 1024 * 1024;

type Connection = { credential: string; savedCredential?: string; child?: ChildProcess; ready: Promise<string>; close: () => Promise<void> };

/** Each secret represents one tailnet identity, shared only by its authorized environments. */
export function createTailscaleNetworkManager(commands: { cli?: string; daemon?: string } = {}) {
  const connections = new Map<string, Connection>();

  async function connect(input: {
    identity: string;
    credential: string;
    persist: (credential: string) => Promise<void>;
  }): Promise<string> {
    const existing = connections.get(input.identity);
    if (existing && (existing.credential === input.credential || existing.savedCredential === input.credential)) return existing.ready;
    if (existing) { await existing.close(); return connect(input); }

    const connection: Connection = {
      credential: input.credential,
      ready: Promise.resolve(""),
      close: async () => undefined,
    };
    connections.set(input.identity, connection);
    connection.ready = start(input, connection).catch(async () => {
      if (connections.get(input.identity) === connection) connections.delete(input.identity);
      await connection.close().catch(() => undefined);
      throw new Error("Tailscale could not connect. Check the connection key and tailnet policy, then reconnect this environment.");
    });
    return connection.ready;
  }

  async function start(input: { identity: string; credential: string; persist: (credential: string) => Promise<void> }, connection: Connection) {
    const restored = input.credential.startsWith(STATE_PREFIX);
    const state = restored ? Buffer.from(input.credential.slice(STATE_PREFIX.length), "base64") : null;
    if (state && (state.length > MAX_STATE_BYTES || !state.length)) throw new Error("Invalid state");
    if (state) JSON.parse(state.toString("utf8"));
    if (!restored && !/^tskey-auth-[A-Za-z0-9_-]+$/.test(input.credential)) throw new Error("Invalid auth key");

    let dir: string | undefined;
    let statePath: string | undefined;
    let closed = false;
    let closing: Promise<void> | undefined;
    connection.close = () => closing ??= (async () => {
      closed = true;
      const child = connection.child;
      if (child?.pid && child.exitCode === null && child.signalCode === null) {
        await new Promise<void>((resolve) => {
          const timeout = setTimeout(() => { child.kill("SIGKILL"); }, 2_000);
          child.once("exit", () => { clearTimeout(timeout); resolve(); });
          child.kill("SIGTERM");
        });
      }
      try {
        if (connection.savedCredential && statePath) {
          const bytes = await fs.readFile(statePath);
          if (bytes.length && bytes.length <= MAX_STATE_BYTES) {
            const latest = STATE_PREFIX + bytes.toString("base64");
            if (latest !== connection.savedCredential) await input.persist(latest);
          }
        }
      } finally {
        if (dir) await fs.rm(dir, { recursive: true, force: true });
        if (connections.get(input.identity) === connection) connections.delete(input.identity);
      }
    })();
    // /tmp keeps the ProxyCommand path short and free of shell metacharacters.
    dir = await fs.mkdtemp(path.join(os.platform() === "win32" ? os.tmpdir() : "/tmp", "paperclip-ts-"));
    if (closed) { await fs.rm(dir, { recursive: true, force: true }); throw new Error("Tailscale stopped"); }
    await fs.chmod(dir, 0o700);
    const socket = path.join(dir, "socket");
    statePath = path.join(dir, "state");
    const keyPath = path.join(dir, "key");
    if (state) await fs.writeFile(statePath, state, { mode: 0o600 });
    if (closed) throw new Error("Tailscale stopped");
    const child = spawn(commands.daemon ?? "tailscaled", ["--tun=userspace-networking", "--port=0", `--socket=${socket}`, `--state=${statePath}`, `--statedir=${dir}`], {
      stdio: "ignore",
    });
    connection.child = child;
    let failed = false;
    child.once("error", () => { failed = true; });
    child.once("exit", () => { failed = true; void connection.close().catch(() => undefined); });
    const cli = async (args: string[], timeout = 5_000) => {
      if (failed || closed) throw new Error("Tailscale stopped");
      return exec(commands.cli ?? "tailscale", [`--socket=${socket}`, ...args], { timeout, maxBuffer: MAX_STATE_BYTES });
    };
    // Bounded readiness for this active connection attempt; no idle polling.
    const deadline = Date.now() + 5_000;
    for (;;) {
      try { await cli(["status", "--json"]); break; } catch {
        if (failed || closed || Date.now() >= deadline) throw new Error("Tailscale startup timed out");
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    if (!restored) await fs.writeFile(keyPath, input.credential, { mode: 0o600 });
    try {
      await cli(["up", "--accept-dns=false", "--accept-routes=false", "--shields-up", "--timeout=30s",
        `--hostname=paperclip-${input.identity.replace(/[^a-z0-9]/gi, "").slice(-16)}`,
        ...(!restored ? [`--auth-key=file:${keyPath}`] : [])], 35_000);
    } finally {
      await fs.rm(keyPath, { force: true });
    }
    const status = JSON.parse((await cli(["status", "--json"])).stdout);
    if (status.BackendState !== "Running") throw new Error("Tailscale requires authorization");
    const nextState = await fs.readFile(statePath);
    if (!nextState.length || nextState.length > MAX_STATE_BYTES) throw new Error("Invalid state");
    const saved = STATE_PREFIX + nextState.toString("base64");
    if (saved !== input.credential) await input.persist(saved);
    connection.savedCredential = saved;
    if (failed || closed) throw new Error("Tailscale stopped");
    return socket;
  }

  return {
    connect,
    async close() { await Promise.all([...connections.values()].map((connection) => connection.close())); },
  };
}

export const tailscaleNetworks = createTailscaleNetworkManager();
