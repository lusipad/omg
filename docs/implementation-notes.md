# 实现说明与物理边界记录（Implementation Notes）

本文件记录影响物理含义、量纲换算、版本锁与验证偏差的设计决策、代码位置及对照证据。

## 1. 物理量纲与单位换算基准（Milestone 1）

- 实现位置：[contracts/units.ts](../contracts/units.ts)
- **同规范单位恒等直通**：当源单位与目标单位解析为同一 `canonical` 标识（例如 `N·m` 与 `N.m`、`r/min` 与 `rpm`、`Arms` 与 `A`）时，直接返回原浮点数，避免 `value * scale / scale` 引入 1 ULP 级别的浮点尾数漂移。
- **十进制整倍率换算精度**：转动惯量样本常见单位 `10⁻⁴ kg·m²`（如 `0.254 × 10⁻⁴ kg·m²`）、功率 `kW`（`0.4 kW`）、力 `kN`（`27.6 kN`）、时间 `ms` 等均按标准 SI 基准倍率换算（`0.254` `10⁻⁴ kg·m²` → `0.0000254` `kg.m2`）。
- **拒绝猜测区间与不等式**：`parseQuantityText` 对含范围符（`~`、`～`、`至`、数值间连字符如 `5~7 dB`）或不等号（`≥`、`≤`、`>`、`<` 如 `≥0.294 N·m`）的文本返回 `undefined`，强制进入人工核对或待确认流程。

## 2. 统一模型注册表与只读工件锁

- 实现位置：[contracts/model-registry.ts](../contracts/model-registry.ts)
- **严禁改写现有 `public/modelica/` 清单与 WASM 工件**：注册表直接只读导入 `public/modelica/*.json` 与 `public/modelica/runtime/*.json`，并在模块加载时校验组件与运行时清单的 ID/版本一致性，保护 `scripts/modelica/build-web.py --check` 的 SHA-256 字节锁。
- **严格版本匹配**：`requireRegisteredModel` 按 `${id}@${version}` 精确查找，禁止静默降级或回退至其他版本；但 `parseDevicePackage` 允许导入尚未安装的未知 `modelRef` 以保留前向兼容，实际运行或就绪度检查时明确拦截并报告缺失的具体 `id @ version`。

## 3. 设备事实与模型绑定（SSP / IDTA 对齐）

- 实现位置：[contracts/twin-device.ts](../contracts/twin-device.ts)、[contracts/device-model-binding.ts](../contracts/device-model-binding.ts)
- **平铺参数集 + 线性映射**：设备包的 `parameters` 仅保存客观手册/实测/衍生/假设条目或 `pending` 候选分支；`modelBindings` 通过 SSP 风格的 `source -> target` 与可选线性变换 `factor * x + offset` 将参数映射到目标模型，不写厂商专用解析分支。
- **旧设备包零损投影**：保留对既有 `pkg.servo`、`pkg.feed`、`pkg.motorPhysics`、`pkg.factory` 与信号 `pkg.rules` 的支持，`effectiveModelBindings` 将其无损投影为统一绑定视图，不改变原对象序列化结果。

## 4. 台达 ASDA-B3 黄金回归基准核验（Milestone 1）

- **依据来源**：`DELTA_IA-ASDA_ASDA-B3_C_EN_20240703`（驱动器 `ASD-B3-0421-L` 第 32 页连续电流 `2.65 Arms`；电机 `ECM-B3M-CA0604RB1` 第 41 页 `0.4 kW`、`1.27 N·m`、峰值 `3.81 N·m`、`3000 r/min`、最高 `6000 r/min`、`2.40 Arms`、无抱闸 `R` 选件惯量 `0.254 × 10⁻⁴ kg·m²` / 有抱闸 `0.264 × 10⁻⁴ kg·m²`）。
- **验证链路**：纯 `parameters + modelBindings`（不依赖旧 `pkg.servo` 字段）通过 `resolveParameterChoice` 选定无抱闸候选后，自动换算得 `rotorInertiaKgM2 = 0.0000254 kg.m2`、`ratedPowerW = 400 W`；在 90° 阶跃、`loadInertiaRatio = 1` 下：
  - `simulateServoAxis` 在 `433 ms` 收敛（与讨论稿核验记录一致）；
  - `runModelicaServo`（`servo-axis.wasm`）与搭配纯 `modelBindings` 5 mm/rev 丝杠 + 5 kg 滑台的 `runModelicaLinearAssembly`（`feed-axis.wasm`）均正常收敛，并与直接传入 SI 参数的数值一致。
- **偏差与边界记录**：该基线沿用平台当前平均转矩伺服模型设定（自然角频率 `24 rad/s`），油封附加阻力与真机驱动器整定不在该名义模型包含范围内。

## 5. 可追溯资料工件与模型契约驱动提取（Milestone 2）

- 实现位置：[contracts/twin-source-url.ts](../contracts/twin-source-url.ts)、[contracts/source-artifact.ts](../contracts/source-artifact.ts)、[api/twin-source.ts](../api/twin-source.ts)、[contracts/model-extraction.ts](../contracts/model-extraction.ts)、[api/twin-ai-router.ts](../api/twin-ai-router.ts)
- **PDF SHA-256 单次解析缓存**：上传或下载的 PDF 先计算文件内容 SHA-256 摘要，以有界内存缓存（上限 32 份）存储 `pdftotext` 提取结果与分页数组；同一版 PDF 重复提交只调用一次外部解析器。
- **使用条款与登录页拦截识别**：`POST /api/twin-source/artifact/url` 在解析 HTML 时先经 `detectHtmlGate` 检查（识别 `Terms of Use` / `使用条款` / `Sign in` 等非规格拦截页返回 HTTP `422` 与 `gated: true`）；被拦截或网络受阻时，前端保留已填写的厂商、型号与原链接，支持通过 `POST /api/twin-source/artifact/pdf` 上传本地 PDF 无缝续接并继承原 `sourceUrl`。
- **防幻觉确定性复核闸门**：`verifyAndBuildExtractedDevice` 强迫 AI 仅输出原始数值、原始单位倍率（如 `0.254` + `10^-4 kg·m²`）、页码/表头定位及逐字摘录，由程序依次核对：(1) 摘录在提交原文中逐行存在；(2) 若附带分页缓存，声称页码确实包含该摘录；(3) 数值字面量在对应摘录中真实出现（剔除 `10^-4` 倍率干扰后比对）；(4) 原始单位量纲兼容并满足模型参数物理边界；(5) 选件未定参数转为 `status: "pending"` 保留其余已核实字段，不在缺失字符时猜测取值。

## 6. 机电控统一系统图、闭环 `RuntimeTrace` 与原生 Modelica 联合校核（Milestone 3）

- 实现位置：[public/modelica/GouyuanFeedTracking.mo](../public/modelica/GouyuanFeedTracking.mo)、[contracts/system-twin.ts](../contracts/system-twin.ts)、[contracts/system-draft.ts](../contracts/system-draft.ts)、[src/lib/system-twin-runtime.ts](../src/lib/system-twin-runtime.ts)、[src/lib/system-twin-export.ts](../src/lib/system-twin-export.ts)、[src/components/SystemTwinBench.tsx](../src/components/SystemTwinBench.tsx)
- **新独立 Tracking 内核（不动旧摘要）**：新增 `GouyuanFeedTracking.TrackingFeedAxis @ 1.0.0`（`feed-tracking-axis.wasm`），接受一阶线性保持位置指令 `referenceMm` 并以 `50 us` RK4 子步积分，保证原有 `Gouyuan.mo` / `GouyuanLinear.mo` / `GouyuanMotor.mo` / `GouyuanContour.mo` 的 SHA-256 字节锁完全不变。
- **通信步长耦合执行与 `RuntimeTrace`**：以通信步长 `commStepMs`（默认 `1 ms`）在同构时间轴上联合推进多轴 Modelica WASM 动力学、三维世界位姿 `tipPoseMm`、限位开关电平（NO/NC）、DI 滞回防抖滤波（如 `GL10-1600END` 10 ms）及 `-not` 取反 / `1 -> N` 扇出接线，统一记录在同一份 `RuntimeTrace` 中。
- **原生 OpenModelica 1.27.2 DASSL 对照误差**：经 `scripts/modelica/prepare-closed-loop-cases.ts` 与 `scripts/modelica/verify-closed-loop.py` 校验 `baseline-10ms`（291 ms 触停于 16.7264 mm）、`fast-filter-2ms`（283 ms 触停于 16.0965 mm，精确提前 8 ms）与 `dual-axis-gantry-reverse`（含 Y 轴 `factor = -1` 极性反转，292 ms 触停于 -16.7483 mm），三组工况全部 601 个采样刻的离散急停状态完全锁步，连续位移与原生 Modelica 差异 `<= 0.000003 mm`。

## 7. 实机测点对标、客户项目桥接与第三厂商零硬编码盲测（Milestone 4）

- 实现位置：[contracts/field-alignment.ts](../contracts/field-alignment.ts)、[contracts/project-to-twin.ts](../contracts/project-to-twin.ts)、[src/pages/ProjectWorkbench.tsx](../src/pages/ProjectWorkbench.tsx)、[tests/field-alignment-and-bridge.test.ts](../tests/field-alignment-and-bridge.test.ts)、[tests/unfamiliar-vendor-acceptance.test.ts](../tests/unfamiliar-vendor-acceptance.test.ts)
- **资产绑定与双工况实测复验门禁**：`TwinSystemAssembly.assetBindings` 绑定物理设备序列号与标定修订号。`parseFieldTraceCsv` 与 `parseOpenPnpStepTrace` 统一换算 `s/ms`、`um/mm`、极性及零偏；`evaluateSystemVerificationStatus` 严格区分 `offline_simulation_only`（未附现场数据时明确标注“离线仿真验收（待实测对标）”）、`primary_aligned_pending_reverify`、`deviation_exceeded` 与 `field_verified`（须主标定与独立第二工况双双落入容差内）。
- **版本化实测修订不破坏目录真源**：`applyFieldCalibrationRevision` 基于现有设备包克隆生成带 `-<calibrationVersion>` 后缀的 `status: "measured"` 修订并切换系统轴槽位指向，原目录修订保持不可变。
- **早期选型端到 `/twin` 一键转化**：`convertProjectToTwinWorkspace` 解析 `COMPONENT_SEED` 官方部件修订（含自动识别括号选件生成 `pending` 分支及不完整系列级部件阻断提示），未选定或缺失负载的质量/电机/丝杠角色显式标为 `status: "assumed"`（`项目初算假设`）而不伪装为样本实值。
- **零厂商硬编码盲测验收**：`unfamiliar-vendor-acceptance.test.ts` 通过静态代码断言及 Panasonic（`MSMF012L1T1` + `MADLN05SE`）+ THK（`BNK1005`/`BNK1010`）+ Omron（`E2E-X4B2L12` + `NX-ID5442`）全流程验证，证明全平台核心契约与求解链不含任何品牌或型号专属代码分支。



