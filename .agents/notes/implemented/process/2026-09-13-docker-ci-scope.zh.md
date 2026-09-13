# Agent Note: Docker 仓库的 CI 范围

Status: implemented

[English](2026-09-13-docker-ci-scope.md) | 中文

## 问题

Docker 仓库部署在 Linux 上，却继承了消耗外部 API 额度、依赖上游专有运行器池，以及在 macOS 上运行完整单元测试的工作流。缺失密钥会造成反复的预检失败，不可用的私有运行器会让参考作业一直排队。这两种结果都不能证明 Docker 运行时出现回归。

## 决策

[真实 API E2E](../../../../.github/workflows/e2e.yml) 和 [CI master](../../../../.github/workflows/ci-master.yml) 仅接受手动触发。API 密钥仍限定在步骤范围内，缺少密钥时会在检出代码或安装依赖前失败。参考套件需要显式选择；默认的 Wine 缓存任务使用标准托管运行器，自托管及大型运行器套件需要对应名称的运行器池。

[Sandbox](../../../../.github/workflows/sandbox.yml) 保留 master 推送时自动执行的 bwrap 与 Landlock x64/arm64 检查。bwrap 作业也运行完整单元测试和部署配置测试。Seatbelt 和 macOS 单元测试一致性检查仅在手动触发时运行。启用的作业保留测试断言；改变触发方式不会把失败的测试变成成功。

本决策部分取代[真实 API CI 记录](../testing/2026-06-19-real-api-e2e-ci.zh.md)和[串行参考流程记录](2026-07-21-serial-cross-platform-ci-reference.zh.md)中的触发策略。它们关于密钥安全与独立参考验证的依据仍然有用，因此两份记录继续保留在活动目录。拉取请求 CI 与发布工作流保留各自的独立策略。

## 曾考虑的替代方案

**删除所有继承的工作流和测试。** 这会移除仍与 Docker 服务相关的 Linux 隔离、部署及回归验证证据。

**保留自动任务并配置上游基础设施。** 下游部署不需要这些私有运行器池或持续付费的 API 测试。手动触发仍保留按需检查的能力。

**使用 `continue-on-error` 忽略失败。** 已启动的检查必须继续报告真实回归。可选执行应由触发条件控制，而不是通过忽略失败实现。

## 后果

普通推送不需要 API 密钥或自托管参考池。真实 API 与 macOS 的回归只会在手动选择对应套件时被检测到。分支保护不能要求仅支持手动运行的检查。GitHub 上已有的排队或失败记录保留原来的工作流定义，修改后续提交不会修复这些记录。

## 验证

[工作流测试](../../../../scripts/ci-workflow.spec.ts) 固定自动 Linux 检查清单、手动套件选择和密钥范围，并使用缺失及合成密钥执行 API 预检。[远程事件测试](../../../../packages/api/remotes/tests/remote-events.host.spec.ts) 使用具备 Session 的主体，验证路由取自持久化所有者，而非当前请求用户。[Fixture（测试前置数据）布局测试](../../../../scripts/session-fixture-layout.spec.ts) 要求会话记录采用规范格式，且不改变解码后的载荷。
