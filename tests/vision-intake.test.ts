import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { twinAiRouter } from "../api/twin-ai-router";
import { evaluateBindingReadiness, fillPendingParameterValue } from "../contracts/device-model-binding";
import { confirmSystemProvenance, evaluateSystemReadiness } from "../contracts/system-twin";
import { packageKey } from "../contracts/twin-device";
import { emptyWorkspace, parseWorkspace } from "../contracts/twin-simulation";
import { verifyAndApplyVisionIntake, VISION_DEMO_PRESETS } from "../contracts/vision-intake";

const date = new Date(0);
const user = {
  id: 1,
  unionId: "vision-test",
  name: null,
  email: null,
  role: "user" as const,
  avatar: null,
  createdAt: date,
  updatedAt: date,
  lastSignInAt: date,
};
const caller = twinAiRouter.createCaller({
  req: new Request("http://localhost"),
  resHeaders: new Headers(),
  user,
});
const modelFetch = vi.fn<typeof fetch>();

describe("拍照 / 手绘草图多模态视觉建库与防编造门禁", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", modelFetch.mockReset());
    vi.stubEnv("TWIN_AI_BASE_URL", "http://localhost:11434/v1/");
    vi.stubEnv("TWIN_AI_MODEL", "vision-fixture");
    vi.stubEnv("TWIN_AI_API_KEY", "");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("试玩 1（松下电机铭牌）：识别铭牌实参，未印出的转子惯量自动标为 pending，补全后立即就绪", () => {
    const preset = VISION_DEMO_PRESETS.find((item) => item.id === "nameplate-panasonic")!;
    const res = verifyAndApplyVisionIntake(emptyWorkspace(), preset.rawOutput, { sourceLabel: preset.title });

    expect(res.createdSystem).toBeUndefined();
    expect(res.createdDevices).toHaveLength(1);
    const motor = res.createdDevices[0]!;
    expect(motor.manufacturer).toBe("Panasonic");
    expect(motor.model).toBe("MSMF042L1V2M");

    const motorModelRef = { id: "Gouyuan.RatedTorqueMotor", version: "1.0.0" };
    const before = evaluateBindingReadiness(motor, motorModelRef);
    expect(before.status).toBe("pending");
    expect(before.pendingParameters.some((p) => p.key === "rotorInertiaKgM2")).toBe(true);
    expect(res.pendingItems.some((item) => item.parameterKey === "rotorInertiaKgM2")).toBe(true);

    // 不允许随意覆盖已确认目录项
    expect(() => fillPendingParameterValue(motor, "ratedPowerW", 500, "W")).toThrow(/非待确认项/);

    // 人工补全惯量后，就绪检查通过
    const completed = fillPendingParameterValue(motor, "rotorInertiaKgM2", 0.000014, "kg.m2");
    const after = evaluateBindingReadiness(completed, motorModelRef);
    expect(after.status).toBe("ready_with_assumptions");
    expect(after.values.rotorInertiaKgM2).toBeCloseTo(0.000014, 10);
    expect(after.values.ratedPowerW).toBe(400);
    expect(after.values.ratedTorqueNm).toBe(1.27);
  });

  it("试玩 2（手绘接线与行程草图）：生成 6 个器件 + 1 个未建模部件 + 草图系统，补全与确认后解锁闭环仿真", () => {
    const preset = VISION_DEMO_PRESETS.find((item) => item.id === "sketch-closed-loop")!;
    const res = verifyAndApplyVisionIntake(emptyWorkspace(), preset.rawOutput, { sourceLabel: preset.title });

    expect(res.createdDevices).toHaveLength(6);
    expect(res.unmodeledRequests).toHaveLength(1);
    expect(res.unmodeledRequests[0]!.model).toBe("PG-10");
    expect(res.createdSystem).toBeDefined();
    const draft = res.createdSystem!;

    const initialReport = evaluateSystemReadiness(res.workspace, draft);
    expect(initialReport.ready).toBe(false);
    expect([...initialReport.pendingItems, ...initialReport.blockingErrors].length).toBeGreaterThan(0);

    // 1) 在闭环工作台补全 MS1H1-40B30CB 缺少的转子转动惯量
    const motorKey = draft.axes[0]!.motorKey;
    const motorPkg = res.workspace.packages.find((p) => packageKey(p) === motorKey)!;
    const fixedMotor = fillPendingParameterValue(motorPkg, "rotorInertiaKgM2", 0.000026, "kg.m2");
    const updatedWs = parseWorkspace({
      ...res.workspace,
      packages: res.workspace.packages.map((p) => (packageKey(p) === motorKey ? fixedMotor : p)),
    });

    // 2) 补全限位开关触发位置并确认草图来源
    const draftWithSensor = {
      ...draft,
      sensors: draft.sensors.map((s) => ({ ...s, triggerPositionMm: 115 })),
    };
    const confirmedSystem = confirmSystemProvenance(draftWithSensor);
    const readyReport = evaluateSystemReadiness(updatedWs, confirmedSystem);

    expect(readyReport.blockingErrors).toEqual([]);
    expect(readyReport.pendingItems).toEqual([]);
    expect(readyReport.ready).toBe(true);
  });

  it("防编造校验：拒绝不存在的原文片段与不匹配数值，同时支持 ×10⁻⁴ 科学计数法铭牌惯量", () => {
    const base = VISION_DEMO_PRESETS[0]!.rawOutput;

    expect(() =>
      verifyAndApplyVisionIntake(emptyWorkspace(), {
        ...base,
        devices: [
          {
            ...base.devices[0]!,
            parameters: [
              { key: "ratedTorqueNm", value: 1.27, unit: "N.m", excerpt: "不存在于转录中的段落" },
            ],
          },
        ],
      }),
    ).toThrow(/未在照片转录文本中找到/);

    expect(() =>
      verifyAndApplyVisionIntake(emptyWorkspace(), {
        ...base,
        devices: [
          {
            ...base.devices[0]!,
            parameters: [
              { key: "ratedTorqueNm", value: 2.5, unit: "N.m", excerpt: "RATED TORQUE 1.27 N.m" },
            ],
          },
        ],
      }),
    ).toThrow(/拒绝猜测或编造数值/);

    const sciRes = verifyAndApplyVisionIntake(emptyWorkspace(), {
      sceneKind: "nameplate",
      transcribedText:
        "SERVOMOTOR A06B-0215  400W  3000r/min  1.27 N.m  转子惯量 0.15 ×10⁻⁴ kg·m²",
      devices: [
        {
          deviceTypeLabel: "交流伺服电机",
          manufacturer: "FANUC",
          model: "A06B-0215",
          role: "motor",
          modelRef: { id: "Gouyuan.RatedTorqueMotor", version: "1.0.0" },
          parameters: [
            { key: "ratedPowerW", value: 400, unit: "W", excerpt: "400W" },
            { key: "ratedSpeedRpm", value: 3000, unit: "rpm", excerpt: "3000r/min" },
            { key: "ratedTorqueNm", value: 1.27, unit: "N.m", excerpt: "1.27 N.m" },
            {
              key: "rotorInertiaKgM2",
              value: 0.000015,
              unit: "kg.m2",
              excerpt: "转子惯量 0.15 ×10⁻⁴ kg·m²",
            },
          ],
        },
      ],
    });
    const fanucMotor = sciRes.createdDevices[0]!;
    const ready = evaluateBindingReadiness(fanucMotor, { id: "Gouyuan.RatedTorqueMotor", version: "1.0.0" });
    expect(ready.status).toBe("ready");
    expect(ready.values.rotorInertiaKgM2).toBeCloseTo(0.000015, 10);
  });

  it("twinAi.analyzePhotos 发送多模态 text + image_url 请求并解析返回的 JSON（支持去除代码块围栏）", async () => {
    const preset = VISION_DEMO_PRESETS[0]!;
    modelFetch.mockResolvedValue(
      Response.json({
        choices: [
          {
            finish_reason: "stop",
            message: {
              content: "```json\n" + JSON.stringify(preset.rawOutput) + "\n```",
            },
          },
        ],
      }),
    );

    const parsed = await caller.analyzePhotos({
      images: [
        {
          name: "plate.jpg",
          mimeType: "image/jpeg",
          dataUrl: "data:image/jpeg;base64,QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=",
        },
      ],
      userGoal: "识别电机铭牌参数",
    });

    expect(modelFetch).toHaveBeenCalledTimes(1);
    const [, init] = modelFetch.mock.calls[0]!;
    const reqBody = JSON.parse(String(init?.body)) as {
      messages: Array<{ role: string; content: unknown }>;
    };
    const userContent = reqBody.messages[1]?.content as Array<{ type: string; image_url?: { url: string; detail: string } }>;
    expect(Array.isArray(userContent)).toBe(true);
    expect(userContent.some((part) => part.type === "text")).toBe(true);
    expect(
      userContent.some(
        (part) =>
          part.type === "image_url"
          && part.image_url?.detail === "high"
          && part.image_url.url.startsWith("data:image/jpeg;base64,"),
      ),
    ).toBe(true);
    expect(parsed.devices[0]?.model).toBe("MSMF042L1V2M");
  });
});
