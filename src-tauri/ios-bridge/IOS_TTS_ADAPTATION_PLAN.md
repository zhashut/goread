# iOS TTS 适配审计与方案

> 审计目标：基于当前 Android 已可用的 TTS 链路，核对 iOS 侧是否具备同等可用能力；对缺失项给出实施方案。本文仅做现状审计与计划，不包含代码实现。

## 审计范围

- `src-tauri/plugins/tauri-plugin-native-tts`
- `src-tauri/src/tts`
- `src/services/tts`
- `src/components/tts`
- `src-tauri/ios-bridge`

## 当前 TTS 架构梳理

当前 TTS 链路可以分为 4 层：

1. 前端客户端选择层  
   `src/components/tts/hooks/createTTSClient.ts` 负责按平台选择 `NativeTTSClient` 或其他客户端。
2. 前端原生 TTS 抽象层  
   `src/services/tts/NativeTTSClient.ts`、`src/services/tts/drivers/NativeSessionDriver.ts`、`src/services/tts/TTSSession.ts` 负责初始化插件、监听事件、驱动托管会话。
3. Rust 托管会话层  
   `src-tauri/src/tts/session_manager.rs` 负责分段取文、补给队列、控制原生会话命令。
4. 原生插件执行层  
   `src-tauri/plugins/tauri-plugin-native-tts` 负责把 Rust 命令下沉到 Android / iOS 原生 TTS 引擎。

结论：  
Rust 层和前端会话协议层已经定义了完整的会话接口，Android 原生执行层也已实现；iOS 目前主要缺的是“原生插件执行层”和“前端平台选路适配”。

## 关键现状确认

### 1. 插件 Rust 层已经预留 iOS 入口

- `src-tauri/plugins/tauri-plugin-native-tts/src/mobile.rs:10`
  - `tauri::ios_plugin_binding!(init_plugin_native_tts);`
- `src-tauri/plugins/tauri-plugin-native-tts/src/mobile.rs:19`
  - `let handle = api.register_ios_plugin(init_plugin_native_tts)?;`

说明 Rust 侧已经把 iOS 视为支持平台，但这里只是“注册入口”，不代表 iOS 原生实现已经存在。

### 2. 插件命令面已经覆盖完整会话协议

- `src-tauri/plugins/tauri-plugin-native-tts/src/lib.rs:36-52`
- `src-tauri/plugins/tauri-plugin-native-tts/src/commands.rs:51-102`

当前已暴露：

- 基础能力：`init`、`set_rate`、`set_voice`、`get_all_voices`、`set_media_session_active`、`open_tts_settings`、`install_tts_data`、`shutdown`
- 会话能力：`tts_session_start`、`tts_session_push`、`tts_session_stop`、`tts_session_pause`、`tts_session_resume`、`tts_session_set_rate`、`tts_session_set_voice`、`tts_session_set_end_of_book`

说明协议层不是问题，真正差异在平台原生落地。

### 3. 插件目录下目前没有 iOS 原生实现目录

当前 `src-tauri/plugins/tauri-plugin-native-tts` 目录仅看到：

- `android`
- `permissions`
- `src`
- `build.rs`
- `Cargo.toml`

未看到与 iOS 原生插件实现对应的目录或 Swift 源码，这说明 iOS 原生插件大概率尚未实现。

### 4. 前端当前没有把 iOS 当成原生 TTS 优先平台处理

- `src/components/tts/hooks/createTTSClient.ts:48`
  - `const isAndroid = (): boolean => /android/i.test(navigator.userAgent || '');`
- `src/components/tts/hooks/createTTSClient.ts:130`
  - `return isAndroid() ? pickClientOnAndroid(normalized) : pickClientOnDesktop(normalized);`

结论：  
iOS 现在会走“桌面分支”，而不是“移动原生分支”。

### 5. NativeTTSClient 的可用性判断仍偏旧桥接模式

- `src/services/tts/NativeTTSClient.ts:76-77`
  - `isAvailable()` 只判断 `window.TTSBridge`
- `src/services/tts/NativeTTSClient.ts:87-89`
  - 实际初始化顺序是先 `#initPlugin()`，失败后才 `#initBridge()`

结论：  
即使后面补齐了 iOS 插件，只要没有 `window.TTSBridge`，当前“是否可用”的前置判断仍可能把 iOS 原生能力挡掉。

### 6. 前端会话层对原生事件的要求已经非常明确

- `src/services/tts/drivers/NativeSessionDriver.ts:200-268`
- `src/services/tts/drivers/NativeSessionDriver.ts:298`

当前依赖的插件事件包括：

- `session_progress`
- `session_request_more`
- `session_waiting_more`
- `session_segment_done`
- `session_paused`
- `session_resumed`
- `session_end`
- `engine_changed`
- `session_engine_changed`

说明 iOS 若要做到“同样逻辑的功能”，不是只做 `speak/stop`，而是要对齐整个会话事件模型。

### 7. Rust 托管会话层可直接复用

`src-tauri/src/tts/session_manager.rs` 已通过 `app.native_tts()` 调用原生会话命令，负责统一内容补给、锚点、结束状态管理。  
只要 iOS 原生插件实现对齐 Android 的会话命令语义，这一层不需要重写。

### 8. `src-tauri/ios-bridge` 已纳入 iOS 工程

- `src-tauri/gen/apple/project.yml:35`
  - `- path: ../../ios-bridge`

说明把 iOS 方案文档放在 `src-tauri/ios-bridge` 是合理的，后续若需要在该目录补充桥接 Swift 文件，也符合当前项目组织方式。

## TTS 功能点逐项核对

| 功能点 | Android 现状 | iOS 现状 | 是否满足 iOS 使用 | 结论 |
| --- | --- | --- | --- | --- |
| 插件注册入口 | 已实现 | Rust 侧已预留 `register_ios_plugin` | 部分满足 | 只有入口，没有原生实现 |
| 插件基础初始化 `init` | 已实现 | 无明确 Swift 实现 | 不满足 | 需补 iOS 原生初始化、音频会话、语音列表缓存 |
| 获取语音列表 `get_all_voices` | 已实现 | 无明确实现 | 不满足 | 需映射 `AVSpeechSynthesisVoice` 到现有 `TTSVoice` |
| 设置语速 `set_rate` | 已实现 | 无明确实现 | 不满足 | 需做 Android/前端速率到 iOS `utterance.rate` 的换算策略 |
| 设置语音 `set_voice` | 已实现 | 无明确实现 | 不满足 | 需支持按 `voice_id` 绑定系统声音 |
| 基础停止/暂停/继续 | 已实现 | 无明确实现 | 不满足 | 需补齐 `stopSpeaking` / `pauseSpeaking` / `continueSpeaking` 行为 |
| 托管会话启动 `tts_session_start` | 已实现 | 无明确实现 | 不满足 | 需实现队列启动、首段开播、状态切换 |
| 托管会话补给 `tts_session_push` | 已实现 | 无明确实现 | 不满足 | 需实现运行中追加段落 |
| 托管会话停止 `tts_session_stop` | 已实现 | 无明确实现 | 不满足 | 需清空队列、结束事件、重置状态 |
| 托管会话暂停/恢复 | 已实现 | 无明确实现 | 不满足 | 需对齐会话状态机与事件 |
| 会话内动态改语速 | 已实现 | 无明确实现 | 不满足 | 需定义对当前段和后续段的生效策略 |
| 会话内动态切换声音 | 已实现 | 无明确实现 | 不满足 | 需定义切换时机与中断策略 |
| 结束标记 `tts_session_set_end_of_book` | 已实现 | 无明确实现 | 不满足 | 需支持“无更多内容”语义 |
| 进度事件 `session_progress` | 已实现 | 无明确实现 | 不满足 | 前端高亮与阅读位置恢复依赖该事件 |
| 段落完成事件 `session_segment_done` | 已实现 | 无明确实现 | 不满足 | 前端会话推进依赖该事件 |
| 补给请求事件 `session_request_more` | 已实现 | 无明确实现 | 不满足 | 托管会话低水位补给依赖该事件 |
| 等待补给事件 `session_waiting_more` | 已实现 | 无明确实现 | 不满足 | 前端需要感知等待中状态 |
| 会话结束事件 `session_end` | 已实现 | 无明确实现 | 不满足 | 前端统一收口依赖该事件 |
| 引擎切换事件 `engine_changed` | 已实现 | iOS 无同等系统语义 | 不满足，但可降为不支持 | 建议明确标记为 Android 特有，不强行仿真 |
| 后台播放保活 | Android 前台服务已实现 | iOS 尚无对应方案 | 不满足 | 需改为 `AVAudioSession` + iOS 后台音频能力 |
| 打开系统 TTS 设置 | 已实现 | iOS 无直接等价入口 | 不满足 | 需定义为“不支持”或跳转应用设置页 |
| 安装 TTS 数据 | 已实现 | iOS 无直接等价入口 | 不满足 | 需定义为“不支持” |
| 前端选路到原生 TTS | Android 优先走原生 | iOS 被归到桌面链路 | 不满足 | 需新增 iOS 平台分支 |
| NativeTTSClient 可用性探测 | Android 可走插件或桥接 | iOS 仍受 `window.TTSBridge` 限制 | 不满足 | 需改为“插件可用”与“桥接可用”分离判断 |

## 缺口归类

### A. 必做缺口

这些能力不补齐，iOS 无法达到“与 Android 同样逻辑”的可用标准：

1. iOS 原生插件执行层
2. iOS 会话状态机与事件回传
3. iOS 后台播放音频会话
4. 前端平台选路适配
5. NativeTTSClient 可用性判断修正

### B. 可明确声明为平台差异的缺口

这些能力 Android 有，但 iOS 不一定存在系统等价物，建议在方案中显式区分，而不是硬做伪兼容：

1. `engine_changed` / `session_engine_changed`
2. `open_tts_settings`
3. `install_tts_data`

## iOS 实施方案

### 方案 1：补齐 iOS 原生插件，与 Android 会话协议对齐

这是推荐方案，也是最符合现有架构的方案。

#### 目标

在不重写前端会话与 Rust 托管逻辑的前提下，为 `tauri-plugin-native-tts` 增加 iOS 原生实现，使 iOS 能复用现有协议与业务流程。

#### 设计原则

1. 复用现有接口，不新造协议。
2. 对齐 Android 的事件名与命令名，避免前端分叉。
3. 仅对平台差异项做显式声明，不加模糊兜底。
4. 优先保证托管会话、高亮同步、补给逻辑一致。

### 分阶段计划

#### 阶段一：补齐 iOS 原生插件骨架

目标：让 Rust `register_ios_plugin` 对应到真正可执行的 Swift 插件实现。

计划要点：

1. 在 `src-tauri/plugins/tauri-plugin-native-tts` 下新增 iOS 原生插件工程结构与 Swift 入口。
2. 提供与 Rust 当前命令面一致的 iOS 命令实现：
   - `init`
   - `set_rate`
   - `set_voice`
   - `get_all_voices`
   - `shutdown`
   - `tts_session_start`
   - `tts_session_push`
   - `tts_session_stop`
   - `tts_session_pause`
   - `tts_session_resume`
   - `tts_session_set_rate`
   - `tts_session_set_voice`
   - `tts_session_set_end_of_book`
3. 底层使用 `AVSpeechSynthesizer` 作为引擎。
4. 建立 Swift 数据模型与现有 Rust/TS 协议字段的一一映射。

验收标准：

1. iOS 构建时插件可成功注册。
2. 所有现有原生命令可被调用，不出现“方法不存在”类错误。

#### 阶段二：实现 iOS 会话状态机

目标：让 iOS 原生层具备与 Android `TTSEngineRunner` 对齐的会话语义。

计划要点：

1. 在 iOS 侧建立最小必要状态机：
   - `Idle`
   - `Playing`
   - `RequestingMore`
   - `WaitingForMore`
   - `Paused`
   - `Completed`
   - `Stopped`
   - `Error`
2. 维护段落队列、当前段、已结束标记、等待补给标记。
3. 以 `AVSpeechSynthesizerDelegate` 驱动段落完成、暂停恢复、结束状态变更。
4. 在低水位时发出 `session_request_more`，无补给时发出 `session_waiting_more`。
5. 发出与 Android 对齐的事件载荷：
   - `session_progress`
   - `session_segment_done`
   - `session_request_more`
   - `session_waiting_more`
   - `session_paused`
   - `session_resumed`
   - `session_end`

重点说明：

- `session_progress` 不能只表示“开始朗读了”，还要带上当前段落的 `segmentId`、`sectionIndex`、`chunkIndex`、`cursor`、`anchor`，否则前端高亮与阅读位置恢复无法复用。

验收标准：

1. Rust 托管会话层无需改协议即可驱动 iOS。
2. 前端 `NativeSessionDriver` 可直接消费 iOS 事件。

#### 阶段三：补齐 iOS 语音、语速、声音切换策略

目标：把基础参数控制做成稳定可用，而不是仅能播报。

计划要点：

1. 用 `AVSpeechSynthesisVoice.speechVoices()` 构造 `TTSVoice[]`。
2. 统一 `voice_id` 映射规则，保证前端持久化后的 `voiceId` 能重新命中。
3. 建立前端速率到 iOS `utterance.rate` 的换算表，避免 Android 速率值直接套到 iOS 后过快或过慢。
4. 明确动态切换规则：
   - `tts_session_set_rate`：至少对后续未播段落生效
   - `tts_session_set_voice`：至少对后续未播段落生效
5. 如 iOS 对“当前正在播报的 utterance”无法无损热切换，则在方案中明确为“从下一段生效”，不要做不稳定的强行打断。

验收标准：

1. 语音列表可正常展示。
2. 切换语音和语速后，行为稳定且规则清晰。

#### 阶段四：补齐 iOS 后台播放能力

目标：在 iOS 后台、锁屏或息屏场景下尽量保持朗读连续性。

计划要点：

1. 参考 `src-tauri/ios-bridge/VolumeKeyBridge.swift:96-97` 现有做法，统一使用 `AVAudioSession` 管理音频会话。
2. 为 TTS 播放选择合适的 `AVAudioSession` category / options。
3. 补充 iOS 工程的后台音频能力声明。
4. 明确 `set_media_session_active` 在 iOS 的语义：
   - Android：更接近通知/媒体会话保活
   - iOS：更接近音频会话激活/停用
5. 若锁屏媒体控制暂不做，则应在方案中明确“先保证后台连续播放，再考虑远程控制中心集成”。

验收标准：

1. App 退到后台后，朗读不立即中断。
2. 回到前台后会话状态与前端保持一致。

#### 阶段五：修正前端 iOS 选路与可用性检测

目标：让补齐后的 iOS 插件能被前端正确发现和使用。

计划要点：

1. 调整 `src/components/tts/hooks/createTTSClient.ts`，新增 iOS 平台识别，不再把 iOS 直接并入桌面分支。
2. 调整 `src/services/tts/NativeTTSClient.ts`：
   - `isAvailable()` 不再只依赖 `window.TTSBridge`
   - 区分“插件可用”和“旧桥接可用”
3. 确保初始化顺序仍为：
   - 优先插件
   - 其次旧桥接
4. 检查设置页与播放页所有直接依赖 `window.TTSBridge` 的入口，统一收敛到 `NativeTTSClient` 抽象。

验收标准：

1. iOS 可稳定走插件链路。
2. 不影响 Android 现有行为。
3. 不影响桌面现有行为。

#### 阶段六：明确平台差异项

目标：把不能等价实现的能力显式定义出来，避免伪兼容。

计划要点：

1. `engine_changed` / `session_engine_changed`
   - 建议标记为 Android 特有
   - iOS 不主动发此事件
2. `open_tts_settings`
   - 建议改为 iOS 返回“不支持”或仅跳转应用设置页
3. `install_tts_data`
   - 建议在 iOS 直接返回“不支持”
4. 前端收到“不支持”时，应保持可预期行为，不把它误判为 TTS 主流程失败。

验收标准：

1. 平台差异项行为可预期。
2. 不引入“为了兼容而兼容”的隐式分支。

## 推荐执行顺序

1. 先做原生插件骨架与基础命令
2. 再做会话状态机与事件回传
3. 再做语音/语速/声音切换
4. 再做后台播放能力
5. 最后做前端选路修正与平台差异收口

原因：  
会话协议打通之前，前端改选路没有验证价值；而后台播放与平台差异收口都依赖前面能力已稳定。

## 风险与注意事项

1. iOS `AVSpeechSynthesizer` 的暂停、恢复、切换声音能力与 Android `TextToSpeech` 并不完全等价，需要以“后续段落生效”为优先策略。
2. `session_progress` 若拿不到稳定的逐词回调，就要以“段开始时发当前段进度”作为最低保真方案，但字段必须保持完整。
3. 后台播放依赖 iOS 工程能力声明，不能只改插件代码。
4. `engine_changed` 这类 Android 语义不要强搬到 iOS，否则前端会产生伪状态。

## 最终结论

当前项目的 TTS 架构已经为 iOS 预留了 Rust 协议入口，也已经具备可复用的前端会话层与 Rust 托管会话层；但是 `tauri-plugin-native-tts` 目录下尚未看到 iOS 原生实现，因此当前 iOS 不能视为已经适配完成。

iOS 要达到“与 Android 同样逻辑的功能”，至少需要补齐以下 5 件事：

1. iOS 原生插件执行层
2. iOS 会话状态机与事件回传
3. iOS 后台音频会话方案
4. 前端 iOS 平台选路
5. NativeTTSClient 可用性检测修正

其中：

- `engine_changed`
- `open_tts_settings`
- `install_tts_data`

建议视为平台差异项，明确声明不支持或采用 iOS 可接受的替代语义，而不是硬做伪兼容。
