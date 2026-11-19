export type ReleaseCheck = {
  key: string;
  title: string;
  status: "passed" | "recorded" | "pending" | "blocked";
  evidence: string;
  boundary: string;
};

export const RELEASE_MANIFEST: { release: string; name: string; checks: ReleaseCheck[] } = {
  release: "pilot-0.2.0",
  name: "通用模块平台 · 客户试点自动配置版",
  checks: [
    {
      key: "engineering-rules",
      title: "工程公式与边界测试",
      status: "passed",
      evidence: "Vitest 32/32 通过：23 项工程公式与边界测试，9 项整机自动分配和候选初筛回归",
      boundary: "测试通过也不等于具体设备设计已经验证",
    },
    {
      key: "automation-workflow",
      title: "整机需求自动配置",
      status: "passed",
      evidence: "CNC / 六轴机械臂 / 差速平台可自动创建组成、分配参数、保存初算、初筛候选并冻结 V1；桌面与移动端浏览器路径通过",
      boundary: "自动结果是可修改草案；减速比、目录转矩与转速初筛不等于供应商选型或制造验证",
    },
    {
      key: "persistence",
      title: "项目持久化与版本追溯",
      status: "passed",
      evidence: "真实数据库闭环通过：手动与自动组成、重读、历史、V1 自动快照、导出、部件角色负向校验与越权阻断",
      boundary: "仍需在客户部署环境执行备份恢复与迁移演练",
    },
    {
      key: "component-sources",
      title: "供应商资料来源",
      status: "recorded",
      evidence: "8 条官方来源修订已入库：7 家制造商，含型号级 / 系列级边界、页码与待确认项",
      boundary: "来源已记录不等于供应商确认或工程师复核",
    },
    {
      key: "modelica-servo-axis",
      title: "Gouyuan.ServoAxis 1.0.0 软件回归",
      status: "passed",
      evidence: "OpenModelica 1.27.2 与标准库 4.0.0 完成原生编译，11 个伺服工况通过。90° 指令、负载比 1 在 100 ms 时达到 62.2403°、78.3803 rpm。",
      boundary: "验证范围为平均转矩与刚性负载的离线响应，厂家控制整定和现场轨迹由实测核对。",
    },
    {
      key: "modelica-feed-axis",
      title: "GouyuanLinear.FeedAxis 1.0.0 软件回归",
      status: "passed",
      evidence: "9 个进给工况通过 OpenModelica 原生验证。浏览器逐点核对位移、速度、电机转矩、轴向推力、转角和转速，每工况 801 个时刻。",
      boundary: "水平无损丝杠与刚性工作台，丝杠导程和移动质量取自选定的 BOM 部件。",
    },
    {
      key: "modelica-built-motor",
      title: "GouyuanMotor.CncFeedAxis 1.0.0 软件回归",
      status: "passed",
      evidence: "由选定定子、转子及轴承组成电机，安装到真实声明的 CNC 槽位。15 个原生工况与浏览器逐点对照，核对电流、转矩、转子和工作台响应。",
      boundary: "教学工况采用基波 q 轴模型、理想反馈与粘性轴承阻力。实机磁路、摩擦及驱动整定需要实测。",
    },
    {
      key: "modelica-cnc-contour",
      title: "GouyuanContour.TrackingAxis 1.0.0 三轴加工回归",
      status: "passed",
      evidence: "标准圆槽、换转子和双向螺旋共核对 11,337 个浏览器与原生 Modelica 时刻。三轴反馈位置的最大差小于 0.000031 mm，速度最大差小于 0.00026 mm/s。",
      boundary: "Z 轴重力理想平衡，按仿真刀位做几何去料，动力学忽略切削力和刀具挠度。",
    },
    {
      key: "modelica-factory",
      title: "GouyuanFactory 1.0.0 整厂过程回归",
      status: "passed",
      evidence: "两条线共享移动机器人与数控机床，9 件完成 33 道工序。5 种配置包含只更换机床 X 轴的工况，原生 Modelica 与浏览器逐项核对派工、设备占用和子件额定值来源。",
      boundary: "工厂模型使用单件运输、固定工艺路线和标定节拍。现场通行能力和设备节拍需要实测。",
    },
    {
      key: "modelica",
      title: "客户工程 Modelica 验收",
      status: "blocked",
      evidence: "客户项目仍需提交具体部件、负载与工况的模型对照和具名工程师复核。",
      boundary: "软件回归的结论限于记录的模型版本和工况。",
    },
    {
      key: "reference-project",
      title: "真实客户参考项目",
      status: "pending",
      evidence: "等待客户现场需求、实测数据与验收记录",
      boundary: "模板项目不是客户现场验收项目",
    },
    {
      key: "engineering-review",
      title: "机械 / 电气 / 控制工程师复核",
      status: "pending",
      evidence: "等待具名复核人与复核记录",
      boundary: "客户试点版不构成量产或安全认证",
    },
  ],
};
