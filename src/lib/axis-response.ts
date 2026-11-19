export const metrics = {
  position: { label: "位置", aria: "轴位置", unit: "mm", color: "#62dfb0", column: "position_mm" },
  velocity: { label: "速度", aria: "轴速度", unit: "mm/s", color: "#80c0f5", column: "velocity_mm_s" },
  angle: { label: "电机转角", aria: "电机转角", unit: "°", color: "#62dfb0", column: "angle_deg" },
  speed: { label: "电机转速", aria: "电机转速", unit: "rpm", color: "#80c0f5", column: "speed_rpm" },
  torque: { label: "电机转矩", aria: "电机转矩", unit: "N·m", color: "#e7bc72", column: "motor_torque_Nm" },
  force: { label: "轴向推力", aria: "轴向推力", unit: "N", color: "#c4a7ec", column: "axial_force_N" },
} as const;
export type Metric = keyof typeof metrics;
export type AxisSample = { timeMs: number; position: number; velocity: number; torque?: number; force?: number; angle?: number; speed?: number };
export const formatAxisValue = (value: number) => String(Number(value.toPrecision(6)));

export function nearestSample(samples: readonly { timeMs: number }[], timeMs: number) {
  let low = 0, high = samples.length - 1;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (samples[mid].timeMs < timeMs) low = mid + 1;
    else high = mid;
  }
  return low > 0 && timeMs - samples[low - 1].timeMs < samples[low].timeMs - timeMs ? low - 1 : low;
}
