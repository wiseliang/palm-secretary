#!/usr/bin/env bash
set -eo pipefail
cd /tmp/palm-quiz-v036
set -a
source /etc/palm-secretary/app.env
set +a
set -u
for start in 0 10 20 30 40 50; do
  batch=$((start / 10))
  if (( batch % 2 == 0 )); then models=(gpt-5.6-sol gpt-5.6-terra); else models=(gpt-5.6-terra gpt-5.6-sol); fi
  for model in "${models[@]}"; do
    output="/tmp/palm-quiz-v036-batch-${start}-${model}.json"
    QUIZ_BENCHMARK_MODEL="$model" QUIZ_BENCHMARK_START="$start" QUIZ_BENCHMARK_COUNT=10 \
      QUIZ_BENCHMARK_OUTPUT="$output" node tests/quiz-model-batch-v036.mjs
    sleep 2
  done
done
echo '{"complete":true,"batches":12}'
