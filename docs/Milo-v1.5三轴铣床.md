# Milo v1.5 三轴铣床

1. 打开 [Milo v1.5 工作台](https://lusipad.com/omg/?view=milo)，载入官方 BOM。也可以下载原版 `sourcing_guide.md`，在工作台或 **导入中心 → BOM 与手册** 中选择文件。GitHub 原文件暂时无法访问时，可以使用站内已核对的物料表。[官方采购指南](https://millenniummachines.github.io/docs/milo_1.5/bom/sourcing_guide/) · [固定版本原文件](https://raw.githubusercontent.com/MillenniumMachines/millenniummachines.github.io/2aaa0c55e6bc176e42592bdb27051e428413f516/docs/milo_1.5/bom/sourcing_guide.md)
2. 分别装配 X、Y、Z 三根轴。每次装配都核对当前库存。比如把 NEMA 23 的数量从 3 改为 2，前两根轴会用完两台电机，第三根会显示缺料。可以卸下一根轴把电机改配给另一轴，也可以补齐数量后重新导入。完整清单保留七组共 81 条记录，包括接线、紧固件和可选配置的原始数量。[部件分配和来源](../public/machines/milo-v1-5/SOURCE.md)
3. 三根轴就绪后，运行页面中的示例，或输入自己的 G 代码。拖动回放时间，可以同时读取当前程序行、三个轴的位置（mm）、速度（mm/s）和刀尖在工件坐标系中的位置。示意图中 X/Y 工作台与编程刀尖的运动方向相反，Z 轴带动主轴升降。[官方机构说明](https://millenniummachines.github.io/docs/milo_1.5/faq/#what-is-the-work-area)
4. 通过 **工程文件 → 导出工程 JSON** 保存清单、已装轴和程序草稿。在另一台电脑导入工程文件后可以重新运行。工程中另外安装了物理模型时，使用同一菜单导出的完整 ZIP。

## 一个可手算的程序

工作台内置以下程序。刀尖从工件坐标 `(0, 0, 5)` mm 开始，抬至 Z8，再以每分钟 180 mm 进给至工件表面 Z0。

```gcode
; Milo v1.5 三轴联动
G21 G90 G94
G0 Z8
G1 Z0 F180
G1 X30 Y40 F600
G91
G1 X-6 Y-8 Z3 F300
G90
G0 Z8
G0 X0 Y0
```

第 5 行的斜线长 50 mm。F600 对应沿刀路 10 mm/s，匀速时 X、Y、Z 分量分别为 6、8、0 mm/s。这一段从静止到停止共 5.04 s。第 7 行让三轴同时进给到 `(24, 32, 3)` mm。退刀并返回起始 XY 后，刀尖停在 `(0, 0, 8)` mm。全程 116.440 mm，仿真用时 12.062 s。

页面支持 G0/G1 直线、G21 毫米、G90/G91 绝对与相对坐标、G94 每分钟进给。超行程及未实现的指令会定位到源码行。[数控直线插补与进给定义](https://linuxcnc.org/docs/stable/html/gcode/g-code.html#gcode:g1)

## 运动模型

| 参考配置 | X | Y | Z |
| --- | ---: | ---: | ---: |
| 丝杠长度（mm） | 550（最短） | 535 | 300（最短） |
| 导轨长度（mm） | 500 | 350 | 250 |
| 电机每转进给（mm） | 8 | 8 | 4 |
| 机床坐标软限位（mm） | 0 至 335 | 0 至 208 | −120 至 0 |
| 最高轴速（mm/min） | 1500 | 1500 | 1000 |
| 轴加速度（mm/s²） | 200 | 200 | 100 |

三轴使用 TR8×8 四头丝杠。X/Y 经联轴器直驱，Z 电机的 20 齿带轮驱动丝杠端 40 齿带轮。速度、加速度与软限位取自官方 `reference-fly-cdyv3` 配置。官方 FAQ 另列标准机型推荐工作包络为 340 × 160 × 60 mm，实物可用空间还取决于装夹和刀具。[装配与传动资料](../public/machines/milo-v1-5/SOURCE.md) · [固件软限位](https://github.com/MillenniumMachines/RRF-Configs/blob/c670a5819af159816a007d66c60750dbe2a93de0/milo-v1.5/reference-fly-cdyv3/limits.g) · [固件速度与加速度](https://github.com/MillenniumMachines/RRF-Configs/blob/c670a5819af159816a007d66c60750dbe2a93de0/milo-v1.5/reference-fly-cdyv3/speed.g)

示例将工件零点放在机床坐标 `(10, 10, −20)` mm。曲线表示理想开环步进轴按规划进给得到的运动。每段在端点停稳，短行程可能达不到设定进给。实机的切削载荷、失步、反向间隙和刀具挠曲需要另外建模和测量。
