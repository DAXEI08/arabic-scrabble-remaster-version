# Audio system

Arabic Scrabble uses a **zero-MP3 procedural audio system** in `js/audio.js`.

## Audio direction

The audio layer is designed around a **restrained, classic Arabic character** rather than an arcade-game palette:

- oud-inspired plucked-string synthesis for musical notes and tonal feedback;
- sparse Hijaz-colored phrases in 12-TET;
- long, quiet note tails and a small room ambience;
- no bright electronic beeps, synthetic score fanfares, or rhythmic arcade percussion;
- tile interaction uses subtle wood/tap transients instead of hard UI impacts;
- end-game uses one calm Hijaz cadence with no separate win/lose cues.

This is an **oud-inspired synthesis model**, not a recording of a real oud and not a claim of reproducing traditional maqam intonation.

## Procedural SFX

The audio engine synthesizes all gameplay/UI effects with Web Audio API:

- `button-click` — soft high-register plucked-string touch.
- `tile-select` — warm single-string confirmation.
- `tile-place` — muted wood tap with a low oud pluck.
- `tile-cancel` — restrained descending two-note pluck.
- `word-submit` — gentle two-note oud cadence.
- `invalid` — low muted note instead of a buzzer-like warning.
- `score` — sparse Hijaz-colored three-note phrase.
- `tile-swap` — quiet wood shuffle with two muted plucks.
- `pass` — low, soft string tone.
- `undo` — descending two-note pluck.
- `game-end` — quiet A–G–F#–Eb–D Hijaz-colored resolution.

No external audio file is loaded for these events.

## Procedural BGM

Gameplay music is synthesized in real time with a lightweight scheduler.

The melodic material uses a **D Hijaz color in 12-TET**:

`D – Eb – F# – G – A – Bb – C – D`

The arrangement is intentionally spacious:

- 72 BPM;
- oud-like multi-harmonic plucks instead of triangle/sine lead synths;
- sparse 16-step phrases with deliberate rests;
- occasional brief b2→3 ornamentation to reinforce the Hijaz color;
- very soft D/A drone and low plucked-string foundation;
- no continuous kick/snare/backbeat layer;
- subtle synthesized room ambience;
- gentle fade-in/out and modal ducking.

The result is intended to feel closer to an intimate traditional-instrument performance than an arcade soundtrack.

## Runtime design

`js/audio.js` provides:

- one shared Web Audio context;
- logical master/music/SFX buses;
- gentle dynamics compression for headroom;
- lazy context creation for mobile autoplay compatibility;
- low-cost procedural synthesis instead of asset decoding;
- deterministic lifecycle/session cleanup;
- modal music ducking with balanced depth;
- BGM scheduling with bounded look-ahead;
- visibility/page lifecycle pause and resume;
- SFX priority and cooldown handling;
- protection against asynchronous playback races;
- immediate end-game stinger cancellation on the new-game control;
- persistent master/music/SFX preferences.

The public API used by the game remains compatible.

## Asset-quality note

Because the audio is synthesized at runtime, there are no MP3 codec, bitrate, loudness, or loop-file import settings to maintain.

Device-level validation is still required for perceived oud timbre, latency, CPU usage, autoplay/audio-focus behavior, and subjective mix quality on representative desktop, Android, and iOS browsers.
