# 构元 · 通用模块工程平台

[打开在线导入中心](https://lusipad.github.io/omg/)。这个 GitHub Pages 地址会跳转到 `lusipad.com/omg/`。在首页可以导入自己的物理模型、几何网格、设备包、物料清单和手册。[导入格式与操作步骤](docs/通用模型与资料导入.md)

在首页的 **开源机器人** 中可以直接试跑[双足机器鸭 Open Duck Mini v2](https://lusipad.com/omg/?view=import&robot=open-duck-mini-v2)、[三轮机械臂 LeKiwi](https://lusipad.com/omg/?view=import&robot=lekiwi)和[四足机器人 Barkour v0](https://lusipad.com/omg/?view=import&robot=barkour-v0)。打开卡片会加载对应模型包，点击 **运行仿真** 可观察关节和指定部位的反馈。每个模型都能单独下载、重新导入。

[组装 UR5e 取放工位](https://lusipad.com/omg/?view=import&robot=ur5e-pick-place)可以把[UR5e 六轴臂](https://lusipad.com/omg/?view=import&robot=ur5e)、[Robotiq 2F-85 夹爪](https://lusipad.com/omg/?view=import&robot=robotiq-2f85)和独立的 30 mm 方块装成一个场景。点击 **组装取放工位 → 运行仿真**，在 **阶段观测记录** 中比较夹爪与工件的抬升、横移和释放结果。另有 [TurtleBot3 Burger](https://lusipad.com/omg/?view=import&robot=turtlebot3-burger) 可通过左右轮速度试验直行和转向。

[Milo v1.5 三轴铣床](https://lusipad.com/omg/?view=milo)可直接读取官方 BOM 并逐个装配 X、Y、Z。打开**[圆形凹槽示例](https://lusipad.com/omg/?view=milo#milo-pocket)**，用 Ø6 mm 平底刀通过 G2/G3 圆弧分三层铣出 Ø30 × 3 mm 的凹槽。回放中可拖动三维视角，贴近工件查看槽壁与刀尖，或切到整机观察工作台与主轴的运动。时间轴同时驱动毛坯、刀路和三轴曲线。[下载 G 代码](public/machines/milo-v1-5/circular-pocket.nc) · [装轴步骤与刀路算例](docs/Milo-v1.5三轴铣床.md)

公开站点在浏览器内运行模型。轻量工程可导出 JSON，包含用户物理模型的工程可导出带原始资源的 ZIP。工作台也提供[汇川伺服轴](https://lusipad.com/omg/?view=servo)和 [SO-101 从臂](https://lusipad.com/omg/?view=so101)的专用界面。客户项目、数据库、通用官网资料提取、PDF 转换和在线 AI 生成使用下文的完整服务部署。`npm run build:pages` 生成 `dist/pages`，推送到 `main` 后 GitHub Actions 会构建并发布这个目录。

## 从底层设备搭建仿真

在工程根目录运行 `npm ci`、`npm run dev`，打开 [本机设备仿真工作台](http://127.0.0.1:3000/twin)。此入口支持从制造商资料生成设备包、审核安装、创建多个设备实例、连接端口和单步仿真。本机工作区可以在没有数据库和 OAuth 配置的开发环境中使用。原客户项目工作台的部署要求见下文。

点击 **打开接线示例** 可运行一个已接好线的汇川 GL10-1600END 和虚拟电压源。要制作自己的设备，请从 **设备库** 开始。操作步骤、设备包格式、AI 接入和仿真边界见[设备仿真工作台指南](docs/设备仿真工作台.md)。

[伺服轴工作台](http://127.0.0.1:3000/twin?view=servo)支持从驱动器和电机的官网资料链接生成两个独立设备包。导入后选择目标角度，可以观察轴的位置和速度随时间变化。试用时点 **打开伺服轴示例**，或导入[已经装配好的 90° 示例工程](examples/inovance-servo-axis.twin.json)。操作步骤及模型假设见[汇川伺服轴示例](docs/汇川伺服轴示例.md)。

[SO-101 从臂工作台](http://127.0.0.1:3000/twin?view=so101)可以直接导入上游 Markdown 采购表，装配新标定的 Follower 模型，并在浏览器中用 MuJoCo 运行六关节动作。运行后可回放三维姿态，观察关节实际位置、速度和夹爪末端轨迹。[操作指南](docs/SO-101从臂示例.md) · [已装配的工程文件](examples/so101-follower.twin.json)

面向非标机电设备早期方案设计的客户试点自动配置版。默认从少量整机需求自动创建组成模块、分配参数、完成初算、初筛候选部件并冻结 V1 草案；高级模式仍可手动组成。平台在同一项目中维护需求参数、工程初算、官方部件来源、计算历史、版本快照和审计事件。

**当前版本：`pilot-0.2.0`。它用于方案配置与客户试点，不是生产图纸系统、采购定型工具、功能安全认证工具或可直接制造的设计包。**

## 已实现范围

- 真实用户登录与项目隔离；项目归属由服务端校验。
- 三步自动方案向导：选择设备、填写少量整机需求、确认并生成；成功后直接进入统一待办工作台。
- 三轴 CNC、六轴机械臂、差速平台的整机需求分配规则；自动写入真实组成、计算运行、计算步骤、审计事件和 V1 快照。
- 基于已入库官方资料的候选初筛；电机转矩/转速和减速比不满足时留空并生成待确认项，不虚构部件。
- 高级手动模式：空白项目或整机模板仍可创建同级组成模块实例，而非独立演示卡片。
- 三类通用模块：丝杠直线进给轴、伺服减速旋转关节、电机减速驱动轮。
- 参数化三维布局、工程初算、公式代入、假设、警告与阻断状态。
- 每次保存追加计算运行及逐步计算记录，不覆盖历史。
- 项目版本冻结、SHA-256 内容摘要、版本快照与审计事件。
- 首批 8 条制造商官方来源部件修订；区分型号级、系列级和工程假设。
- JSON 工程设计包与 CSV 溯源 BOM；文件由浏览器即时生成，不上传到服务端。
- 桌面与移动端工作台；Three.js 三维引擎按需加载。
- 公式单元测试、真实数据库闭环测试、角色不匹配与越权访问负向测试。

## 明确未完成

- 指定 OpenModelica 版本的模型编译、仿真和数值回归：**阻断**。
- 真实客户现场参考项目与实测验收：**待完成**。
- 机械、电气、控制工程师具名复核：**待完成**。
- 供应商最终选型、接口图纸、寿命、热、刚度、强度和安全验证：**待完成**。
- 制造级 CAD、工程图、公差、图纸审批与采购定型：**不在本版本交付范围内**。

完整验收口径见 [客户试点指南](docs/客户试点指南.md) 和 [工程与验证边界](docs/工程与验证边界.md)。

## 运行要求

- Node.js 20 或兼容的更高 LTS 版本；
- npm 10+；
- MySQL 8，或兼容 Drizzle MySQL 协议的数据库；
- Kimi OAuth 应用及回调地址配置；
- 首次部署需要可建表的数据库账号，日常运行账号可按最小权限另行配置。

## 本地启动

```bash
npm ci
cp .env.example .env
```

编辑 `.env`，填写真实部署值。不要把 `.env` 提交到版本库或打入源码包。

```dotenv
APP_ID=
APP_SECRET=
DATABASE_URL=mysql://user:password@host:3306/database
VITE_KIMI_AUTH_URL=
VITE_APP_ID=
KIMI_AUTH_URL=
KIMI_OPEN_URL=
OWNER_UNION_ID=
```

`APP_SECRET` 用于会话签名，应使用独立高熵随机值；`VITE_` 前缀变量会进入浏览器构建产物，不能放置服务端秘密。

初始化数据库并写入幂等基础数据：

```bash
npm run db:push
npm run db:seed
npm run dev
```

开发服务默认由 Vite 启动。生产服务默认监听 `3000`，可通过 `PORT` 修改。

> `db:push` 用于受控开发环境。已有客户数据时，应先备份并评审 schema 差异；不要通过删表或强制推送恢复失败迁移。生产环境建议采用经过评审的迁移流程。

## 测试与构建

```bash
npm run check             # TypeScript 全量检查
npm run test              # 工程公式与边界测试
npm run test:persistence  # 真实数据库闭环；创建并清理临时账号和项目
npm run build             # 前端与生产服务构建
npm run lint              # 可选：静态规范检查
```

`test:persistence` 需要可用数据库，会先读取模块与部件种子数据，再验证：手动及自动组成实例、参数持久化、历史追加、非法部件角色拒绝、自动 V1 快照、工程设计包导出和跨账号访问阻断。测试创建的临时项目会在账号前删除，避免外键约束导致残留。

生产启动：

```bash
npm run build
NODE_ENV=production node dist/boot.js
```

服务入口会同时提供前端静态资源和 `/api/trpc/*`。OAuth 回调路径为 `/api/oauth/callback`，外部回调地址必须与 OAuth 应用配置一致。

## Docker 部署

```bash
docker build -t gouyuan-platform:pilot-0.2.0 .
docker run --rm -p 3000:3000 --env-file .env gouyuan-platform:pilot-0.2.0
```

镜像构建阶段执行类型检查、公式测试和生产构建。数据库初始化与种子数据仍需在受控发布流程中单独执行，不在容器启动时自动改库。

## 日常使用流程

### 默认：自动生成方案

1. 在“客户项目”点击“自动生成方案”。
2. 选择三轴 CNC、六轴机械臂或差速轮式机器人。
3. 按页面单位填写少量整机需求；默认值只是草案输入，不是推荐工况。
4. 在确认页检查自动组成和分配假设，然后生成项目。
5. 系统在同一事务中创建全部模块、计算运行与步骤、候选部件、审计事件，并冻结“自动生成初版”V1 快照。
6. 在工作台顶部“方案待办”集中处理阻断、警告和缺失部件；点击条目会跳到对应模块的计算或部件页。
7. 查看“首次自动候选依据（历史）”，打开官方来源核对原文。没有候选的角色保持空白，不以假设型号补齐。
8. 需要调整时仍可编辑每个实例；保存会追加新计算历史。后续修改不会重写 V1，需另行冻结新版本。
9. 导出 JSON 设计包供复核，导出 CSV BOM 供供应链沟通。JSON 同时包含自动需求、假设、警告和待确认项。

### 高级：手动组成

非标准结构可从“高级模式”创建空白项目或组成模板，再自行增删同级模块实例。此入口不会根据整机需求自动分配参数，也不会自动处理模块间载荷传递、运动学耦合、共享轮径或共享控制器约束。

无论采用哪种入口，都应将现场实测、供应商回复和工程师复核结论纳入下一轮版本；不要只改当前表单而省略版本记录。

## 数据与追溯结构

- `moduleDefinitions / moduleVersions`：通用模块定义及输入规则版本。
- `manufacturers / components / componentRevisions`：制造商、型号、修订及官方来源。
- `projects / projectModules`：客户项目与整机组成实例。
- `calculationRuns / calculationSteps`：不可覆盖的计算历史与公式代入。
- `projectVersions`：带内容摘要的项目快照。
- `auditEvents`：项目与模块操作事件。

工程计算核心位于 `contracts/engineering.ts`，不依赖数据库；前端预览与服务端保存调用同一套规则。保存操作在事务中更新组成实例、追加计算、写入步骤和审计事件。

## 部件来源口径

首批种子包含 THK HSR 25R、HIWIN Super S 系列、Panasonic MSMF012L1T1、Delta ASDA-A2 400 W 低惯量组、Harmonic Drive CSG-25-100-2A、Nabtesco RV-25N、maxon EC-i 40 与 GP 42 C。每条修订都保存官方 URL、资料标题、版本（如有）、页码或网页区块、证据摘录和待确认项。

- `source_recorded`：仅表示记录了制造商官方资料来源。
- `engineer_reviewed`：需要具名工程师复核记录才能使用。
- `supplier_confirmed`：需要供应商针对具体订货型号和应用工况确认。
- 系列级参数不能替代具体订货型号参数。
- 种子脚本可更新来源字段，但不会把后续人工或供应商确认状态降级。

## 安全与运维

- 只通过受保护环境变量注入凭证；不要将数据库 URL、JWT、APP_SECRET 写入日志、截图、前端常量或压缩包。
- 对外部署应使用 HTTPS、受控域名、备份策略、日志保留策略和最小权限数据库账号。
- 项目导出在浏览器生成；如需服务端文件归档，应另行设计对象存储、权限、保留期和防泄漏策略。
- 客户上线前必须做备份恢复、迁移回滚、账号权限和 OAuth 回调演练。
- 开发依赖审计与生产依赖审计应分别评估，不能用破坏性强制升级掩盖兼容风险。

## 代码导航

```text
api/                    Hono、tRPC、业务服务与数据库查询
contracts/              工程规则、模块目录、发布门槛与共享类型
db/                     Drizzle schema、关系与幂等种子
src/pages/              项目、工作台、模块库、部件库、验证中心
src/components/         产品布局、状态组件与按需三维场景
tests/                  公式测试与真实数据库闭环测试
docs/                   客户试点和工程验证边界
Dockerfile              两阶段生产镜像
```

旧教学原型保留在独立备份与压缩包中，不属于本商业试点版的验证证据。
