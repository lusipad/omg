# Universal Robots UR5e 六轴机械臂

模型取自 Google DeepMind 的 MuJoCo Menagerie，固定提交 `71f066ad0be9cd271f7ed58c030243ef157af9f4`。该目录将 Universal Robots UR5e 的 ROS-Industrial URDF 转成 MJCF，配有位置执行器和简化的碰撞几何。目录许可为 BSD-3-Clause，版权声明为 “Copyright 2018 ROS Industrial Consortium”。[上游模型与说明](https://github.com/google-deepmind/mujoco_menagerie/tree/71f066ad0be9cd271f7ed58c030243ef157af9f4/universal_robots_ur5e) · [许可证原文](https://github.com/google-deepmind/mujoco_menagerie/blob/71f066ad0be9cd271f7ed58c030243ef157af9f4/universal_robots_ur5e/LICENSE)

**默认入口为 `scene.xml`**，含地面和六轴机械臂。只装配机械臂时可选 `ur5e.xml`。在两个入口下选择 `home` 关键帧，六个关节及其控制初值按顺序均为 `[-1.5708,-1.5708,1.5708,-1.5708,-1.5708,0]` rad。

**复算肩部转动。** 从 `home` 开始，观测腕部安装点 `attachment_site`（`site:0`）。将第一个输入 `shoulder_pan` 改为 −1.3708 rad，其余五项保持关键帧值，运行 1 s。MuJoCo 4.0.1 WASM 下的积分步长为 0.002 s，肩部实际转角到达 −1.372052 rad，安装点世界坐标约为 `(-0.228792, 0.457301, 0.479916)` m。与相同初态下保持六个 `home` 控制值 1 s 的终点相比，安装点移动了 101.46 mm。

**包内资源。** 两份 MJCF 和 `assets/` 中的 20 个 OBJ 均逐一核对上游 Git blob 哈希，保留原始字节。另附原版 `LICENSE` 和打包归属说明，共 24 个文件，解压后 30,992,844 字节。ZIP 为 4,399,916 字节，SHA-256 为 `a5ba3c3fedb7d08ec230b53f04800a7054396638c6d5659e6030a8ed260d05d1`。[模型包](./model.zip)
