# Audio system

Arabic Scrabble now uses a **zero-MP3 procedural audio system** in `js/audio.js`.

## Audio assets

No MP3 runtime assets are required under `assets/audio/`.

The folder may contain only documentation and repository housekeeping files.

## Procedural SFX

The audio engine synthesizes all gameplay/UI effects with Web Audio API:

- `button-click` — short clean UI tick.
- `tile-select` — light confirmation tone.
- `tile-place` — warm tile tap with a short noise transient.
- `tile-cancel` — soft downward cancellation tone.
- `word-submit` — two-note positive chime.
- `invalid` — muted dissonant warning.
- `score` — short ascending score flourish.
- `tile-swap` — compact tap + tone.
- `pass` — low soft pass tone.
- `undo` — short descending confirmation.
- `game-end` — calm Hijaz-colored resolution; there are no separate win/lose cues.

No external audio file is loaded for these events.

## Procedural BGM

Gameplay music is synthesized in real time with a lightweight scheduler.

The melodic material uses a **D Hijaz color in 12-TET**:

`D – Eb – F# – G – A – Bb – C – D`

The arrangement is intentionally subtle:

- triangle/sine plucked melody;
- low root/fifth bass;
- quiet D/G drone;
- restrained pulse/percussion;
- four-bar phrase variation;
- soft fade-in/out and modal ducking.

This is an inspired Hijaz coloration, not a claim of reproducing traditional Arabic maqam performance practice or microtonal intonation.

## Runtime design

`js/audio.js` provides:

- one shared Web Audio context;
- logical master/music/SFX buses;
- dynamics compression for headroom protection;
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

Device-level validation is still required for perceived timbre, latency, CPU usage, autoplay/audio-focus behavior, and subjective mix quality on representative desktop, Android, and iOS browsers.
