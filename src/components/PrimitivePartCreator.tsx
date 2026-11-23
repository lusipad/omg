import { useRef, useState } from "react";
import { Box, FileUp, PackagePlus } from "lucide-react";
import {
  PRIMITIVE_SHAPE_LABELS,
  type AxisDir,
  type ExtrusionSeries,
  type PrimitiveFinish,
  type PrimitivePartSpec,
} from "@contracts/primitive-parts";
import { buildPrimitivePartPackage, type DevicePackage } from "@contracts/twin-device";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { sha256Hex } from "@/lib/model-files";
import { writeModels } from "@/lib/model-store";

type ShapeKind = PrimitivePartSpec["shape"];

export interface PrimitivePartCreatorProps {
  onCreate: (pkg: DevicePackage) => void;
  onCancel?: () => void;
  submitLabel?: string;
}

const FINISH_OPTIONS: Array<{ value: PrimitiveFinish; label: string }> = [
  { value: "aluminum", label: "铝合金本色" },
  { value: "anodized_black", label: "黑色阳极氧化" },
  { value: "steel", label: "碳钢 / 不锈钢" },
  { value: "brass", label: "铜合金 / 黄铜" },
  { value: "spindle_red", label: "主轴红漆" },
  { value: "workpiece_alloy", label: "切削毛坯绿" },
  { value: "sensor_amber", label: "传感器琥珀色" },
  { value: "rubber_grip", label: "高摩擦橡胶/防滑垫" },
  { value: "aerospace_white", label: "航天白瓷/复合材料" },
  { value: "pearl_crimson", label: "明珠璀璨洋红" },
];

const DEFAULT_NAMES: Record<ShapeKind, string> = {
  box: "实体安装块",
  cylinder: "光轴定位销",
  sphere: "明珠太空球舱",
  cone: "整流罩 / 火箭喷管",
  tube: "空心支撑套筒",
  plate: "带孔滑台板",
  angle_bracket: "L型加强角件",
  extrusion_profile: "铝型材梁柱",
  linear_rail_block: "线性导轨滑块副",
  lead_screw: "滚珠丝杠",
  servo_motor_body: "伺服电机壳体",
  spindle_cutter: "电主轴与铣刀",
  bearing_pillow: "丝杠轴承支座",
  external_mesh: "外部三维零件",
};

const AXIS_VEC: Record<AxisDir, [number, number, number]> = {
  x: [1, 0, 0],
  y: [0, 1, 0],
  z: [0, 0, 1],
};

function parsePos(raw: string, label: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${label}必须填写大于 0 的毫米数值。`);
  return n;
}

export default function PrimitivePartCreator({
  onCreate,
  onCancel,
  submitLabel = "创建参数化基本件",
}: PrimitivePartCreatorProps) {
  const fileRef = useRef<HTMLInputElement>(null);

  const [shape, setShape] = useState<ShapeKind>("extrusion_profile");
  const [manufacturer, setManufacturer] = useState("标准基本件库");
  const [model, setModel] = useState(DEFAULT_NAMES.extrusion_profile);
  const [revision, setRevision] = useState("P1");
  const [finish, setFinish] = useState<PrimitiveFinish>("anodized_black");
  const [axis, setAxis] = useState<AxisDir>("x");

  // Dimension states (mm)
  const [dimA, setDimA] = useState("300"); // width / length / railLength / bodyDiameter / flange
  const [dimB, setDimB] = useState("80");  // depth / radius / outerRadius / bodyLength / railWidth / legA
  const [dimC, setDimC] = useState("40");  // height / thickness / innerRadius / legB / blockLength
  const [dimD, setDimD] = useState("42");  // blockWidth / shaftLength / leadMm / toolStickout / boreDiameter
  const [dimE, setDimE] = useState("20");  // railHeight / shaftDiameter / toolDiameter / bracketThickness
  const [series, setSeries] = useState<ExtrusionSeries>("2040");

  // Joint settings
  const [jointType, setJointType] = useState<"fixed" | "slide" | "hinge">("fixed");
  const [jointAxis, setJointAxis] = useState<AxisDir>("x");
  const [rangeMin, setRangeMin] = useState("-100");
  const [rangeMax, setRangeMax] = useState("100");

  // Optional Modelica behavior coupling
  const [bindBehavior, setBindBehavior] = useState(false);
  const [massKgText, setMassKgText] = useState("6.5");

  // External mesh upload state
  const [extModelId, setExtModelId] = useState("");
  const [extMeshPath, setExtMeshPath] = useState("");
  const [extUnitScale, setExtUnitScale] = useState("1");

  const [error, setError] = useState("");

  function switchShape(next: ShapeKind) {
    setShape(next);
    setError("");
    setModel(DEFAULT_NAMES[next]);
    if (next === "box") {
      setDimA("120"); setDimB("90"); setDimC("26"); setFinish("aluminum");
    } else if (next === "cylinder") {
      setDimA("220"); setDimB("12"); setFinish("steel");
    } else if (next === "tube") {
      setDimA("180"); setDimB("20"); setDimC("14"); setFinish("steel");
    } else if (next === "plate") {
      setDimA("240"); setDimB("160"); setDimC("14"); setFinish("aluminum");
    } else if (next === "angle_bracket") {
      setDimA("28"); setDimB("75"); setDimC("95"); setDimE("10"); setFinish("steel");
    } else if (next === "extrusion_profile") {
      setSeries("2040"); setDimA("360"); setFinish("anodized_black");
    } else if (next === "linear_rail_block") {
      setDimA("320"); setDimB("15"); setDimC("60"); setDimD("42"); setDimE("20"); setFinish("steel");
    } else if (next === "lead_screw") {
      setDimA("320"); setDimB("12"); setDimD("8"); setFinish("steel");
    } else if (next === "servo_motor_body") {
      setDimA("57"); setDimB("60"); setDimE("8"); setDimD("20"); setFinish("anodized_black");
    } else if (next === "spindle_cutter") {
      setDimA("62"); setDimB("135"); setDimE("10"); setDimD("38"); setFinish("spindle_red");
    } else if (next === "bearing_pillow") {
      setDimA("24"); setDimB("44"); setDimC("36"); setDimD("12"); setFinish("steel");
    } else if (next === "sphere") {
      setDimA("42"); setFinish("pearl_crimson");
    } else if (next === "cone") {
      setDimA("90"); setDimB("32"); setDimC("4"); setFinish("aerospace_white");
    } else {
      setDimA("100"); setDimB("80"); setDimC("60"); setFinish("aluminum");
    }
  }

  async function handleExternalMeshFile(file: File) {
    setError("");
    if (!/\.(?:stl|obj|glb|gltf)$/i.test(file.name)) {
      setError("请选择 .stl、.obj、.glb 或 .gltf 三维零件网格文件。");
      return;
    }
    try {
      const data = new Uint8Array(await file.arrayBuffer());
      const id = await sha256Hex(data);
      await writeModels([
        {
          ref: { id, name: file.name, entry: file.name },
          bundle: { entry: file.name, files: [{ path: file.name, data }] },
        },
      ]);
      setExtModelId(id);
      setExtMeshPath(file.name);
      if (model === DEFAULT_NAMES.external_mesh || !model.trim()) {
        setModel(file.name.replace(/\.[^.]+$/, ""));
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "读取外部网格失败。");
    }
  }

  function submit() {
    setError("");
    try {
      if (!model.trim() || !manufacturer.trim() || !revision.trim()) {
        throw new Error("请填写基本件的型号名称、来源系列和修订号。");
      }

      let spec: PrimitivePartSpec;
      switch (shape) {
        case "box":
          spec = { shape, widthMm: parsePos(dimA, "宽度 X"), depthMm: parsePos(dimB, "深度 Y"), heightMm: parsePos(dimC, "高度 Z"), finish };
          break;
        case "cylinder":
          spec = { shape, lengthMm: parsePos(dimA, "长度"), radiusMm: parsePos(dimB, "半径"), axis, finish };
          break;
        case "tube":
          spec = {
            shape,
            lengthMm: parsePos(dimA, "长度"),
            outerRadiusMm: parsePos(dimB, "外半径"),
            innerRadiusMm: parsePos(dimC, "内半径"),
            axis,
            finish,
          };
          break;
        case "plate":
          spec = { shape, widthMm: parsePos(dimA, "宽 X"), depthMm: parsePos(dimB, "深 Y"), thicknessMm: parsePos(dimC, "厚 Z"), finish };
          break;
        case "angle_bracket":
          spec = {
            shape,
            widthMm: parsePos(dimA, "角件宽度"),
            legAMm: parsePos(dimB, "底边长 A"),
            legBMm: parsePos(dimC, "竖边高 B"),
            thicknessMm: parsePos(dimE, "板厚"),
            finish,
          };
          break;
        case "extrusion_profile":
          spec = { shape, series, lengthMm: parsePos(dimA, "型材长度"), axis, finish };
          break;
        case "linear_rail_block":
          spec = {
            shape,
            railLengthMm: parsePos(dimA, "导轨全长"),
            railWidthMm: parsePos(dimB, "导轨宽"),
            blockLengthMm: parsePos(dimC, "滑块长"),
            blockWidthMm: parsePos(dimD, "滑块宽"),
            heightMm: parsePos(dimE, "组合高度"),
            axis,
            finish,
          };
          break;
        case "lead_screw":
          spec = {
            shape,
            lengthMm: parsePos(dimA, "丝杠长度"),
            diameterMm: parsePos(dimB, "公称直径"),
            leadMm: parsePos(dimD, "导程 mm/rev"),
            axis,
            finish,
          };
          break;
        case "servo_motor_body":
          spec = {
            shape,
            flangeMm: parsePos(dimA, "法兰方边长"),
            bodyLengthMm: parsePos(dimB, "机身长度"),
            shaftDiameterMm: parsePos(dimE, "出轴直径"),
            shaftLengthMm: parsePos(dimD, "出轴伸出长"),
            axis,
            finish,
          };
          break;
        case "spindle_cutter":
          spec = {
            shape,
            bodyDiameterMm: parsePos(dimA, "主轴外径"),
            bodyLengthMm: parsePos(dimB, "主轴筒长"),
            toolDiameterMm: parsePos(dimE, "刀具直径"),
            toolStickoutMm: parsePos(dimD, "悬伸刀长"),
            finish,
          };
          break;
        case "bearing_pillow":
          spec = {
            shape,
            widthMm: parsePos(dimA, "厚度"),
            depthMm: parsePos(dimB, "深度"),
            heightMm: parsePos(dimC, "高度"),
            boreDiameterMm: parsePos(dimD, "轴承孔径"),
            axis,
            finish,
          };
          break;
        case "sphere":
          spec = { shape, radiusMm: parsePos(dimA, "球体半径"), finish };
          break;
        case "cone": {
          const rTop = Number(dimC);
          if (!Number.isFinite(rTop) || rTop < 0) throw new Error("顶半径必须填写大于等于 0 的数值。");
          spec = {
            shape,
            lengthMm: parsePos(dimA, "椎体高度"),
            radiusBottomMm: parsePos(dimB, "底面半径"),
            radiusTopMm: rTop,
            axis,
            finish,
          };
          break;
        }
        case "external_mesh":
          if (!extModelId || !extMeshPath) {
            throw new Error("请先上传 .stl / .obj / .glb 三维网格文件。");
          }
          spec = {
            shape,
            modelId: extModelId,
            meshPath: extMeshPath,
            unitScaleMm: parsePos(extUnitScale, "网格单位倍率"),
            approxBoundsMm: [parsePos(dimA, "包络宽 X"), parsePos(dimB, "包络深 Y"), parsePos(dimC, "包络高 Z")],
            finish,
          };
          break;
      }

      let joint: Parameters<typeof buildPrimitivePartPackage>[0]["joint"] = { type: "fixed" };
      if (jointType !== "fixed") {
        const min = Number(rangeMin);
        const max = Number(rangeMax);
        if (!Number.isFinite(min) || !Number.isFinite(max) || min >= max) {
          throw new Error("关节下限必须小于上限，且均为有限数值。");
        }
        joint =
          jointType === "slide"
            ? { type: "slide", unit: "mm", axis: AXIS_VEC[jointAxis], range: [min, max] }
            : { type: "hinge", unit: "deg", axis: AXIS_VEC[jointAxis], range: [min, max] };
      }

      let behavior: Parameters<typeof buildPrimitivePartPackage>[0]["behavior"];
      if (bindBehavior) {
        if (spec.shape === "lead_screw") behavior = { kind: "lead_screw", leadMmPerRev: spec.leadMm };
        else if (spec.shape === "servo_motor_body") {
          behavior = { kind: "servo_motor", ratedPowerW: 400, ratedTorqueNm: 1.27, ratedSpeedRpm: 3000, rotorInertiaKgM2: 0.000026 };
        } else {
          behavior = { kind: "moving_table", massKg: parsePos(massKgText, "移动质量") };
        }
      }

      const pkg = buildPrimitivePartPackage({
        manufacturer,
        model,
        revision,
        primitive: spec,
        joint,
        behavior,
      });
      onCreate(pkg);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "创建参数化基本件失败。");
    }
  }

  const geometryEntries = Object.entries(PRIMITIVE_SHAPE_LABELS).filter(([, m]) => m.group === "geometry");
  const industrialEntries = Object.entries(PRIMITIVE_SHAPE_LABELS).filter(([, m]) => m.group === "industrial");
  const meshEntries = Object.entries(PRIMITIVE_SHAPE_LABELS).filter(([, m]) => m.group === "mesh");

  return (
    <section aria-label="创建参数化三维基本件" className="min-w-0 space-y-3 text-xs">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="sm:col-span-2">
          <span className="field-label">基本件类别与几何基元</span>
          <select
            aria-label="基本件类别"
            className="h-9 w-full rounded-md border bg-background px-2 text-xs"
            value={shape}
            onChange={(e) => switchShape(e.target.value as ShapeKind)}
          >
            <optgroup label="一、基础几何积木">
              {geometryEntries.map(([id, meta]) => (
                <option key={id} value={id}>{meta.label} — {meta.hint}</option>
              ))}
            </optgroup>
            <optgroup label="二、工业标准机械基元">
              {industrialEntries.map(([id, meta]) => (
                <option key={id} value={id}>{meta.label} — {meta.hint}</option>
              ))}
            </optgroup>
            <optgroup label="三、导入外部网格文件">
              {meshEntries.map(([id, meta]) => (
                <option key={id} value={id}>{meta.label} — {meta.hint}</option>
              ))}
            </optgroup>
          </select>
        </label>

        <label>
          <span className="field-label">基本件型号名称</span>
          <Input value={model} onChange={(e) => setModel(e.target.value)} />
        </label>
        <div className="grid grid-cols-3 gap-2">
          <label>
            <span className="field-label">系列 / 制造方</span>
            <Input value={manufacturer} onChange={(e) => setManufacturer(e.target.value)} />
          </label>
          <label>
            <span className="field-label">修订号</span>
            <Input value={revision} onChange={(e) => setRevision(e.target.value)} />
          </label>
          <label>
            <span className="field-label">表面材质</span>
            <select
              aria-label="表面材质"
              className="h-9 w-full rounded-md border bg-background px-2 text-xs"
              value={finish}
              onChange={(e) => setFinish(e.target.value as PrimitiveFinish)}
            >
              {FINISH_OPTIONS.map((f) => (
                <option key={f.value} value={f.value}>{f.label}</option>
              ))}
            </select>
          </label>
        </div>
      </div>

      {/* Dynamic Dimension Controls */}
      <div className="grid gap-2 rounded-md border bg-background/50 p-3 sm:grid-cols-4">
        {shape === "extrusion_profile" && (
          <label>
            <span className="field-label">型材截面规格</span>
            <select
              className="h-8 w-full rounded border bg-background px-2 text-xs"
              value={series}
              onChange={(e) => setSeries(e.target.value as ExtrusionSeries)}
            >
              {(["2020", "2040", "2080", "4040", "4080"] as const).map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </label>
        )}

        {(shape === "cylinder" || shape === "tube" || shape === "cone" || shape === "extrusion_profile" || shape === "linear_rail_block" || shape === "lead_screw" || shape === "servo_motor_body" || shape === "bearing_pillow") && (
          <label>
            <span className="field-label">延伸主轴向</span>
            <select
              className="h-8 w-full rounded border bg-background px-2 text-xs"
              value={axis}
              onChange={(e) => setAxis(e.target.value as AxisDir)}
            >
              <option value="x">X 轴方向</option>
              <option value="y">Y 轴方向</option>
              <option value="z">Z 轴垂直</option>
            </select>
          </label>
        )}

        {shape === "external_mesh" && (
          <div className="sm:col-span-4 space-y-2 border-b pb-2">
            <input
              ref={fileRef}
              type="file"
              accept=".stl,.obj,.glb,.gltf"
              className="sr-only"
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (file) void handleExternalMeshFile(file);
              }}
            />
            <div className="flex flex-wrap items-center gap-2">
              <Button type="button" size="sm" variant="outline" onClick={() => fileRef.current?.click()}>
                <FileUp />
                选择 .STL / .OBJ / .GLB 文件
              </Button>
              {extMeshPath && <span className="text-primary">已加载：{extMeshPath}</span>}
              <label className="ml-auto flex items-center gap-1.5">
                <span>源文件单位转毫米倍率</span>
                <Input className="h-7 w-20 text-xs" value={extUnitScale} onChange={(e) => setExtUnitScale(e.target.value)} />
              </label>
            </div>
          </div>
        )}

        <label>
          <span className="field-label">
            {shape === "box" || shape === "plate" || shape === "external_mesh" ? "宽 X (mm)"
              : shape === "sphere" ? "球半径 R (mm)"
              : shape === "angle_bracket" ? "角件宽 X (mm)"
              : shape === "linear_rail_block" ? "导轨总长 (mm)"
              : shape === "servo_motor_body" ? "法兰方宽 (mm)"
              : shape === "spindle_cutter" ? "主轴直径 (mm)"
              : shape === "bearing_pillow" ? "座体厚度 (mm)"
              : "长度 (mm)"}
          </span>
          <Input className="h-8 text-xs" value={dimA} onChange={(e) => setDimA(e.target.value)} />
        </label>

        {shape !== "extrusion_profile" && shape !== "sphere" && (
          <label>
            <span className="field-label">
              {shape === "box" || shape === "plate" || shape === "bearing_pillow" || shape === "external_mesh" ? "深 Y (mm)"
                : shape === "cylinder" ? "半径 (mm)"
                : shape === "cone" ? "底半径 (mm)"
                : shape === "tube" ? "外半径 (mm)"
                : shape === "angle_bracket" ? "底腿长 A (mm)"
                : shape === "linear_rail_block" ? "导轨宽 (mm)"
                : shape === "lead_screw" ? "公称直径 (mm)"
                : shape === "servo_motor_body" ? "机身长度 (mm)"
                : "主轴长度 (mm)"}
            </span>
            <Input className="h-8 text-xs" value={dimB} onChange={(e) => setDimB(e.target.value)} />
          </label>
        )}

        {(shape === "box" || shape === "tube" || shape === "cone" || shape === "plate" || shape === "angle_bracket" || shape === "linear_rail_block" || shape === "bearing_pillow" || shape === "external_mesh") && (
          <label>
            <span className="field-label">
              {shape === "box" || shape === "bearing_pillow" || shape === "external_mesh" ? "高 Z (mm)"
                : shape === "cone" ? "顶半径 (mm)"
                : shape === "plate" ? "厚度 Z (mm)"
                : shape === "tube" ? "内半径 (mm)"
                : shape === "angle_bracket" ? "立腿高 B (mm)"
                : "滑块长 (mm)"}
            </span>
            <Input className="h-8 text-xs" value={dimC} onChange={(e) => setDimC(e.target.value)} />
          </label>
        )}

        {(shape === "linear_rail_block" || shape === "lead_screw" || shape === "servo_motor_body" || shape === "spindle_cutter" || shape === "bearing_pillow") && (
          <label>
            <span className="field-label">
              {shape === "lead_screw" ? "导程 (mm/rev)"
                : shape === "servo_motor_body" ? "出轴长 (mm)"
                : shape === "spindle_cutter" ? "刀具伸出 (mm)"
                : shape === "bearing_pillow" ? "内孔径 (mm)"
                : "滑块宽 (mm)"}
            </span>
            <Input className="h-8 text-xs" value={dimD} onChange={(e) => setDimD(e.target.value)} />
          </label>
        )}

        {(shape === "angle_bracket" || shape === "linear_rail_block" || shape === "servo_motor_body" || shape === "spindle_cutter") && (
          <label>
            <span className="field-label">
              {shape === "angle_bracket" ? "壁厚 (mm)"
                : shape === "servo_motor_body" ? "轴径 (mm)"
                : shape === "spindle_cutter" ? "刀径 (mm)"
                : "组合总高 (mm)"}
            </span>
            <Input className="h-8 text-xs" value={dimE} onChange={(e) => setDimE(e.target.value)} />
          </label>
        )}
      </div>

      {/* Motion Joint Capability */}
      <div className="grid gap-2 rounded-md border bg-background/50 p-3 sm:grid-cols-4">
        <label>
          <span className="field-label">可动关节副类型</span>
          <select
            aria-label="可动关节副类型"
            className="h-8 w-full rounded border bg-background px-2 text-xs"
            value={jointType}
            onChange={(e) => setJointType(e.target.value as "fixed" | "slide" | "hinge")}
          >
            <option value="fixed">fixed（刚性固连）</option>
            <option value="slide">slide（直线滑动副 · mm）</option>
            <option value="hinge">hinge（旋转回转副 · °）</option>
          </select>
        </label>
        {jointType !== "fixed" && (
          <>
            <label>
              <span className="field-label">运动方向轴</span>
              <select
                className="h-8 w-full rounded border bg-background px-2 text-xs"
                value={jointAxis}
                onChange={(e) => setJointAxis(e.target.value as AxisDir)}
              >
                <option value="x">X 轴</option>
                <option value="y">Y 轴</option>
                <option value="z">Z 轴</option>
              </select>
            </label>
            <label>
              <span className="field-label">下限 ({jointType === "slide" ? "mm" : "°"})</span>
              <Input className="h-8 text-xs" value={rangeMin} onChange={(e) => setRangeMin(e.target.value)} />
            </label>
            <label>
              <span className="field-label">上限 ({jointType === "slide" ? "mm" : "°"})</span>
              <Input className="h-8 text-xs" value={rangeMax} onChange={(e) => setRangeMax(e.target.value)} />
            </label>
          </>
        )}
      </div>

      {/* Optional Modelica Behavior Binding */}
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2">
        <label className="inline-flex cursor-pointer items-center gap-2">
          <input
            type="checkbox"
            checked={bindBehavior}
            onChange={(e) => setBindBehavior(e.target.checked)}
          />
          <span>同时绑定 Modelica 动力学模型（供机电控闭环仿真复用）</span>
        </label>
        {bindBehavior && shape !== "lead_screw" && shape !== "servo_motor_body" && (
          <label className="flex items-center gap-1.5">
            <span>移动质量 (kg)</span>
            <Input className="h-7 w-20 text-xs" value={massKgText} onChange={(e) => setMassKgText(e.target.value)} />
          </label>
        )}
      </div>

      <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <Box className="size-3.5 text-primary" />
        自动生成标准化机械安装点（top / bottom / pos_x / neg_x / pos_y / neg_y / center），可直接与其他基本件拼装、联动和做爆炸视图。
      </p>

      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}

      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" onClick={submit}>
          <PackagePlus />
          {submitLabel}
        </Button>
        {onCancel && (
          <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
            取消
          </Button>
        )}
      </div>
    </section>
  );
}
