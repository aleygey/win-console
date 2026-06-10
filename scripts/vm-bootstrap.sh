#!/usr/bin/env bash
# Ubuntu (WSL2) 一键准备 exp playbook 后端,供 super-work-host 测试用。
#
# 在 WSL 的 Ubuntu 里执行:
#   bash /mnt/d/张泽南/03-嵌入式/02-opencode/01-plugin/super-work-host/scripts/vm-bootstrap.sh
#
# 做的事:装 bun + 基础工具,从 Windows 上的 exp-dev-offline.tar.gz 解出
# opencode-plugin-playbook 到 ~/exp,跑一遍 bun install,然后告诉你怎么起 serve。
set -euo pipefail

# 默认用工程里的中文路径;若设了 TARBALL 环境变量则用它(规避中文路径传参乱码)
TARBALL="${TARBALL:-/mnt/d/张泽南/03-嵌入式/02-opencode/01-plugin/exp-dev-offline.tar.gz}"
DEST="$HOME/exp"
PB="$DEST/opencode-plugin-playbook"

# root 直接跑、普通用户加 sudo —— 两种都能用
SUDO=""; if [ "$(id -u)" -ne 0 ]; then SUDO="sudo"; fi

echo "==> [1/4] apt 基础工具"
$SUDO apt-get update -y
$SUDO apt-get install -y curl unzip ca-certificates build-essential

echo "==> [2/4] 安装 bun"
if ! command -v bun >/dev/null 2>&1; then
  curl -fsSL https://bun.sh/install | bash
fi
export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"
bun --version

echo "==> [3/4] 解出 playbook 后端 -> $PB"
if [ ! -f "$TARBALL" ]; then
  echo "!! 找不到 $TARBALL —— 确认 Windows 上路径没变" >&2
  exit 1
fi
mkdir -p "$DEST"
# 只解后端那一棵子树(连同它自带的 .opencode 经验库数据)
tar -xzf "$TARBALL" -C "$DEST" opencode-plugin-playbook 2>/dev/null || true
# 清掉 macOS 打包残留的 ._ 文件
find "$DEST" -name '._*' -delete 2>/dev/null || true
test -d "$PB" || { echo "!! 解包后没看到 $PB" >&2; exit 1; }

echo "==> [4/4] bun install(拿 Linux 版依赖,离线包里的可能是 mac 二进制)"
cd "$PB"
bun install

cat <<EOF

✅ 准备完成。后端在: $PB

起经验库后端(默认 :53550,Windows 用 http://localhost:53550 直连):
  cd $PB
  export PATH="\$HOME/.bun/bin:\$PATH"
  EXP_PORT=53550 bun scripts/serve.ts

opencode serve(测对话用,需你自己装好 opencode 并配好模型):
  opencode serve --hostname 0.0.0.0 --port 4096
  # Windows 控制台「管理 · opencode serve 地址」填 http://localhost:4096

EOF
