# v1.6.2

**修复：画像合并（consolidation）白名单**

画像长期为空的问题根因：合并提示词从未把 `profile-schema.json` 的分区白名单传给裁决模型，导致引擎室凭直觉自创分区（如 `background`/`relation`/`preference`）全部被 `partition not in schema` 拒绝，增量几乎 100% 落空。

- 提示词注入完整白名单（partition/topic/subTopic + 各格 temporal 允许集），明确禁止自创分区、evidence ref 必须写成 `cursors.json#<时间戳>` 而非带多余前缀。
- 扩充 schema 槽位：interest 新增 `acg`/`hardware`/`audio`/`writing`/`life`，projects 新增 `heartbeat`/`dsh`/`zcode`，comm 新增 `interaction`/`boundary`，psy 新增 `background`/`social`。
- 修复 `profile rebuild` 写明文 profile.json 的问题（改回 DPAPI 加密写）。
