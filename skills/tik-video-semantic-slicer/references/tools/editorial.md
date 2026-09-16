# 内容审核与视听验收

商品标注、完整语义组写入 content.json；格式见 pipeline-io.md。先用 selection_tools.py estimate 试算，再渲染草稿审核，不必先建远端工程。

## 审核记录

```bash
python3 "$SKILL_DIR/scripts/selection_tools.py" review-draft --sentences "$RUN_DIR/intermediate/sentences.json" --selection "$RUN_DIR/intermediate/keep_selection.json" --config "$RUN_DIR/intermediate/edit_config.json" --content "$RUN_DIR/intermediate/content.json" > "$RUN_DIR/intermediate/review.json"
```

命令生成指纹、待填检查和少量重复风险提示，不自动通过。已有审核先保留上一版再生成；需继续记录之前问题如何处理。逐项填写 checks 的 indices、status（pass/pending）、evidence：

| rule | 检查依据 |
| --- | --- |
| product | 同款身份、换款边界、跨段属性归属 |
| meaning | 整组主干完整、前后依赖/指代、跳接与收束 |
| repetition | 相邻及全片表达是否有信息增量 |
| hook | 所选声音兼容、开头承诺及后续承接 |
| constraints | 价格/直播话术/第三方名称、品牌红线、用户排除项 |
| speech | 口吃、疑似转写错误及复听或换句结果 |

每项关联本轮选中编号，除 hook 聚焦开头及承接外，其余项覆盖全部选中编号；写具体依据，不能只填“已检查”。发现的问题在 issues 中记录 id、indices、reason、status、resolution；status 为 pending/resolved/dismissed，后两者须说明处理或排除理由。工具提示可能误报，不能机械删句，也不能直接忽略。模型发现的商品错配、近义重复等也要记入，不局限于工具提示。

选句、配置、内容标注或句子数据改变后指纹失效，重新阅读当前草稿并审核；不能只抄新指纹。build_edit_ops 拒绝缺失、过期、不完整或仍有未解决问题的记录。它只确认记录完整，无法证实模型判断正确。

## 能力与验收

准备阶段根据模型和工具说明判断能否看图、听音频、浏览器预览；不确定时用一小段代表性素材检查一次，不先批量抽帧。媒体工具返回成功不代表模型看过或听过。

review.json 的 media.visual / media.audio 各记录 status 与 evidence：
- pending：尚未检查。
- unavailable：当前能力不支持；写具体缺失能力。
- pass：已实际检查；写成片时间/源时间与观察依据。

选句阶段优先检查换款边界和属性画面，提交后在工程预览中检查开头、跨段跳接及结尾；用户要求导出时再检查 MP4。可试听时完整试听；不能用图片推断切点听感，不能把源片抽帧称为成片验收。视听状态绑定当前方案，换句或修改速度等后重新检查。

已知商品/语义冲突须解决后才能提交；视听能力缺失可交预览链接并说明待验，不为验收自动导出。视听发现问题则记录、修正、重新提交并审核预览，不保持 pass。

```bash
python3 "$SKILL_DIR/scripts/selection_tools.py" check-review --sentences "$RUN_DIR/intermediate/sentences.json" --selection "$RUN_DIR/intermediate/keep_selection.json" --config "$RUN_DIR/intermediate/edit_config.json" --content "$RUN_DIR/intermediate/content.json" --review "$RUN_DIR/intermediate/review.json"
```

工程校验、内容审核、画面与听感状态分别记录。默认交付预览 URL，有待验项时简要说明；独立配置、content、review、submitted_mapping 留在作业目录，不在原生 project.json 内，按需提供。
