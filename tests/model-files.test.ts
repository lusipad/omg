import { beforeEach, describe, expect, it, vi } from "vitest";
import { zipSync, type Zippable } from "three/examples/jsm/libs/fflate.module.js";
import { emptyWorkspace } from "../contracts/twin-simulation";
import { MODEL_LIMITS, type ModelBundle } from "../contracts/import-catalog";
import {
  describeModel, exportModelBundle, exportProjectArchive, getModelBundle, inspectModelSources,
  ProjectArchiveFileError, putModelBundle, putProjectModels, readModelFiles, readProjectArchive, readWorkbenchBundle, resolveModelResource,
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

describe("从同一次选择分流模型或工程", () => {
  it("供应商的同名元数据仍是模型附件，每个压缩条目只解一次", async () => {
    const selected = archive({ "workspace.json": bytes('{"schemaVersion":1,"vendor":"零件"}'), "主模型.xml": bytes("<mujoco/>") });
    const read = vi.spyOn(selected, "arrayBuffer"), native = globalThis.DecompressionStream;
    const decompressor = vi.fn(function(format: CompressionFormat) { return new native(format); });
    vi.stubGlobal("DecompressionStream", decompressor);
    try {
      const opened = await readWorkbenchBundle([selected]);
      expect(opened.kind).toBe("model");
      if (opened.kind !== "model") throw new Error("应取得物理模型");
      expect(opened.selection.entries).toEqual(["主模型.xml"]);
      expect(opened.selection.files.map((f) => f.path)).toContain("workspace.json");
      expect(read).toHaveBeenCalledTimes(1);
      expect(decompressor).toHaveBeenCalledTimes(2);
    } finally { vi.unstubAllGlobals(); }
  });

  it("一次读取 ZIP 完成工程资源和哈希核对，保留待确认状态", async () => {
    const ref = await describeModel(bundle);
    const workspace = { ...emptyWorkspace(), catalog: { models: [ref], materials: [] } };
    vi.mocked(readStoredModel).mockResolvedValue(bundle);
    const selected = new File([await exportProjectArchive(workspace)], "机器.mjz");
    const read = vi.spyOn(selected, "arrayBuffer");
    const result = await readWorkbenchBundle([selected]);
    expect(result).toEqual({ kind: "project", workspace, models: [{ ref, bundle }] });
    expect(read).toHaveBeenCalledTimes(1);
    expect(writeModels).not.toHaveBeenCalled();
  });

  it("目录保持子路径，每份普通文件仅读一次，支持解压后的工作台工程", async () => {
    const folder = (path: string, data: Uint8Array) => {
      const f = new File([data.slice()], path.split("/").at(-1)!);
      Object.defineProperty(f, "webkitRelativePath", { value: "所选目录/" + path });
      return f;
    };
    const selected = bundle.files.map((f) => folder(f.path, f.data));
    const reads = selected.map((f) => vi.spyOn(f, "arrayBuffer"));
    expect(await readWorkbenchBundle(selected)).toEqual({ kind: "model", selection: { files: bundle.files, entries: [bundle.entry] } });
    for (const read of reads) expect(read).toHaveBeenCalledTimes(1);
    const workspace = emptyWorkspace(), manifest = folder("workspace.json", bytes(JSON.stringify(workspace)));
    expect(await readWorkbenchBundle([manifest])).toEqual({ kind: "project", workspace, models: [] });
  });

  it("工程目录首个资源读完时取消，后续条目和模型哈希都不会启动", async () => {
    const ref = await describeModel(bundle), stop = new AbortController();
    const manifest = new File([JSON.stringify({ ...emptyWorkspace(), catalog: { models: [ref], materials: [] } })], "workspace.json");
    const inputs = bundle.files.map((f) => {
      const item = new File([f.data.slice()], f.path.split("/").at(-1)!);
      Object.defineProperty(item, "webkitRelativePath", { value: "models/" + ref.id + "/" + f.path });
      return item;
    });
    const native = inputs[0].stream.bind(inputs[0]);
    const first = vi.spyOn(inputs[0], "stream").mockImplementation(() => native().pipeThrough(new TransformStream({
      flush() { stop.abort(); },
    })));
    const later = inputs.slice(1).map((f) => vi.spyOn(f, "stream"));
    const digest = vi.spyOn(crypto.subtle, "digest");
    try {
      await expect(readWorkbenchBundle([manifest, ...inputs], stop.signal)).rejects.toMatchObject({ name: "AbortError" });
      expect(first).toHaveBeenCalledOnce();
      for (const read of later) expect(read).not.toHaveBeenCalled();
      expect(digest).not.toHaveBeenCalled();
    } finally { digest.mockRestore(); }
  });

  it("中止等待输出的 ZIP 解压流，不开启下一个条目", async () => {
    const stop = new AbortController(), cancelReader = vi.fn();
    let started!: () => void;
    const ready = new Promise<void>((done) => { started = done; });
    const decoder = vi.fn(function() {
      return { writable: new WritableStream<Uint8Array>(), readable: new ReadableStream<Uint8Array>({
        start() { started(); }, cancel: cancelReader,
      }) };
    });
    const selected = archive({ "scene.xml": bytes("<mujoco/>"), "attachment.bin": Uint8Array.of(1, 2, 3) });
    vi.stubGlobal("DecompressionStream", decoder);
    try {
      const task = readWorkbenchBundle([selected], stop.signal);
      await ready;
      stop.abort();
      await expect(task).rejects.toMatchObject({ name: "AbortError" });
      expect(cancelReader).toHaveBeenCalledOnce();
      expect(decoder).toHaveBeenCalledOnce();
    } finally { vi.unstubAllGlobals(); }
  });

  it("已判明的工程有坏清单或缺二进制时拒绝恢复", async () => {
    const bad = archive({ "workspace.json": bytes(JSON.stringify({ ...emptyWorkspace(), packages: null })), "scene.xml": bytes("<mujoco/>") });
    await expect(readWorkbenchBundle([bad])).rejects.toThrow(/场景|工程/);
    const incomplete = archive({ "workspace.json": bytes('{"schemaVersion":1,"packages":[],"instances":[]}'), "scene.xml": bytes("<mujoco/>") });
    await expect(readWorkbenchBundle([incomplete])).rejects.toThrow(/场景|工程/);
    const ref = await describeModel(bundle);
    const manifest = bytes(JSON.stringify({ ...emptyWorkspace(), catalog: { models: [ref], materials: [] } }));
    await expect(readWorkbenchBundle([archive({ "workspace.json": manifest })])).rejects.toThrow(/文件数量/);
    expect(writeModels).not.toHaveBeenCalled();
  });

  it("类型确定后才应用单模型上限，工程可包含多个各自合规的模型", async () => {
    const attachments = Array.from({ length: MODEL_LIMITS.maxFiles / 2 }, (_, i) => file("数据/" + i + ".txt", "a"));
    const packages = ["A", "B"].map((name) => ({
      entry: "scene.xml", files: [file("scene.xml", '<mujoco model="' + name + '"/>'), ...attachments],
    }));
    const refs = await Promise.all(packages.map(describeModel));
    const workspace = { ...emptyWorkspace(), catalog: { models: refs, materials: [] } };
    const members: Zippable = { "workspace.json": bytes(JSON.stringify(workspace)) };
    packages.forEach((model, i) => model.files.forEach((f) => { members["models/" + refs[i].id + "/" + f.path] = f.data; }));
    const opened = await readWorkbenchBundle([archive(members)]);
    expect(opened.kind === "project" && opened.models.length).toBe(2);
    members["workspace.json"] = bytes('{"vendor":"普通模型"}');
    await expect(readWorkbenchBundle([archive(members)])).rejects.toThrow(/数量或大小/);
  });
});

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
  it("校验成功后由同一个取消信号控制整批写入", async () => {
    const records = [{ ref: await describeModel(bundle), bundle }], controller = new AbortController();
    await putProjectModels(records, controller.signal);
    expect(writeModels).toHaveBeenCalledWith(records, controller.signal);
  });

  it("预先取消或在 SHA 校验期间取消均不会进入写事务", async () => {
    const record = { ref: await describeModel(bundle), bundle };
    const stopped = new AbortController(); stopped.abort();
    await expect(putProjectModels([record], stopped.signal)).rejects.toMatchObject({ name: "AbortError" });
    const controller = new AbortController(), digest = crypto.subtle.digest.bind(crypto.subtle);
    const spy = vi.spyOn(crypto.subtle, "digest").mockImplementationOnce(async (...args) => {
      const result = await digest(...args); controller.abort(); return result;
    });
    try {
      await expect(putModelBundle(record.ref, bundle, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
      expect(writeModels).not.toHaveBeenCalled();
    } finally { spy.mockRestore(); }
  });

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
