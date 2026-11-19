# 机械安装点示例的来源

## 转台、滑台和工具

“构元示教”修订 1.0 的三个部件由本项目定义。RZ-转台绕本地 Z 轴旋转，范围为 −180° 至 180°。LX-滑台沿本地 X 轴移动，行程为 0 至 100 mm。两个部件的输入安装点和输出安装点 `out` 在零位重合。T20-工具采用固定连接，其输出点 `tip` 位于本地 (20, 0, 0) mm。演示时给转台 +90°、滑台 +40 mm。上述数值均为自定义的运动学参数。

`slide-tool.package.json` 取自 `turn-slide.assembly.json` 中以 `slide` 为根的子树，观测点为 `tool.tip`。包的根型号为 LX-T20-子装配，公开安装点为 `out`。重新装到转台上时，内部滑台沿用 40 mm 的指令。

## SO-101 肩部与肘关节原点

项目 `so101.twin.json` 根据 The Robot Studio 与 Hugging Face 的 SO-101 Follower 新标定模型制作。取自 TheRobotStudio/SO-ARM100 提交 `a758567c3978dfeefe282ede0500085a48fe8f78`。已比较仓库内 XML 与上游原件，两者的 SHA-256 均为 `d75253eb568e8a7214db9c631ab7bed4217f608a26f7276ebe9a7636cac82580`。原项目仓库附 Apache License 2.0，本项目保留许可证和模型归属说明。[固定版本 XML](https://github.com/TheRobotStudio/SO-ARM100/blob/a758567c3978dfeefe282ede0500085a48fe8f78/Simulation/SO101/so101_new_calib.xml) · [本地原件](../../models/so101/so101_new_calib.xml) · [模型归属](../../models/so101/SOURCE.md) · [许可证](../../models/so101/LICENSE)

每个零件的输入安装点取其源刚体原点，姿态为单位四元数。父件的输出安装点取对应子刚体的 `pos`、`quat`。源文件以米、弧度和 `w x y z` 四元数表示，设备包将长度换算为毫米，关节限位换算为度。四元数按 MuJoCo 的规则归一化，舍入到整数度的限位与源文件之差小于 10⁻¹²°。

| 工程中的连接或观测点 | 源 XML 的父刚体 → 子刚体 | 子原点在父系的位置 (mm) | 源四元数 (w, x, y, z) |
| --- | --- | --- | --- |
| `base.shoulder_pan` | `base` → `shoulder` | (38.8353, −0.00000897657, 62.4) | (3.56167e−16, 1.22818e−15, −1, −4.14635e−16) |
| `shoulder_pan.shoulder_lift` | `shoulder` → `upper_arm` | (−30.3992, −18.2778, −54.2) | (0.5, −0.5, −0.5, −0.5) |
| `shoulder_lift.elbow_flex` | `upper_arm` → `lower_arm` | (−112.57, −28, 1.73763e−13) | (0.707107, −5.98613e−17, −2.58051e−17, 0.707107) |

`shoulder_pan` 与 `shoulder_lift` 均绕各自子刚体的本地 (0, 0, 1) 轴旋转，限位分别为 ±110°、±100°。观测点是 `elbow_flex` 的铰链中心，与 `lower_arm` 的原点重合。校验时使用完整六关节原模型，将后四关节固定在零位，用 `mj_forward` 读取 `elbow_flex` 的 `xanchor`。这组拆分数据用于核对安装几何与正运动学。完整惯量、网格和电机属性见原模型。
