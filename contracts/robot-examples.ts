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

export const PICK_PLACE_EXAMPLE = {
  id: "ur5e-pick-place",
  name: "UR5e 取放工位",
  description: "把六轴臂、平行夹爪和自由方块装在同一场景，观察工件被夹起、横移和放下。",
  modelId: "ee3c25defaf29d16aba708d8150fb535a9bcef2a52b03317df91f703d8fee3e2",
};

export const ROBOT_EXAMPLES: readonly RobotExample[] = [
  {
    id: "robotiq-2f85",
    name: "Robotiq 2F-85",
    category: "自适应平行夹爪",
    description: "在带悬挂方块的上游场景中改变开合指令，观察联动指垫的位置。",
    author: "Robotiq · MuJoCo Menagerie",
    license: "BSD-2-Clause",
    sourceUrl: "https://github.com/google-deepmind/mujoco_menagerie/tree/71f066ad0be9cd271f7ed58c030243ef157af9f4/robotiq_2f85",
    entry: "scene.xml",
    modelId: "185ac97d1ae141911c2eda97b8951d71b12a2f14003652a982023cc713cc2ed9",
    bytes: 961311,
    sha256: "d5e85f776526b7fd626afe53b9a121c35599bdcd654d88c64eb8c90139c213d5",
    trial: { durationS: 1, controls: [255], pointId: "body:13" },
  },
  {
    id: "turtlebot3-burger",
    name: "TurtleBot3 Burger",
    category: "差速移动底盘",
    description: "左右轮同速可直行，反向可转弯。通过车身轨迹观察轮速和地面接触的作用。",
    author: "Hakoniwa Lab · ROBOTIS",
    license: "MIT / Apache-2.0",
    sourceUrl: "https://github.com/hakoniwalab/hakoniwa-mujoco-robots/tree/e541c09e6de1aa9e3b5cf83e19b42cc613038b18/models/tb3",
    entry: "turtlebot3_burger_world.xml",
    modelId: "2f096952a86fafc6dfe75a3978f46c16da1194a84ee1b1d6ad1f3657452593e6",
    bytes: 8469,
    sha256: "5b6c9a0d20e1dd8df0d0b0e8fe8d15187b95fcbb977b912dbad325f2226a8449",
    trial: { durationS: 1, controls: [3, 3], pointId: "body:16" },
  },
  {
    id: "ur5e",
    name: "UR5e",
    category: "六轴工业机械臂",
    description: "从 home 姿态转动肩部，观察工具法兰轨迹。可作为取放工位的机械臂组件。",
    author: "Universal Robots · MuJoCo Menagerie",
    license: "BSD-3-Clause",
    sourceUrl: "https://github.com/google-deepmind/mujoco_menagerie/tree/71f066ad0be9cd271f7ed58c030243ef157af9f4/universal_robots_ur5e",
    entry: "scene.xml",
    modelId: "bf70f5db43ed25262a77efd72d1c8fd467fa0200eb859178b96094991b64e6fa",
    bytes: 4399916,
    sha256: "a5ba3c3fedb7d08ec230b53f04800a7054396638c6d5659e6030a8ed260d05d1",
    preferredKeyframe: "home",
    trial: { keyframe: "home", durationS: 1, controls: [-1.3708, -1.5708, 1.5708, -1.5708, -1.5708, 0], pointId: "site:0" },
  },
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
