#!/usr/bin/env bash
#
# 转公开 / force-push 前的个人信息门。**扫形状，不扫已知串。**
#
# 为什么是形状：前几轮清洗都是拿「我预料到的值」当清单，于是所有没预料到的
# 整类漏掉 —— 真实 Gmail、Apple relay 邮箱、编码形式的家目录、真实 MAC OUI、
# 测试夹具路径里的真实客户名，五类全是这么漏的。
#
# 两条由此推出的硬规则：
#
# 1. **允许清单必须是完整锚定值，不能是「域」或「类别」。**
#    曾经写成允许 `@gmail.com` 整个域，于是任何**新的**未知真实 Gmail 都会全绿；
#    为了补这个洞又加了一条「禁止这几个已知真人前缀」的规则 ——
#    结果这个脚本自己成了那些真值的载体，还因为真实写法是 `前缀@…`（省略号）
#    而打不中。全地址锚定之后，**这个文件里不需要出现任何真实值**。
# 2. **commit message 走和 blob 完全相同的规则。** 上一轮已经证明
#    commit message 会独立泄漏，对它用弱化规则等于给自己开后门。
#
# 用法：scripts/verify-clean.sh <仓库路径>
# 配套：gitleaks git --log-opts=--all --redact（查凭证熵值，两个都跑才算过）

set -uo pipefail

R="${1:?用法: verify-clean.sh <仓库路径>}"
cd "$R" || { echo "进不去 $R" >&2; exit 2; }

TMP=$(mktemp -d) || exit 2          # 固定 /tmp 文件名会让并行运行互相截断 → 漏报
trap 'rm -rf "$TMP"' EXIT

FAIL=0
say() { printf '%-40s %s\n' "$1" "$2"; }
bad() { echo "  ❌ $1"; FAIL=1; }

echo "───── refs / 计数 ─────"
git show-ref > "$TMP/refs" || { bad "git show-ref 失败"; exit 1; }
say "refs" "$(wc -l < "$TMP/refs" | tr -d ' ') 个"
sed 's/^/    /' "$TMP/refs"
M=$(git rev-list --count main) || { bad "数不了 main"; exit 1; }
A=$(git rev-list --count --all) || { bad "数不了 --all"; exit 1; }
say "main / --all" "$M / $A"
[ "$M" = "$A" ] || bad "有 refs 指向 main 之外的历史（旧远程分支？）"

# unreachable 对象必须**置失败**，不能只打印数量 ——
# 「待发布的仓库里还躺着旧对象」正是这道门要拦的事
git fsck --full --unreachable --no-reflogs > "$TMP/unreach" 2>/dev/null
if [ -s "$TMP/unreach" ]; then
  bad "有 $(wc -l < "$TMP/unreach" | tr -d ' ') 个 unreachable 对象（旧历史残留）"
  head -5 "$TMP/unreach" | sed 's/^/      /'
else
  say "unreachable 对象" "0 ✅"
fi

echo
echo "───── 提交元数据 ─────"
git log --all --format='%an <%ae>|%cn <%ce>' | sort -u | grep -v 'users\.noreply\.github\.com' > "$TMP/who" || true
if [ -s "$TMP/who" ]; then bad "非 noreply 身份:"; sed 's/^/      /' "$TMP/who"
else say "作者/提交者" "全部 noreply ✅"; fi

# ── 规则表：blob 与 commit message 共用，一处定义 ─────────────────────
#    每行： 名称 ┆ 匹配正则 ┆ 完整锚定的允许清单（^…$，空=一条都不允许）
#    允许清单里**只能出现合成值**。要豁免一个真值，说明清洗没做完。
RULES=$(cat <<'EOF'
邮箱┆[A-Za-z0-9._%+*-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}┆^(alice@example\.com|alice@gmail\.com|abc123xyz@privaterelay\.appleid\.com|bob@corp\.io|carol@x\.org|demo@example\.com|user@example\.com|user@host\.example|old@z\.com|x@y\.com|a@b\.com|a@b\.sql|git@github\.com|root@prod\.internal|password@example\.com|s3cret@db\.example\.com|S3cr3tPassw0rdVeryLong@db-primary\.internal|TOPSECRET@prod\.example|pe\*\*\*@mail\.com|wo\*\*\*@mail\.com|a\*\*\*@gmail\.com|a\*\*\*@example\.com|example@privaterelay\.appleid\.com|a\*\*\*@privaterelay\.appleid\.com|Hardboiled98k@users\.noreply\.github\.com|noreply@anthropic\.com)$
MAC┆\b[0-9a-fA-F]{2}(:[0-9a-fA-F]{2}){5}\b┆^(02:00:00:00:00:01|00:00:00:00:00:00)$
私网/CGNAT IPv4┆\b(10\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}|172\.(1[6-9]|2[0-9]|3[01])\.[0-9]{1,3}\.[0-9]{1,3}|192\.168\.[0-9]{1,3}\.[0-9]{1,3}|100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.[0-9]{1,3}\.[0-9]{1,3})\b┆^(10\.0\.0\.[0-9]{1,3}|172\.19\.0\.1|192\.168\.1\.1|100\.64\.0\.1|100\.71\.3\.42|100\.100\.1\.1|100\.101\.102\.103|100\.127\.255\.254|100\.64\.0\.0|172\.16\.0\.0|10\.0\.0\.0|192\.168\.0\.0)$
家目录（含编码形式）┆(/Users/[a-zA-Z][a-zA-Z0-9_-]+|-Users-[a-zA-Z][a-zA-Z0-9_-]+-)┆^(/Users/(you|x|me|other|newbie|somebody|test|demo|alice)$|-Users-you-)
凭证前缀┆sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|xox[baprs]-[0-9A-Za-z-]{20,}|glpat-[0-9A-Za-z_-]{20}|-----BEGIN[A-Z ]*PRIVATE KEY-----┆^sk-SECRET-DO-NOT-LEAK$
JWT┆eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}┆^$
长 hex（账号 id / 令牌）┆\b[0-9a-f]{32,64}\b┆^(abcdef0123456789abcdef0123456789|eddef6be8dcabf76651893ecd2548866658f339f)$
UUID┆\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b┆^00000000-0000-0000-0000-000000000000$
EOF
)

# ── blob 扫描 ────────────────────────────────────────────────────────
echo
echo "───── 全 blob 形状扫描 ─────"
git cat-file --batch-check --batch-all-objects | awk '$2=="blob"{print $1}' | sort -u > "$TMP/blobs"
[ -s "$TMP/blobs" ] || { bad "一个 blob 都没枚举到 —— 门本身坏了"; exit 1; }
say "blob 总数" "$(wc -l < "$TMP/blobs" | tr -d ' ')"

# blob → 路径：报红时要能说出命中在哪，否则既没法复核也没法正确加豁免
git rev-list --objects --all 2>/dev/null | awk 'NF>1{print $1" "substr($0, index($0," ")+1)}' > "$TMP/paths" || true

while IFS='┆' read -r name re ok; do
  [ -n "${name:-}" ] || continue
  : > "$TMP/hits"
  while read -r b; do
    git cat-file blob "$b" 2>/dev/null | grep -a -o -E "$re" 2>/dev/null | sed "s|^|$b |" >> "$TMP/hits"
  done < "$TMP/blobs"
  sed 's/^[0-9a-f]* //' "$TMP/hits" | sort -u | grep -vE "$ok" > "$TMP/out" || true
  if [ -s "$TMP/out" ]; then
    bad "$name —— 不在允许清单内:"
    while read -r v; do
      B=$(grep -F -m1 " $v" "$TMP/hits" | cut -d' ' -f1)
      P=$(grep -m1 "^$B " "$TMP/paths" | cut -d' ' -f2-)
      printf '      %-44s  blob %s  %s\n' "$v" "${B:0:10}" "${P:-<非当前树>}"
    done < "$TMP/out"
  else
    say "  $name" "干净 ✅"
  fi
done <<< "$RULES"

# ── commit message 扫描：**同一套规则**，不弱化 ───────────────────────
echo
echo "───── commit message（同一套规则）─────"
git log --all --format='%B' | tr -d '\000' > "$TMP/msgs"
while IFS='┆' read -r name re ok; do
  [ -n "${name:-}" ] || continue
  grep -a -o -E "$re" "$TMP/msgs" 2>/dev/null | sort -u | grep -vE "$ok" > "$TMP/mout" || true
  if [ -s "$TMP/mout" ]; then bad "$name:"; sed 's/^/      /' "$TMP/mout"
  else say "  $name" "干净 ✅"; fi
done <<< "$RULES"

echo
if [ $FAIL = 0 ]; then echo "═══ 全部通过 ═══"; else echo "═══ 有未通过项，见上面 ❌ ═══"; fi
exit $FAIL
