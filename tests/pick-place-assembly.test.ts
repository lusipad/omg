import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PICK_PLACE_EXAMPLE, ROBOT_EXAMPLES } from "../contracts/robot-examples";
import { UR5E_WORKPIECE_XML } from "../contracts/ur5e-workcell";
import { describeModel, getModelBundle, readModelFiles } from "../src/lib/model-files";
import { isUr5eWorkcell, loadWorkcellParts } from "../src/lib/pick-place-assembly";

vi.mock("../src/lib/model-files", async original => ({
  ...await original<typeof import("../src/lib/model-files")>(), getModelBundle: vi.fn(),
}));
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe("取放工位组件入口", () => {
  it("默认件和单独安装的三个组件可以组出相同的自包含工位", async () => {
    const publicRoot = new URL("../public/", import.meta.url);
    const request = vi.fn(async (url: string) => {
      const path = new URL(url, "https://example.org/").pathname.slice(1);
      return new Response(new Uint8Array(await readFile(new URL(path, publicRoot))));
    });
    vi.stubGlobal("fetch", request);
    const example = await loadWorkcellParts();
    expect(request).toHaveBeenCalledTimes(3);
    expect(isUr5eWorkcell(example)).toBe(true);

    const parts = await Promise.all(["ur5e", "robotiq-2f85"].map(async id => {
      const data = new Uint8Array(await readFile(new URL(`robots/${id}/model.zip`, publicRoot)));
      const { files } = await readModelFiles([new File([data], `${id}.zip`)]);
      return { entry: ROBOT_EXAMPLES.find(item => item.id === id)!.entry, files };
    }));
    const cube = { entry: "workpiece.xml", files: [{ path: "workpiece.xml", data: new TextEncoder().encode(UR5E_WORKPIECE_XML) }] };
    const components = [...parts, cube];
    const refs = await Promise.all(components.map(describeModel));
    vi.mocked(getModelBundle).mockImplementation(async id => components[refs.findIndex(ref => ref.id === id)]);
    request.mockClear();
    const local = await loadWorkcellParts(refs[0], refs[1], refs[2]);
    expect(request).not.toHaveBeenCalled();
    const expected = await describeModel(example);
    expect(expected.id).toBe(PICK_PLACE_EXAMPLE.modelId);
    expect(await describeModel(local)).toEqual(expected);
  }, 60_000);

  it("所选本地部件缺失时指明槽位并保留用户的选择", async () => {
    const model = { id: "local", entry: "local.xml", name: "本机组件" };
    vi.mocked(getModelBundle).mockRejectedValue(new Error("本机资源缺失"));
    const request = vi.fn();
    vi.stubGlobal("fetch", request);
    await expect(loadWorkcellParts(model, model, model)).rejects.toThrow(/机械臂读取失败.*本机资源缺失/);
    expect(request).not.toHaveBeenCalled();
  });
});
