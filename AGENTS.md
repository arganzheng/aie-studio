# 给在这个仓库里干活的 agent

## 不在线上 checkout 里开发

`~/Code/aie-studio` 这个目录就是线上服务（launchd `com.argan.aie-studio`，端口 9991）：服务端直接从这里的源码运行，前端直接提供这里的 `web/dist`。在这个目录里的任何未完成改动，都会在下一次构建或重启时被带上线。所以：

1. **这个目录只停在 `main` 上，不在里面改代码、不切分支。** 开发一律用单独的 worktree：

   ```sh
   git worktree add ../aie-studio-<名字> -b <分支> main
   ```

   改完走 PR；合并后删掉 worktree 和分支。

2. **不在这个目录里为了测试而构建或启动服务。** 测试用 worktree 里的代码起隔离实例：另选端口（`PORT=9996`），`REMOTE_IDE_CONFIG_DIR` 指到临时目录，不碰 9991 和真实的用户数据。

3. **部署只在 PR 合并之后做**，并且先确认 `git status -sb` 显示在 `main` 上且工作区干净；不是的话停下来告诉用户，不要拉代码、构建或重启。部署步骤：

   1. `git pull --ff-only`
   2. `pnpm install --frozen-lockfile`
   3. 类型检查和测试（`server`、`web` 各跑 `tsc --noEmit` 和 `vitest run`）
   4. `pnpm --filter web build`
   5. 重启：用 `~/Code/.aie-restart/restart.sh`，它会等所有会话空闲后再重启并自检，结果写在同目录的 `result` 里。提交方式：

      ```sh
      launchctl submit -l com.argan.aie-studio-restart -- /bin/bash ~/Code/.aie-restart/restart.sh
      ```

      不要直接 `launchctl kickstart`：正在跑的会话都是这个服务的子进程，会被一起杀掉。
