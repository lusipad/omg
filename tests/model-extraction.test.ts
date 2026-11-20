import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { twinAiRouter } from "../api/twin-ai-router";
import { resolveParameterChoice } from "../contracts/device-model-binding";
import {
  modelExtractionPrompt,
  verifyAndBuildExtractedDevice,
} from "../contracts/model-extraction";
import { assembleServoAxis, simulateServoAxis } from "../contracts/servo-axis";
import { buildSourceArtifact } from "../contracts/source-artifact";
import { packageKey } from "../contracts/twin-device";
import { emptyWorkspace, installPackage } from "../contracts/twin-simulation";

const deltaPdfRawText = [
  "DELTA_IA-ASDA_ASDA-B3_C_EN_20240703\nAC Servo Drive & Motor Series Overview",
  ...Array.from({ length: 19 }, (_, idx) => `General specifications page ${idx + 2}`),
  "Page 21 Drive-Motor Combinations\n400W Servo Motor ECM-B3M-CA0604RB1 paired with Drive ASD-B3-0421-L",
  ...Array.from({ length: 10 }, (_, idx) => `Drive dimensions page ${idx + 22}`),
  "Page 32 Servo Drive Specifications\nModel: ASD-B3-0421-L | Continuous output current: 2.65 Arms | Instantaneous max current: 7.95 Arms",
  ...Array.from({ length: 4 }, (_, idx) => `Wiring page ${idx + 33}`),
  "Page 37 Motor Part Numbering\nDigit 13 Oil seal and brake: R = without brake, with oil seal",
  ...Array.from({ length: 3 }, (_, idx) => `Motor frame page ${idx + 38}`),
  [
    "Page 41 Low Inertia 400 W Servo Motor ECM-B3M-CA0604",
    "Rated output power: 0.4 kW | Rated torque: 1.27 N·m | Maximum torque: 3.81 N·m",
    "Rated speed: 3000 r/min | Maximum speed: 6000 r/min | Rated current: 2.40 Arms",
    "Rotor inertia (10^-4 kg·m²): without brake 0.254 / with brake 0.264",
  ].join("\n"),
].join("\f");

const deltaArtifact = buildSourceArtifact({
  sha256: "a".repeat(64),
  rawText: deltaPdfRawText,
  format: "pdf",
  title: "Delta AC Servo Drive & Motor ASDA-B3 Series Catalogue",
  sourceUrl: "https://www.deltaww.com/en-US/products/Servo-Systems-AC-Servo-Motors-and-Drives/5158",
});

const date = new Date(0);
const user = { id: 1, unionId: "test", name: null, email: null, role: "user" as const, avatar: null, createdAt: date, updatedAt: date, lastSignInAt: date };
const member = twinAiRouter.createCaller({ req: new Request("http://localhost"), resHeaders: new Headers(), user });
const modelFetch = vi.fn<typeof fetch>();

function mockModelResponse(output: unknown) {
  modelFetch.mockResolvedValueOnce(
    Response.json({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(output) } }] }),
  );
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

describe("模型参数契约驱动的跨品牌资料提取", () => {
  it("零厂商专用代码提取台达 ASDA-B3 驱动与电机，保留页码证据并在 433 ms 收敛", async () => {
    mockModelResponse({
      fields: {
        driveRatedCurrentA: {
          status: "confirmed",
          value: 2.65,
          rawUnit: "Arms",
          page: 32,
          tableLocation: "Servo Drive Specifications",
          excerpt: "Model: ASD-B3-0421-L | Continuous output current: 2.65 Arms | Instantaneous max current: 7.95 Arms",
        },
        drivePeakCurrentA: {
          status: "confirmed",
          value: 7.95,
          rawUnit: "Arms",
          page: 32,
          tableLocation: "Servo Drive Specifications",
          excerpt: "Model: ASD-B3-0421-L | Continuous output current: 2.65 Arms | Instantaneous max current: 7.95 Arms",
        },
      },
    });
    mockModelResponse({
      fields: {
        rotorInertiaKgM2: {
          status: "confirmed",
          value: 0.254,
          rawUnit: "10^-4 kg·m²",
          page: 41,
          tableLocation: "400 W column",
          condition: "without brake (R)",
          excerpt: "Rotor inertia (10^-4 kg·m²): without brake 0.254 / with brake 0.264",
        },
        ratedPowerW: {
          status: "confirmed",
          value: 0.4,
          rawUnit: "kW",
          page: 41,
          excerpt: "Rated output power: 0.4 kW | Rated torque: 1.27 N·m | Maximum torque: 3.81 N·m",
        },
        ratedTorqueNm: {
          status: "confirmed",
          value: 1.27,
          rawUnit: "N·m",
          page: 41,
          excerpt: "Rated output power: 0.4 kW | Rated torque: 1.27 N·m | Maximum torque: 3.81 N·m",
        },
        peakTorqueNm: {
          status: "confirmed",
          value: 3.81,
          rawUnit: "N·m",
          page: 41,
          excerpt: "Rated output power: 0.4 kW | Rated torque: 1.27 N·m | Maximum torque: 3.81 N·m",
        },
        ratedSpeedRpm: {
          status: "confirmed",
          value: 3000,
          rawUnit: "r/min",
          page: 41,
          excerpt: "Rated speed: 3000 r/min | Maximum speed: 6000 r/min | Rated current: 2.40 Arms",
        },
        maxSpeedRpm: {
          status: "confirmed",
          value: 6000,
          rawUnit: "r/min",
          page: 41,
          excerpt: "Rated speed: 3000 r/min | Maximum speed: 6000 r/min | Rated current: 2.40 Arms",
        },
        motorRatedCurrentA: {
          status: "confirmed",
          value: 2.4,
          rawUnit: "Arms",
          page: 41,
          excerpt: "Rated speed: 3000 r/min | Maximum speed: 6000 r/min | Rated current: 2.40 Arms",
        },
      },
      compatiblePeerModels: {
        models: ["ASD-B3-0421-L"],
        page: 21,
        tableLocation: "Drive-Motor Combinations",
        excerpt: "400W Servo Motor ECM-B3M-CA0604RB1 paired with Drive ASD-B3-0421-L",
      },
      unmodeledPhysicsNotes: ["R 选件含油封，真实摩擦降额须单独建模"],
    });

    const artifactInput = {
      sha256: deltaArtifact.sha256,
      title: deltaArtifact.title!,
      sourceUrl: deltaArtifact.sourceUrl,
      documentVersion: deltaArtifact.documentVersion,
      pages: deltaArtifact.pages,
      text: deltaArtifact.text,
    };

    const driveExtracted = await member.extractForModel({
      manufacturer: "Delta Electronics",
      model: "ASD-B3-0421-L",
      revision: "20240703",
      modelRef: { id: "Gouyuan.PositionDrive", version: "1.0.0" },
      artifact: artifactInput,
    });
    const motorExtracted = await member.extractForModel({
      manufacturer: "Delta Electronics",
      model: "ECM-B3M-CA0604RB1",
      revision: "20240703",
      modelRef: { id: "Gouyuan.RatedTorqueMotor", version: "1.0.0" },
      artifact: artifactInput,
    });

    expect(driveExtracted.readiness.status).toBe("ready");
    expect(motorExtracted.readiness.status).toBe("ready");
    expect(motorExtracted.warnings).toContain("R 选件含油封，真实摩擦降额须单独建模");
    expect(motorExtracted.device.parameters?.rotorInertiaKgM2).toMatchObject({
      status: "catalog",
      value: 0.254,
      unit: "10^-4 kg·m²",
      locator: "DELTA_IA-ASDA_ASDA-B3_C_EN_20240703 · 第 41 页 · 400 W column",
    });

    const ws = assembleServoAxis(
      installPackage(installPackage(emptyWorkspace(), driveExtracted.device), motorExtracted.device),
      {
        driveKey: packageKey(driveExtracted.device),
        motorKey: packageKey(motorExtracted.device),
        targetDeg: 90,
        loadInertiaRatio: 1,
      },
    );
    const result = simulateServoAxis(ws);
    expect(result.settled).toBe(true);
    expect(result.samples.at(-1)?.timeMs).toBe(433);
  });

  it("隐去订货选件字符时保留已核实参数并进入待确认态，确认选件后即可就绪", async () => {
    mockModelResponse({
      fields: {
        rotorInertiaKgM2: {
          status: "ambiguous",
          rawUnit: "10^-4 kg·m²",
          reason: "型号未标明是否带抱闸（第 13 位字符），第 41 页列出无抱闸与带抱闸两个数值。",
          candidates: [
            { option: "无抱闸", value: 0.254, page: 41, excerpt: "Rotor inertia (10^-4 kg·m²): without brake 0.254 / with brake 0.264" },
            { option: "带抱闸", value: 0.264, page: 41, excerpt: "Rotor inertia (10^-4 kg·m²): without brake 0.254 / with brake 0.264" },
          ],
        },
        ratedPowerW: { status: "confirmed", value: 0.4, rawUnit: "kW", page: 41, excerpt: "Rated output power: 0.4 kW" },
        ratedTorqueNm: { status: "confirmed", value: 1.27, rawUnit: "N·m", page: 41, excerpt: "Rated torque: 1.27 N·m" },
        ratedSpeedRpm: { status: "confirmed", value: 3000, rawUnit: "r/min", page: 41, excerpt: "Rated speed: 3000 r/min" },
        motorRatedCurrentA: { status: "confirmed", value: 2.4, rawUnit: "Arms", page: 41, excerpt: "Rated current: 2.40 Arms" },
      },
    });

    const extracted = await member.extractForModel({
      manufacturer: "Delta Electronics",
      model: "ECM-B3M-CA0604",
      revision: "20240703-pending",
      modelRef: { id: "Gouyuan.RatedTorqueMotor", version: "1.0.0" },
      artifact: {
        title: deltaArtifact.title!,
        documentVersion: deltaArtifact.documentVersion,
        pages: deltaArtifact.pages,
        text: deltaArtifact.text,
      },
    });

    expect(extracted.readiness.status).toBe("pending");
    expect(extracted.readiness.values).toMatchObject({
      ratedPowerW: 400,
      ratedTorqueNm: 1.27,
      ratedSpeedRpm: 3000,
      motorRatedCurrentA: 2.4,
    });
    expect(extracted.readiness.pendingParameters[0].candidates.map((c) => c.convertedValue)).toEqual([0.0000254, 0.0000264]);

    const confirmed = resolveParameterChoice(extracted.device, "rotorInertiaKgM2", 0, "20240703-R");
    expect(confirmed.parameters?.rotorInertiaKgM2).toMatchObject({ status: "catalog", value: 0.254 });
  });

  it("确定性复核闸门拦截虚假摘录、错误页码、篡改数值与错误量纲", () => {
    const req = {
      manufacturer: "Delta Electronics",
      model: "ECM-B3M-CA0604RB1",
      revision: "20240703",
      modelRef: { id: "Gouyuan.RatedTorqueMotor", version: "1.0.0" },
      artifact: {
        title: deltaArtifact.title!,
        documentVersion: deltaArtifact.documentVersion,
        pages: deltaArtifact.pages,
        text: deltaArtifact.text,
      },
    };
    const prompt = modelExtractionPrompt(req);
    expect(prompt).toContain("rotorInertiaKgM2");
    expect(prompt).toContain("Page 41");

    expect(() => verifyAndBuildExtractedDevice(req, {
      fields: {
        rotorInertiaKgM2: { status: "confirmed", value: 0.254, rawUnit: "10^-4 kg·m²", page: 41, excerpt: "编造的惯量行 0.254" },
      },
    })).toThrow(/摘录/);

    expect(() => verifyAndBuildExtractedDevice(req, {
      fields: {
        rotorInertiaKgM2: {
          status: "confirmed",
          value: 0.254,
          rawUnit: "10^-4 kg·m²",
          page: 12,
          excerpt: "Rotor inertia (10^-4 kg·m²): without brake 0.254 / with brake 0.264",
        },
      },
    })).toThrow(/第 12 页/);

    expect(() => verifyAndBuildExtractedDevice(req, {
      fields: {
        rotorInertiaKgM2: {
          status: "confirmed",
          value: 0.199,
          rawUnit: "10^-4 kg·m²",
          page: 41,
          excerpt: "Rotor inertia (10^-4 kg·m²): without brake 0.254 / with brake 0.264",
        },
      },
    })).toThrow(/0\.199/);

    expect(() => verifyAndBuildExtractedDevice(req, {
      fields: {
        rotorInertiaKgM2: {
          status: "confirmed",
          value: 0.254,
          rawUnit: "N·m",
          page: 41,
          excerpt: "Rotor inertia (10^-4 kg·m²): without brake 0.254 / with brake 0.264",
        },
      },
    })).toThrow(/量纲不兼容/);
  });

  it("同一提取管道无需伺服代码即可提取丝杠与接近开关设备包", () => {
    const screwExtracted = verifyAndBuildExtractedDevice({
      manufacturer: "THK",
      model: "BNK2010",
      revision: "1",
      modelRef: { id: "Gouyuan.IdealLeadScrew", version: "1.0.0" },
      artifact: {
        title: "THK Precision Ball Screw BNK",
        text: "Model BNK2010: Shaft diameter 20 mm, Lead 10 mm/rev",
      },
    }, {
      fields: {
        leadMmPerRev: { status: "confirmed", value: 10, rawUnit: "mm/rev", excerpt: "Lead 10 mm/rev" },
      },
    });
    expect(screwExtracted.readiness.status).toBe("ready");
    expect(screwExtracted.readiness.values.leadMmPerRev).toBe(10);

    const switchExtracted = verifyAndBuildExtractedDevice({
      manufacturer: "Generic",
      model: "LJ12A3-4-Z/AY",
      revision: "1",
      modelRef: { id: "GouyuanSignal.PositionLimitSwitch", version: "1.0.0" },
      artifact: {
        title: "LJ12A3 Proximity Switch Datasheet",
        text: "LJ12A3-4-Z/AY PNP Normally Closed (NC) Sensing distance: 4 mm, Supply voltage: 24 VDC",
      },
    }, {
      fields: {
        senseDistanceMm: { status: "confirmed", value: 4, rawUnit: "mm", excerpt: "Sensing distance: 4 mm" },
        supplyVoltageV: { status: "confirmed", value: 24, rawUnit: "VDC", excerpt: "Supply voltage: 24 VDC" },
        normallyClosed: { status: "confirmed", value: true, rawUnit: "1", excerpt: "Normally Closed (NC)" },
      },
    });
    expect(switchExtracted.readiness.status).toBe("ready");
    expect(switchExtracted.readiness.values).toMatchObject({
      senseDistanceMm: 4,
      supplyVoltageV: 24,
      normallyClosed: true,
    });
  });
});
