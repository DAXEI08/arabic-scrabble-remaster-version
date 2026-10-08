# Audio assets

This project uses a single isolated web-audio layer in `js/audio.js`.

## Bundled assets

- `bgm.mp3` — looping gameplay background music.
- `game-end.mp3` — single end-of-game stinger.
- `tile-select.mp3` — tile selection/UI feedback.
- `tile-place.mp3` — tile placement/swap feedback.
- `tile-cancel.mp3` — cancel/pass/undo/invalid feedback.
- `word-submit.mp3` — successful submit/score feedback.

Dedicated files such as `invalid.mp3`, `score.mp3`, `tile-swap.mp3`, `pass.mp3`, and `undo.mp3` are not requested by the current build. Those logical events intentionally reuse the bundled sources above, avoiding speculative 404 requests.

Win/lose-specific cues are not used. The game uses only `game-end.mp3` when the match ends.

## Audio runtime behavior

`js/audio.js` provides:

- independent music and SFX controls plus master mute;
- logical music/SFX buses with per-event gain;
- shared media pools per unique source to avoid duplicate pools for reused assets;
- priority-based voice selection and deterministic voice stealing;
- cooldowns applied only after a playback attempt is accepted;
- immediate end-stinger cancellation when the new-game control is pressed;
- session reset so old fades/voices cannot leak into a new game;
- modal ducking with balanced state release;
- visibility/page lifecycle pause and resume;
- defensive handling for missing/broken audio without affecting gameplay;
- lazy creation of SFX voices and `bgm.mp3` with `preload="none"`.

The existing public audio API remains compatible with the game modules.

## Asset guidance

Keep SFX short and clean. Avoid clipped masters, excessive low-end, and large uncompressed files. Background music should have a clean loop point and a level that leaves headroom for gameplay SFX.

The repository stores the MP3 files directly. This web project has no Unity/Godot-style importer settings; codec/sample-rate/true-peak/loudness verification therefore requires access to the binary audio files or an in-browser/device audit.
