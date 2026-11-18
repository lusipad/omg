# TurtleBot3 Burger 双轮差速场景

网页提供的 `model.zip` 大小为 8,469 字节，SHA-256 为 `5b6c9a0d20e1dd8df0d0b0e8fe8d15187b95fcbb977b912dbad325f2226a8449`。

TurtleBot3 Burger 的原硬件来自 ROBOTIS。本包采用 Hakoniwa Lab 的社区 MuJoCo 场景，固定提交为 `e541c09e6de1aa9e3b5cf83e19b42cc613038b18`。ZIP 内入口 `turtlebot3_burger_world.xml` 与上游同名文件逐字节一致，Git blob 为 `58cd334d8a98771cca4de46a8c88e4a53b88346c`。地面、障碍物、车体、轮子和雷达外壳均由文件内的基础几何构成，纹理由 MuJoCo 内建图案生成，可离线打开。[Hakoniwa 场景原文](https://github.com/hakoniwalab/hakoniwa-mujoco-robots/blob/e541c09e6de1aa9e3b5cf83e19b42cc613038b18/models/tb3/turtlebot3_burger_world.xml) · [ROBOTIS 硬件说明](https://emanual.robotis.com/docs/en/platform/turtlebot3/features/)

## 复验轮速和车身运动

导入 `model.zip`，从默认姿态选取 `base_footprint` 刚体（`body:16`），运行 1 秒。控制顺序为左轮 `left_motor`、右轮 `right_motor`，单位 rad/s。两个控制器的值域均为 −12 至 +12 rad/s。下表为平台通用运行器在 MuJoCo 4.0.1 WASM 中的结果，每种工况分别从同一初态开始。

| 工况 | 左轮 rad/s | 右轮 rad/s | 世界 X 位移 m | 世界 Y 位移 m | 偏航角变化 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 同向直行 | 3 | 3 | +0.097917 | +0.000686 | +0.423° |
| 反向原地转向 | 3 | −3 | −0.001176 | −0.002194 | −69.374° |

偏航角由自由底盘的姿态四元数计算，正方向按世界 Z 轴右手定则。原地转向工况有约 2.49 mm 的水平漂移。模型使用 0.033 m 轮半径、0.16 m 轮心距、1 ms 积分步长和接触摩擦。后部球形脚轮设有球关节，其碰撞掩码均为零。自由底盘、两个车轮铰链和脚轮球关节共 11 个速度自由度，场景编译出 22 个几何体。[模型结构与控制参数](https://github.com/hakoniwalab/hakoniwa-mujoco-robots/blob/e541c09e6de1aa9e3b5cf83e19b42cc613038b18/models/tb3/turtlebot3_burger_world.xml)

控制量直接送入 MuJoCo 轮速伺服器。此例验证双轮控制与车身位姿。站内场景含相机位姿及 `base_scan` 外壳。Hakoniwa 的手柄速度斜坡、激光射线与噪声处理、图像流和消息传输属于上游独立运行程序。[上游运行程序说明](https://github.com/hakoniwalab/hakoniwa-mujoco-robots/blob/e541c09e6de1aa9e3b5cf83e19b42cc613038b18/README.md#turtlebot3-2d-lidar)

## 来源与许可

- Hakoniwa Lab, LLC 的社区场景仓库使用 MIT License，包内 `LICENSE-Hakoniwa.txt` 是该提交的许可证原文。[Hakoniwa 许可证](https://github.com/hakoniwalab/hakoniwa-mujoco-robots/blob/e541c09e6de1aa9e3b5cf83e19b42cc613038b18/LICENSE)
- Hakoniwa 固定引用的模型注册表将 TurtleBot3 派生数据归于 **ROBOTIS CO., LTD.**，并标明 Apache License 2.0。ZIP 内保留注册表的 `NOTICE` 以及从 ROBOTIS 固定快照取得的 `LICENSE-ROBOTIS.txt`。[派生模型署名](https://github.com/hakoniwalab/hakoniwa-mbody-registry/blob/82d7afed4fa748f791e00842571194b6f2acb0f4/bodies/turtlebot3/generated/NOTICE) · [ROBOTIS 许可证](https://github.com/ROBOTIS-GIT/turtlebot3/blob/0d4e59cf34da9c0661f80008bb0fa02636c713b2/LICENSE)
