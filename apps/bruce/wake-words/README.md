# Wake-word models

Bruce listens for his wake phrase with
[openWakeWord](https://github.com/dscripka/openWakeWord) (Apache-2.0), run
locally through ONNX Runtime. Entirely offline and account-free — it replaced
Picovoice Porcupine, whose access key stopped working and can't be reissued
without a Picovoice account.

Three models make one detector:

| File | Role | Shared? |
|---|---|---|
| `melspectrogram.onnx` | 16kHz PCM → mel spectrogram | yes |
| `embedding_model.onnx` | mel frames → Google `speech_embedding` vectors | yes |
| `hey_bruce.onnx` | embeddings → "did they say the phrase?" | **no** — this one *is* the phrase |

Only the third file is phrase-specific, so changing the wake phrase means
dropping in another `.onnx` and pointing `BRUCE_WAKE_WORD_MODEL` at it. Unlike
the old `.ppn` files these are platform-independent: the same models run on the
Pi and on a Windows dev machine.

```
70d164290c1d095d1d4ee149bc5e00543250a7316b59f31d056cff7bd3075c1f  embedding_model.onnx
ba2b0e0f8b7b875369a2c89cb13360ff53bac436f2895cced9f479fa65eb176f  melspectrogram.onnx
166718c26a4629064b2cfbaadbfd1c70a651a7c706bc60c53afed93efa443f85  hey_bruce.onnx
94a13cfe60075b132f6a472e7e462e8123ee70861bc3fb58434a73712ee0d2cb  hey_jarvis_v0.1.onnx
```

The two shared models come from the openWakeWord
[v0.5.1 release](https://github.com/dscripka/openWakeWord/releases/tag/v0.5.1).
They are committed rather than downloaded at deploy time so that a Pi rebuild
never depends on GitHub being reachable.

## `hey_bruce.onnx`

Trained locally (RTX 3090, ~3 h) with openWakeWord's `train.py`: 30,000
synthetic "hey bruce" clips from Piper TTS, augmented against 270 MIT room
impulse responses, 4.7 h of AudioSet noise and 4 h of Free Music Archive music,
with 2,000 h of ACAV100M speech as the negative feature set. The training
scripts live outside this repo — see `deploy/README-bruce.md`.

Measured on 60 held-out "hey bruce" clips and 136 negatives, scored through
`src/engine/WakeWordDetector.js` (i.e. the code that actually runs on the Pi,
not the Python trainer):

| Threshold | Wake phrase detected | False fires (136 negatives) |
|---|---|---|
| 0.4 | 88.3% | 2 |
| **0.5 (default)** | **83.3%** | **0** |
| 0.7 | 78.3% | 0 |

At the default threshold nothing in the negative set fires: not the brewery
vocabulary (`brew day`, `brewing`, `brewer`, `brewers friend`, `the brew is
ready`, all ≤0.003), and not the near-miss phrases (`hey bro` 0.119,
`hey booster` 0.070, `hey bertie` 0.016).

**Don't lower the threshold below 0.5 without re-testing.** The margin is not
uniform — `hey brew` peaks at 0.480, so it sits just under the line and is the
first thing that will start firing. Everything else has far more headroom.

The 83% is per-utterance, not per-session: an unheard "hey Bruce" is normally
just repeated, which takes two attempts past 97%.

## Why the negatives are weighted the way they are

The first model trained (not committed) scored 0.93–0.96 on `hey brew` and
`hey bro` — as high as genuine positives, so no threshold could separate them.
It had learned "hey + b-word" rather than *bruce*.

The cause is worth knowing before retraining. `train.py` builds its negative
text pool as

```python
adversarial_texts = config["custom_negative_phrases"]
adversarial_texts.extend(generate_adversarial_texts(N=config["n_samples"]))
```

and `generate_samples()` walks that list with `itertools.cycle` up to
`max_samples`. With `n_samples: 30000` the list is *17 curated + 30,000
generated*, consumed in order and never wrapped — so each curated phrase
produced exactly **one** clip out of 30,000. Listing a phrase in
`custom_negative_phrases` does essentially nothing at default settings.

The committed model repeats 41 curated phrases until they are 20% of the
negative set, in two families: same onset/wrong ending (`hey brew`, `hey bro`,
`hey brute`) and same ending/wrong onset (`hey truce`, `hey juice`,
`hey spruce`). Both are needed — suppressing only the first leaves it firing on
"hey truce", only the second on "hey brew". It generalised rather than
memorised: `hey bertie` and `hey booster` were never in the training config and
still dropped from 0.945 to under 0.07.

The trade is real. Recall on heavily-augmented validation audio fell from 0.458
to 0.119 as false-positives-per-hour went 0.177 → 0.0, which is what the 100% →
83% column above costs. A model that answers to "hey bro" in a room with people
in it is worse than one that occasionally needs the phrase repeated.

## `hey_jarvis_v0.1.onnx`

Kept as a fallback, no longer the default. It is one of openWakeWord's
pre-trained models and was the placeholder before `hey_bruce.onnx` existed. It
does not respond to "hey bruce" (scores ≤0.005 on the same 60 clips), so it is
only useful if you want to test the audio chain independently of the custom
model. Point `BRUCE_WAKE_WORD_MODEL` at it to do that.
