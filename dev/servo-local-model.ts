import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { promisify } from "node:util";
import { TRPCError } from "@trpc/server";

const execute = promisify(execFile);
const osVariables = new Set(["path", "pathext", "systemroot", "windir", "comspec", "home", "userprofile",
  "homedrive", "homepath", "appdata", "localappdata", "tmpdir", "tmp", "temp", "programdata", "username", "codex_home"]);
const cliEnvironment = () => Object.fromEntries(Object.entries(process.env).filter(([name]) => osVariables.has(name.toLowerCase())));

export function findLocalCodex(): string | undefined {
  for (const dir of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    if (process.platform === "win32") {
      // npm installs a .cmd shim next to node_modules. Launch the native executable so timeout stops the model process.
      const triple = process.arch === "arm64" ? "aarch64" : "x86_64";
      const npmBinary = resolve(dir, "node_modules", "@openai", "codex", "node_modules", "@openai",
        `codex-win32-${process.arch}`, "vendor", `${triple}-pc-windows-msvc`, "bin", "codex.exe");
      if (existsSync(npmBinary)) return npmBinary;
    }
    const binary = resolve(dir, process.platform === "win32" ? "codex.exe" : "codex");
    if (existsSync(binary)) return binary;
  }
}

export async function codexChatLogin(binary: string): Promise<boolean> {
  try {
    const { stdout, stderr } = await execute(binary, ["login", "status"], {
      env: cliEnvironment(), timeout: 7500, windowsHide: true, maxBuffer: 8192,
    });
    return /logged in using ChatGPT/i.test(stdout + stderr);
  } catch { return false; }
}

const disabledFeatures = ["shell_tool", "unified_exec", "shell_snapshot", "apps", "plugins", "hooks", "multi_agent",
  "multi_agent_v2", "view_image", "image_generation", "browser_use", "computer_use", "in_app_browser",
  "skill_search", "skill_mcp_dependency_install", "code_mode_host", "memories", "goals", "unbounded_connection_retries"];

export function recordLocalModelEvent(line: string, turn: { answer: string; completed: boolean }) {
  if (!line.trim()) return;
  let event;
  try { event = JSON.parse(line); }
  catch { throw new TRPCError({ code: "BAD_GATEWAY", message: "本机 Codex 返回了无法识别的推理记录。" }); }
  if (event.type === "turn.failed") throw new TRPCError({ code: "BAD_GATEWAY", message: "本机 Codex 推理失败，请检查网络和登录状态。" });
  if (event.type === "turn.completed") turn.completed = true;
  if (!["item.started", "item.completed", "item.updated"].includes(event.type)) return;
  // Some Codex releases emit a diagnostic error item before turn.started. It cannot invoke a tool.
  if (!["reasoning", "agent_message", "error"].includes(event.item?.type)) {
    throw new TRPCError({ code: "BAD_GATEWAY", message: "本次模型调用使用了工具，已中止。" });
  }
  if (event.type === "item.completed" && event.item.type === "agent_message") turn.answer = event.item.text;
}

export async function codexServoModel(binary: string, prompt: string, signal?: AbortSignal): Promise<unknown> {
  if (Buffer.byteLength(prompt) > 16 * 1024) throw new TRPCError({ code: "PAYLOAD_TOO_LARGE", message: "选型资料过长，请缩小到所需型号。" });
  const cwd = await mkdtemp(join(tmpdir(), "gouyuan-servo-"));
  try {
    const args = ["exec", "--ignore-user-config", "--ignore-rules", "--skip-git-repo-check", "--ephemeral",
      "--strict-config", "--sandbox", "read-only", "--color", "never", "-C", cwd,
      "-c", 'approval_policy="never"', "-c", 'web_search="disabled"', "-c", "agents.enabled=false", "-c", "agents.max_depth=0",
      "-c", "mcp_servers={}", "-c", "project_doc_max_bytes=0", "-c", "skills.include_instructions=false",
      "-c", "tools.update_plan.enabled=false", "-c", 'model_reasoning_effort="low"',
      ...disabledFeatures.flatMap(feature => ["--disable", feature]), "--json", "-"];
    const job = execute(binary, args, { cwd, env: cliEnvironment(), signal, timeout: 85_000, windowsHide: true, maxBuffer: 256 * 1024 });
    let lineBuffer = "", stopped: unknown;
    const turn = { answer: "", completed: false };
    const acceptLine = (line: string) => {
      if (stopped) return;
      try { recordLocalModelEvent(line, turn); }
      catch (error) { stopped = error; job.child.kill(); }
    };
    job.child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
      const lines = (lineBuffer + chunk).split("\n");
      lineBuffer = lines.pop() ?? "";
      for (const line of lines) acceptLine(line);
    });
    job.child.stdin?.on("error", () => {});
    job.child.stdin?.end("仅从给出的资料转录并返回 JSON。只回答正文，禁止调用工具。\n" + prompt);
    try { await job; }
    catch (error) {
      if (stopped) throw stopped;
      if (error instanceof Error && "killed" in error && error.killed) {
        throw new TRPCError({ code: "GATEWAY_TIMEOUT", message: "本机 Codex 推理超时，请稍后再试。" });
      }
      throw new TRPCError({ code: "BAD_GATEWAY", message: "本机 Codex 未完成推理，请检查登录或网络。" });
    }
    if (lineBuffer) acceptLine(lineBuffer);
    if (stopped) throw stopped;
    if (!turn.completed) throw new TRPCError({ code: "BAD_GATEWAY", message: "本机模型推理未结束，请重试。" });
    try { return JSON.parse(turn.answer.replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/i, "$1")); }
    catch { throw new TRPCError({ code: "UNPROCESSABLE_CONTENT", message: "本机模型未返回合法 JSON，请核对资料后重试。" }); }
  } finally {
    await rmdir(cwd).catch(() => {});
  }
}
