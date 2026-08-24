#!/usr/bin/env bash
# leader-spike.sh — S1..S4 gates from the 2026-08-13 leader spec.
# Usage: leader-spike.sh <repo-path> [n-clients]   (default 8)
set -euo pipefail
REPO="${1:?repo path}"; N="${2:-8}"
SOCK="/tmp/grok-leader-spike.sock"
OUT="/tmp/grok-leader-spike-$(date +%s)"
mkdir -p "$OUT"
MODEL="${GROK_SWARM_WORKER_MODEL:-grok-4.6}"

rss_kb() { ps -o rss= -p "$1" 2>/dev/null | tr -d ' ' || echo 0; }

sum_rss() { # $@ = pids -> total KB
  local t=0 p r
  for p in "$@"; do r=$(rss_kb "$p"); t=$((t + ${r:-0})); done
  echo "$t"
}

echo "== S0 baseline: $N standalone grok -p =="
BASE_PIDS=()
for i in $(seq 1 "$N"); do
  grok -p "List the files in this directory with the list_dir tool, then say DONE-$i" \
    --cwd "$REPO" -m "$MODEL" --always-approve \
    --output-format json > "$OUT/base-$i.json" 2>"$OUT/base-$i.err" &
  BASE_PIDS+=($!)
done
sleep 20   # sample mid-flight
BASE_RSS=$(sum_rss "${BASE_PIDS[@]}")
wait "${BASE_PIDS[@]}" || true
echo "baseline_rss_kb=$BASE_RSS" | tee "$OUT/s0.txt"

echo "== leader up =="
grok agent leader --no-exit-on-disconnect --no-auto-update \
  --leader-socket "$SOCK" > "$OUT/leader.log" 2>&1 &
LEADER_PID=$!
for _ in $(seq 1 50); do [[ -S "$SOCK" ]] && break; sleep 0.2; done
[[ -S "$SOCK" ]] || { echo "FAIL: leader socket never appeared"; exit 1; }

echo "== S1: $N leader clients, independent sessions =="
S1_PIDS=()
for i in $(seq 1 "$N"); do
  grok --leader --leader-socket "$SOCK" \
    -p "List the files in this directory with the list_dir tool, then say DONE-$i" \
    --cwd "$REPO" -m "$MODEL" --always-approve \
    --output-format json > "$OUT/s1-$i.json" 2>"$OUT/s1-$i.err" &
  S1_PIDS+=($!)
done
sleep 20
S1_CLIENT_RSS=$(sum_rss "${S1_PIDS[@]}")
S1_LEADER_RSS=$(rss_kb "$LEADER_PID")
wait "${S1_PIDS[@]}" || true
S1_TOTAL=$((S1_CLIENT_RSS + S1_LEADER_RSS))
SIDS=$(jq -r '.sessionId // empty' "$OUT"/s1-*.json 2>/dev/null | sort -u | wc -l | tr -d ' ')
echo "s1_total_rss_kb=$S1_TOTAL leader_rss_kb=$S1_LEADER_RSS distinct_sessions=$SIDS/$N" | tee "$OUT/s1.txt"

echo "== S2: mixed cwd (MAIN + throwaway worktree) =="
WT="$OUT/wt-spike"
git -C "$REPO" worktree add -b swarm/leader-spike "$WT" HEAD >/dev/null
grok --leader --leader-socket "$SOCK" -p "Run list_dir, say MAIN" \
  --cwd "$REPO" -m "$MODEL" --always-approve --output-format json \
  > "$OUT/s2-main.json" 2>&1 &
P_MAIN=$!
grok --leader --leader-socket "$SOCK" -p "Run list_dir, say WT" \
  --cwd "$WT" -m "$MODEL" --always-approve --output-format json \
  > "$OUT/s2-wt.json" 2>&1 &
P_WT=$!
wait "$P_MAIN" "$P_WT" && echo "s2=pass" | tee "$OUT/s2.txt" || echo "s2=FAIL" | tee "$OUT/s2.txt"

echo "== S3: kill client mid-turn — does the leader session keep running? =="
# STARTED marker proves the tool call was mid-flight before the kill; DONE only
# appears if the leader keeps executing after the client dies.
grok --leader --leader-socket "$SOCK" \
  -p "Use run_terminal_cmd to run exactly: touch SPIKE-S3-STARTED.txt && sleep 15 && touch SPIKE-S3-DONE.txt
Then say DONE." \
  --cwd "$WT" -m "$MODEL" --always-approve > "$OUT/s3.log" 2>&1 &
P_S3=$!
for _ in $(seq 1 60); do [[ -f "$WT/SPIKE-S3-STARTED.txt" ]] && break; sleep 0.5; done
S3_STARTED=$([[ -f "$WT/SPIKE-S3-STARTED.txt" ]] && echo 1 || echo 0)
kill -9 "$P_S3" 2>/dev/null || true
sleep 25
# `|| true`: empty glob must read as 0, not abort the script under set -euo pipefail
S3_FILES=$(ls "$WT"/SPIKE-S3-DONE.txt 2>/dev/null | wc -l | tr -d ' ' || true)
# DONE present after client kill = leader kept executing = leader_pause_mode must stay "leader"
echo "s3_started=$S3_STARTED s3_files_after_kill=$S3_FILES (0=client kill cancels turn; 1=leader keeps running)" | tee "$OUT/s3.txt"

echo "== S4: read-only flags through the leader =="
grok --leader --leader-socket "$SOCK" \
  -p "Try to create a file called S4-WRITE-TEST.txt. Report whether you could." \
  --cwd "$WT" -m "$MODEL" --always-approve --max-turns 5 \
  --tools "read_file,grep,list_dir" > "$OUT/s4.log" 2>&1 || true
[[ -f "$WT/S4-WRITE-TEST.txt" ]] && echo "s4=FAIL (reviewer wrote)" | tee "$OUT/s4.txt" \
                                 || echo "s4=pass (write blocked)" | tee "$OUT/s4.txt"

echo "== cleanup =="
kill "$LEADER_PID" 2>/dev/null || true
git -C "$REPO" worktree remove --force "$WT" 2>/dev/null || true
git -C "$REPO" branch -D swarm/leader-spike 2>/dev/null || true
echo "Results in $OUT"; cat "$OUT"/s*.txt
