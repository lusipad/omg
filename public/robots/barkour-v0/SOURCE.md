# Google Barkour v0 四足机器人

Barkour v0 是 Google 开发的四足机器人。这个模型包取自 Google DeepMind 的 MuJoCo Menagerie，固定提交为 `71f066ad0be9cd271f7ed58c030243ef157af9f4`。选择入口 `scene.xml` 可加载平地场景和原始机器人描述 `barkour_v0.xml`。[上游模型目录](https://github.com/google-deepmind/mujoco_menagerie/tree/71f066ad0be9cd271f7ed58c030243ef157af9f4/google_barkour_v0) · [平地场景](https://github.com/google-deepmind/mujoco_menagerie/blob/71f066ad0be9cd271f7ed58c030243ef157af9f4/google_barkour_v0/scene.xml) · [机器人描述](https://github.com/google-deepmind/mujoco_menagerie/blob/71f066ad0be9cd271f7ed58c030243ef157af9f4/google_barkour_v0/barkour_v0.xml)

## 署名与分发

Copyright 2023 DeepMind Technologies Limited. 本模型采用 Apache-2.0。压缩包保留上游 `LICENSE` 全文和含作者、引用信息的 `README.md`，另附 `UPSTREAM.txt` 记录提交和入口。经核对，该提交的模型目录和仓库根目录均无独立 `NOTICE` 文件。[模型许可证](https://github.com/google-deepmind/mujoco_menagerie/blob/71f066ad0be9cd271f7ed58c030243ef157af9f4/google_barkour_v0/LICENSE) · [上游署名与论文引用](https://github.com/google-deepmind/mujoco_menagerie/blob/71f066ad0be9cd271f7ed58c030243ef157af9f4/google_barkour_v0/README.md)

学术使用请引用 Ken Caluwaerts 等人在 2023 年发表的《Barkour: Benchmarking Animal-level Agility with Quadruped Robots》。[论文](https://arxiv.org/abs/2305.14654)

## 模型包校验

| 项目 | 值 |
| --- | --- |
| 文件 | [model.zip](./model.zip) |
| ZIP 的 SHA-256 | `f20e08d9a44b0a622abe879e73decd4be25f5a3201e76d26f610857d6f4ef970` |
| 压缩大小 | 3,799,238 字节 |
| 解压大小 | 10,501,159 字节，共 19 个文件 |
| 场景内容 | 2 个 MJCF 文件和模型引用的 14 个 STL 网格 |
| 模型规模 | 6 个浮动机身自由度、12 个腿部铰链、12 个执行器 |

两个 MJCF、14 个 STL、许可证和上游说明均逐文件核对了固定提交的 Git 对象哈希。

## 站姿保持工况

从上游关键帧 `standing` 开始，连续运行 1 秒，追踪刚体 `chassis` 的世界坐标。关键帧将机身放在 0.210 m 高处，并为每条腿的外展、髋、膝执行器分别设置 0、0.5、1.0 rad。本工况保持这 12 路控制值，用于观察重力、足地接触和关节伺服共同作用下的机身沉降。步态与越障需要单独的控制策略。

下表是 MuJoCo 4.0.1 WASM 对此模型的计算结果。重力为 −9.81 m/s²，积分步长取自源模型的 1 ms，工作台每 20 ms 记录一次，共 51 帧。

| 时间（s） | 机身高度（m） | 右前膝反馈角（rad） |
| ---: | ---: | ---: |
| 0.0 | 0.210000 | 1.000000 |
| 0.1 | 0.173199 | 0.853110 |
| 0.2 | 0.162071 | 0.749859 |
| 0.5 | 0.172172 | 0.834820 |
| 1.0 | 0.174825 | 0.860080 |
