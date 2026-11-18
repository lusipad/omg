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
      key: "modelica",
      title: "OpenModelica 编译与数值回归",
      status: "blocked",
      evidence: "当前交付环境未安装 omc，本版本未执行编译",
      boundary: "不得将参数化三维或旧演示生成器描述为已验证 Modelica 模型",
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
