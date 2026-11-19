import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { applyMiloBomImport, applySo101BomImport, mergeImportedMaterials } from "../contracts/import-apply";
import { initialMiloWorkspace } from "../contracts/milo-workspace";
import { parseMiloBom } from "../contracts/milo-bom";
import { SO101_MODEL_ID } from "../contracts/so101";
import { parseSo101Bom } from "../contracts/so101-bom";
import { createDocumentMaterial, parseMaterialTable } from "../contracts/material-import";
import { emptyWorkspace } from "../contracts/twin-simulation";
import { packageKey, type DevicePackage } from "../contracts/twin-device";

const milo = parseMiloBom(readFileSync(new URL("../public/machines/milo-v1-5/bom-facts.md", import.meta.url), "utf8"));
const follower = parseSo101Bom(readFileSync(new URL("../public/models/so101/follower-bom.md", import.meta.url), "utf8"));
const device: DevicePackage = {
  schemaVersion: 1, manufacturer: "仪表厂", model: "X8", revision: "B",
  source: { kind: "local", url: "", title: "记录", locator: "台架 A", excerpt: "模拟输入" },
  ports: [{ id: "x", label: "信号", type: "boolean", direction: "input" }], rules: [],
};

describe("确认导入到当前工程", () => {
  it("Milo 清单重核保留程序和仍有料的轴，不动当前其他工作区", () => {
    const base = { ...emptyWorkspace(), milo: { ...initialMiloWorkspace, bom: milo, assembled: ["Y", "X", "Z"] as ("X" | "Y" | "Z")[], program: "G1 X12 F60" } };
    const next = applyMiloBomImport(base, milo.filter(row => !row.name.includes("550mm (min - X-Axis)")), "新实测表");
    expect(next.milo).toMatchObject({ assembled: ["Y", "Z"], program: "G1 X12 F60", bomSource: "新实测表" });
    expect(base.milo.assembled).toEqual(["Y", "X", "Z"]);
    expect(next.instances).toBe(base.instances);
    expect(() => applyMiloBomImport(base, [], "空清单")).toThrow();
    expect(base.milo.assembled).toEqual(["Y", "X", "Z"]);
  });

  it("首次从采购表装配 SO-101 仅给一个零位保持点，重导保留已编辑路点", () => {
    const initial = applySo101BomImport(emptyWorkspace(), follower);
    expect(initial.so101).toMatchObject({ modelId: SO101_MODEL_ID, bom: follower, waypoints: [{ timeS: 1, anglesDeg: [0, 0, 0, 0, 0, 0] }] });
    const customized = [{ timeS: 1.5, anglesDeg: [1, 2, 3, 4, 5, 6] }];
    const ws = { ...initial, so101: { ...initial.so101!, waypoints: customized } };
    const next = applySo101BomImport(ws, follower.filter(row => !row.part.startsWith("Screwdriver")));
    expect(next.so101?.waypoints).toEqual(customized);
    expect(ws.so101.bom).toHaveLength(6);
    expect(() => applySo101BomImport(ws, [{ part: "未知舵机", quantity: 5 }])).toThrow();
    expect(ws.so101.waypoints).toEqual(customized);
  });

  it("物料按已有规则匹配、幂等合并，已有人工绑定优先", () => {
    const [row] = parseMaterialTable("名称,数量,制造商,型号\n传感器,2,仪表厂,X8", "设备表");
    const manual = createDocumentMaterial("手册", " 原文\n", "试验文件");
    const base = { ...emptyWorkspace(), packages: [device] };
    const next = mergeImportedMaterials(base, [row, manual]);
    expect(next.catalog?.materials[0].binding).toEqual({ kind: "device", key: packageKey(device) });
    expect(mergeImportedMaterials(next, [row, manual])).toEqual(next);
    const newRevision = { ...device, revision: "C" };
    const ws = { ...next, packages: [device, newRevision] };
    const incoming = { ...row, binding: { kind: "device" as const, key: packageKey(newRevision) } };
    expect(mergeImportedMaterials(ws, [incoming]).catalog?.materials[0].binding).toEqual(next.catalog?.materials[0].binding);
    expect(base).not.toHaveProperty("catalog");
  });

  it("资料保存后安装唯一设备，重导补上绑定；有冲突时整批保持原工程", () => {
    const [row] = parseMaterialTable("name,qty,model\n探头,1,X8");
    const ws = mergeImportedMaterials(emptyWorkspace(), [row]);
    expect(ws.catalog?.materials[0].binding).toBeUndefined();
    const installed = { ...ws, packages: [device] };
    expect(mergeImportedMaterials(installed, [row]).catalog?.materials[0].binding?.key).toBe(packageKey(device));
    expect(() => mergeImportedMaterials(ws, [createDocumentMaterial("新文件", "数据"), { ...row, quantity: 20 }])).toThrow(/标识相同/);
    expect(ws.catalog?.materials).toEqual([row]);
  });

  it("同批重复项幂等，有相同标识的不同内容时拒绝整批", () => {
    const base = emptyWorkspace();
    const row = createDocumentMaterial("标定记录", "值为 4 mA");
    expect(mergeImportedMaterials(base, [row, row]).catalog?.materials).toEqual([row]);
    expect(() => mergeImportedMaterials(base, [row, { ...row, notes: "值为 8 mA" }])).toThrow(/标识相同/);
    expect(base.catalog).toBeUndefined();
  });
});
