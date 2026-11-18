import { beforeEach, describe, expect, it, vi } from "vitest";
import { zipSync, type Zippable } from "three/examples/jsm/libs/fflate.module.js";
import { emptyWorkspace } from "../contracts/twin-simulation";
import type { ModelBundle } from "../contracts/import-catalog";
import {
  describeModel, exportModelBundle, exportProjectArchive, getModelBundle, inspectModelSources,
  ProjectArchiveFileError, putModelBundle, putProjectModels, readModelFiles, readProjectArchive, resolveModelResource,
} from "../src/lib/model-files";
import { readStoredModel, writeModels } from "../src/lib/model-store";

vi.mock("../src/lib/model-store", () => ({ readStoredModel: vi.fn(), writeModels: vi.fn() }));
const bytes = (s: string) => new TextEncoder().encode(s);
const archive = (members: Zippable) => new File([zipSync(members)], "工序.mjz");
const file = (path: string, text: string) => ({ path, data: bytes(text) });
const bundle: ModelBundle = {
  entry: "机械/main.mjcf",
  files: [
    file("机械/main.mjcf", '<?xml version="1.0"?><!--入口--><mujoco model="装配试台"><include file="parts/a.xml"/></mujoco>'),
    file("机械/parts/a.xml", '<mujocoinclude><include file="links/b.xml"/></mujocoinclude>'),
    file("机械/parts/links/b.xml", '<mujocoinclude><asset><mesh file="../../网格/臂.stl"/></asset></mujocoinclude>'),
    { path: "机械/网格/臂.stl", data: Uint8Array.of(0, 254, 128, 1) },
  ],
};

beforeEach(() => vi.resetAllMocks());

describe("通用模型二进制资源", () => {
  it("识别二级 include 与所属目录中的资源，仅列真正的模型入口", async () => {
    const meshPaths = new Set<string>();
    const refs = await inspectModelSources(bundle, meshPaths);
    expect([...refs]).toEqual(bundle.files.slice(0, 3).map((f) => f.path));
    expect([...meshPaths]).toEqual([bundle.files[3].path]);
    const archiveFile = archive(Object.fromEntries(bundle.files.map((f) => [f.path, f.data])));
    const read = await readModelFiles([archiveFile]);
    expect(read.entries).toEqual([bundle.entry]);
    expect(await describeModel({ entry: read.entries[0], files: read.files })).toEqual(await describeModel(bundle));
  });

  it("支持 include 相对于主入口目录的常见扁平布局", async () => {
    const files = [file("r/main.xml", '<mujoco><include file="src/inc.xml"/></mujoco>'),
      file("r/src/inc.xml", '<mujocoinclude><include file="common.xml"/></mujocoinclude>'), file("r/common.xml", "<mujocoinclude/>")];
    expect(await inspectModelSources({ entry: files[0].path, files })).toContain("r/common.xml");
  });

  it("目录保留内部层次、文件顺序与模型哈希无关", async () => {
    const selected = bundle.files.map((f) => {
      const input = new File([f.data.slice()], f.path.split("/").at(-1)!);
      Object.defineProperty(input, "webkitRelativePath", { value: "下载/" + f.path });
      return input;
    });
    const { files } = await readModelFiles(selected.toReversed());
    const ref = await describeModel({ entry: bundle.entry, files });
    expect(ref).toEqual(await describeModel(bundle));
    expect(ref.name).toBe("装配试台");
    expect(ref.id).toMatch(/^[a-f0-9]{64}$/);
    const another = { entry: "other.xml", files: [file("other.xml", "<mujoco/>"), ...files] };
    expect((await describeModel(another)).id).not.toBe((await describeModel({ ...another, entry: bundle.entry })).id);
  });

  it("保留供应商的 workspace.json；裸网格返回空入口供用户选单位", async () => {
    const vendor = await readModelFiles([archive({ "workspace.json": bytes('{"project":"供应商"}'), "scene.xml": bytes("<mujoco/>") })]);
    expect(vendor.files.map((f) => f.path)).toContain("workspace.json");
    expect(vendor.entries).toEqual(["scene.xml"]);
    expect((await readModelFiles([new File(["solid"], "支架.stl")])).entries).toEqual([]);
  });

  it("只允许可在本包确切定位的 ROS 包资源", async () => {
    const files = [file("hardware/urdf/arm.urdf", '<robot name="Arm"><link name="a"><visual><geometry><mesh filename="package://sample/meshes/x.stl"/></geometry></visual></link></robot>'),
      file("hardware/package.xml", "<package><name>sample</name></package>"), file("hardware/meshes/x.stl", "mesh")];
    expect((await describeModel({ entry: files[0].path, files })).name).toBe("Arm");
    expect(() => resolveModelResource(files, files[0].path, "package://unknown/meshes/x.stl")).toThrow(/缺失/);
  });

  it.each(["../x.xml", "\\\\server/x", "https://example.org/x.xml", "C:/x", "/absolute.xml"])("拒绝归档中的非法路径 %s", async (name) => {
    await expect(readModelFiles([archive({ [name]: bytes("<mujoco/>") })])).rejects.toThrow(/路径|包目录/);
  });

  it("拒绝大小写冲突、缺失资源和外部 URI", async () => {
    await expect(readModelFiles([archive({ "M/a.xml": bytes("<mujoco/>"), "m/b.xml": bytes("<mujoco/>") })])).rejects.toThrow(/冲突/);
    await expect(describeModel({ ...bundle, files: bundle.files.slice(0, -1) })).rejects.toThrow(/缺少资源|包目录/);
    const files = [file("asset.xml", '<mujoco><asset><mesh file="https://example.org/part.stl"/></asset></mujoco>')];
    await expect(describeModel({ entry: "asset.xml", files })).rejects.toThrow(/本地包/);
  });

  it("拒绝伪 ZIP 和资源校验码损坏的 ZIP", async () => {
    await expect(readModelFiles([new File(["<mujoco/>"], "fake.zip")])).rejects.toThrow(/ZIP/);
    const data = new Uint8Array(await exportModelBundle(bundle).arrayBuffer());
    const before = data.findIndex((_, i) => data[i] === 60 && data[i + 1] === 63);
    data[before] ^= 1;
    await expect(readModelFiles([new File([data], "wrong-crc.zip")])).rejects.toThrow(/校验/);
  });
});

describe("工程归档", () => {
  it("导出包含资源与工程清单；恢复并核对全部内容后再单批保存", async () => {
    const ref = await describeModel(bundle);
    vi.mocked(readStoredModel).mockResolvedValue(bundle);
    const ws = { ...emptyWorkspace(), catalog: { models: [{ ...ref, name: "用户命名" }], materials: [] } };
    const backup = new File([await exportProjectArchive(ws)], "完整工程.zip");
    await expect(readModelFiles([backup])).rejects.toBeInstanceOf(ProjectArchiveFileError);
    const restored = await readProjectArchive(backup);
    expect(restored.workspace).toEqual(ws);
    expect(restored.models[0].bundle).toEqual(bundle);
    expect(writeModels).not.toHaveBeenCalled();
    await putProjectModels(restored.models);
    expect(writeModels).toHaveBeenCalledOnce();
  });

  it("清单中模型缺失、入口错配或文件被修改时拒绝导入", async () => {
    const ref = await describeModel(bundle);
    const ws = { ...emptyWorkspace(), catalog: { models: [ref], materials: [] } };
    const manifest = bytes(JSON.stringify(ws));
    await expect(readProjectArchive(archive({ "workspace.json": manifest }))).rejects.toThrow(/文件数量/);
    const resources = Object.fromEntries(bundle.files.map((f) => ["models/" + ref.id + "/" + f.path, f.data]));
    resources["models/" + ref.id + "/" + bundle.files[3].path] = bytes("变更");
    await expect(readProjectArchive(archive({ "workspace.json": manifest, ...resources }))).rejects.toThrow(/哈希/);
    await expect(putModelBundle({ ...ref, entry: "bad.xml" }, bundle)).rejects.toThrow(/入口/);
    expect(writeModels).not.toHaveBeenCalled();
  });

  it("浏览器资源缺失或内容已损坏时给出错误", async () => {
    const ref = await describeModel(bundle);
    vi.mocked(readStoredModel).mockRejectedValueOnce(new Error("缺少模型资源"));
    await expect(getModelBundle(ref.id)).rejects.toThrow(/缺少/);
    vi.mocked(readStoredModel).mockResolvedValue({ ...bundle, files: [...bundle.files, file("extra", "new")] });
    await expect(getModelBundle(ref.id)).rejects.toThrow(/哈希/);
  });
});
