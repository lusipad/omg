import type { ImportedRunSettings } from "./imported-physics";

export interface RobotExample {
  id: string;
  name: string;
  category: string;
  description: string;
  author: string;
  license: string;
  sourceUrl: string;
  entry: string;
  modelId: string;
  sha256: string;
  bytes: number;
  preferredKeyframe?: string;
  trial?: ImportedRunSettings;
}

export const ROBOT_EXAMPLES: readonly RobotExample[] = [
  {
    id: "open-duck-mini-v2",
    name: "Open Duck Mini v2",
    category: "双足机器鸭",
    description: "在固定底座上让头部转动 0.25 rad，观察左侧天线支架的移动。",
    author: "apirrone · Open Duck Mini",
    license: "Apache-2.0",
    sourceUrl: "https://github.com/apirrone/Open_Duck_Mini/tree/b23317a485b3cec7d8417f352478778b3475173c/mini_bdx/robots/open_duck_mini_v2",
    entry: "scene_position.xml",
    modelId: "7ba891d2bc39becd443389e1701bee507ff24e91635d8f09cf9e44b12cace558",
    bytes: 5930499,
    sha256: "f9a2db9b36ffe5029d6db270a27ffcfa3eacd4662d9dcc4cc5123e6503cab0c2",
    trial: { durationS: 0.4, controls: [0, 0, 0, 0, 0, 0, 0, 0.25, 0, 0, 0, 0, 0, 0, 0, 0], pointId: "body:15" },
  },
  {
    id: "lekiwi",
    name: "LeKiwi",
    category: "三轮移动机械臂",
    description: "查看三轮底盘和 SO 系列机械臂。在固定底盘的 URDF 中观察夹爪受重力后的位移。",
    author: "SIGRobotics-UIUC",
    license: "Apache-2.0",
    sourceUrl: "https://github.com/SIGRobotics-UIUC/LeKiwi/tree/efa608d7ee5a495a4803b1d28cd0c955b4f1e033/URDF",
    entry: "LeKiwi.urdf",
    modelId: "8e20054356fc1ee7e3f0bb66cc80297f294159f3ee6f30e98755c52bdc2eb493",
    bytes: 5883386,
    sha256: "a5e3486bcff0fe284e57faa8ba49e0174345c143c3b5b58b32fe9a3a438c535d",
    trial: { durationS: 0.1, controls: [], pointId: "body:9" },
  },
  {
    id: "barkour-v0",
    name: "Barkour v0",
    category: "四足机器人",
    description: "从官方 standing 站姿保持关节目标，观察足部接触地面后机身的高度变化。",
    author: "Google · MuJoCo Menagerie",
    license: "Apache-2.0",
    sourceUrl: "https://github.com/google-deepmind/mujoco_menagerie/tree/71f066ad0be9cd271f7ed58c030243ef157af9f4/google_barkour_v0",
    entry: "scene.xml",
    modelId: "915ca267eeb157b5eef62ac48b8945da44f93da8743c9ac98ee1db15a4abaf37",
    bytes: 3799238,
    sha256: "f20e08d9a44b0a622abe879e73decd4be25f5a3201e76d26f610857d6f4ef970",
    preferredKeyframe: "standing",
    trial: { keyframe: "standing", durationS: 1, controls: [0, 0.5, 1, 0, 0.5, 1, 0, 0.5, 1, 0, 0.5, 1], pointId: "body:1" },
  },
];
