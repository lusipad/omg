# LeKiwi 移动操作机器人

网页提供的 `model.zip` 大小为 5,883,386 字节，SHA-256 为 `a5e3486bcff0fe284e57faa8ba49e0174345c143c3b5b58b32fe9a3a438c535d`。

模型取自 SIGRobotics-UIUC/LeKiwi 的提交 `efa608d7ee5a495a4803b1d28cd0c955b4f1e033`。项目说明列出三全向轮 Kiwi 底盘和 SO-ARM101 机械臂。本包采用该提交的整机 CAD 导出。部分连杆沿用 CAD 中的 `SO_ARM100_08k` 名称。[项目说明](https://github.com/SIGRobotics-UIUC/LeKiwi/blob/efa608d7ee5a495a4803b1d28cd0c955b4f1e033/README.md) · [原始 URDF 和网格](https://github.com/SIGRobotics-UIUC/LeKiwi/tree/efa608d7ee5a495a4803b1d28cd0c955b4f1e033/URDF)

## 打开和观察

直接导入 `model.zip`，或解压后从 `LeKiwi.urdf` 打开。包内 `meshes/` 使用相对路径。URDF 的三个轮轴和六个机械臂关节均为连续转动关节。轮轴名为 `base_back_wheel`、`base_right_wheel` 和 `base_left_wheel`。臂关节依次为 `arm_shoulder_pan`、`arm_shoulder_lift`、`arm_elbow_flex`、`arm_wrist_flex`、`arm_wrist_roll` 和 `arm_gripper`。[上游关节名对照](https://github.com/SIGRobotics-UIUC/LeKiwi/blob/efa608d7ee5a495a4803b1d28cd0c955b4f1e033/URDF/JOINT_NAMES.md)

在构元的 MuJoCo 4.0.1 WASM 运行器中，选择夹爪刚体 `Moving_Jaw_08d-v1`，从默认姿态运行 0.1 秒。积分步长为 0.002 秒，重力为 (0, 0, −9.81) m/s²。该刚体原点的世界坐标从 (−0.024600, 0.134836, 0.134208) m 变为 (−0.018950, 0.129916, 0.119028) m。此演示观察重力与接触作用下的被动响应。

该 URDF 将底盘固定在世界坐标中，把每个全向轮建为一个刚体。MuJoCo 编译出 9 个关节自由度、0 个控制输入和 0 个 site。底盘平移、轮上各滚子的独立接触、舵机控制和实物运动范围均超出该演示的建模范围。夹爪观测值取 CAD 刚体原点。[固定版本模型](https://github.com/SIGRobotics-UIUC/LeKiwi/blob/efa608d7ee5a495a4803b1d28cd0c955b4f1e033/URDF/LeKiwi.urdf)

## 入库适配

- 原 URDF 的 45 个 STL 文件名对应 27 份不同的 Git blob。本包按完整 blob 的 SHA-1 核对内容，将相同网格的引用指向同一个文件。位置、旋转、网格缩放、关节和惯性项沿用上游数据。
- 原始全向轮 STL（Git blob `0d1af9d6efec5aeb542ea673bb3f483754058c2b`）有 314244 个三角面，超过 MuJoCo 4.0.1 的单 STL 解码上限 200000 面。本包将轮子转换为 OBJ，以原毫米坐标、面次序和绕序写出全部三角面，共享 157080 个不同顶点。法线由加载器从几何生成。其余 26 份 STL 保留上游字节。[上游轮子网格](https://github.com/SIGRobotics-UIUC/LeKiwi/blob/efa608d7ee5a495a4803b1d28cd0c955b4f1e033/URDF/meshes/4-Omni-Directional-Wheel_Single_Body-v1.stl)
- 模型编译含 27 个网格、493842 个三角面。通用运行器在三维视图中合并同位视觉与碰撞几何，显示 45 个构件。

上游附 Apache License 2.0。压缩包内的 `LICENSE.txt` 保留许可证原文，URDF 和转换后的 OBJ 带有修改说明。该提交的仓库树中没有单列 NOTICE 文件。[上游许可证](https://github.com/SIGRobotics-UIUC/LeKiwi/blob/efa608d7ee5a495a4803b1d28cd0c955b4f1e033/LICENSE.txt)
