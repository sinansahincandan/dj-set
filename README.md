# DJ Set

A two-deck DJ set that runs in the browser and is played with your hands. The laptop camera
shows you as a mirror, the DJ rig is drawn on top, and you work it the way you would work real
gear. No install; Windows and Mac; Chrome or Edge.

## How to play

Sit back about 60 cm so both hands fit in the picture, with light on your hands.

| You want to | Do this |
|---|---|
| Scratch | Lay your fingers on the record and slide or turn your hand. Take it away and the record carries on. |
| Turn a knob (EQ, filter) | Pinch it with thumb and index finger, then twist your hand, or circle your hand around the knob like a crank. |
| Move a fader (volume, tempo, crossfader) | Pinch it and slide. |
| Hit a pad (play, cue, sync, loop, hot cues) | Tap it in the air with your index finger. A quick pinch works too. |
| Filter sweep and echo | Put an open hand into the FX pad at the top: left/right sweeps the filter, higher adds echo. Take the hand out and the sound comes back. |

Two hands work at the same time, so you can scratch with one and cut the crossfader with the
other. Everything also works with a mouse (knobs: drag up and down).

Each deck starts with a built-in demo track. `LOAD` on a deck offers the other demo tracks and
your own audio files; you can also drop a file on the left or right half of the window.
Press `D` for the tracking debug panel.

## Record a set

`REC` in the top bar records what you play. "Screen + sound" asks to share this tab and saves a
video of the rig, your hands and the music; "Sound only" saves just the audio. Click `REC`
again to stop: the file lands in your Downloads folder (MP4 where the browser can write it,
otherwise WebM). The sound is taken straight from the mixer, so it is clean, and the microphone
is never used.

## Run it locally

The camera only works on `https://` or `localhost`, so opening `index.html` by double-click is
not enough. From this folder:

```bash
python3 -m http.server 5173
```

then open <http://localhost:5173> in Chrome or Edge.

## Put it online

It is a plain static folder, so any static host gives you a link to share.

- **Netlify Drop**: open <https://app.netlify.com/drop> and drag this folder onto the page.
- **GitHub Pages**: push the folder to a GitHub repository, then Settings → Pages → deploy from
  the `main` branch, root folder.

## Notes

- Hand tracking uses MediaPipe Hand Landmarker, loaded from jsDelivr and Google's model storage
  the first time the page opens, so the first start needs an internet connection. The camera
  picture is processed in the browser and never leaves the computer.
- Audio is the Web Audio API; each deck is an AudioWorklet that can play at any speed in either
  direction, which is what makes scratching work.
- `SPEC.md` describes how the modules fit together.
