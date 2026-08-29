# Third-party asset notices

This notice covers third-party files distributed in `public/assets`. It does not grant a
license to Riftline's source code or original project assets.

## WCA1 / Funpark arena

- Files: `public/assets/maps/wca1-remix.json`, `wca1-remix.bin`,
  `wca1-materials.json`, and `wca1-materials/`
- Source: [Warsow `warsow-assets`](https://github.com/Warsow/warsow-assets), including
  [`maps/wca1.bsp`](https://github.com/Warsow/warsow-assets/blob/master/maps/wca1.bsp)
- Upstream credit: Warsow contributors and the original WCA1/Funpark authors credited by
  that project
- Arena geometry license recorded by the conversion manifest: CC BY-SA 4.0
- Material license recorded by the import manifest: CC BY-SA 4.0 / CC BY-ND 4.0; consult
  the upstream [README](https://github.com/Warsow/warsow-assets#license) and
  [`assets-non-free.txt`](https://github.com/Warsow/warsow-assets/blob/master/assets-non-free.txt)
- Changes: BSP geometry was converted to compact browser collision/render buffers; selected
  textures were converted to browser formats, with normal/roughness companions generated
  where recorded in `wca1-materials.json`.

The CC BY-SA 4.0 license text is available at
https://creativecommons.org/licenses/by-sa/4.0/legalcode and the CC BY-ND 4.0 license text at
https://creativecommons.org/licenses/by-nd/4.0/legalcode.

## SWAT character

- File: `public/assets/models/quaternius-swat.glb`
- Creator: Quaternius
- Source: https://poly.pizza/m/Btfn3G5Xv4
- License: CC0 1.0 Universal, https://creativecommons.org/publicdomain/zero/1.0/
- Integration changes: the downloaded GLB is loaded at runtime with project-authored material
  tuning, animation selection, and collision behavior.

The model directory also contains its original [attribution notice](public/assets/models/ATTRIBUTION.md).

## Outpost Tower (FXB)

- File: `public/assets/models/outpost-tower-fxb.glb`
- Creator: laza
- Source: https://sketchfab.com/3d-models/outpost-tower-fxb-5f7cd68d238c4052b6802912f4a15865
- License: CC BY-NC 4.0, https://creativecommons.org/licenses/by-nc/4.0/
- Integration changes: geometry was simplified and quantized for browser runtime use; the source
  file contained UVs but no image textures, so QuickSense applies project-authored panel, roughness,
  and emissive signal materials at load time.

## Fonts

- Oxanium 700/800: Oxanium project, distributed through Google Fonts under the SIL Open Font
  License 1.1.
- Rajdhani 500/600/700: Indian Type Foundry, distributed through Google Fonts under the SIL
  Open Font License 1.1.
- License: https://openfontlicense.org/open-font-license-official-text/

## Generated audio

The files in `public/assets/audio` were generated for this project using the ElevenLabs account
and generation workflow described in the repository scripts. Their use remains subject to the
terms applicable to the account that generated them.
