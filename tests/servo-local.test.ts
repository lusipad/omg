import { createServer as createHttpServer } from "node:http";
import { EventEmitter, once } from "node:events";
import type { AddressInfo } from "node:net";
import { createServer as createVite } from "vite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { servoPairInputSchema } from "../api/servo-generation";
import { localServoPlugin } from "../dev/servo-local-plugin";
import { codexChatLogin, codexServoModel } from "../dev/servo-local-model";

vi.mock("../dev/servo-local-model", () => ({
  findLocalCodex: () => "fixture-codex", codexChatLogin: vi.fn(), codexServoModel: vi.fn(),
}));

const generatePair = vi.fn();
const input = {
  driveUrl: "https://www.inovance.com/global/content/details_816_555207.html",
  motorUrl: "https://www.inovance.com/global/content/details_816_541747.html",
};

async function serve(enabled: boolean) {
  const vite = await createVite({
    configFile: false, appType: "custom", plugins: [localServoPlugin(enabled)], logLevel: "silent",
    server: { middlewareMode: true, hmr: false, watch: null }, optimizeDeps: { noDiscovery: true },
  });
  vi.spyOn(vite, "ssrLoadModule").mockResolvedValue({ servoPairInputSchema, generateServoPair: generatePair });
  const server = createHttpServer(vite.middlewares);
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const generate = (body: unknown, headers: Record<string, string> = {}) => fetch(origin + "/api/local-servo/generate", {
    method: "POST", headers: { Origin: origin, "Content-Type": "application/json", ...headers }, body: JSON.stringify(body),
  });
  return {
    origin, generate,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
      await vite.close();
    },
  };
}

describe("本机伺服生成入口", () => {
  let enabled: Awaited<ReturnType<typeof serve>>;
  let disabled: Awaited<ReturnType<typeof serve>>;
  beforeAll(async () => {
    enabled = await serve(true);
    disabled = await serve(false);
  });
  afterAll(async () => { await enabled.close(); await disabled.close(); });
  beforeEach(() => {
    vi.mocked(codexChatLogin).mockReset().mockResolvedValue(true);
    vi.mocked(codexServoModel).mockReset();
    generatePair.mockReset();
  });

  it("关闭本机模式时查询状态和提交均不启动 CLI", async () => {
    expect(await (await fetch(disabled.origin + "/api/local-servo/status")).json()).toEqual({ available: false });
    expect((await disabled.generate(input)).status).toBe(503);
    expect(codexChatLogin).not.toHaveBeenCalled();
    expect(generatePair).not.toHaveBeenCalled();
  });

  it("登录状态可用时查询状态仍不会调用模型", async () => {
    expect(await (await fetch(enabled.origin + "/api/local-servo/status")).json()).toEqual({ available: true });
    expect(codexServoModel).not.toHaveBeenCalled();
  });

  it.each([
    { Origin: "https://example.com" }, { "Sec-Fetch-Site": "cross-site" }, { "X-Forwarded-For": "192.0.2.1" },
  ])("拒绝从其他来源发起或经代理转发的生成请求", async headers => {
    expect((await enabled.generate(input, headers as Record<string, string>)).status).toBe(403);
    expect(generatePair).not.toHaveBeenCalled();
    expect(codexChatLogin).not.toHaveBeenCalled();
  });

  it("请求不接受任意提示词和超长的请求体", async () => {
    expect((await enabled.generate({ ...input, prompt: "任意文本" })).status).toBe(400);
    expect((await enabled.generate({ driveUrl: "x".repeat(9000) })).status).toBe(413);
    expect(codexServoModel).not.toHaveBeenCalled();
  });

  it("服务端未登录时不读取资料或启动推理", async () => {
    vi.mocked(codexChatLogin).mockResolvedValue(false);
    expect((await enabled.generate(input)).status).toBe(503);
    expect(generatePair).not.toHaveBeenCalled();
  });

  it("一次仅处理一组由共享生成器校验的设备", async () => {
    const events = new EventEmitter();
    const entered = once(events, "entered"), release = once(events, "release");
    const pair = { drive: { model: "驱动器" }, motor: { model: "电机" } };
    generatePair.mockImplementationOnce(async (_input: unknown, model: (prompt: string) => Promise<unknown>) => {
      events.emit("entered");
      await release;
      await model("已核对的选型行");
      return pair;
    });
    const first = enabled.generate(input);
    await entered;
    try { expect((await enabled.generate(input)).status).toBe(429); }
    finally { events.emit("release"); }
    expect(await (await first).json()).toEqual(pair);
    expect(codexServoModel).toHaveBeenCalledWith("fixture-codex", "已核对的选型行", expect.anything());
    expect(generatePair).toHaveBeenCalledTimes(1);
  });
});
