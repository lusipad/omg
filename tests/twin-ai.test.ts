import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { twinAiRouter } from "../api/twin-ai-router";
import { generateDevicePackage, inovanceSource } from "../contracts/twin-extract";
import servoDrive from "../examples/SV660NS2R8I-FS-INT.device.json";

const input = {
  manufacturer: "测试仪表厂", model: "LT-4", revision: "B",
  title: "LT-4 信号转换资料", url: "https://example.org/lt-4", locator: "第 2 页，转换特性",
  text: "输入为电压。\n输出电压    等于输入电压的 2 倍。\n零点偏移 0 V。",
};
const device = {
  schemaVersion: 1, manufacturer: input.manufacturer, model: input.model, revision: input.revision,
  source: { title: input.title, url: input.url, locator: input.locator, excerpt: "输出电压 等于输入电压的 2 倍。\n零点偏移 0 V。" },
  ports: [
    { id: "u", direction: "input", type: "number", label: "输入电压", unit: "V" },
    { id: "y", direction: "output", type: "number", label: "输出电压", unit: "V" },
  ],
  rules: [{ op: "linear", input: "u", output: "y", gain: 2, offset: 0 }],
};
const date = new Date(0);
const user = { id: 1, unionId: "test", name: null, email: null, role: "user" as const, avatar: null, createdAt: date, updatedAt: date, lastSignInAt: date };
const context = { req: new Request("http://localhost"), resHeaders: new Headers() };
const guest = twinAiRouter.createCaller(context);
const member = twinAiRouter.createCaller({ ...context, user });
const modelFetch = vi.fn<typeof fetch>();

function modelReturns(output: unknown) {
  modelFetch.mockResolvedValue(Response.json({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(output) } }] }));
}

beforeEach(() => {
  vi.stubGlobal("fetch", modelFetch.mockReset());
  vi.stubEnv("TWIN_AI_BASE_URL", "http://localhost:11434/v1/");
  vi.stubEnv("TWIN_AI_MODEL", "fixture");
  vi.stubEnv("TWIN_AI_API_KEY", "");
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("可选 AI 设备草案", () => {
  it("单份资料的模型草案不能另行指定产品来源链接", async () => {
    modelReturns({ ...device, source: { ...device.source, productUrl: "https://example.org/other" } });
    await expect(member.generate(input)).rejects.toThrow(/来源/);
  });

  it("公开配置状态且区分登录状态", async () => {
    expect(await guest.status()).toEqual({ available: true, authenticated: false });
    expect(await member.status()).toEqual({ available: true, authenticated: true });
    vi.stubEnv("TWIN_AI_MODEL", "");
    expect(await member.status()).toEqual({ available: false, authenticated: true });
    expect(modelFetch).not.toHaveBeenCalled();
  });

  it("匿名用户无法调用模型", async () => {
    await expect(guest.generate(input)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(guest.generateServoPair({ driveUrl: input.url, motorUrl: input.url })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(modelFetch).not.toHaveBeenCalled();
  });

  it("已登录但未配置模型时保留离线生成入口", async () => {
    vi.stubEnv("TWIN_AI_BASE_URL", "");
    await expect(member.generate(input)).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    await expect(member.generateServoPair({ driveUrl: input.url, motorUrl: input.url })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(modelFetch).not.toHaveBeenCalled();
  });

  it("从兼容服务返回经校验的草案并支持无密钥服务", async () => {
    modelReturns(device);
    expect(await member.generate(input)).toEqual({ device });
    const [address, request] = modelFetch.mock.calls[0];
    expect(String(address)).toBe("http://localhost:11434/v1/chat/completions");
    expect(new Headers(request?.headers).has("Authorization")).toBe(false);
    const body = JSON.parse(String(request?.body));
    expect(body.model).toBe("fixture");
    expect(body.messages.at(-1).content).toContain(input.url);
  });

  it.each([
    [{ ...device, revision: "A" }, /身份|修订/],
    [{ ...device, source: { ...device.source, locator: "第 3 页" } }, /来源|定位/],
    [{ ...device, source: { ...device.source, excerpt: "输出电压 等于输入电压的 2 倍。\n零点偏移 1 V。" } }, /摘录|原文/],
    [{ ...device, rules: [{ op: "script", input: "u", output: "y" }] }, /设备包|规则/],
  ])("拒绝来源不实或规则不受支持的草案", async (bad, error) => {
    modelReturns(bad);
    await expect(member.generate(input)).rejects.toThrow(error);
  });

  it("给出模型列出的缺失规格", async () => {
    modelReturns({ missing: ["转换系数", "输出单位"] });
    await expect(member.generate(input)).rejects.toThrow(/转换系数.*输出单位/);
  });

  it("单份资料的 AI 入口拒绝伺服包", async () => {
    modelReturns(servoDrive);
    await expect(member.generate(input)).rejects.toThrow(/双链接入口/);
  });

  it("数字量输入草案的数值须符合已识别的原文规格", async () => {
    const official = generateDevicePackage(inovanceSource);
    modelReturns({ ...official, rules: official.rules.map(rule => ({ ...rule, onAbove: 50 })) });
    await expect(member.generate(inovanceSource)).rejects.toThrow(/阈值/);
  });

  it("数字量输入资料缺少阈值时拒绝 AI 补猜", async () => {
    const official = generateDevicePackage(inovanceSource);
    const text = "数字量输入扩展模块，16 路数字输入。";
    modelReturns({ ...official, source: { ...official.source, excerpt: text } });
    await expect(member.generate({ ...inovanceSource, text })).rejects.toThrow(/原文未能确认/);
  });

  it("不完整的数字量输入模块规格也不能降为线性草案", async () => {
    const text = "LT-4 数字量输入模块";
    modelReturns({ ...device, source: { ...device.source, excerpt: text } });
    await expect(member.generate({ ...input, text })).rejects.toThrow(/补齐.*数字量输入规格表/);
  });

  it("每个数字量输入通道必须独立使用以 V 计量的端口", async () => {
    const official = generateDevicePackage(inovanceSource);
    modelReturns({ ...official, rules: official.rules.map(rule => ({ ...rule, input: "v0" })) });
    await expect(member.generate(inovanceSource)).rejects.toThrow(/电压通道/);
    modelReturns({ ...official, ports: official.ports.map(port => port.id === "v0" ? { ...port, unit: "mV" } : port) });
    await expect(member.generate(inovanceSource)).rejects.toThrow(/设备包校验/);
  });

  it("模型服务错误只报告状态码", async () => {
    vi.stubEnv("TWIN_AI_API_KEY", "fixture-private-key");
    modelFetch.mockResolvedValue(new Response("fixture-private-key", { status: 403 }));
    await expect(member.generate(input)).rejects.toMatchObject({ message: "模型服务返回 HTTP 403，请检查服务端模型配置。" });
    expect(new Headers(modelFetch.mock.calls[0][1]?.headers).get("Authorization")).toBe("Bearer fixture-private-key");
  });

  it("截断的模型输出提示缩小规格范围", async () => {
    modelFetch.mockResolvedValue(Response.json({ choices: [{ finish_reason: "length", message: { content: "{" } }] }));
    await expect(member.generate(input)).rejects.toThrow(/长度限制/);
  });
});
