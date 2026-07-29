#!/usr/bin/env bash
# 净化仓库放行前的验证。**扫形状，不扫已知串** ——
# 前两轮都是拿"我预料到的值"当清单，于是所有没预料到的（真实 gmail、
# Apple relay 邮箱、编码路径、真实 MAC）整类漏掉。
set -uo pipefail
R="${1:?用法: verify-clean.sh <仓库路径>}"
cd "$R" || exit 1
FAIL=0
say() { printf '%-42s %s\n' "$1" "$2"; }

echo "───── refs / 计数 ─────"
say "refs" "$(git show-ref | wc -l | tr -d ' ') 个"
git show-ref | sed 's/^/    /'
M=$(git rev-list --count main); A=$(git rev-list --count --all)
say "main / --all" "$M / $A"
[ "$M" = "$A" ] || { echo "  ❌ 有 refs 指向 main 之外的历史"; FAIL=1; }
say "无 refs 可达的对象" "$(git fsck --full --unreachable --no-reflogs 2>/dev/null | wc -l | tr -d ' ') 条"

echo
echo "───── 提交元数据 ─────"
BAD=$(git log --all --format='%an <%ae>|%cn <%ce>' | sort -u | grep -v 'users.noreply.github.com' || true)
if [ -n "$BAD" ]; then echo "  ❌ 非 noreply 身份:"; echo "$BAD" | sed 's/^/    /'; FAIL=1
else say "作者/提交者" "全部 noreply ✅"; fi

echo
echo "───── 全 blob 形状扫描 ─────"
git cat-file --batch-check --batch-all-objects | awk '$2=="blob"{print $1}' | sort -u > /tmp/vb.txt
say "blob 总数" "$(wc -l < /tmp/vb.txt | tr -d ' ')"
scan() { # 名称  正则  允许清单（extended regex，空则不允许任何命中）
  local name="$1" re="$2" ok="${3:-}"
  : > /tmp/vh.txt
  while read -r b; do
    git cat-file blob "$b" 2>/dev/null | grep -a -o -E "$re" >> /tmp/vh.txt
  done < /tmp/vb.txt
  local hits
  if [ -n "$ok" ]; then hits=$(sort -u /tmp/vh.txt | grep -vE "$ok" || true)
  else hits=$(sort -u /tmp/vh.txt || true); fi
  if [ -n "$hits" ]; then
    echo "  ❌ $name —— 未在允许清单内的命中:"; echo "$hits" | head -12 | sed 's/^/      /'; FAIL=1
  else say "  $name" "干净 ✅"; fi
}

# 邮箱：只允许明显合成的域
scan "邮箱" '[A-Za-z0-9._%+*-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}' \
  '@(example\.(com|org)|users\.noreply\.github\.com|github\.com|corp\.io|x\.org|y\.com|b\.com|b\.sql|z\.com|host\.example|prod\.example|db\.example\.com|db-primary\.internal|prod\.internal|mail\.com|gmail\.com|privaterelay\.appleid\.com)$'
# 上面 gmail / privaterelay 只允许 alice@ / abc123xyz@ 这两个合成前缀
scan "真人形状的邮箱前缀" '(haifeng|hai_feng|abc123xyz)@[A-Za-z0-9.-]+' ''
# MAC：只允许 locally-administered（第二个十六进制位是 2/6/A/E）
scan "MAC" '\b[0-9a-fA-F]{2}(:[0-9a-fA-F]{2}){5}\b' '^(0[26ae]:|00:00:00:00:00:00$)'
# 私网 / CGNAT IP：允许文档网段与测试夹具
# 只扫 192.168.*（真会是本机 LAN）；10.* / 172.* 在 package-lock 里全是 node 版本号，纯噪音
scan "私网 IPv4（192.168 段）" '\b192\.168\.[0-9]{1,3}\.[0-9]{1,3}\b' '^192\.168\.(0|1)\.[0-9]+$'
scan "家目录路径（含编码形式）" '(/Users/[a-z][a-z0-9_-]+|-Users-[a-z][a-z0-9_-]+-)' '^(/Users/(you|x|me|test|demo|alice|other|newbie|somebody)|-Users-you-)'
scan "凭证前缀" 'sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|xox[baprs]-[0-9A-Za-z-]{20,}|glpat-[0-9A-Za-z_-]{20}|-----BEGIN[A-Z ]*PRIVATE KEY-----' \
  '^sk-SECRET-DO-NOT-LEAK$'
scan "JWT" 'eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}' ''
scan "长 hex（账号 id / 令牌形状）" '\b[0-9a-f]{32,64}\b' \
  '^(abcdef0123456789abcdef0123456789|eddef6be8dcabf76651893ecd2548866658f339f)$'
scan "非全零 UUID" '\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b' \
  '^00000000-0000-0000-0000-000000000000$'

echo
echo "───── commit message ─────"
MSG=$(git log --all --format='%B' | grep -a -o -E '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}|/Users/[a-z][a-z0-9_-]+' \
  | sort -u | grep -vE '@(users\.noreply\.github\.com|example\.com|anthropic\.com|privaterelay\.appleid\.com)|^/Users/(you|me)' || true)
if [ -n "$MSG" ]; then echo "  ❌ commit message 里:"; echo "$MSG" | sed 's/^/    /'; FAIL=1
else say "邮箱 / 家目录" "干净 ✅"; fi

echo
[ $FAIL = 0 ] && echo "═══ 全部通过 ═══" || echo "═══ 有未通过项，见上面 ❌ ═══"
exit $FAIL
