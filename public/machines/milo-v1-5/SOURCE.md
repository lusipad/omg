# Milo v1.5 资料来源

离线采购表取自 Millennium Machines 官方文档提交 `2aaa0c55e6bc176e42592bdb27051e428413f516`，范围为采购指南的 `Individual Parts`。按上游顺序保留 81 行物料的名称、标准及原文数量。七组依次为 Printed Parts 4 行、Fasteners 27 行、Frame 10 行、Electronics 10 行、Motion 17 行、Cabling 10 行、Misc 3 行。采购渠道、配图和安装文字请查上游指南。[离线物料表](./bom-facts.md) · [固定版本采购指南](https://github.com/MillenniumMachines/millenniummachines.github.io/blob/2aaa0c55e6bc176e42592bdb27051e428413f516/docs/milo_1.5/bom/sourcing_guide.md#individual-parts)

数量中的 `6 / 74 (FMJ)` 是标准和 Full Metal Jacket 两种装配的用量，`1L` 为树脂体积，`N/A` 表示原表未给出确定数量。原文 Git blob 为 `ef0bb1d3cde7f074ea44d0fa10ba34f4881e865b`，原文 SHA-256 为 `40ef8ea0f5d4d8182c68aa29e7e548d5c84417ab83b78922ce6785dffa8a168f`，离线表 SHA-256 为 `3a8dcda537fb118d9d5c700ee26e874c1bc35a927a3ef7527a3bbdd82bd773bd`。2026 年 11 月 8 日，项目将 Y 轴丝杠修正为 535 mm，X 轴保留 550 mm。[原版 Markdown](https://raw.githubusercontent.com/MillenniumMachines/millenniummachines.github.io/2aaa0c55e6bc176e42592bdb27051e428413f516/docs/milo_1.5/bom/sourcing_guide.md) · [丝杠修订记录](https://github.com/MillenniumMachines/millenniummachines.github.io/commit/25a833c5c20789eed39ac485c8d885bd9fbe6ccc)

## 三轴物料分配

| 每轴使用的物料 | X | Y | Z |
| --- | --- | --- | --- |
| MGN15 导轨 | 500 mm × 2 | 350 mm × 2 | 250 mm × 2 |
| MGN15C 滑块 | 4 | 4 | 4 |
| TR8×8 四头丝杠 | 至少 550 mm × 1 | 535 mm × 1 | 至少 300 mm × 1 |
| 黄铜 TR8×8 螺母 / 8 mm 锁紧环 | 2 / 2 | 2 / 2 | 2 / 2 |
| 608ZZ 轴承 / 带法兰 F608ZZ 轴承 | 1 / 2 | 4 / 2 | 3 / 0 |
| NEMA 23 步进电机 / 电机驱动器 / 归零开关 | 1 / 1 / 1 | 1 / 1 / 1 | 1 / 1 / 1 |
| 电机到丝杠的传动 | 6.35 mm 转 8 mm 联轴器 × 1 | 6.35 mm 转 8 mm 联轴器 × 1 | 电机 20 齿、丝杠 40 齿，200 mm 闭环 GT2 带 × 1 |

X、Y 共用一块 XY 滑台板。Y 轴装配章的前两张滑块安装图分别给出下表面的 4 个 Y 滑块和上表面的 4 个 X 滑块。Y 支座两侧各用 2 个 608ZZ 和 1 个 F608ZZ。Z 单独使用一块滑台板，底部支座用 1 个 608ZZ，顶部电机座用 2 个。三轴采购合计为 12 个滑块、8 个 608ZZ、4 个 F608ZZ、6 个黄铜螺母。Z 章在安装丝杠的下一工序再次列出已装在消隙块上的两个螺母。[Y 轴及共享滑台板](https://github.com/MillenniumMachines/millenniummachines.github.io/blob/2aaa0c55e6bc176e42592bdb27051e428413f516/docs/milo_1.5/manual/chapters/40_y_axis_assembly.md) · [X 轴](https://github.com/MillenniumMachines/millenniummachines.github.io/blob/2aaa0c55e6bc176e42592bdb27051e428413f516/docs/milo_1.5/manual/chapters/50_x_axis_assembly.md) · [Z 轴](https://github.com/MillenniumMachines/millenniummachines.github.io/blob/2aaa0c55e6bc176e42592bdb27051e428413f516/docs/milo_1.5/manual/chapters/60_z_axis_assembly.md)

三维视窗中的整机按装配图建立了可动的简化几何。底部框架和后立柱固定，500 mm 横向工作台由 XY 滑台承载，立柱前方安装竖直主轴。工件特写采用实际毫米比例，轨迹与剩余材料都定位在同一工件坐标系。完整装配几何可查官方 STEP 文件。[立柱与底梁装配图](https://github.com/MillenniumMachines/millenniummachines.github.io/blob/2aaa0c55e6bc176e42592bdb27051e428413f516/docs/milo_1.5/manual/chapters/60_z_axis_assembly.md) · [Milo v1.5 官方 CAD](https://github.com/MillenniumMachines/Milo-v1.5/blob/cecc5a616a1b326f50f9dd881eaa79c9e7506039/CAD/Milo.zip)

## 标准参考板的运动参数

以下为官方 RRF-Configs 发布 `v12.11.26-stable` 的 `milo-v1.5/reference-fly-cdyv3` 配置。提交为 `c670a5819af159816a007d66c60750dbe2a93de0`，发布清单指定 RepRapFirmware 3.6.1。该配置以标准 BOM 和采用打印连接件的 Z 柱为基准。不同套件使用各自的速度和加速度设置。[发行清单](https://github.com/MillenniumMachines/RRF-Configs/releases/tag/v12.11.26-stable) · [参考配置说明](https://github.com/MillenniumMachines/RRF-Configs/blob/c670a5819af159816a007d66c60750dbe2a93de0/milo-v1.5/reference-fly-cdyv3/README.md)

| 配置或规格 | X | Y | Z |
| --- | ---: | ---: | ---: |
| FAQ 推荐标准工作包络（mm） | 340 | 160 | 60 |
| M208 固件坐标范围（mm） | 0 至 335 | 0 至 208 | −120 至 0 |
| M203 最大轴速度（mm/min） | 1500 | 1500 | 1000 |
| M201 加速度（mm/s²） | 200 | 200 | 100 |
| M92 指令步数（steps/mm） | 800 | 800 | 1600 |
| 归零端 | 最小端 | 最大端 | 最大端 |

FAQ 工作包络描述工件可用空间。M208 则约束固件接受的机床坐标，两者涵盖不同几何量。X、Y 由工作台在主轴下运动，Z 带动主轴座。TR8×8 丝杠每转进给 8 mm，Z 电机与丝杠的 20∶40 齿比使每电机转的理想进给为 4 mm。[官方工作包络](https://github.com/MillenniumMachines/millenniummachines.github.io/blob/2aaa0c55e6bc176e42592bdb27051e428413f516/docs/milo_1.5/faq.md) · [坐标与归零端](https://github.com/MillenniumMachines/RRF-Configs/blob/c670a5819af159816a007d66c60750dbe2a93de0/milo-v1.5/reference-fly-cdyv3/limits.g) · [速度与加速度](https://github.com/MillenniumMachines/RRF-Configs/blob/c670a5819af159816a007d66c60750dbe2a93de0/milo-v1.5/reference-fly-cdyv3/speed.g) · [传动与步数](https://github.com/MillenniumMachines/RRF-Configs/blob/c670a5819af159816a007d66c60750dbe2a93de0/milo-v1.5/reference-fly-cdyv3/drives.g)
