# 发布指南（从零开始）

本目录就是 GitHub 仓库 `vacum972/dsh-page-translate` 的根目录：
`package.json` 在根目录，`index.js` 是 Host 半体，`client.js` 是 Client 半体，
`cordis.patch.yml` 是 bundle 补丁。

> 本机现状：Node / npm 已安装；GitHub 账号 `vacum972`；
> GitHub CLI 在 `_gh/bin/gh.exe`，配置目录 `_gh/config`（已登录，token 存于 keyring）；
> npm 发布凭据在 `~/.npmrc`（已配置免 2FA token）。
>
> 注意：本工作区的命令跑在文件沙箱里，`git push` 走 https 时 Schannel 拿不到系统凭据，
> 需要用 `http.sslBackend=openssl`（或改用 `gh api` 上传）—— 见下文第 3 步。

## 第 0 步：确认内容

```
D:\软件\deepseek\插件\publish\dsh-page-translate
├── index.js            Host：/page-translate/translate 路由（Google 代理 + 翻译服务兜底）
├── client.js           Client：浏览器按钮、菜单行、页面采集/注入、自动翻译、续翻、引擎切换
├── cordis.patch.yml    bundle 补丁
├── locale/{zh,en}.json 插件管理页文案
├── icon.svg
├── package.json
├── README.md  CHANGELOG.md  LICENSE  PUBLISH.md  SUBMIT_ISSUE.md
├── .gitignore  .gitattributes
```

发布前做一次语法检查：

```powershell
node --check client.js
node --check index.js
```

## 第 1 步：本地初始化仓库

```powershell
cd "D:\软件\deepseek\插件\publish\dsh-page-translate"
git init
git add -A
git commit -m "feat: initial release v0.1.0"
git branch -M main
```

## 第 2 步：在 GitHub 上创建公开仓库

用已登录的 gh：

```powershell
$env:GH_CONFIG_DIR = "D:\软件\deepseek\插件\_gh\config"
D:\软件\deepseek\插件\_gh\bin\gh.exe repo create vacum972/dsh-page-translate `
  --public --source . --remote origin `
  --description "DSH 右侧边栏浏览器的沉浸式双语网页翻译：原文保留、译文插入其下，支持整站自动翻译、滚动续翻与引擎切换"
```

## 第 3 步：推送

沙箱里 Git 的 https 需要 openssl 后端：

```powershell
$token = (D:\软件\deepseek\插件\_gh\bin\gh.exe auth token)
git config http.sslBackend openssl
git remote set-url origin "https://x-access-token:$token@github.com/vacum972/dsh-page-translate.git"
git push -u origin main
git remote set-url origin https://github.com/vacum972/dsh-page-translate.git   # 推完把 token 从 remote 里去掉
```

如果 `git push` 仍被沙箱拦截（`sh.exe ... signal pipe` 之类），
改用 `gh api` 的 Git Data API 上传（本地有等价脚本思路：建 blob → tree → commit → 更新 ref），
或者让 GitHub CLI 做仓库创建，再由外部终端推送。

## 第 4 步：给仓库加 topic（市场靠它扫描）

```powershell
$env:GH_CONFIG_DIR = "D:\软件\deepseek\插件\_gh\config"
D:\软件\deepseek\插件\_gh\bin\gh.exe repo edit vacum972/dsh-page-translate `
  --add-topic dsh-plugin --add-topic deepseek-harness --add-topic translation --add-topic browser
```

## 第 5 步：Release

```powershell
git tag v0.1.0
git push origin v0.1.0
D:\软件\deepseek\插件\_gh\bin\gh.exe release create v0.1.0 --notes-file CHANGELOG.md --title v0.1.0
```

## 第 6 步：发布到 npm（可选）

```powershell
cd "D:\软件\deepseek\插件\publish\dsh-page-translate"
npm pack --dry-run          # 预览打包内容
npm publish --access public
npm view @vacum972/dsh-page-translate version
```

## 第 7 步：提交 dsh-plugin.org 收录（可选）

仓库 Public + topic `dsh-plugin` + 根目录 `package.json` 三项满足后，
把 [SUBMIT_ISSUE.md](SUBMIT_ISSUE.md) 里的标题与正文发到
<https://github.com/dshplugin/dsh-plugin-hub/issues/new> 的「插件提交」模板。

## 以后升级

```powershell
npm version patch
git add -A
git commit -m "chore: release v0.1.1"
git push
git push --tags
npm publish --access public
```
