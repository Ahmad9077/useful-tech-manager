# Useful Tech permanent production system

Every Useful Tech render uses the canonical Remotion system in `LocalSend-Style-Test-v2` and the profile in `quality-reference.json`.

## Layering and focus

Scene layers are fixed: environment, supporting graphics, device/UI, active concept, captions, then brand bug. A concept introduced by narration must enter as the foreground focal element; it cannot be decoratively faint, behind a device, or obscured by a card.

## Captions and language

Caption cues are generated from final Cartesia Walid word timestamps. A TTS, pause, pace, pronunciation, or script change invalidates old cues. Arabic captions are native RTL browser text. Inline English product names use isolated LTR `bdi` elements; Arabic is never manually reversed.

Caption surfaces use canonical related-color themes: DARK_NAVY, LIGHT_IVORY, BLUE, TEAL, NEUTRAL_DARK, and NEUTRAL_LIGHT. The surface remains calm relative to the scene while text remains strongly readable.

## Brand

`AccountIdentifier` always uses the approved profile logo in a small upper-left channel pill. A matching secondary pill directly beneath it contains the TikTok mark and `@useful.tech.ar`. Both are quiet video artwork, separate from TikTok's own username, logo, and controls.

## Required quality gates

Before delivery, the pipeline verifies the 1080x1920 H.264/AAC master; final narration-to-caption timing; RTL and mixed-direction implementation; canonical logo asset and placement; foreground concept layering; adaptive caption surfaces; and representative visual frames. A failed gate prevents Telegram delivery.
