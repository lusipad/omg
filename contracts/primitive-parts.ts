import { z } from "zod";
import type { MechanicalFrame, MechanicalPart } from "./mechanical-types";

export const primitiveFinishSchema = z.enum([
  "aluminum",
  "anodized_black",
  "steel",
  "brass",
  "spindle_red",
  "workpiece_alloy",
  "sensor_amber",
  "rubber_grip",
  "aerospace_white",
  "pearl_crimson",
  "concrete_gray",
  "curtain_glass",
]);
export type PrimitiveFinish = z.infer<typeof primitiveFinishSchema>;

export const axisDirSchema = z.enum(["x", "y", "z"]);
export type AxisDir = z.infer<typeof axisDirSchema>;

export const extrusionSeriesSchema = z.enum(["2020", "2040", "2080", "4040", "4080"]);
export type ExtrusionSeries = z.infer<typeof extrusionSeriesSchema>;

const pos = z.number("请填写正数尺寸").finite().positive("尺寸必须大于 0").max(20_000, "尺寸超出单件限制");
const finishField = { finish: primitiveFinishSchema.optional() };

export const primitivePartSchema = z.discriminatedUnion("shape", [
  z.strictObject({
    shape: z.literal("box"),
    widthMm: pos,
    depthMm: pos,
    heightMm: pos,
    ...finishField,
  }),
  z.strictObject({
    shape: z.literal("cylinder"),
    radiusMm: pos,
    lengthMm: pos,
    axis: axisDirSchema,
    ...finishField,
  }),
  z.strictObject({
    shape: z.literal("tube"),
    outerRadiusMm: pos,
    innerRadiusMm: pos,
    lengthMm: pos,
    axis: axisDirSchema,
    ...finishField,
  }).refine((v) => v.innerRadiusMm < v.outerRadiusMm, "管件内半径须小于外半径"),
  z.strictObject({
    shape: z.literal("plate"),
    widthMm: pos,
    depthMm: pos,
    thicknessMm: pos,
    cornerRadiusMm: z.number().finite().nonnegative().max(500).optional(),
    holeDiameterMm: pos.optional(),
    holeInsetMm: pos.optional(),
    ...finishField,
  }),
  z.strictObject({
    shape: z.literal("angle_bracket"),
    widthMm: pos,
    legAMm: pos,
    legBMm: pos,
    thicknessMm: pos,
    ...finishField,
  }),
  z.strictObject({
    shape: z.literal("extrusion_profile"),
    series: extrusionSeriesSchema,
    lengthMm: pos,
    axis: axisDirSchema,
    ...finishField,
  }),
  z.strictObject({
    shape: z.literal("linear_rail_block"),
    railLengthMm: pos,
    railWidthMm: pos,
    blockLengthMm: pos,
    blockWidthMm: pos,
    heightMm: pos,
    axis: axisDirSchema,
    ...finishField,
  }),
  z.strictObject({
    shape: z.literal("lead_screw"),
    diameterMm: pos,
    lengthMm: pos,
    leadMm: pos,
    axis: axisDirSchema,
    ...finishField,
  }),
  z.strictObject({
    shape: z.literal("servo_motor_body"),
    flangeMm: pos,
    bodyLengthMm: pos,
    shaftDiameterMm: pos,
    shaftLengthMm: pos,
    axis: axisDirSchema,
    ...finishField,
  }),
  z.strictObject({
    shape: z.literal("spindle_cutter"),
    bodyDiameterMm: pos,
    bodyLengthMm: pos,
    toolDiameterMm: pos,
    toolStickoutMm: pos,
    ...finishField,
  }),
  z.strictObject({
    shape: z.literal("bearing_pillow"),
    widthMm: pos,
    depthMm: pos,
    heightMm: pos,
    boreDiameterMm: pos,
    axis: axisDirSchema,
    ...finishField,
  }),
  z.strictObject({
    shape: z.literal("sphere"),
    radiusMm: pos,
    ...finishField,
  }),
  z.strictObject({
    shape: z.literal("cone"),
    radiusBottomMm: pos,
    radiusTopMm: z.number("请填写非负顶面半径").finite().nonnegative().max(20_000, "尺寸超出单件限制"),
    lengthMm: pos,
    axis: axisDirSchema,
    ...finishField,
  }),
  z.strictObject({
    shape: z.literal("external_mesh"),
    modelId: z.string().regex(/^[a-f0-9]{64}$/, "外部网格需要模型包 SHA-256"),
    meshPath: z.string().trim().min(1).max(512),
    unitScaleMm: pos,
    approxBoundsMm: z.tuple([pos, pos, pos]),
    ...finishField,
  }),
]);

export type PrimitivePartSpec = z.infer<typeof primitivePartSchema>;

export const EXTRUSION_SERIES_SECTION_MM: Record<ExtrusionSeries, readonly [number, number]> = {
  "2020": [20, 20],
  "2040": [20, 40],
  "2080": [80, 20],
  "4040": [40, 40],
  "4080": [80, 40],
};

export const PRIMITIVE_SHAPE_LABELS: Record<
  PrimitivePartSpec["shape"],
  { readonly group: "geometry" | "industrial" | "mesh"; readonly label: string; readonly hint: string }
> = {
  box: { group: "geometry", label: "长方体 / 实体块", hint: "机架块、垫块、工件毛坯、安装基座" },
  cylinder: { group: "geometry", label: "实心圆柱 / 销轴", hint: "光轴、立柱、定位销、联轴器、火箭贮箱" },
  sphere: { group: "geometry", label: "高精度球体 / 观景舱", hint: "东方明珠观光球体、直升机球形风挡、卫星胶囊" },
  cone: { group: "geometry", label: "圆锥 / 圆台 / 喷管", hint: "火箭整流罩头锥、扩张引擎喷管、明珠发射塔尖" },
  tube: { group: "geometry", label: "空心管 / 套筒", hint: "导套、隔离套管、核心井筒、支撑立管" },
  plate: { group: "geometry", label: "带安装孔平板", hint: "底座端板、Y 轴鞍座板、X 轴 T 型槽工作台、Z 轴滑板" },
  angle_bracket: { group: "geometry", label: "L 型角件 / 加强筋板", hint: "立柱加固三角板、直角安装托架" },
  extrusion_profile: { group: "industrial", label: "工业铝型材 (2020~4080)", hint: "机架纵梁、横梁、龙门立柱（带开槽截面）" },
  linear_rail_block: { group: "industrial", label: "直线导轨与滑块副", hint: "线性导轨（可设导轨滑块自带移动副或与滑台配对）" },
  lead_screw: { group: "industrial", label: "滚珠丝杠 / 梯形丝杠", hint: "带螺旋纹路，支持随滑台位移耦合自转 (coupledTo)" },
  servo_motor_body: { group: "industrial", label: "伺服 / 步进电机壳体", hint: "标准方形法兰机壳与出轴（支持绑定额定转矩/惯量模型）" },
  spindle_cutter: { group: "industrial", label: "电主轴与立铣刀", hint: "带主轴夹头与螺旋立铣刀，内置底面 tool_tip 观察点" },
  bearing_pillow: { group: "industrial", label: "带孔轴承座 / 端盖支座", hint: "BK/BF 丝杠支撑座、光轴两端支承" },
  external_mesh: { group: "mesh", label: "外部三维网格 (.STL / .OBJ / .GLB)", hint: "绑定模型库已导入网格与标准化安装接口" },
};

function alignAlongAxis(axis: AxisDir, length: number, crossU: number, crossV: number): [number, number, number] {
  if (axis === "x") return [length, crossU, crossV];
  if (axis === "y") return [crossU, length, crossV];
  return [crossU, crossV, length];
}

export function primitiveBoundingBoxMm(spec: PrimitivePartSpec): [number, number, number] {
  switch (spec.shape) {
    case "box":
      return [spec.widthMm, spec.depthMm, spec.heightMm];
    case "cylinder":
      return alignAlongAxis(spec.axis, spec.lengthMm, spec.radiusMm * 2, spec.radiusMm * 2);
    case "tube":
      return alignAlongAxis(spec.axis, spec.lengthMm, spec.outerRadiusMm * 2, spec.outerRadiusMm * 2);
    case "plate":
      return [spec.widthMm, spec.depthMm, spec.thicknessMm];
    case "angle_bracket":
      return [spec.widthMm, spec.legAMm, spec.legBMm];
    case "extrusion_profile": {
      const [w, h] = EXTRUSION_SERIES_SECTION_MM[spec.series];
      return alignAlongAxis(spec.axis, spec.lengthMm, w, h);
    }
    case "linear_rail_block": {
      const crossW = Math.max(spec.railWidthMm, spec.blockWidthMm);
      return spec.axis === "z"
        ? [crossW, spec.heightMm, spec.railLengthMm]
        : spec.axis === "y"
          ? [crossW, spec.railLengthMm, spec.heightMm]
          : [spec.railLengthMm, crossW, spec.heightMm];
    }
    case "lead_screw":
      return alignAlongAxis(spec.axis, spec.lengthMm, spec.diameterMm * 1.4, spec.diameterMm * 1.4);
    case "servo_motor_body":
      return alignAlongAxis(spec.axis, spec.bodyLengthMm + spec.shaftLengthMm, spec.flangeMm, spec.flangeMm);
    case "spindle_cutter":
      return [spec.bodyDiameterMm, spec.bodyDiameterMm, spec.bodyLengthMm + spec.toolStickoutMm];
    case "bearing_pillow":
      return [spec.widthMm, spec.depthMm, spec.heightMm];
    case "sphere": {
      const d = spec.radiusMm * 2;
      return [d, d, d];
    }
    case "cone": {
      const maxD = Math.max(spec.radiusBottomMm, spec.radiusTopMm) * 2;
      return alignAlongAxis(spec.axis, spec.lengthMm, maxD, maxD);
    }
    case "external_mesh":
      return [...spec.approxBoundsMm];
  }
}

const IDENTITY_QUAT: [number, number, number, number] = [1, 0, 0, 0];

function semanticMountsForShape(spec: PrimitivePartSpec, bounds: [number, number, number]): MechanicalPart["outputs"] {
  const [dx, dy, dz] = bounds;
  const standard: MechanicalPart["outputs"] = [
    { id: "center", positionMm: [0, 0, 0], quatWxyz: IDENTITY_QUAT },
    { id: "top", positionMm: [0, 0, dz / 2], quatWxyz: IDENTITY_QUAT },
    { id: "bottom", positionMm: [0, 0, -dz / 2], quatWxyz: IDENTITY_QUAT },
    { id: "pos_x", positionMm: [dx / 2, 0, 0], quatWxyz: IDENTITY_QUAT },
    { id: "neg_x", positionMm: [-dx / 2, 0, 0], quatWxyz: IDENTITY_QUAT },
    { id: "pos_y", positionMm: [0, dy / 2, 0], quatWxyz: IDENTITY_QUAT },
    { id: "neg_y", positionMm: [0, -dy / 2, 0], quatWxyz: IDENTITY_QUAT },
    { id: "pos_z", positionMm: [0, 0, dz / 2], quatWxyz: IDENTITY_QUAT },
    { id: "neg_z", positionMm: [0, 0, -dz / 2], quatWxyz: IDENTITY_QUAT },
  ];

  const extra: MechanicalPart["outputs"] = [];
  if (spec.shape === "linear_rail_block") {
    extra.push({
      id: "carriage_top",
      positionMm: spec.axis === "z" ? [0, spec.heightMm / 2, 0] : [0, 0, spec.heightMm / 2],
      quatWxyz: IDENTITY_QUAT,
    });
  } else if (spec.shape === "servo_motor_body") {
    const tipDist = spec.bodyLengthMm / 2 + spec.shaftLengthMm;
    const tipPos: [number, number, number] =
      spec.axis === "x" ? [tipDist, 0, 0] : spec.axis === "y" ? [0, tipDist, 0] : [0, 0, tipDist];
    extra.push({ id: "shaft_tip", positionMm: tipPos, quatWxyz: IDENTITY_QUAT });
  } else if (spec.shape === "lead_screw") {
    const half = spec.lengthMm / 2;
    const farPos: [number, number, number] =
      spec.axis === "x" ? [half, 0, 0] : spec.axis === "y" ? [0, half, 0] : [0, 0, half];
    extra.push(
      { id: "nut_mount", positionMm: [0, 0, 0], quatWxyz: IDENTITY_QUAT },
      { id: "far_end", positionMm: farPos, quatWxyz: IDENTITY_QUAT },
    );
  } else if (spec.shape === "spindle_cutter") {
    const toolTipZ = -spec.bodyLengthMm / 2 - spec.toolStickoutMm;
    extra.push({ id: "tool_tip", positionMm: [0, 0, toolTipZ], quatWxyz: IDENTITY_QUAT });
  } else if (spec.shape === "angle_bracket") {
    extra.push({
      id: "leg_b_face",
      positionMm: [0, -spec.legAMm / 2, spec.legBMm / 2],
      quatWxyz: IDENTITY_QUAT,
    });
  }

  if ((spec.shape === "box" || spec.shape === "plate") && dx >= 60 && dy >= 40) {
    const xFront = Number((dx * 0.34).toFixed(2));
    const xRear = Number((-dx * 0.34).toFixed(2));
    extra.push(
      { id: "pos_y_front", positionMm: [xFront, dy / 2, 0], quatWxyz: IDENTITY_QUAT },
      { id: "pos_y_rear", positionMm: [xRear, dy / 2, 0], quatWxyz: IDENTITY_QUAT },
      { id: "neg_y_front", positionMm: [xFront, -dy / 2, 0], quatWxyz: IDENTITY_QUAT },
      { id: "neg_y_rear", positionMm: [xRear, -dy / 2, 0], quatWxyz: IDENTITY_QUAT },
      { id: "top_front", positionMm: [xFront, 0, dz / 2], quatWxyz: IDENTITY_QUAT },
      { id: "top_rear", positionMm: [xRear, 0, dz / 2], quatWxyz: IDENTITY_QUAT },
    );
  } else if ((spec.shape === "cylinder" || spec.shape === "tube") && spec.axis === "z" && dx >= 32) {
    const zLow = Number((-dz * 0.35).toFixed(2));
    extra.push(
      { id: "rim_px", positionMm: [dx / 2, 0, zLow], quatWxyz: IDENTITY_QUAT },
      { id: "rim_nx", positionMm: [-dx / 2, 0, zLow], quatWxyz: IDENTITY_QUAT },
      { id: "rim_py", positionMm: [0, dy / 2, zLow], quatWxyz: IDENTITY_QUAT },
      { id: "rim_ny", positionMm: [0, -dy / 2, zLow], quatWxyz: IDENTITY_QUAT },
    );
  }

  return [...extra, ...standard];
}

export function defaultPrimitiveMechanics(
  spec: PrimitivePartSpec,
  options?: {
    joint?: MechanicalPart["joint"];
    input?: MechanicalFrame;
    extraOutputs?: MechanicalPart["outputs"];
  },
): MechanicalPart {
  const bounds = primitiveBoundingBoxMm(spec);
  const baseOutputs = semanticMountsForShape(spec, bounds);
  const byId = new Map<string, MechanicalPart["outputs"][number]>();
  for (const out of baseOutputs) byId.set(out.id, out);
  for (const out of options?.extraOutputs ?? []) byId.set(out.id, out);

  return {
    kind: "part",
    input: options?.input ?? { positionMm: [0, 0, 0], quatWxyz: IDENTITY_QUAT },
    joint: options?.joint ?? { type: "fixed" },
    outputs: [...byId.values()].slice(0, 32),
  };
}
