# 提交到 dsh-plugin.org 的 Issue 草稿

在 <https://github.com/dshplugin/dsh-plugin-hub/issues/new> 选择「插件提交」模板后粘贴以下内容。

> **已提交**：<https://github.com/dshplugin/dsh-plugin-hub/issues/823>（2026-11-17，等待扫描/人工核实；
> 收录后页面为 <https://dsh-plugin.org/zh/plugins/vacum972/dsh-page-translate>）

标题：`[插件提交] vacum972/dsh-page-translate — 右侧边栏浏览器的沉浸式双语网页翻译`

正文：

```
### 仓库地址
https://github.com/vacum972/dsh-page-translate

### 一句话价值
在 DSH 右侧边栏的浏览器里把网页翻成双语对照：原文保留、译文插到对应段落下方（短标题同行、长段落另起一行带红色竖线），支持整站自动翻译、滚动/懒加载续翻，以及 Google / Bing 双引擎切换。

### 能力分类
界面与体验

### 安装命令
已发布 NPM 包时：dsh plugin --profile web add @vacum972/dsh-page-translate
仅源码安装时：dsh plugin --profile web add github:vacum972/dsh-page-translate

### 兼容与运行要求
DSH >= 0.2.1-rc.5；仅 Desktop 生效（右侧浏览器是 Electron <webview>，Web profile 是跨域 iframe 无法注入）。
翻译为免费匿名接口（Google 网页翻译 / Microsoft Edge），不需要 API Key，不需要登录。

### 许可
MIT

### 截图 / 演示
仓库 README 中的操作说明；截图可参考 DSH 右侧浏览器内任意英文页面（如 GitHub README）翻译后的双语对照效果。

### 补充说明
- 页面文本只发送到翻译服务，不写入 DSH 会话日志，不保存 API Key；
- Host 路由只挂在本机 Web 服务（默认回环监听），不对局域网开放；
- 保守插入策略：只翻拥有文本的块元素、不改页面内联样式、不移动原文、跳过顶部导航与隐藏文本；
- 每次翻译用「运行 ID + 原文哈希」校验目标，站点重渲染也不会把译文放错位置；
- 依赖浏览器包的 guest 标记（webview[data-sidebar-browser-frame="webview"]），DSH 大版本升级后需回归。

### 提交前自查
- [ ] 仓库已公开
- [ ] 已添加 GitHub topic：dsh-plugin
- [x] README 包含安装命令
- [x] 插件导出 apply(ctx) 模块
- [x] 仓库根目录包含 package.json
```
