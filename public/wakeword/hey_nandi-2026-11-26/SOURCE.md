# Wake word model: hey_nandi (2026-11-26)

Source: [shunn-labs/Nandi_WakeWord](https://github.com/shunn-labs/Nandi_WakeWord), branch `development`,
commit `14f8497` ("Add hey_nandi model trained with first real recordings", PR #1).

| file | from | md5 |
|---|---|---|
| `hey_nandi.onnx` | `models/hey_nandi.onnx` | b178bdd02628cb3f7cf7a4b6e1c32aba |
| `hey_nandi.json` | `models/hey_nandi.json` (threshold 0.99, patience 1, debounce 1.5 s) | a0906b2a6916bc85e454bd42250e34fe |
| `melspectrogram.onnx` | `models/shared/melspectrogram.onnx` (openWakeWord v0.5.1) | 763f67cda79753bd15a7dc9e2c391100 |
| `embedding_model.onnx` | `models/shared/embedding_model.onnx` (openWakeWord v0.5.1) | 7602421d736d1a67e616bd85a01686fc |

Input is 16 kHz mono audio, processed in 1280-sample chunks. The model's input is `[1, 16, 96]` embeddings and
its output is a `[1, 1]` score.

## Why this model, not hey_nandi_baseline
Measured on the held-out real recordings (2026-11-27):

| | baseline | hey_nandi |
|---|---|---|
| recall, 20 real "hey nandi"s | 0 % | 90 % |
| false wakes on real room background | 59–257/h | 0 (thr ≥ 0.9) |
| false accepts/h on the 11 h validation set at 0.99 | 0.93 | 0.00 |

## In the browser (Chrome, real recordings through a fake mic)
- **Threshold 0.95:** 18 of 21 heard, and 0 false wakes in 3 min of real room audio plus other speech.
- **Threshold 0.99:** 16 of 21 heard.

This is why the frontend's "Normal" sensitivity is 0.95 rather than the model's own 0.99.
