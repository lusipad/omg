# Open Duck Mini v2 机器鸭

作者为 Antoine Pirrone（apirrone）与 Open Duck Mini 贡献者。此包取自 `apirrone/Open_Duck_Mini` 的 `v2` 分支，固定提交为 `b23317a485b3cec7d8417f352478778b3475173c`。上游根目录采用 Apache License 2.0，压缩包保留原版 `LICENSE` 和贡献者致谢 `thanks.md`。该提交的模型目录没有单独的许可或 NOTICE 文件。[上游模型](https://github.com/apirrone/Open_Duck_Mini/tree/b23317a485b3cec7d8417f352478778b3475173c/mini_bdx/robots/open_duck_mini_v2) · [许可证](https://github.com/apirrone/Open_Duck_Mini/blob/b23317a485b3cec7d8417f352478778b3475173c/LICENSE) · [贡献者](https://github.com/apirrone/Open_Duck_Mini/blob/b23317a485b3cec7d8417f352478778b3475173c/thanks.md)

**默认入口为 `scene_position.xml`。** 它载入原版 `robot.xml`、45 个 STL 和地面。模型固定住躯干，高度基准为 0.4 m，双腿、头颈和两根天线由 16 个铰链及 16 个位置执行器驱动。场景使用模型默认零位，未定义初始关键帧。可观察转头、摆动天线或屈膝。[上游位置控制场景](https://github.com/apirrone/Open_Duck_Mini/blob/b23317a485b3cec7d8417f352478778b3475173c/mini_bdx/robots/open_duck_mini_v2/scene_position.xml) · [位置执行器模型](https://github.com/apirrone/Open_Duck_Mini/blob/b23317a485b3cec7d8417f352478778b3475173c/mini_bdx/robots/open_duck_mini_v2/robot.xml)

**复算转头动作。** 选 `left_antenna_holder`（左天线支架，`body:15`）作为观测点，给 `head_yaw` 设置 0.25 rad。控制向量按执行器顺序为 `[0,0,0,0,0,0,0,0.25,0,0,0,0,0,0,0,0]`。从默认状态运行 0.4 s，在本平台 MuJoCo 4.0.1 WASM 中积分步长为 0.002 s，实际关节相对偏航角为 0.246071 rad。以相同初始状态和时长用全零控制再运行，两个末态的左天线支架世界位置相差 23.67 mm。

**浮动基座入口为 `scene.xml`。** 它载入上游的 `robot_motors.xml`，在 16 个铰链之外增加一个自由关节，16 个执行器接收原生 motor 控制。可选择 `base` 为观测点，以全零控制运行 0.08 s 观察重力和地面接触下的短时响应。要复现作者的行走演示，还需使用上游单独提供的策略和控制程序。[上游浮动场景](https://github.com/apirrone/Open_Duck_Mini/blob/b23317a485b3cec7d8417f352478778b3475173c/mini_bdx/robots/open_duck_mini_v2/scene.xml) · [上游策略说明](https://github.com/apirrone/Open_Duck_Mini/blob/b23317a485b3cec7d8417f352478778b3475173c/README.md#state-of-sim2real)

**资源核对。** 4 个 MJCF 文件与两个场景共用的 45 个网格均按上游 Git blob 哈希核对，保留原始字节。ZIP 内另含许可证、致谢及来源说明，共 52 项，解压后 18,790,759 字节。ZIP 为 5,930,499 字节，SHA-256 为 `f9a2db9b36ffe5029d6db270a27ffcfa3eacd4662d9dcc4cc5123e6503cab0c2`。[模型包](./model.zip)
