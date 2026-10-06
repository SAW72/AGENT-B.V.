# Checks the paste-safe operator guard in docs/runbooks/register-test-bots-base-sepolia.md.
# Run with bash and with zsh. A failing guard returns 1; this script keeps going and
# exits 1 at the end if any case missed. It does not broadcast.

fail=0
if [ -n "${ZSH_VERSION-}" ]; then
  shell=zsh
elif [ -n "${BASH_VERSION-}" ]; then
  shell=bash
else
  shell="sh"
fi

root=$(cd -- "$(dirname "$0")/.." && pwd)
md=$root/docs/runbooks/register-test-bots-base-sepolia.md

extract() {
  n=$1
  awk -v n="$n" '
    /^ops_guard\(\) \{/ { c++; g=1 }
    g && c==n { print }
    g && c==n && /^}$/ { g=0 }
  ' "$md"
}

a=$(extract 1)
b=$(extract 2)
c=$(extract 3)
if [ -z "$a" ] || [ "$a" != "$b" ] || [ "$a" != "$c" ]; then
  echo "$shell: the three ops_guard copies differ or are missing"
  exit 1
fi
echo "$shell: three ops_guard copies identical"

unset_count=$(grep -c '^unset PAYER_OPERATOR PAYEE_OPERATOR$' "$md" || true)
if [ "$unset_count" != 1 ]; then
  echo "$shell: expected one standalone unset line, found $unset_count"
  fail=$((fail + 1))
fi
export_has_unset=$(awk '
  /^## Checklist$/ { p=1 }
  p && /^```bash$/ { f=1; next }
  f && /^```$/ { exit }
  f && /^unset / { print "yes"; exit }
' "$md")
if [ "$export_has_unset" = yes ]; then
  echo "$shell: the export block still contains unset"
  fail=$((fail + 1))
fi

if ! python3 - "$root" "$a" <<'PY'
import json, pathlib, re, sys
root = pathlib.Path(sys.argv[1])
fn = sys.argv[2]
book = json.loads((root / "deployments/base-sepolia.json").read_text())
wanted = [
    ("Vault.address", book["Vault"]["address"]),
    ("Denylist.address", book["Denylist"]["address"]),
    ("DisputePanel.address", book["DisputePanel"]["address"]),
    ("superseded.Vault.address", book["superseded"]["Vault"]["address"]),
    ("InsuranceFund.address", book["InsuranceFund"]["address"]),
    ("Liability.address", book["Liability"]["address"]),
    ("superseded.Denylist.address", book["superseded"]["Denylist"]["address"]),
]
sol = (root / "script/DeployBotAttestationEscrow.s.sol").read_text()
for name in ("SIMULATE_SENDER", "FOUNDRY_DEFAULT_SENDER"):
    m = re.search(rf"{name} = (0x[0-9a-fA-F]{{40}})", sol)
    if not m:
        print(f"missing {name} in DeployBotAttestationEscrow.s.sol")
        sys.exit(1)
    wanted.append((name, m.group(1)))
escrow = (root / "script/DEPLOY_ESCROW_BASE_SEPOLIA.md").read_text()
for addr in re.findall(r"export ARBITRATOR_[123]=(0x[0-9a-fA-F]{40})", escrow):
    wanted.append(("ARBITRATOR", addr))
sample_from = "0x0000000000000000000000000000000000000001"
if sample_from not in escrow:
    print("sample --from address missing from DEPLOY_ESCROW_BASE_SEPOLIA.md")
    sys.exit(1)
wanted.append(("DEPLOY_ESCROW sample --from", sample_from))
ops = (root / "script/OPS_LIVE_DENYLIST_VAULT.md").read_text()
m = re.search(r"export OPERATOR=(0x[0-9a-fA-F]{40})", ops)
if not m:
    print("OPERATOR sample missing from OPS_LIVE_DENYLIST_VAULT.md")
    sys.exit(1)
wanted.append(("OPERATOR", m.group(1)))
def contract_addresses(node, path=""):
    found = []
    if isinstance(node, dict):
        for key, value in node.items():
            child = f"{path}.{key}" if path else key
            if key == "address" and isinstance(value, str) and re.fullmatch(r"0x[0-9a-fA-F]{40}", value):
                found.append((child, value))
            else:
                found.extend(contract_addresses(value, child))
    return found

seen = {addr for _, addr in wanted}
for key, addr in contract_addresses(book):
    if addr not in seen:
        wanted.append((key, addr))
        seen.add(addr)

allowed_eoas = [
    ("coreTimelock", book["coreTimelock"]),
    ("deployer", book["BotAttestationEscrow"]["deployer"]),
]
for key, addr in allowed_eoas:
    if addr in fn:
        print(f"allowed EOA is blocklisted: {key} {addr}")
        sys.exit(1)
    print(f"allowed EOA stays allowed {key} {addr}")

missing = [f"{key} {addr}" for key, addr in wanted if addr not in fn]
if missing:
    print("blocklist missing:\n" + "\n".join(missing))
    sys.exit(1)
for key, addr in wanted:
    print(f"blocklist has {key} {addr}")
PY
then
  echo "$shell: blocklist does not match deployments/base-sepolia.json or script/"
  fail=$((fail + 1))
fi

if grep -n 'exit 1' "$md" >/dev/null; then
  echo "$shell: runbook still contains exit 1"
  fail=$((fail + 1))
fi
if grep -n 'A wrong chain does exit' "$md" >/dev/null; then
  echo "$shell: runbook still says a wrong chain does exit"
  fail=$((fail + 1))
fi
missing_cast_count=$(grep -c "command -v cast >/dev/null || { echo 'cast is not installed'; skip_send=1; }" "$md" || true)
if [ "$missing_cast_count" != 2 ]; then
  echo "$shell: expected the missing-cast skip on both send pastes, found $missing_cast_count"
  fail=$((fail + 1))
fi
risks=$(awk '/^## Risks$/{p=1} p' "$md")
case $risks in
  *"cast is not installed"*) ;;
  *)
    echo "$shell: Risks does not mention cast is not installed"
    fail=$((fail + 1))
    ;;
esac
case $risks in
  *"does exit"*)
    echo "$shell: Risks still says the chain check exits"
    fail=$((fail + 1))
    ;;
esac

# shellcheck disable=SC1090
eval "$a"

GOOD_PAYER=0xAbcAbC0000000000000000000000000000000001
GOOD_PAYEE=0xabCAbc0000000000000000000000000000000002
RELAYER=0x9D1b3E1400D2632d435cB7C0fC131C4f42B31861
LIVE=0x3d660502D75f1e97b08c110255921b437A3C4C42
RETIRED=0x141214F04b0E1d949B6e6bf32D019Ad7Ab5B284c
RETIRED_ESC_M1=0x1069aA6597f08F1E8B8ad39AA40EDE1D0c77298d
TIMELOCK=0x10CC9474b45625ADfd05C209f2518023484878D9

check() {
  label=$1
  want=$2
  needle=$3
  PAYER_OPERATOR=$4
  PAYEE_OPERATOR=$5
  export PAYER_OPERATOR PAYEE_OPERATOR
  out=$(ops_guard 2>&1)
  got=$?
  printf '== %s %s ==\n' "$shell" "$label"
  if [ -n "$out" ]; then
    printf '%s\n' "$out"
  fi
  printf 'rc %s (want %s)\n' "$got" "$want"
  if [ "$got" != "$want" ]; then
    echo MISMATCH
    fail=$((fail + 1))
  fi
  if [ -n "$needle" ]; then
    case $out in
      *"$needle"*) ;;
      *)
        echo "MISSING: $needle"
        fail=$((fail + 1))
        ;;
    esac
  elif [ -n "$out" ]; then
    echo "UNEXPECTED OUTPUT"
    fail=$((fail + 1))
  fi
}

check "good pair" 0 "" "$GOOD_PAYER" "$GOOD_PAYEE"
check "stale stand-ins without unset" 1 "PAYER_OPERATOR is blocklisted" \
  0x1111111111111111111111111111111111111111 \
  0x2222222222222222222222222222222222222222
check "payee stand-in" 1 "PAYEE_OPERATOR is blocklisted" \
  "$GOOD_PAYER" 0x2222222222222222222222222222222222222222
check "payee bEEF" 1 "PAYEE_OPERATOR is blocklisted" \
  "$GOOD_PAYER" 0x000000000000000000000000000000000000bEEF
check "payee bEEF lowercase" 1 "PAYEE_OPERATOR is blocklisted" \
  "$GOOD_PAYER" 0x000000000000000000000000000000000000beef
check "payee zero" 1 "PAYEE_OPERATOR is blocklisted" \
  "$GOOD_PAYER" 0x0000000000000000000000000000000000000000
check "payer equals payee" 1 "PAYER_OPERATOR and PAYEE_OPERATOR are the same address" "$GOOD_PAYER" "$GOOD_PAYER"
check "payer not checksummed" 1 "PAYER_OPERATOR is not checksummed" \
  0xabcabc0000000000000000000000000000000001 "$GOOD_PAYEE"
check "payee not checksummed" 1 "PAYEE_OPERATOR is not checksummed" \
  "$GOOD_PAYER" 0xabcabc0000000000000000000000000000000002
check "payer live vault" 1 "PAYER_OPERATOR is blocklisted" \
  0x1463D664fA467FBCDA4B05443434494f05e565bc "$GOOD_PAYEE"
check "payee denylist lowercase" 1 "PAYEE_OPERATOR is blocklisted" \
  "$GOOD_PAYER" 0xee76876beccfc1b58fc06ff4e654a517d784b224
check "payer dispute panel" 1 "PAYER_OPERATOR is blocklisted" \
  0x31a92f9A25396968E14d2b55B6B0BB1482ECf1Bb "$GOOD_PAYEE"
check "payee old vault lowercase" 1 "PAYEE_OPERATOR is blocklisted" \
  "$GOOD_PAYER" 0xa1a067d2f58ae54d4bb5ec06d893b29e23a45cb7
check "payer relayer" 1 "PAYER_OPERATOR is the relayer" "$RELAYER" "$GOOD_PAYEE"
check "payer relayer lowercase" 1 "PAYER_OPERATOR is the relayer" \
  0x9d1b3e1400d2632d435cb7c0fc131c4f42b31861 "$GOOD_PAYEE"
check "payee relayer" 1 "PAYEE_OPERATOR is the relayer" "$GOOD_PAYER" "$RELAYER"
check "payee relayer lowercase" 1 "PAYEE_OPERATOR is the relayer" \
  "$GOOD_PAYER" 0x9d1b3e1400d2632d435cb7c0fc131c4f42b31861
check "payer live escrow" 1 "PAYER_OPERATOR is blocklisted" "$LIVE" "$GOOD_PAYEE"
check "payee live escrow lowercase" 1 "PAYEE_OPERATOR is blocklisted" \
  "$GOOD_PAYER" 0x3d660502d75f1e97b08c110255921b437a3c4c42
check "payer retired esc-m1 escrow" 1 "PAYER_OPERATOR is blocklisted" "$RETIRED_ESC_M1" "$GOOD_PAYEE"
check "payee retired esc-m1 escrow lowercase" 1 "PAYEE_OPERATOR is blocklisted" \
  "$GOOD_PAYER" 0x1069aa6597f08f1e8b8ad39aa40ede1d0c77298d
check "payer retired escrow" 1 "PAYER_OPERATOR is blocklisted" "$RETIRED" "$GOOD_PAYEE"
check "payee retired escrow lowercase" 1 "PAYEE_OPERATOR is blocklisted" \
  "$GOOD_PAYER" 0x141214f04b0e1d949b6e6bf32d019ad7ab5b284c
check "payer simulate sender" 1 "PAYER_OPERATOR is blocklisted" \
  0xDeaDDEaDDeAdDeAdDEAdDEaddeAddEAdDEAd0001 "$GOOD_PAYEE"
check "payee foundry sender" 1 "PAYEE_OPERATOR is blocklisted" \
  "$GOOD_PAYER" 0x1804c8AB1F12E6bbf3894d4083f33e07309d1f38
check "payer sample arbitrator" 1 "PAYER_OPERATOR is blocklisted" \
  0x0000000000000000000000000000000000000A11 "$GOOD_PAYEE"
check "payee sample from-address" 1 "PAYEE_OPERATOR is blocklisted" \
  "$GOOD_PAYER" 0x0000000000000000000000000000000000000001
check "quoted placeholders" 1 "PAYER_OPERATOR invalid/placeholder" \
  "<SPENCER_PAYER_WALLET>" "<REAL_PAYEE_WALLET>"
check "timelock payer still allowed" 0 "" "$TIMELOCK" "$GOOD_PAYEE"
check "deployer payer still allowed" 0 "" 0x5D467FA00eC0E92044f779e495a17db66c5964aa "$GOOD_PAYEE"
check "payer insurance fund" 1 "PAYER_OPERATOR is blocklisted" \
  0x19fc26B36Cb2031062eD90C19db64b3b09753ab8 "$GOOD_PAYEE"
check "payee insurance fund lowercase" 1 "PAYEE_OPERATOR is blocklisted" \
  "$GOOD_PAYER" 0x19fc26b36cb2031062ed90c19db64b3b09753ab8
check "payer liability" 1 "PAYER_OPERATOR is blocklisted" \
  0x554Caf5a214B8d70D675C09186C5EAE24FEB7307 "$GOOD_PAYEE"
check "payee liability lowercase" 1 "PAYEE_OPERATOR is blocklisted" \
  "$GOOD_PAYER" 0x554caf5a214b8d70d675c09186c5eae24feb7307
check "payer old denylist" 1 "PAYER_OPERATOR is blocklisted" \
  0xF0f260967D377E07Bdd7840862508ddB23C012b8 "$GOOD_PAYEE"
check "payee old denylist lowercase" 1 "PAYEE_OPERATOR is blocklisted" \
  "$GOOD_PAYER" 0xf0f260967d377e07bdd7840862508ddb23c012b8

# Stale values stay set until something clears them. The guard fails without unset.
PAYER_OPERATOR=0x1111111111111111111111111111111111111111
PAYEE_OPERATOR=0x2222222222222222222222222222222222222222
export PAYER_OPERATOR PAYEE_OPERATOR
out=$(ops_guard 2>&1)
got=$?
printf '== %s stale pair still set ==\n%s\nrc %s\n' "$shell" "$out" "$got"
if [ "$got" != 1 ]; then
  echo MISMATCH
  fail=$((fail + 1))
fi
unset PAYER_OPERATOR PAYEE_OPERATOR
out=$(ops_guard 2>&1)
got=$?
printf '== %s after standalone unset ==\n%s\nrc %s\n' "$shell" "$out" "$got"
if [ "$got" != 1 ]; then
  echo MISMATCH
  fail=$((fail + 1))
fi
case $out in
  *"PAYER_OPERATOR invalid/placeholder"*) ;;
  *)
    echo "MISSING: PAYER_OPERATOR invalid/placeholder"
    fail=$((fail + 1))
    ;;
esac

saved_path=$PATH
PATH="/usr/bin:/bin"
hash -r 2>/dev/null || true
PAYER_OPERATOR=$GOOD_PAYER
PAYEE_OPERATOR=$GOOD_PAYEE
export PAYER_OPERATOR PAYEE_OPERATOR
out=$(ops_guard 2>&1)
got=$?
PATH=$saved_path
hash -r 2>/dev/null || true
printf '== %s missing cast ==\n%s\nrc %s\n' "$shell" "$out" "$got"
if [ "$got" != 1 ]; then
  echo MISMATCH
  fail=$((fail + 1))
fi
case $out in
  *"cast is not installed"*) ;;
  *)
    echo "MISSING: cast is not installed"
    fail=$((fail + 1))
    ;;
esac

send_tmp=$(mktemp -d)
awk '
  /^```bash$/ { cap=1; buf=""; next }
  cap && /^```$/ {
    cap=0
    if (index(buf, "cast send") && index(buf, "ops_guard()")) {
      n++
      path = sprintf("%s/send-%d.sh", tmp, n)
      printf "%s", buf > path
      close(path)
    }
    next
  }
  cap { buf = buf $0 ORS }
' tmp="$send_tmp" "$md"
send_count=$(find "$send_tmp" -name 'send-*.sh' | wc -l | tr -d ' ')
if [ "$send_count" != 2 ]; then
  echo "$shell: expected two send pastes, found $send_count"
  fail=$((fail + 1))
fi

exercise_send() {
  label=$1
  snippet=$2
  mode=$3
  snippet=$(printf '%s\n' "$snippet" | sed 's/<his-keystore>/KEYSTORE/g')
  out=$(
    {
    unset PAYER_OPERATOR PAYEE_OPERATOR
    unset -f cast 2>/dev/null || true
    if [ "$mode" = missing ]; then
      PATH="/usr/bin:/bin"
      hash -r 2>/dev/null || true
    else
      CHAIN_MODE=$mode
      # shellcheck disable=SC2317
      cast() {
        if [ "$1" = "chain-id" ]; then
          if [ "$CHAIN_MODE" = error ]; then
            echo "cast chain-id failed" >&2
            return 1
          fi
          if [ "$CHAIN_MODE" = empty ]; then
            printf '\n'
            return 0
          fi
          if [ "$CHAIN_MODE" = wrong ]; then
            printf '%s\n' 1
            return 0
          fi
          printf '%s\n' 84532
          return 0
        fi
        if [ "$1" = "send" ]; then
          echo SENT
          return 0
        fi
        if [ "$1" = "wallet" ]; then
          echo WALLET
          return 0
        fi
        command cast "$@"
      }
    fi
    BASE_SEPOLIA_RPC_URL=https://sepolia.base.org
    export BASE_SEPOLIA_RPC_URL
    # shellcheck disable=SC1090
    eval "$snippet"
    echo SHELL_STILL_OPEN
    } 2>&1
  )
  got=$?
  printf '== %s %s ==\n%s\nrc %s\n' "$shell" "$label" "$out" "$got"
  if [ "$got" != 0 ]; then
    echo "shell exited"
    fail=$((fail + 1))
  fi
  case $out in
    *SHELL_STILL_OPEN*) ;;
    *)
      echo "shell did not stay open"
      fail=$((fail + 1))
      ;;
  esac
  case $out in
    *SENT*)
      echo "sent a transaction"
      fail=$((fail + 1))
      ;;
  esac
  case $out in
    *WALLET*)
      echo "called the wallet"
      fail=$((fail + 1))
      ;;
  esac
  if [ "$mode" = missing ]; then
    case $out in
      *"cast is not installed"*) ;;
      *)
        echo "MISSING: cast is not installed"
        fail=$((fail + 1))
        ;;
    esac
    case $out in
      *"wrong chain: expected Base Sepolia 84532"*)
        echo "missing cast reported wrong chain"
        fail=$((fail + 1))
        ;;
    esac
  elif [ "$mode" = ok ]; then
    case $out in
      *"wrong chain: expected Base Sepolia 84532"*)
        echo "84532 reported wrong chain"
        fail=$((fail + 1))
        ;;
    esac
    case $out in
      *"PAYER_OPERATOR invalid/placeholder"*) ;;
      *)
        echo "84532 did not reach ops_guard"
        fail=$((fail + 1))
        ;;
    esac
  else
    case $out in
      *"wrong chain: expected Base Sepolia 84532"*) ;;
      *)
        echo "MISSING: wrong chain: expected Base Sepolia 84532"
        fail=$((fail + 1))
        ;;
    esac
    case $out in
      *"invalid/placeholder"*|*"blocklisted"*|*"is the relayer"*)
        echo "chain failure still ran ops_guard"
        fail=$((fail + 1))
        ;;
    esac
  fi
}

for send_file in "$send_tmp"/send-*.sh; do
  send_body=$(cat "$send_file")
  send_name=$(basename "$send_file")
  exercise_send "$send_name missing cast" "$send_body" missing
  exercise_send "$send_name wrong chain" "$send_body" wrong
  exercise_send "$send_name empty chain" "$send_body" empty
  exercise_send "$send_name cast error" "$send_body" error
  exercise_send "$send_name base sepolia continues" "$send_body" ok
done
rm -rf "$send_tmp"

echo "SHELL-ALIVE $shell fail=$fail"
if [ "$fail" != 0 ]; then
  exit 1
fi
echo "ALL PASS ($shell)"
