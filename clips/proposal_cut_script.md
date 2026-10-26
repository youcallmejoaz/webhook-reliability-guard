# Proposal cut script

A 60 to 90 second video for Upwork proposals: the problem, the result working, the safeguards, the offer. Built only from the Phase 3 clips. No captions, no music, no watermark. The narrator never gives a name or contact details and ends by inviting a reply on the proposal.

Voice: Kokoro TTS (open weights, Apache 2.0), voice `am_michael`, speed 1.0. Rendered with `python3 clips/tts.py` then `python3 clips/render_proposal_cut.py`.

| Scene | Clips | Narration |
|---|---|---|
| 1 | K01 | A customer pays, and the access email never arrives. Usually nobody knows until they complain. |
| 2 | C01, C02 | This safety net catches every event between your tools. Here, one in five deliveries is failing on purpose. |
| 3 | C03 | Failed deliveries are retried automatically, with a growing pause between tries, until they go through. Nothing is lost while a tool is down. |
| 4 | C04, C05 (close up) | Every fifteen minutes it checks that every buyer really has access, and fixes the ones that slipped through silently. In this test, it caught all three. |
| 5 | C06 | When something keeps failing, you get a plain English explanation of what happened, and what to fix. |
| 6 | C07, C08 | It also checks your email setup, and keeps your buyer list up to date. |
| 7 | K04 | If your automations are dropping customers, reply to this proposal, and we can map this to your tools. |

Timing rules:

- Each scene lasts its narration plus 0.5 seconds. With the narration as first written the cut came to about 59 seconds, so scenes 2 to 6 get 1.5 extra seconds each for the UI to breathe, and one true sentence was added to scene 4 ("In this test, it caught all three": reconciliation found all 3 silent drops in the recorded run).
- Clips are trimmed, or hold their last frame when short. Nothing is sped up.
- Hard cuts, except a 0.3 second crossfade from the K01 card into the UI. A slow 5 percent push in on shots longer than 8 seconds.
- Audio: voice only, loudness normalised to about -16 LUFS with ffmpeg loudnorm.
- Output: 1920 x 1080, 30 fps, H.264 (yuv420p), AAC, `+faststart`.
