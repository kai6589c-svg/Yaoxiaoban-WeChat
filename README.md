# 药小伴（微信版）

家庭药品记录与提醒微信小程序，使用 TypeScript、微信云开发和 CloudBase 云函数。

当前版本：**0.5.0-beta.18**。公开仓库默认运行隔离演示模式，不连接原项目的正式环境，不包含用户药品数据、照片或登录凭证。

本仓库保留微信小程序及完整提交历史。普通浏览器版本独立维护于 [药小伴（通用版）](https://github.com/kai6589c-svg/Yaoxiaoban-Web)，当前为网页基础版，两个版本的数据暂不互通。

## 功能

- 药盒与家庭成员管理，支持完整日期和月份精度的有效期。
- 开封期限、实际盘点、预计余量和固定服用计划。
- 今天任务、已服 / 未服记录与撤销、归档和恢复。
- 可选药盒照片：压缩、分块上传、持久化待同步任务和失败恢复。
- 提醒健康状态、订阅提醒与系统日历辅助功能。
- 服务端账号隔离、字段校验、乐观锁、幂等处理及后台媒体清理。

本工具只记录用户确认的信息，不提供诊断、剂量推荐或用药建议；提醒状态也不代表消息一定送达。

## 快速开始

需要 Node.js 22（见 `.nvmrc`）和微信开发者工具。云端业务函数使用 CloudBase 配置中声明的运行时，开发工具版本与云端运行时分开管理。

```sh
npm ci
npm run build
```

安装和构建时会自动生成被 Git 忽略的本地配置。将仓库导入微信开发者工具，小程序根目录为 `dist/miniprogram/`。默认使用游客 AppID 和本机演示数据；如果开发工具要求正式 AppID，请按下一节配置自己的 AppID，演示模式仍保持空云环境。

如遇开发工具缓存无法识别嵌套根目录，可运行：

```sh
node scripts/prepare-wechat-preview.mjs
```

然后导入 `dist/wechat-preview/`。

## 配置自己的环境

```sh
cp deployment.example.json deployment.local.json
```

编辑 `deployment.local.json`，再运行 `npm run build`。配置文件不会提交到 Git。

| 字段                    | 说明                                                       |
| ----------------------- | ---------------------------------------------------------- |
| `deploymentMode`        | `demo` 只用本机演示数据；`production` 使用自己的 CloudBase |
| `appId`                 | 自己的小程序 AppID；游客模式为 `touristappid`              |
| `cloudEnvId`            | 演示模式必须为空；正式模式填写自己的环境 ID                |
| `subscriptionTemplates` | 填写自己审核通过的订阅模板 ID，留空时对应入口不可用        |

`project.config.json`、`cloudbaserc.json` 和 `miniprogram/config/runtime.ts` 由模板生成，**不要直接修改生成文件**。正式模式不会在云请求失败时静默退回演示数据。

部署前阅读 [CloudBase 部署说明](docs/cloudbase-deployment.md) 和 [公开仓库配置说明](docs/github-setup.md)。云函数凭证通过平台或登录工具管理，不能填写到源码中。后台 worker 的环境变量、权限、集合和索引必须单独配置。

## 检查与测试

```sh
npm run check            # 构建、配置、类型、lint、单元测试、审计及包体检查
npm run test:config      # 演示隔离、正式配置和输入校验
npm run test:e2e         # 需要本机微信开发者工具的隔离 UI 旅程
npm run release:check    # 仅允许显式配置的 production 模式
```

GitHub Actions 在 push 和 pull request 时运行 `npm run check`，不使用正式环境凭证，不自动部署、不发送订阅消息。

beta.18 原工程验证记录：345 项客户端与云函数测试通过；30 次合成照片真实云端保存全部成功，界面解除等待 P95 7.732 秒，最长 8.474 秒。测试使用开发者工具及当时的网络条件，不能推导为任意真机、网络都能在 10 秒内完成云端同步。

照片前台等待预算为 9.8 秒，结果不确定时显示待确认状态并保留本机任务。断网时不伪报保存成功。

当前 Nightly 开发工具的完整 UI 自动化旅程存在启动超时，iOS/Android 真机矩阵尚未完成；公开源码不等于已经通过微信正式发布验收。

## 目录

```text
miniprogram/       小程序页面、组件、领域规则和数据服务
cloudfunctions/    业务接口、提醒 worker、维护 worker
scripts/           配置生成、构建与检查工具
tests/             客户端与 UI 旅程测试
docs/              架构、领域规则、数据模型和部署说明
.github/workflows/ GitHub 自动检查
```

- [架构](docs/architecture.md)
- [领域规则](docs/domain-rules.md)
- [数据模型](docs/data-model.md)
- [隐私政策草案](docs/privacy-policy.md)
- [发布清单](docs/release-checklist.md)
- [贡献说明](CONTRIBUTING.md)
- [安全问题处理](SECURITY.md)

## 使用与发布边界

正式服务需要自行配置运营主体、隐私保护指引、联系渠道、备案、类目、订阅模板和云资源，并完成真实设备验收。

本仓库尚未授予开源许可证。代码公开可见不等于授予复制、修改或分发许可；如需使用或分发，请先取得权利人授权。第三方依赖遵循各自许可证。
