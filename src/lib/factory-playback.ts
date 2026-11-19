import type { FactoryOperation, FactoryRunResult } from "./factory-runtime";

export type PlantPoint = [number, number];
export type EquipmentPhase = "idle" | "reserved" | "processing" | "empty" | "pickup" | "carrying" | "drop";
export type PartPhase = "pending" | "waiting" | "pickup" | "carrying" | "drop" | "processing" | "completed";
export interface EquipmentPose {
  id: string;
  phase: EquipmentPhase;
  point: PlantPoint;
  heading: number;
  operation?: FactoryOperation;
}
export interface PartPose {
  id: string;
  lineId: string;
  serial: number;
  phase: PartPhase;
  point?: PlantPoint;
  operation?: FactoryOperation;
}
export const equipmentPhases: Record<EquipmentPhase, string> = {
  idle: "空闲",
  reserved: "预占等料",
  processing: "作业中",
  empty: "空驶去取件",
  pickup: "取件",
  carrying: "载货运输",
  drop: "交付工件",
};
export const partPhases: Record<PartPhase, string> = {
  pending: "待投料",
  waiting: "等待",
  pickup: "取件",
  carrying: "运输中",
  drop: "交接中",
  processing: "作业中",
  completed: "已完工",
};

export function indexFactoryRun(result: FactoryRunResult) {
  const byJob = new Map(result.jobs.map(job => [job.id, [] as FactoryOperation[]]));
  const byResource = new Map(result.resources.map(resource => [resource.id, [] as FactoryOperation[]]));
  const positions = new Map(result.resources.map(resource => [resource.id, resource.positionM]));
  const events = new Set([0, result.makespanS]);
  for (const op of result.operations) {
    byJob.get(op.jobId)!.push(op);
    byResource.get(op.stationId)!.push(op);
    if (op.carrierId) byResource.get(op.carrierId)!.push(op);
    for (const time of [op.readyS, op.dispatchS, op.pickupStartS, op.loadedStartS, op.dropStartS, op.serviceStartS, op.finishS])
      events.add(time);
  }
  for (const ops of byJob.values()) ops.sort((a, b) => a.readyS - b.readyS || a.finishS - b.finishS);
  for (const ops of byResource.values()) ops.sort((a, b) => a.dispatchS - b.dispatchS || a.serviceStartS - b.serviceStartS);
  return { result, byJob, byResource, positions, events: [...events].sort((a, b) => a - b) };
}
export type FactoryTimeline = ReturnType<typeof indexFactoryRun>;

function leg(a: PlantPoint, b: PlantPoint, from: number, to: number, time: number): PlantPoint {
  const f = to > from ? Math.max(0, Math.min(1, (time - from) / (to - from))) : 1;
  return [a[0] * (1 - f) + b[0] * f, a[1] * (1 - f) + b[1] * f];
}
function direction(a: PlantPoint, b: PlantPoint) {
  return Math.atan2(b[1] - a[1], b[0] - a[0]);
}

export function factoryFrame(timeline: FactoryTimeline, timeS: number) {
  const { result, byJob, byResource, positions } = timeline;
  const time = Math.max(0, Math.min(result.makespanS, timeS));
  const equipment = new Map<string, EquipmentPose>();
  for (const resource of result.resources) {
    const moving = resource.role === "mobile";
    const pose: EquipmentPose = { id: resource.id, point: resource.positionM, phase: "idle", heading: 0 };
    for (const op of byResource.get(resource.id)!) {
      if (time < op.dispatchS) break;
      if (op.carrierId === resource.id) {
        const from = positions.get(op.fromStationId!)!,
          to = positions.get(op.stationId)!;
        const origin = positions.get(op.carrierOriginId!)!;
        if (time >= op.serviceStartS) {
          if (moving) {
            pose.point = to;
            pose.heading = direction(from, to);
          }
          continue;
        }
        pose.operation = op;
        if (time < op.pickupStartS) {
          pose.phase = "empty";
          if (moving) {
            pose.point = leg(origin, from, op.dispatchS, op.pickupStartS, time);
            pose.heading = direction(origin, from);
          }
        } else if (time < op.loadedStartS) {
          pose.phase = "pickup";
          if (moving) {
            pose.point = from;
            pose.heading = direction(from, to);
          }
        } else if (time < op.dropStartS) {
          pose.phase = "carrying";
          if (moving) {
            pose.point = leg(from, to, op.loadedStartS, op.dropStartS, time);
            pose.heading = direction(from, to);
          }
        } else {
          pose.phase = "drop";
          if (moving) {
            pose.point = to;
            pose.heading = direction(from, to);
          }
        }
        break;
      }
      if (time < op.finishS) {
        pose.phase = time < op.serviceStartS ? "reserved" : "processing";
        pose.operation = op;
        break;
      }
    }
    equipment.set(resource.id, pose);
  }
  const parts: PartPose[] = [];
  let completed = 0,
    wip = 0,
    waiting = 0;
  for (const job of result.jobs) {
    const ops = byJob.get(job.id)!;
    const part: PartPose = { id: job.id, lineId: job.lineId, serial: job.serial, phase: "pending" };
    if (time >= job.finishS) {
      part.phase = "completed";
      part.operation = ops[ops.length - 1];
      part.point = positions.get(part.operation.stationId);
      completed++;
    } else if (time >= job.releaseS) {
      wip++;
      const op = ops.find(item => time < item.finishS)!;
      part.operation = op;
      const from = positions.get(op.fromStationId ?? op.stationId)!,
        to = positions.get(op.stationId)!;
      if (time < op.dispatchS || time < op.pickupStartS) {
        part.phase = "waiting";
        part.point = from;
        waiting++;
      } else if (time < op.loadedStartS) {
        part.phase = "pickup";
        part.point = from;
      } else if (time < op.dropStartS) {
        part.phase = "carrying";
        part.point = leg(from, to, op.loadedStartS, op.dropStartS, time);
      } else if (time < op.serviceStartS) {
        part.phase = "drop";
        part.point = to;
      } else {
        part.phase = "processing";
        part.point = to;
      }
    }
    parts.push(part);
  }
  return { timeS: time, equipment, parts, completed, wip, waiting, pending: result.jobs.length - completed - wip };
}
export type PlantFrame = ReturnType<typeof factoryFrame>;
