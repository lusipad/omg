# Robotiq 2F-85 自适应夹爪

模型取自 Google DeepMind 的 MuJoCo Menagerie，固定提交 `71f066ad0be9cd271f7ed58c030243ef157af9f4`。该目录依据 Robotiq 双指夹爪的 ROS-Industrial URDF 建模，包含联动机构及指垫接触几何。目录许可为 BSD-2-Clause，版权声明为 “Copyright (c) 2013, ROS-Industrial. All rights reserved.”。[上游模型与说明](https://github.com/google-deepmind/mujoco_menagerie/tree/71f066ad0be9cd271f7ed58c030243ef157af9f4/robotiq_2f85) · [许可证原文](https://github.com/google-deepmind/mujoco_menagerie/blob/71f066ad0be9cd271f7ed58c030243ef157af9f4/robotiq_2f85/LICENSE)

**默认入口为 `scene.xml`**。场景含地面及边长 30 mm 的方块，方块用有限长的 MuJoCo 空间腱连接至上方锚点。单独的 `2f85.xml` 只有夹爪本体，可供其他工位装配。夹爪的 8 个铰链由一个 `fingers_actuator` 联动，控制区间为 0 至 255，使用原生控制单位。两种入口均从默认零位起步。

**复算开闭响应。** 在同一入口中分别给出控制值 `[0]` 和 `[255]`，各从默认状态独立运行 1 s。取左、右指垫刚体 `left_pad`（`body:13`）与 `right_pad`（`body:7`）的世界坐标，计算两原点间的欧氏距离。MuJoCo 4.0.1 WASM 的积分步长为 0.002 s。

| 模型入口 | 0 指令时的末态距离 | 255 指令时的末态距离 | 两次末态距离差 |
| --- | ---: | ---: | ---: |
| `scene.xml`，带悬挂方块 | 98.38 mm | 60.47 mm | 37.91 mm |
| `2f85.xml`，单体夹爪 | 98.38 mm | 14.99 mm | 83.39 mm |

表内距离度量的是指垫刚体原点。接触面的净开口需要按表面几何另行计算。带物体的场景同时模拟悬挂约束和接触响应。

**包内资源。** 两份 MJCF 和 8 个 STL 均逐一核对上游 Git blob 哈希，保留原始字节。另附原版 `LICENSE` 和打包归属说明，共 12 个文件，解压后 3,198,850 字节。ZIP 为 961,311 字节，SHA-256 为 `d5e85f776526b7fd626afe53b9a121c35599bdcd654d88c64eb8c90139c213d5`。[模型包](./model.zip)
