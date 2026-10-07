# Audio assets

Place the optional audio files in this folder. The game continues to work when any file is missing.

## Background music

`bgm.mp3`

- Loops automatically during gameplay.
- Restarts from 00:00 for every new game.
- Default volume: 35%.

## Sound effects

These files are supported as dedicated effects. When one is missing, the game automatically falls back to a compatible custom MP3 already present in `assets/audio/`, so buttons/actions do not become silent:

`tile-select.mp3` — selecting a tile  
`tile-place.mp3` — placing a tile on the board  
`tile-cancel.mp3` — removing/cancelling a placed or selected tile  
`word-submit.mp3` — submitting a valid move  
`invalid.mp3` — invalid action or rejected input  
`score.mp3` — successful scoring feedback  
`tile-swap.mp3` — swapping tiles  
`pass.mp3` — passing a turn  
`undo.mp3` — undoing the last move  
`game-end.mp3` — game finished

Win/lose-specific audio cues are intentionally not used. The game uses the single `game-end.mp3` cue when a match ends.

## Recommended feel

Use short, clean effects rather than loud arcade-style sounds. Tile sounds work best with a wooden/plastic board character, while score and submit sounds should be soft chimes.

The in-game speaker button provides instant mute/unmute. The adjacent audio-settings button opens independent music and SFX volume controls plus per-channel toggles. All audio preferences are saved on the same device.
