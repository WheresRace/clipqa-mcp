# Evaluating QA effectiveness

ClipQA should be judged on whether recording and selective frame retrieval improve QA outcomes compared with periodic screenshots. Do not use a single successful demo as evidence.

## Dataset

Create at least 30 reproducible test runs across desktop applications, browser interfaces, and games:

- 10 short visual defects lasting under 250 ms.
- 8 timing defects lasting 250 ms to 2 seconds.
- 6 persistent visual defects.
- 6 clean control runs.

For each run, store a hidden ground-truth file containing the defect category, start and end timestamps, expected UI or world state, and relevant source subsystem. Randomize scenario order and use the same runs for every strategy.

## Strategies

Compare these conditions:

1. Four periodic screenshots.
2. Twelve periodic screenshots.
3. ClipQA contact sheet only.
4. ClipQA contact sheet plus exact-frame retrieval.
5. ClipQA evidence plus timestamped application logs and events.

Include equal-image-budget comparisons and before/after regression tasks. Align baseline and changed runs by matching test events; report alignment errors separately from visual differences.

Use the same model, system prompt, reasoning setting, and token budget for all conditions.

## Scores

| Metric | Definition |
| --- | --- |
| Detection recall | Defective runs correctly identified / all defective runs. |
| False-positive rate | Clean runs incorrectly reported defective / all clean runs. |
| Temporal localization | Predicted defect timestamp overlaps the labeled interval. |
| Category accuracy | Predicted defect class matches ground truth. |
| Root-cause accuracy | Named subsystem or source location matches the seeded cause. |
| Evidence cost | Image tokens, elapsed time, and frames inspected per run. |

Report a confusion matrix and 95% bootstrap confidence intervals. Preserve every model response so results can be audited.

## Pass criteria for the MVP

ClipQA is useful when exact-frame retrieval materially improves recall on sub-second defects without an unacceptable increase in false positives or evidence cost. Root-cause accuracy should be evaluated separately because video alone often reveals symptoms rather than internal causes.
