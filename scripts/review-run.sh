#!/bin/sh
# Gemini 검토 한 회: sh scripts/review-run.sh <history|text> <elementary|middle>
# 결과: review/gemini-<종류>-<수준>.raw.json (원문), .stderr.txt
cd "$(dirname "$0")/.." || exit 1
k="$1"; lv="$2"
agy --model gemini-4-neon-high --sandbox --mode plan --output-format json --json-schema review/schema.json \
  -p "$(cat review/prompt-$k-$lv.txt)" > "review/gemini-$k-$lv.raw.json" 2> "review/gemini-$k-$lv.stderr.txt"
echo "exit $? review/gemini-$k-$lv.raw.json"
