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
| `hey_jarvis_v0.1.onnx` | embeddings → "did they say the phrase?" | **no** — this one *is* the phrase |

Only the third file is phrase-specific, so changing the wake phrase means
dropping in another `.onnx` and pointing `BRUCE_WAKE_WORD_MODEL` at it. Unlike
the old `.ppn` files these are platform-independent: the same models run on the
Pi and on a Windows dev machine.

All three were downloaded from the openWakeWord
[v0.5.1 release](https://github.com/dscripka/openWakeWord/releases/tag/v0.5.1):

```
70d164290c1d095d1d4ee149bc5e00543250a7316b59f31d056cff7bd3075c1f  embedding_model.onnx
94a13cfe60075b132f6a472e7e462e8123ee70861bc3fb58434a73712ee0d2cb  hey_jarvis_v0.1.onnx
ba2b0e0f8b7b875369a2c89cb13360ff53bac436f2895cced9f479fa65eb176f  melspectrogram.onnx
```

They are committed rather than downloaded at deploy time so that a Pi rebuild
never depends on GitHub being reachable.

## Why "hey jarvis" and not "Bruce"

openWakeWord ships pre-trained models for a handful of phrases only — `alexa`,
`hey_jarvis`, `hey_mycroft`, `hey_rhasspy`, `timer`, `weather`. There is no
"Bruce", so `hey_jarvis` is a placeholder that makes the whole chain work
today. Training a real one is free and unattended; see **"Training a 'hey
Bruce' model"** in [deploy/README-bruce.md](../../../deploy/README-bruce.md).

When you train one, prefer **"hey Bruce"** over bare "Bruce". openWakeWord is
markedly more reliable on longer phrases — a single syllable gives the model
very little to go on, and a brewery full of pumps and boiling wort is exactly
where that shows up as false triggers.
