# Riftline Arena — Technical Art Brief

- Art direction: graphic cel-shaded sci-fi sport; faceted armor, dark navy contact masses, cyan objective energy, magenta power-weapon signals, amber damage signals, lime speed signals, hard silhouettes, restrained fog, and angular HUD/world motifs.
- Hero surfaces: first-person weapon model, three enemy silhouettes, Flux Core, railgun pickup/perch, terrain ski routes, jump pads, four landmark towers, impact/projectile effects, and combat HUD.
- Support surfaces: terrain subdivisions, perimeter arches, route ticks, far monoliths, rail structures, small pickup bases, and background sky geometry.
- Material roles: bodyPrimary navy, bodySecondary blue-gray, trim pale cyan, hazard coral, reward cyan, shieldBoost lime, glass cyan visor, emissiveSignal per gameplay category, groundContact near-black, decalDark navy, decalLight blue-white.
- VFX language: short weapon-colored tracers, deterministic impact shards, bounded trauma shake, speed-based FOV, objective/pickup pulses, damage vignette, hit marker, and reduced-motion freeze.
- Lighting: cool hemisphere fill, white-blue directional key, cyan core practical, magenta rail practical, contact shadows on major actors, exponential depth fog, one stylized sky dome.
- Asset strategy: authored procedural geometry because the credential probe returned `TRIPO_API_KEY=MISSING`, `GEMINI_API_KEY=MISSING`, and `ELEVENLABS_API_KEY=MISSING`; collision proxies stay independent from visual detail. Procedural Web Audio supplies the local feedback fallback.
- Repetition strategy: instanced route ticks and far monoliths; shared toon materials and geometries for repeated kit; frustum culling for static world; no large image textures; no post-processing passes in the first budget.
- Desktop budget: ≤180 calls, ≤350k visible triangles, ≤180 geometries, ≤20 textures, DPR ≤1.75, one 2048 shadow map, zero post passes.
- Mobile budget: ≤150 calls, ≤300k visible triangles, ≤150 geometries, ≤20 textures, DPR ≤1.75 with CSS touch controls; reduce shadow map to 1024 or disable enemy shadows first if measured performance fails.
