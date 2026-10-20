import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder as vendoredDecoder } from './vendor/meshopt_decoder.module.js';
import type { MeshoptDecoderLike } from '../sim/stageGlb.js';

/** The vendored decoder (plain JS: its inferred type is a union with the unsupported stub), typed for its two uses here. */
const MeshoptDecoder = vendoredDecoder as unknown as MeshoptDecoderLike & { ready: Promise<unknown>; supported: boolean };

/**
 * EXT_meshopt_compression for every GLB the game loads: the stage files and the four animals are stored meshopt-compressed (3-4x smaller downloads;
 * the CDN serves .glb bytes as they are, without transfer compression).
 *
 * The decoder is a vendored copy of three r185's examples/jsm/libs/meshopt_decoder.module.js (MIT, WASM embedded: no extra request; the notice below
 * has to survive minification). GLTFLoader reads `this.meshoptDecoder` when it PARSES, so wrapping `GLTFLoader.prototype.parse` once gives EVERY loader
 * this decoder: the engine's shared `engine.loader` (the animals go through `loadCharacterModel`) and the loaders game code cannot reach. The plugin only touches
 * buffer views that carry the extension. Imported from exactly the specifier the engine uses, so the published build patches the same module instance.
 *
 * Since engine 3.1280 every loader the engine builds already has a decoder: three's own, imported lazily on the first compressed file. In the published page that import is one
 * more esm.sh request on the critical path of the first stage (the parse waits for it), while this vendored copy is in the bundle already, so the game's decoder is set
 * unconditionally and the engine's is never imported. (Checked with tools/assets/decoder_requests.mjs.)
 *
 * `parseStageGlb` (the sim's own GLB reader, for the collision meshes) takes `MeshoptDecoder` as an option: see StageView.loadStageAsset.
 */
const PATCHED = Symbol.for('tor.meshoptParsePatch');
/** The decoder's MIT notice as a string the minifier keeps (it strips the vendored file's comment header, and the licence asks for the notice in every copy). */
const MESHOPT_NOTICE = 'meshoptimizer decoder 1.1, MIT License, Copyright (C) 2016-2026 Arseny Kapoulkine, https://github.com/zeux/meshoptimizer';

type ParseFn = GLTFLoader['parse'];
type Patchable = { [PATCHED]?: string; parse: ParseFn };

function patchPrototype(): void {
    const proto = GLTFLoader.prototype as unknown as Patchable;
    if (proto[PATCHED]) return;
    const parse = proto.parse;
    proto.parse = function (this: GLTFLoader, ...args: Parameters<ParseFn>): ReturnType<ParseFn> {
        const self = this as unknown as { meshoptDecoder: unknown };
        self.meshoptDecoder = MeshoptDecoder;   // over the engine's lazy one (see above): same decoder, no extra request
        return parse.apply(this, args);
    } as ParseFn;
    proto[PATCHED] = MESHOPT_NOTICE;
}

// At module evaluation: Game.ts imports this before it builds anything, so no game GLB parses first.
patchPrototype();
if (!MeshoptDecoder.supported) console.warn('[tor] meshopt decoder unsupported here (no WebAssembly): compressed models cannot load');

export { MeshoptDecoder };
