# Linux SSH 裸仓库部署

云笺只需要 Git 和 SSH，不部署独立 HTTP 同步服务。每个知识库对应一个独立裸仓库，使用专用账户与 `main` 分支，下面的账户和路径应按实际环境调整。先确认目标路径没有已有仓库，再在服务器执行命令，并将各设备的 SSH 公钥逐行添加到专用账户的 `authorized_keys`。

```bash
sudo apt-get update
sudo apt-get install git openssh-server
sudo adduser --disabled-password --gecos '' notes
sudo -u notes mkdir -p /home/notes/repos /home/notes/.ssh
sudo -u notes git init --bare --initial-branch=main /home/notes/repos/personal.git
sudo -u notes git -C /home/notes/repos/personal.git config receive.denyNonFastForwards true
sudo -u notes git -C /home/notes/repos/personal.git config receive.denyDeletes true
sudo -u notes git -C /home/notes/repos/personal.git config gc.auto 0
sudo chmod 700 /home/notes/.ssh
sudo chown notes:notes /home/notes/.ssh/authorized_keys
sudo chmod 600 /home/notes/.ssh/authorized_keys
```

私钥留在客户端，通过系统 SSH Agent 认证，插件不读取或保存私钥。公钥可加 `no-agent-forwarding,no-port-forwarding,no-X11-forwarding,no-pty` 限制，保留 Git 所需的非交互命令执行。客户端通过可信渠道核对服务器主机指纹后手动连接一次写入 `known_hosts`，再测试 Git；插件使用 `BatchMode=yes` 与 `StrictHostKeyChecking=yes`，不会交互输入密码或接受新主机。

```bash
ssh notes@notes.example.com
git ls-remote notes@notes.example.com:/home/notes/repos/personal.git
```

插件远端地址填写 `notes@notes.example.com:/home/notes/repos/personal.git`。需要特殊端口或密钥路径时，在各设备的 SSH 配置中定义主机别名，再使用 `private-notes:/home/notes/repos/personal.git` 这样的地址。Windows Git 调用的 SSH 应与终端测试使用的 SSH 访问同一 Agent，否则终端成功不代表 Obsidian 可完成非交互认证。

```sshconfig
Host private-notes
    HostName notes.example.com
    User notes
    Port 22
    IdentityFile ~/.ssh/id_ed25519_notes
    IdentitiesOnly yes
```

服务器应有足够空间，并定期备份整个裸仓库。仓库经 SSH 传输，但服务器管理员可以读取笔记内容和历史，第一版没有端到端加密。其他 Git 工具不应强制推送、删除快照标签或重写历史，以免破坏设备之间的共同基线。
