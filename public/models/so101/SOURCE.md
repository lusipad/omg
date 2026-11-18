# SO-101 Follower 模型来源

`follower-bom.md` 摘自同一提交的单从臂采购表。`preview.png` 是本工作台对内置动作在 2.60 s 时的仿真截图。

本目录使用 TheRobotStudio/SO-ARM100 的提交 `a758567c3978dfeefe282ede0500085a48fe8f78`。MuJoCo 从 `scene.xml` 载入 `so101_new_calib.xml`，URDF 从 `so101_new_calib.urdf` 载入。两个模型共用 `assets/` 下的 13 个 STL。[上游模型目录](https://github.com/TheRobotStudio/SO-ARM100/tree/a758567c3978dfeefe282ede0500085a48fe8f78/Simulation/SO101)

**零位与夹爪。** 上游新标定以关节行程中部为虚拟零位的参考，具体限位取自模型。Follower 的 `gripper` 是转动关节，范围约为 −0.174533 至 1.74533 rad（−10° 至 100°）。LeRobot 的夹爪命令用 0 表示全闭、100 表示全开，两种表示需要单独标定映射。[上游标定说明](https://github.com/TheRobotStudio/SO-ARM100/blob/a758567c3978dfeefe282ede0500085a48fe8f78/Simulation/SO101/README.md)

**归属与许可。** 上游将机械臂原始设计归于 The Robot Studio 与 Hugging Face 的合作。模型由 Onshape CAD 通过 onshape-to-robot 导出，STS3215 电机参数参考 Open Duck Mini。仓库根目录附有 Apache License 2.0，本目录保留其原文。该提交的根说明、Simulation 说明及 SO101 模型说明中均未列出单独的硬件许可。[项目说明](https://github.com/TheRobotStudio/SO-ARM100/blob/a758567c3978dfeefe282ede0500085a48fe8f78/README.md) · [参数来源说明](https://github.com/TheRobotStudio/SO-ARM100/blob/a758567c3978dfeefe282ede0500085a48fe8f78/Simulation/SO101/README.md#motor-parameters) · [许可证](./LICENSE)

**完整性。** 已按模型中的 include 与网格引用核对文件集合。3 个模型文件、13 个网格及许可证共 17 个文件，原始字节均通过指定提交的 Git blob SHA-1 校验。可用 `git hash-object --no-filters <本地文件>` 与上游树内的 `sha` 逐项比对。[固定提交的文件树](https://api.github.com/repos/TheRobotStudio/SO-ARM100/git/trees/a758567c3978dfeefe282ede0500085a48fe8f78?recursive=1)
