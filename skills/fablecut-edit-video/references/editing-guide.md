# FableCut 剪辑参考

## 目录

- 项目结构
- 片段语义
- 属性参考
- 文本与动画
- 关键帧、转场和调整层
- 动画 SVG
- 常用配方
- 交付检查

## 项目结构

时间线是一个 JSON 文档：

```json
{
  "name": "My Edit",
  "width": 1280,
  "height": 720,
  "fps": 30,
  "background": "#000000",
  "revision": 7,
  "markers": [{"t": 2.5}, {"t": 5, "label": "drop"}],
  "inPoint": 0,
  "outPoint": 12,
  "disabledTracks": ["A2"],
  "media": [
    {
      "id": "m_intro",
      "name": "intro.mp4",
      "kind": "video",
      "src": "/projects/my-edit/media/intro.mp4",
      "duration": 12.4,
      "width": 1920,
      "height": 1080
    }
  ],
  "clips": [
    {
      "id": "c_intro",
      "mediaId": "m_intro",
      "kind": "video",
      "track": "V1",
      "start": 0,
      "in": 2.5,
      "duration": 5,
      "props": {"fit": "cover"},
      "keyframes": {
        "scale": [{"t": 0, "v": 1}, {"t": 5, "v": 1.2, "ease": "linear"}]
      },
      "transitionOut": {"type": "fade", "duration": 0.5}
    }
  ]
}
```

`media.kind` 支持 `video`、`audio`、`image`、`svg`。文本和调整层没有媒体记录。

`clip.kind` 支持 `video`、`audio`、`image`、`svg`、`text`、`adjust`。`text` 和 `adjust` 的 `mediaId` 为 `null`。

## 片段语义

- `start`：片段在时间线中的起点，单位秒。
- `in`：源素材入点，单位秒；图片、SVG、文本和调整层通常为 0。
- `duration`：时间线长度，单位秒。
- `track`：V1 先绘制，V2、V3 依次覆盖；A1–A4 放独立音频或视频的关联声道。
- `linkGroup`：画面与关联音频共享的可选联动 ID。
- 静态变速必须满足 `in + duration × speed ≤ media.duration`。
- 切分片段时，前段长度为 `t`；后段的 `start` 增加 `t`，`in` 增加 `t × speed`。
- 同轨重叠加后一个片段的淡入转场即为交叉淡化。
- 缺省属性使用默认值；不要为了完整而写入所有默认属性。
- 修改完整文档时必须基于最新 revision；优先使用 merge-safe patch。

## 属性参考

### 变换与合成

| 属性 | 默认值 | 说明 |
| --- | --- | --- |
| `x`、`y` | 0 | 相对画布中心的像素偏移 |
| `scale` | 1 | 缩放 |
| `rotation` | 0 | 角度 |
| `opacity` | 1 | 0–1 |
| `blend` | `normal` | `multiply`、`screen`、`overlay`、`lighter`、`soft-light`、`hard-light`、`color-dodge`、`darken`、`lighten`、`difference` |

### 布局

| 属性 | 默认值 | 说明 |
| --- | --- | --- |
| `fit` | `contain` | `contain`、`cover`、`stretch`、`none` |
| `cropL/R/T/B` | 0 | 各边裁切百分比 |
| `cornerRadius` | 0 | 圆角像素 |
| `flipH`、`flipV` | false | 水平或垂直翻转 |

### 调色与特效

| 属性 | 默认值 | 说明 |
| --- | --- | --- |
| `filterPreset` | `none` | `cinematic`、`teal-orange`、`noir`、`vintage`、`faded`、`warm`、`cold`、`pop`、`dreamy`、`retro`、`bw-soft`、`cyberpunk`、`sunset`、`midnight` |
| `brightness`、`contrast`、`saturation` | 100 | 百分比，100 为中性 |
| `hue` | 0 | 色相角度 |
| `temperature`、`tint` | 0 | -100 到 100 |
| `blur` | 0 | 模糊像素 |
| `grayscale`、`sepia`、`invert`、`vignette` | 0 | 百分比 |
| `shake` | 0 | 镜头抖动像素 |
| `shakeSpeed` | 8 | 抖动频率 |
| `rgbSplit` | 0 | RGB 分离像素 |
| `grain` | 0 | 动态颗粒百分比 |

### 抠像与音频

| 属性 | 默认值 | 说明 |
| --- | --- | --- |
| `chromaKey` | 空 | 键色，例如 `#00ff00` |
| `chromaTolerance` | 26 | 颜色容差 0–100 |
| `chromaSoftness` | 12 | 边缘柔化与溢色抑制 0–100 |
| `bgRemove` | false | 浏览器内人物背景移除，首次使用需要联网 |
| `volume` | 1 | 音量 0–2 |
| `speed` | 1 | 播放速度 0.25–4，可设关键帧 |

## 文本与动画

常用文本属性：

| 属性 | 默认值 | 说明 |
| --- | --- | --- |
| `text` | `Title` | 支持换行 |
| `fontSize` | 72 | 字号 |
| `font` | `Segoe UI` | 系统字体、素材库字体或 Google Font 名称 |
| `color`、`color2` | 白、空 | 填充色；设置 `color2` 后使用渐变 |
| `bold`、`weight`、`italic` | true、0、false | `weight` 非零时覆盖 bold |
| `uppercase` | false | 转为大写 |
| `align` | `center` | `left`、`center`、`right`、`justify` |
| `boxW`、`boxH` | 0 | 文本框尺寸；0 表示贴合内容 |
| `boxFit` | false | 缩小字体以适应文本框 |
| `vAlign` | `middle` | `top`、`middle`、`bottom` |
| `direction` | `auto` | `auto`、`ltr`、`rtl` |
| `letterSpacing`、`lineHeight` | 0、1.2 | 字距与行高 |
| `strokeWidth`、`strokeColor` | 0、黑 | 描边 |
| `bgColor`、`bgOpacity` | 黑、0 | 行背景胶囊 |
| `textShadow` | 12 | 柔和阴影 |
| `glow`、`glowColor` | 0、空 | 霓虹辉光 |
| `textAnim` | `none` | `typewriter`、`word-pop`、`word-slide`、`karaoke`、`letter-pop`、`wave`、`bounce`、`shake`、`clip-reveal`、`zoom-in`、`font-cut`、`rise-mask` |
| `wordRate` | 0.15 | 动画步进秒数 |
| `fontCutSet` | 内置组合 | `font-cut` 循环使用的字体数组 |

展示标题不要整片复用同一种字体。常见组合：

- 冲击标题：Anton、全大写、`word-pop`、大阴影。
- 优雅标题：Playfair Display、白金渐变、`clip-reveal`。
- 动感标题：Bebas Neue、`font-cut`。
- 霓虹标题：Bebas Neue、青色 glow、`wave`。
- 手写标题：Caveat、轻微旋转、`word-slide`。
- 字幕：Roboto、小字号、底部背景胶囊、`karaoke`。
- 下三分之一：Archivo Black、`rise-mask`。

## 关键帧、转场和调整层

关键帧时间相对片段起点。`ease` 写在每段的目标关键帧上，支持 `linear`、`ease-in`、`ease-out`、`ease-in-out`。存在关键帧时，它会覆盖同名静态属性。

可动画属性包括 `x`、`y`、`scale`、`rotation`、`opacity`、`volume`、`speed`、主要调色属性、`cornerRadius`、`shake`、`rgbSplit`、`grain`、`fontSize`、`letterSpacing`、`glow`。

转场类型：`fade`、`slide-left/right/up/down`、`zoom`、`wipe-left/right/up/down`、`iris`、`spin`、`blur`、`whip`、`glitch`、`pop`。转场叠加在关键帧结果上；fade 同时作用于音频。

调整层使用 `kind: "adjust"`、`mediaId: null`，放在 V2/V3，对下方画面统一应用调色、颗粒、RGB 分离、抖动和透明度。

## 动画 SVG

- 根 `<svg>` 设置 `width`、`height` 或 `viewBox`。
- 使用 `<style>` 中的 CSS `@keyframes`；不要使用 SMIL `<animate>`。
- 不写固定 `animation-delay`，改用元素属性 `style="--d:0.4s"`。
- 一次性动画使用 `animation-fill-mode: both`，循环动画使用 `infinite`。
- 自身中心旋转或缩放时设置 `transform-box: fill-box; transform-origin: center`。
- 保持文件自包含，不引用外部资源。
- 用 `import-media` 上传 SVG，再作为 `kind: "svg"` 的片段放到视频轨。

## 常用配方

- 粗剪：V1 片段首尾相接，后一个 `start` 等于前面时长累加。
- 标题卡：文本片段放 V2，设置 `text`、`font`、`fontSize`、`color`。
- 音乐底：音频放 A1，`volume: 0.2–0.4`，片尾淡出。
- 电影调色：跨全片调整层使用 `filterPreset: "cinematic"` 和少量 grain。
- 绿幕：主体放 V2，设置 `chromaKey`、容差与柔化；背景放 V1。
- 画中画：V3 使用 `scale: 0.35`、位置偏移、圆角和 slide 转场。
- Ken Burns：图片的 scale 从 1 线性到 1.2，并缓慢移动 x 或 y。
- 交叉淡化：同轨重叠约 1 秒，后片段设置 fade 入场。
- 鞭甩切换：前后片段使用约 0.25 秒 whip 转场。
- 节拍剪辑：把节拍时间写入 markers，并让片段起点对齐 markers。
- 变速落点：先快后慢的 speed 关键帧在节拍处落到慢速；确认源素材足够。
- 冲击帧：V3 放 0.25–0.4 秒调整层，设置 shake 与 rgbSplit；A2 对齐冲击音效。
- 霓虹字幕：白字、青色 glow、Bebas Neue、`wave`。
- 短视频画幅：项目设为 1080×1920，字幕避开上下平台 UI 区域。

## 交付检查

- 确认项目宽高与 FPS 符合发布平台。
- 检查片段是否越过源素材时长，是否存在意外黑场或公共空隙。
- 检查对白、音乐和音效的相对响度，给音乐片尾添加淡出。
- 检查字幕拼写、阅读速度、对比度、方向和安全区。
- 检查关键帧时间均在片段 duration 内，转场长度合理。
- 用 compact 时间线复核轨道、起点、时长和素材引用，再让用户在浏览器预览并导出。
