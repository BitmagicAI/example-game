// No community template currently overrides this file — it
// flows into every template's merged source from here. The flat-terrain
// fast path (fillChunkFlat) below benefits every template via the merge.
// The sidescroller subclasses it instead (see generateVoxelTerrain); the overlay
// contract is in game/docs/editing-baseline.md.
import * as THREE from 'three';
import { SeededRandom } from 'engine/SeededRandom.js';
import { getObjectIdService } from 'engine/world/ObjectIdService.js';
import type { Asset, WorldProfileData, EngineLike, GameData, TerrainFrictionProvider } from 'types/game.js';
import {
    TerrainTypeRegistry,
    createGrassTerrainType,
    createSandTerrainType,
    createAsphaltTerrainType,
    createIceTerrainType,
    createLavaTerrainType,
    createDirtTerrainType,
    createStoneTerrainType,
    createWaterTerrainType
} from 'engine/terrain/types/TerrainTypes.js';
import { VoxelTerrainTypeProvider } from 'engine/terrain/types/VoxelTerrainTypeProvider.js';
import { VoxelFoliageSystem } from 'engine/world/foliage/VoxelFoliageSystem.js';
import { EnvironmentObjectSystem, serializeEnvironmentObject } from 'engine/world/env-objects/EnvironmentObjectSystem.js';
import { loadDeclaredMeshLevel } from 'engine/meshlevel/DeclaredMeshLevel.js';
import type { MeshLevel } from 'engine/meshlevel/MeshLevel.js';
import type { NamedTrimeshLevel } from 'engine/vehicle/racing/TrackCenterline.js';
import type { TerrainRuntime } from 'engine/terrain/TerrainRuntime.js';
import { VoxelTerrainSystem, type VoxelTerrainConfig } from 'engine/terrain/voxel/VoxelTerrainSystem.js';
import { VxlSceneTerrainSystem, DEFAULT_VXL_SCENE_TERRAIN_CONFIG } from 'engine/terrain/baked/VxlSceneTerrainSystem.js';
import type { VxlChunkedTerrainSystem } from 'engine/terrain/baked/VxlChunkedTerrainSystem.js';
import { isVxlWorld } from 'engine/voxel/formats/legacy/VxlWorldFormat.js';
import { isVxlScene } from 'engine/vxlscene/VxlSceneFormat.js';
import { fetchVwldBuffer, inflatedSizeOf } from 'engine/world/levels/fetchVwld.js';
import { fetchNavSidecar } from 'engine/world/levels/fetchNavSidecar.js';
import { resolveLevelVwldAsset, shouldApplyBootNav } from 'engine/world/levels/LevelManager.js';
import { resolveLevels } from 'engine/world/levels/levelResolve.js';
import { getActiveLevelIdOrNull } from 'engine/world/levels/levelManagerRegistry.js';
import { VoxelNavMesh, setGlobalNavMesh, getGlobalNavMesh } from 'engine/VoxelNavMesh.js';
import { registerVoxelTreeType, registerVoxelRockType, PendingVoxelObjectPhysics } from './EnvironmentObjects.js';
import { VoxelFluidSystem, FluidRenderMode } from 'engine/voxel/fluids/VoxelFluidSystem.js';
import { pinEnvironmentObjectsToAuthoredPositions } from 'engine/world/water/OpenWaterWorld.js';
import { repairTerrainWalkability } from 'engine/terrain/voxel/TerrainWalkability.js';
import { stepHeightForWorld } from 'engine/player/movement/WalkingAndJumpingMovement.js';
import { createPhysicsSpawnFinder } from 'engine/world/spawning/bakedSpawnResolver.js';
import { buildDefaultHotspotRegistry, type HotspotContext, type HotspotAsset, type InjectedEnvironmentObject } from 'engine/hotspots/index.js';
import {
    getVoxelTextureAtlas,
    BlockType,
    createGrassBlockType,
    createSandBlockType,
    createIceBlockType,
    createStoneBlockType,
    createDirtBlockType,
    createAsphaltBlockType,
    createLavaBlockType,
    createTrunkBlockType,
    createLeavesBlockType,
    createWaterBlockType
} from 'engine/VoxelTextureAtlas.js';
import { MaterialId } from 'engine/physics/MaterialRegistry.js';
import { queryPhysicsFor } from 'engine/physics/plane/PlaneLockedPhysics.js';

/**
 * Terrain type IDs created by this template.
 * These are populated by registerTerrainTypes() before terrain generation.
 *
 * Terrain types define surface properties (grip, foliage, etc.)
 * and are mapped to block types for voxel rendering.
 */
const TerrainTypes = {
    // NONE is always 0 - registered by engine
    GRASS: 0,
    SAND: 0,
    ASPHALT: 0,
    ICE: 0,
    LAVA: 0,
    DIRT: 0,
    STONE: 0,
    WATER: 0
};

/**
 * Block type IDs created by this template.
 * These are populated by registerBlockTypes() before terrain generation.
 * 
 * New block types are added here; registerBlockTypes() creates their
 * textures and registers them.
 */
const BlockTypes = {
    GRASS: 0,
    SAND: 0,
    ICE: 0,
    STONE: 0,
    DIRT: 0,
    ASPHALT: 0,
    LAVA: 0,
    WATER: 0,
    TRUNK: 0,
    LEAVES: 0,
    MARBLE: 0   // Custom block type - texture generated in this template
};

/**
 * World Y the procedural fill stops at — the floor a freshly initialized
 * VoxelWorld is given (`TERRAIN_DEFAULT_MIN_Y` in `VoxelTerrainSystem`, which
 * does not export it). Writing below it would land outside the world's own
 * bounds, so a deep `fillDepth` simply fills to here and stops.
 */
const TERRAIN_FLOOR_Y = -20;

/** Mixed into the world seed for the marble texture, so it does not share a sequence with the terrain. */
const MARBLE_SEED_SALT = 0x6d4152;

/**
 * Stamp a flat terrain plane, honouring the DECLARED world bounds exactly.
 *
 * `fillChunkFlat` writes a chunk's full 16×16 footprint (whole-layer RLE runs —
 * that is what makes it O(numChunks)), so it may only run for chunks that lie
 * ENTIRELY inside the world bounds. The old code stamped every overlapped
 * chunk, which quantized the terrain's extent to whole chunk spans: a side-on
 * strip declared 3 m deep rendered 16 m deep with the side camera sitting over
 * (or inside) the phantom apron, and any world whose size was not a multiple
 * of `16 × voxelBlockSize` grew ground past its own edge. Edge chunks are
 * stamped per-column with `setBlockFast` instead — the perimeter is a few
 * thousand columns at most, far below what the procedural path already does.
 *
 * Exported for tests; the generator's flat fast path is its only runtime
 * caller.
 */
export function stampFlatTerrain(
    voxelWorld: {
        getVoxelSize(): number;
        getBounds(): { minX: number; minY: number; minZ: number } | null;
        fillChunkFlat(cx: number, cy: number, cz: number, surfaceLocalY: number, yLowLocal: number, surfaceBlock: number, subLayers?: number[]): void;
        setBlockFast(x: number, y: number, z: number, block: number): void;
    },
    opts: {
        halfX: number; halfZ: number;
        /** World Y of the surface plane (the surface BLOCK's base). */
        baseHeight: number;
        /** How many blocks of sub-surface fill below the surface block. */
        fillDepth: number;
        blockSize: number;
        surfaceBlock: number;
        subLayers: number[];
    },
): { chunks: number; edgeColumns: number } {
    const CHUNK = 16;
    const vsz = voxelWorld.getVoxelSize();
    const b = voxelWorld.getBounds();
    const bX = b?.minX ?? 0, bY = b?.minY ?? 0, bZ = b?.minZ ?? 0;
    const EPS = 1e-6;
    const gSurfaceY = Math.floor((opts.baseHeight - bY + EPS) / vsz);
    // Clamped to the world's own floor (voxel index 0 = the bounds' minY), so
    // an oversized fillDepth means "solid to the bottom" rather than writing
    // out-of-bounds chunks below the world.
    const gYLow = Math.max(0, Math.floor((opts.baseHeight - opts.fillDepth * opts.blockSize - bY + EPS) / vsz));
    const vxMin = Math.floor((-opts.halfX - bX + EPS) / vsz), vxMax = Math.floor((opts.halfX - bX - EPS) / vsz);
    const vzMin = Math.floor((-opts.halfZ - bZ + EPS) / vsz), vzMax = Math.floor((opts.halfZ - bZ - EPS) / vsz);
    const cxMin = Math.floor(vxMin / CHUNK), cxMax = Math.floor(vxMax / CHUNK);
    const czMin = Math.floor(vzMin / CHUNK), czMax = Math.floor(vzMax / CHUNK);
    const cyMin = Math.floor(gYLow / CHUNK), cyMax = Math.floor(gSurfaceY / CHUNK);
    const chunkFull = (cx: number, cz: number): boolean =>
        cx * CHUNK >= vxMin && cx * CHUNK + CHUNK - 1 <= vxMax
        && cz * CHUNK >= vzMin && cz * CHUNK + CHUNK - 1 <= vzMax;

    let chunks = 0;
    for (let cx = cxMin; cx <= cxMax; cx++) for (let cz = czMin; cz <= czMax; cz++) {
        if (!chunkFull(cx, cz)) continue;
        for (let cy = cyMin; cy <= cyMax; cy++) {
            const chunkBottom = cy * CHUNK;
            voxelWorld.fillChunkFlat(cx, cy, cz, gSurfaceY - chunkBottom, gYLow - chunkBottom, opts.surfaceBlock, opts.subLayers);
            chunks++;
        }
    }

    // Edge columns: the in-bounds remainder of partially-covered chunks, stamped
    // per column with the exact block stack `VoxelChunk.fillFlat` would produce.
    const subLen = opts.subLayers.length;
    let edgeColumns = 0;
    for (let vx = vxMin; vx <= vxMax; vx++) {
        const cx = Math.floor(vx / CHUNK);
        for (let vz = vzMin; vz <= vzMax; vz++) {
            if (chunkFull(cx, Math.floor(vz / CHUNK))) continue;
            const wx = bX + (vx + 0.5) * vsz, wz = bZ + (vz + 0.5) * vsz;
            for (let gy = gYLow; gy <= gSurfaceY; gy++) {
                const depth = gSurfaceY - gy - 1;
                const block = gy === gSurfaceY
                    ? opts.surfaceBlock
                    : (subLen > 0 ? opts.subLayers[Math.min(depth, subLen - 1)] ?? opts.surfaceBlock : opts.surfaceBlock);
                voxelWorld.setBlockFast(wx, bY + (gy + 0.5) * vsz, wz, block);
            }
            edgeColumns++;
        }
    }
    return { chunks, edgeColumns };
}

export class WorldGenerator implements TerrainFrictionProvider {
    private worldSize: number;
    private world: THREE.Object3D;
    private worldBodies: any[];
    private rng: SeededRandom;
    /** world.json's world profile. Protected so a subclass (the sidescroller's) reads the same object. */
    protected worldProfileData: WorldProfileData;
    /** The mesh level world.json declares (`meshLevel`), once `generateMeshLevelWorld` loaded it. */
    private declaredMeshLevel: MeshLevel | null = null;
    private engine: EngineLike | null;

    private terrainRegistry: TerrainTypeRegistry;
    private voxelTerrainTypeProvider: VoxelTerrainTypeProvider;
    private foliageSystem: VoxelFoliageSystem | null = null;

    private voxelTerrainSystem: VoxelTerrainSystem | null = null;
    /** Set instead of `voxelTerrainSystem` when the world is a baked VxlScene
     *  (`.vwld` VLSC container) — e.g. a GLB voxelized via LevelVoxelizer.
     *  Only one terrain system is non-null per world. */
    private vxlSceneTerrain: VxlSceneTerrainSystem | null = null;
    private fluidSystem: VoxelFluidSystem | null = null;

    private environmentObjectSystem: EnvironmentObjectSystem | null = null;
    /** Physics-raycast spawn finder for worlds without a voxel grid (terrain.shape 'none', open water). Built on first use. */
    private physicsSpawnFinder: ((x: number, z: number, fromY?: number) => THREE.Vector3 | null) | null = null;
    private voxelBlockSize: number = 1; // Default block size in meters

    /** Maps terrain type ID → block type ID for procedural generation.
     * Terrain appearance is changed by editing these mappings in registerBlockTypes().
     * Example: To make grass terrain look snowy, map TerrainTypes.GRASS to a snow block type. */
    private terrainBlockMap: Map<number, number> = new Map();
    /** Maps surface block type ID → underground block type ID */
    private undergroundBlockMap: Map<number, number> = new Map();
    private groundSettings: {
        worldSizeX: number;
        worldSizeZ: number;
    } = {
            worldSizeX: 128,
            worldSizeZ: 128,
        };

    private static readonly GROUND_OFFSET = 0.001;
    private gameData: GameData | null = null;

    /** Placed trees and rocks waiting for their physics bodies; see PendingVoxelObjectPhysics. */
    private readonly pendingVoxelObjectPhysics = new PendingVoxelObjectPhysics();
    /** The navmesh this generator installed from a baked level's sidecar, so dispose() withdraws only its own. */
    private bootNavMesh: VoxelNavMesh | null = null;
    /** Set by dispose(): an async step of the load that finishes afterwards must not install anything. */
    private disposed = false;
    /** Ground friction from getVoxelTerrainConfig(), read once: the player asks every grounded frame. */
    private terrainFriction: number | null = null;

    /**
     * @param worldSize Square world size in metres, used when world.json declares no ground size.
     * @param seed The world seed every procedural step draws from.
     * @param worldProfileData world.json's world profile.
     * @param engine The engine the world is built into (null only in tests).
     * @param _gameId Unused; kept so existing `new WorldGenerator(...)` calls keep their argument order.
     * @param gameData The loaded game (placed objects, assets, levels).
     */
    constructor(worldSize: number = 128, seed: number, worldProfileData: WorldProfileData, engine: EngineLike | null = null, _gameId?: string, gameData?: GameData | null) {
        this.world = engine ? engine.getWorldGroup() : new THREE.Group();
        this.worldBodies = [];
        this.rng = new SeededRandom(seed);
        this.worldProfileData = worldProfileData;
        this.engine = engine;
        this.gameData = gameData || null;

        // Ground size from worldProfileData (stored directly, not nested).
        this.groundSettings.worldSizeX = worldProfileData.groundWorldSizeX ?? this.groundSettings.worldSizeX;
        this.groundSettings.worldSizeZ = worldProfileData.groundWorldSizeZ ?? this.groundSettings.worldSizeZ;

        this.voxelBlockSize = worldProfileData.voxelBlockSize ?? this.voxelBlockSize;
        console.log(`[WorldGenerator] Voxel block size: ${this.voxelBlockSize}m`);

        // Use worldSize from groundSettings if available, otherwise use constructor parameter
        this.worldSize = this.groundSettings.worldSizeX
            ? Math.max(this.groundSettings.worldSizeX, this.groundSettings.worldSizeZ || worldSize)
            : worldSize;

        this.terrainRegistry = new TerrainTypeRegistry();

        // Register terrain types (templates define what terrain types exist)
        this.registerTerrainTypes();

        // Create VoxelTerrainTypeProvider - queries VoxelWorld directly for terrain info
        // No separate 2D map needed - terrain type comes from surface block type
        this.voxelTerrainTypeProvider = new VoxelTerrainTypeProvider(this.terrainRegistry);
        this.voxelTerrainTypeProvider.setDefaultTerrainType(TerrainTypes.GRASS);

        // Environment object system will be initialized in generateWorld() after foliageSystem is created
    }

    getWorld(): THREE.Object3D {
        return this.world;
    }

    /**
     * One physics step so colliders created since the last one are queryable —
     * on whichever world this game runs (Rapier 3D, or Rapier 2D on the side-on lane).
     * Spawn raycasts, player gravity, NPC pathing and vehicle wheels all depend on it.
     */
    protected stepPhysicsOnce(): void {
        if (this.engine?.physicsWorld) this.engine.physicsWorld.step(1 / 60);
        else this.engine?.physicsWorld2D?.step(1 / 60);
    }

    getWorldBodies(): any[] {
        return this.worldBodies;
    }

    getSeed(): number {
        return this.rng.getSeed();
    }

    getVoxelBlockSize(): number {
        return this.voxelBlockSize;
    }

    /**
     * World extent in metres along X: the `groundSettings` value when world.json
     * declared one, else the constructor's square `worldSize`. Terrain
     * generation, the VoxelTerrainSystem and foliage each derived this the same
     * way; one copy keeps them from drifting apart.
     */
    private get effectiveWorldSizeX(): number {
        return this.groundSettings.worldSizeX || this.worldSize;
    }

    /** World extent in metres along Z — see {@link effectiveWorldSizeX}. */
    private get effectiveWorldSizeZ(): number {
        return this.groundSettings.worldSizeZ || this.worldSize;
    }

    getTerrainTypeAt(x: number, z: number): number {
        return this.voxelTerrainTypeProvider.getTerrainTypeAt(x, z);
    }

    /** Get the voxel terrain system for animation updates */
    getVoxelTerrainSystem(): VoxelTerrainSystem | null { return this.voxelTerrainSystem; }

    /** Get the VxlScene terrain system for baked new-format `.vwld` (VLSC)
     *  worlds. Returns null unless the loaded world was a VxlScene file. */
    getVxlSceneTerrain(): VxlSceneTerrainSystem | null { return this.vxlSceneTerrain; }

    /**
     * @deprecated VWLD levels are retired: no world is a VWLD world any more, so this is
     * always null. Game code written before then still calls it; use `getVxlSceneTerrain()`.
     */
    getVxlChunkedTerrain(): VxlChunkedTerrainSystem | null { return null; }

    /**
     * The terrain this world runs on, whichever of the two it is (`getVoxelTerrainSystem`,
     * `getVxlSceneTerrain` — a world builds exactly one), for the
     * queries every terrain answers: `getHeightAt`, `areCollidersReady`, `updateVisibility`.
     * Null before the world is generated and after it is disposed.
     */
    getTerrain(): TerrainRuntime | null {
        return this.vxlSceneTerrain ?? this.voxelTerrainSystem;
    }

    /** The mesh level declared by world.json `meshLevel` (null: none, or the game builds its own). */
    getMeshLevel(): MeshLevel | null { return this.declaredMeshLevel; }

    /**
     * Whichever baked level this world has — a voxel bake (`getVxlSceneTerrain`) or a declared
     * mesh level (`getMeshLevel`) — for the queries both answer: `getTrimeshNames`,
     * `getTrimesh`, `getTrackCenterline`. Null for procedural voxel terrain.
     */
    getBakedLevel(): NamedTrimeshLevel | null { return this.vxlSceneTerrain ?? this.declaredMeshLevel; }

    /**
     * Alternative `generateWorld` path: the level is a pre-baked VxlScene world
     * (`.vwld` VLSC: greedy-mesh LOD hints + per-chunk trimesh colliders) rather
     * than a procedurally generated chunk grid. Sets up `vxlSceneTerrain`, builds
     * render meshes + static colliders, steps physics once so colliders are
     * queryable, and returns. None of the procedural chunk-grid pipeline runs —
     * baked levels carry their geometry inside the chunks themselves.
     */
    private async loadVxlSceneWorld(vwldBuffer: ArrayBuffer, startTime: number): Promise<void> {
        const t0 = performance.now();
        if (!this.engine) {
            throw new Error('[WorldGenerator] engine is null — cannot load VxlScene world');
        }
        this.vxlSceneTerrain = new VxlSceneTerrainSystem(
            this.engine,
            { ...DEFAULT_VXL_SCENE_TERRAIN_CONFIG },
        );
        // The container is ours — fetched a few lines up and never read again — so let the
        // load free it the moment it is decoded rather than holding tens of MB through the
        // batch allocation.
        await this.vxlSceneTerrain.loadVxlScene(vwldBuffer, { releaseSourceBuffer: true });

        // Step the physics world once so the per-chunk static colliders are
        // registered before anything that depends on them (spawn raycasts,
        // player gravity, NPC pathing, vehicle wheels) runs.
        this.stepPhysicsOnce();

        // Spawn world.json environment objects (placed buildings, trees,
        // etc.) ON TOP of the baked level. The baked terrain carries its own
        // geometry, but environmentObjects are separate placed instances —
        // without this they were silently dropped on VxlScene levels (the
        // procedural pipeline that normally spawns them is skipped here).
        await this.spawnBakedLevelScenery();
        this.stepPhysicsOnce();

        // Prebuilt navmesh sidecar for the boot level: fire-and-forget so a
        // slow/missing fetch never blocks game start — the same precedent as
        // the PVS sidecar load in GameEngine.loadGame. Absent navUrl (legacy
        // level, or a level authored before this feature) is simply a no-op;
        // the runtime falls back to whatever navmesh the engine already
        // builds elsewhere. `bootLevelId` is captured NOW (before the async
        // fetch) so `shouldApplyBootNav` can detect a late-join multiplayer
        // boot whose fetch resolves after a level switch already installed
        // the correct mesh for whatever level is active by then — applying
        // the boot level's mesh at that point would clobber a newer, correct
        // install with a stale one.
        const bootNav = this.resolveBootNavAsset();
        const bootNavUrl = bootNav?.asset.navUrl;
        const bootLevelId = bootNav?.levelId;
        if (bootNavUrl) {
            void (async () => {
                try {
                    const buffer = await fetchNavSidecar(bootNavUrl);
                    if (this.disposed) return; // the game went while the sidecar was in flight
                    if (!shouldApplyBootNav(bootLevelId, getActiveLevelIdOrNull())) return; // superseded mid-load
                    if (!buffer) return; // fetchNavSidecar already warned
                    const mesh = new VoxelNavMesh();
                    mesh.buildFromSerialized(buffer);
                    this.bootNavMesh = mesh;
                    setGlobalNavMesh(mesh);
                } catch (err) {
                    console.warn('[WorldGenerator] navmesh sidecar install failed:', err);
                }
            })();
        }

        const bounds = this.vxlSceneTerrain.getBounds();
        console.log(
            `[WorldGenerator] Loaded VxlScene: ${this.vxlSceneTerrain.getChunkCount()} chunks, ` +
            `bounds=${bounds ? JSON.stringify(bounds) : 'none'}, ` +
            `load=${(performance.now() - t0).toFixed(1)}ms, ` +
            `total=${(performance.now() - startTime).toFixed(1)}ms`,
        );
    }

    /**
     * Resolve the vwld asset carrying the boot level's nav sidecar (if any),
     * paired with that level's id so the caller can guard against a
     * superseded-mid-load boot install (see `shouldApplyBootNav`). In levels
     * mode this is the START level's vwld asset — the same lookup
     * `LevelManager`/`LevelEngineBridge` use, shared via `resolveLevelVwldAsset`
     * so the resolution (and its error text) has one implementation. Legacy
     * single-world games (no `levels[]`) have no level to resolve, so fall
     * back to matching the lone terrain asset by `voxelUrl` — `levelId` is
     * `undefined` in that case (nothing to compare a later switch against).
     * Never throws — a misconfigured level→asset reference just means no
     * boot navmesh, never a boot failure.
     */
    private resolveBootNavAsset(): { asset: Asset; levelId: string | undefined } | undefined {
        if (!this.gameData) return undefined;
        const resolved = resolveLevels(this.gameData);
        if (resolved) {
            try {
                const asset = resolveLevelVwldAsset(this.gameData, resolved.startLevel);
                return { asset, levelId: resolved.startLevel.id };
            } catch {
                return undefined;
            }
        }
        const voxelUrl = this.worldProfileData.voxelUrl;
        const asset = (this.gameData.assets as Asset[] | undefined)?.find((a) => a.url === voxelUrl);
        return asset ? { asset, levelId: undefined } : undefined;
    }

    /**
     * Spawn `world.json` environment-object instances onto a pre-baked level
     * (VxlScene), where the procedural generation pipeline — which normally
     * constructs the `EnvironmentObjectSystem` and calls `generateScenery()`
     * — does not run.
     *
     * Only loads EXPLICITLY-placed objects from world.json (the immutable
     * `environmentObjectsGeneratedProcedurally: false` flag routes
     * `generateScenery` to the world.json loader); never generates procedural
     * scenery on a baked level. No-ops when there are no placed objects. The
     * system is constructed without a terrain connection (no flattening on
     * baked levels); absolute-positioned (`forcePosition`) instances — the
     * World Forger path — need no terrain-height lookup, and
     * `generateScenery`'s terrain post-step is guarded on a connected terrain
     * system so it is safely skipped.
     */
    private async spawnBakedLevelScenery(): Promise<void> {
        await this.spawnPlacedScenery('baked level');
    }

    /**
     * Construct the environment-object system WITHOUT a terrain connection and
     * run the world.json placement pass. Shared by the baked-level path and the
     * open-water path — both have placed objects to spawn and no procedural
     * terrain to snap them to.
     */
    private async spawnPlacedScenery(context: string): Promise<void> {
        const envObjects = this.gameData?.environmentObjects;
        if (!envObjects || envObjects.length === 0) return;

        this.environmentObjectSystem = new EnvironmentObjectSystem(
            this.world,
            this.worldBodies,
            this.rng,
            this.worldSize,
            this.voxelTerrainTypeProvider,
            this.terrainRegistry,
            null,
            WorldGenerator.GROUND_OFFSET,
            this.worldProfileData,
            this.gameData,
            this.engine?.physicsWorld ?? null,
        );
        this.registerEnvironmentObjectTypes();
        await this.generateScenery();
        console.log(`[WorldGenerator] Spawned ${envObjects.length} environment objects onto ${context}`);
    }

    /**
     * Add a terrain feature by flattening an area and changing its block type.
     * This method is for RUNTIME modifications - it rebuilds meshes after modification.
     * 
     * Use this for roads, plazas, or any flat surface.
     * 
     * @param centerX - Center X coordinate
     * @param centerZ - Center Z coordinate  
     * @param widthX - Width in X direction
     * @param widthZ - Width in Z direction
     * @param blockType - Block type to use (from BlockTypes, e.g., BlockTypes.ASPHALT)
     * @param height - Optional height to flatten to (default: queries current ground level)
     * 
     * @example
     * // Create an asphalt road
     * this.addTerrainFeature(0, 0, 100, 8, BlockTypes.ASPHALT, 0);
     * 
     * // Create a stone plaza
     * this.addTerrainFeature(50, 50, 20, 20, BlockTypes.STONE);
     */
    addTerrainFeature(centerX: number, centerZ: number, widthX: number, widthZ: number, blockType: number, height?: number): void {
        // getHeightAt returns the surface block's walkable TOP, but flattenArea wants the
        // block's BASE (it floors the argument onto the voxel grid) — so step down one block
        // to keep the feature level with the existing ground instead of a block above it.
        // An explicit `height` is already a flatten target and passes through untouched.
        if (!this.voxelTerrainSystem) {
            throw new Error('[WorldGenerator] addTerrainFeature needs a voxel ground, and this world has none (terrain.shape is "none" or openWater) — build the feature into the mesh level instead');
        }
        const targetHeight = height ?? (this.voxelTerrainSystem.getHeightAt(centerX, centerZ) - this.voxelBlockSize);
        // Use rebuildMeshes=true since this is for runtime modifications
        this.flattenArea(centerX, centerZ, widthX, widthZ, targetHeight, blockType, true);
    }

    /**
     * Open-water world generation: no voxel terrain, no fluid system, no
     * foliage, no starting plate. Only the block atlas (placed VXL scenery
     * still renders through it) and the world.json environment objects.
     *
     * The ocean and sky are NOT built here — `GameEngine.applyOpenWater` owns
     * them, so every genre and template gets them from the same flag.
     */
    private async generateOpenWaterWorld(): Promise<void> {
        console.log('[WorldGenerator] Open-water world — skipping all terrain, fluid and foliage generation.');
        await this.generateTerrainlessWorld('open water');
    }

    /**
     * Mesh-level world generation (`terrain.shape: 'none'`): the level's own
     * geometry — a `MeshLevel` loaded from a GLB, placed objects — IS the
     * world. No voxel ground, no invisible safety plane, no fluid, no foliage,
     * no starting plate. Without a `MeshLevel` (or something else with
     * colliders) every body falls forever, which is the intended loud failure.
     */
    private async generateMeshLevelWorld(): Promise<void> {
        console.log("[WorldGenerator] terrain.shape='none' — no voxel ground; the mesh level is the world.");
        // A DECLARED level (worldProfileData.meshLevel) loads first, so the placed
        // objects below and the player spawn find its colliders. A game that
        // builds its own MeshLevel in code leaves the field out.
        if (this.worldProfileData.meshLevel && this.engine) {
            this.declaredMeshLevel = (await loadDeclaredMeshLevel(this.engine, this.worldProfileData))?.level ?? null;
        }
        await this.generateTerrainlessWorld('mesh level');
    }

    /**
     * Shared body of the two terrainless modes: the block atlas (placed VXL
     * scenery still renders through it), the world.json environment objects
     * pinned to their authored Y, and one physics step so their colliders
     * are queryable before anything spawns.
     */
    private async generateTerrainlessWorld(context: string): Promise<void> {
        const startTime = performance.now();

        // Placed scenery (islands, palms, huts, arches) are VXL assets drawn
        // through the shared voxel atlas, so block types are still needed.
        await this.registerBlockTypes();

        // No terrain means no ground height to snap to: pin every placed object
        // to its authored Y or they all surface at the waterline.
        const pinned = pinEnvironmentObjectsToAuthoredPositions(this.gameData);
        if (pinned > 0) {
            console.log(`[WorldGenerator] ${context} — ${pinned} environment objects pinned to authored positions`);
        }
        await this.spawnPlacedScenery(context);

        // Register any colliders the scenery just created.
        this.stepPhysicsOnce();
        console.log(`[WorldGenerator] ${context} world ready in ${(performance.now() - startTime).toFixed(1)}ms (terrain: none)`);
    }

    async generateWorld(): Promise<void> {
        // OPEN WATER (worldProfileData.openWater): the sea IS the world. The
        // engine owns the ocean and the sky; there is no terrain to build.
        //
        // Falling through to the procedural path instead is the classic
        // boat-game bug: the game gets a grass/dirt island under the ocean AND
        // the voxel fluid system's own water sitting in a low channel, which
        // reads to a player as "the water level is wrong" when in fact none of
        // that terrain should exist.
        //
        // A BAKED level (`voxelUrl`) is the exception: a forged vessel IS baked
        // geometry — the ship is the level — and it sails on the engine's open
        // ocean. Taking the terrainless path here would skip loading the SHIP,
        // and the player falls through the world. The baked path builds no
        // procedural ground and no voxel fluid, so the bug above cannot come
        // back through it.
        if (this.worldProfileData.openWater && !this.worldProfileData.voxelUrl) {
            await this.generateOpenWaterWorld();
            return;
        }
        if (this.worldProfileData.terrain?.shape === 'none') {
            await this.generateMeshLevelWorld();
            return;
        }

        const startTime = performance.now();
        console.log(`Starting voxel world generation: ${this.worldSize}x${this.worldSize}m, block size: ${this.voxelBlockSize}m`);

        // Check if we have a saved VXL file
        const voxelUrl = this.worldProfileData.voxelUrl;
        const hasVxlFile = !!voxelUrl;

        // If the URL points to a baked VxlScene level (`.vwld`), take a
        // separate path: build the baked level and skip the entire
        // procedural / chunk-grid generation pipeline. Detected by sniffing
        // the file's magic — works for any URL/extension.
        if (voxelUrl && this.engine) {
            let retiredVwld = false;
            try {
                // Shared fetch+inflate helper (also used by LevelManager for
                // runtime level switches). Throws on HTTP failure — same
                // fallthrough as the old resp.ok check via the catch below.
                const buf = await fetchVwldBuffer(voxelUrl, inflatedSizeOf(this.gameData?.assets, voxelUrl));
                if (isVxlScene(buf)) {
                    await this.loadVxlSceneWorld(buf, startTime);
                    return;
                }
                // The retired VWLD container: nothing loads it any more.
                retiredVwld = isVxlWorld(buf);
            } catch (err) {
                console.warn('[WorldGenerator] Baked-level pre-sniff failed, falling back to chunk-grid path:', err);
            }
            if (retiredVwld) {
                throw new Error(
                    `[WorldGenerator] ${voxelUrl} is a VWLD level, a voxel level format the engine no longer loads. ` +
                    'Re-bake the level as a VxlScene level: voxelize its GLB again with "Voxelize GLB as Level" in the Creator, ' +
                    'and point world.json at the new .vwld.',
                );
            }
        }

        // Initialize voxel terrain system
        const t3 = performance.now();
        const voxelTerrainConfig = this.getVoxelTerrainConfig();
        this.voxelTerrainSystem = new VoxelTerrainSystem(
            this.world,
            this.engine,
            this.voxelTerrainTypeProvider,
            this.terrainRegistry,
            this.effectiveWorldSizeX,
            this.effectiveWorldSizeZ,
            voxelTerrainConfig
        );

        // Register custom block types before generating terrain
        await this.registerBlockTypes();

        // Load from VXL file if available, otherwise generate procedurally
        let terrainLoaded = false;
        if (voxelUrl) {
            console.log(`[WorldGenerator] Loading terrain from VXL: ${voxelUrl}`);
            terrainLoaded = await this.voxelTerrainSystem.loadFromUrl(voxelUrl);
            // NOTE: Spawn position is set at the END of generateWorld() after all modifications
        }

        if (!terrainLoaded) {
            // Generate voxel terrain directly using noise (no heightmap conversion)
            console.log('[WorldGenerator] Generating voxel terrain procedurally...');

            this.voxelTerrainSystem.initializeVoxelWorld();
            this.generateVoxelTerrain();
        }

        // Connect VoxelTerrainTypeProvider to VoxelWorld and set up block-to-terrain mappings
        const voxelWorld = this.voxelTerrainSystem.getVoxelWorld();
        if (voxelWorld) {
            this.voxelTerrainTypeProvider.setVoxelWorld(voxelWorld);
            this.registerBlockTerrainMappings();
        }

        // Apply smooth surface settings BEFORE building meshes (avoids double-building)
        this.applySmoothSurfaceSettings();

        // For large worlds (>256m), use lazy generation to dramatically speed up initial load
        // Only builds chunks within 150m of spawn initially, rest are built as player explores
        const maxWorldDimension = Math.max(this.groundSettings.worldSizeX, this.groundSettings.worldSizeZ);
        const LAZY_GENERATION_THRESHOLD = 256; // Use lazy gen for worlds larger than this
        const spawnPos = this.worldProfileData.playerSpawnPosition ?? { x: 0, y: 0, z: 0 };
        // Doubles as the lazy-generation radius and the culling render distance —
        // one default (150m) so the two cannot disagree about how far "visible" is.
        const renderDistance = this.worldProfileData.renderDistance ?? 150;

        if (maxWorldDimension > LAZY_GENERATION_THRESHOLD) {
            // Lazy generation for large worlds - ~5 seconds instead of ~60 seconds
            this.voxelTerrainSystem.finalizeTerrainLazy(spawnPos.x, spawnPos.z, renderDistance);
            console.log(`  [Timing] Voxel terrain (lazy): ${(performance.now() - t3).toFixed(1)}ms`);
        } else {
            // Full generation for small worlds - still fast enough
            this.voxelTerrainSystem.finalizeTerrain();
            console.log(`  [Timing] Voxel terrain: ${(performance.now() - t3).toFixed(1)}ms`);
        }

        // Enable visibility culling for worlds larger than 64m
        // This significantly improves rendering performance by hiding chunks
        // that are outside the camera frustum or beyond the render distance
        if (maxWorldDimension > 64) {
            this.voxelTerrainSystem.setCullingEnabled(true);
            this.voxelTerrainSystem.setMaxRenderDistance(renderDistance);
            console.log(`  [Culling] Enabled for ${maxWorldDimension}m world, render distance: ${renderDistance}m`);
        }

        // CRITICAL: Step physics world once to register terrain colliders
        // Without this, any physics bodies (player, NPCs, animals, vehicles, VoxelObjects)
        // will fall through terrain because colliders aren't active until first step
        this.stepPhysicsOnce();
        console.log(`  [Physics] Terrain colliders registered`);

        // Initialize fluid rendering system for water, lava, etc.
        const fluidVoxelWorld = this.voxelTerrainSystem.getVoxelWorld();
        if (fluidVoxelWorld) {
            this.fluidSystem = new VoxelFluidSystem(this.world, fluidVoxelWorld, {
                renderMode: FluidRenderMode.SURFACE_ONLY,
                opacity: 0.6
            });
            this.fluidSystem.updateFluidMeshes();
            console.log(`  [Fluids] Fluid system initialized`);
        }

        // Expand worldProfileData.hotspots into carved foundations + injected
        // environmentObjects. Runs AFTER terrain (so getHeightAt is meaningful)
        // and BEFORE EnvironmentObjectSystem is constructed (so injected objects
        // get loaded by the standard scenery path). Only runs when at least one
        // hotspot is declared — zero-cost otherwise. On .vxl-loaded terrain
        // (forged levels) the registry applies only vxl-safe interpreters —
        // constructive 'building' shells run (team bases on forged cities);
        // ground-reshaping types (village lots) are skipped with a warning.
        if (Array.isArray(this.worldProfileData.hotspots) && this.worldProfileData.hotspots.length > 0) {
            const t_hot = performance.now();
            this.expandHotspots(hasVxlFile);
            console.log(`  [Timing] Hotspots: ${(performance.now() - t_hot).toFixed(1)}ms`);
        }

        // Initialize environment object system BEFORE foliage
        // This allows scenery to set terrain types to "no foliage" areas
        const t4 = performance.now();
        this.environmentObjectSystem = new EnvironmentObjectSystem(
            this.world,
            this.worldBodies,
            this.rng,
            this.worldSize,
            this.voxelTerrainTypeProvider,
            this.terrainRegistry,
            null, // No foliage clearing needed - foliage is generated after scenery
            WorldGenerator.GROUND_OFFSET,
            this.worldProfileData,
            this.gameData,
            // 3D world, or on the side-on lane the 2D world through its facade —
            // placed objects then get sliced 2D colliders (engine/physics/world2d/EnvObject2D.ts).
            queryPhysicsFor(this.engine)
        );

        // Register default environment object types (trees, rocks)
        // (customized by editing this file)
        this.registerEnvironmentObjectTypes();
        console.log(`  [Timing] Environment object system: ${(performance.now() - t4).toFixed(1)}ms`);

        // Connect environment object system to terrain BEFORE generating scenery
        // This is critical so that flattening can work when objects are loaded
        if (this.voxelTerrainSystem && this.environmentObjectSystem) {
            this.voxelTerrainSystem.setEnvironmentObjectSystem(this.environmentObjectSystem);
            // Also set terrain system reference in environment system for flattening
            this.environmentObjectSystem.setVoxelTerrainSystem(this.voxelTerrainSystem);

            // Enable per-object culling if terrain culling is enabled
            if (this.voxelTerrainSystem.isCullingEnabled()) {
                this.environmentObjectSystem.setCullingEnabled(true);
                // Objects (houses, props, large scenery) must stay visible until the FOG
                // hides them — culling them closer makes big objects pop out distractingly
                // (the old 0.6×-of-terrain default put houses at ~90m on a 512m city). The
                // per-LOD instancing keeps distant objects cheap, so default the render
                // distance to the fog far. A world can still opt into a SHORTER distance via
                // worldProfileData.vegetationRenderDistance.
                const fogFar = this.worldProfileData.fogConfig?.far ?? 500; // matches GameEngine fog default
                const envRenderDistance = this.worldProfileData.vegetationRenderDistance ?? fogFar;
                this.environmentObjectSystem.setMaxRenderDistance(envRenderDistance);
                console.log(`  [Env Object Culling] Enabled, render distance: ${envRenderDistance}m (fog: ${fogFar}m)`);
            }
        }

        // Generate scenery (trees, rocks) - this sets terrain types to prevent foliage overlap
        const t5 = performance.now();
        await this.generateScenery();
        console.log(`  [Timing] Scenery: ${(performance.now() - t5).toFixed(1)}ms`);

        // Rebuild terrain meshes ONCE after all flattening operations from object placement
        // This is a critical optimization - we defer rebuilds during flattenArea() calls
        // and do a single batch rebuild here
        const t_rebuild = performance.now();
        const voxelWorldForRebuild = this.voxelTerrainSystem?.getVoxelWorld();
        if (voxelWorldForRebuild) {
            voxelWorldForRebuild.rebuildDirtyChunks();
            console.log(`  [Timing] Terrain rebuild after objects: ${(performance.now() - t_rebuild).toFixed(1)}ms`);
        }

        // Generate foliage AFTER scenery - terrain types already mark occupied areas
        // Skip foliage when terrain was loaded as VoxelObject (map asset mode), and in a
        // low-poly game: box-blade grass and block flowers are the voxel look.
        const t6 = performance.now();
        if (this.gameData?.artStyle === 'low-poly') {
            console.log(`  [Timing] Foliage: skipped (low-poly art style)`);
        } else if (!this.voxelTerrainSystem?.loadedAsVoxelObject) {
            this.generateFoliage();
            console.log(`  [Timing] Foliage: ${(performance.now() - t6).toFixed(1)}ms`);
        } else {
            console.log(`  [Timing] Foliage: skipped (map asset mode)`);
        }

        // The player spawns directly on the terrain. Every placed object (asset
        // objects included) was loaded by generateScenery() above, through
        // EnvironmentObjectSystem's world.json loader.

        // The spawn check is the LAST step, after everything that reshapes the
        // ground under it: hotspots, scenery and placed objects. It never writes
        // worldProfileData.playerSpawnPosition: the saved Y is kept verbatim (an
        // interior spawn sits below a roof), and PlayerLoader.createPlayerPhysicsBody
        // corrects a clipped or floating spawn in memory at spawn time.
        if (!hasVxlFile) {
            this.prepareStartingPlate();
        }

        const totalTime = performance.now() - startTime;
        console.log(`Generated ${this.worldSize}x${this.worldSize}m procedural world with seed: ${this.rng.getSeed()} (total: ${totalTime.toFixed(1)}ms)`);
    }

    /**
     * Register environment object types (trees, rocks, etc.)
     *
     * Edit this method to customize environment objects.
     *
     * You can:
     * - Change tree/rock dimensions via the treeConfig/rockConfig passed to
     *   registerVoxelTreeType/registerVoxelRockType below
     * - Create entirely new object types by editing EnvironmentObjects.ts
     *
     * Objects are placed from world.json's environmentObjects (proceduralCount is 0),
     * and their colours come from the voxel texture atlas.
     *
     * The voxel tree and rock snap to the voxel ground under them, so a world
     * without one (a baked level, terrain.shape 'none', open water) does not
     * register them. A world.json entry of either type then loads like any
     * other placed object: from its VXL asset when it has one, otherwise it is
     * skipped as an unknown type instead of failing on a missing ground.
     */
    private registerEnvironmentObjectTypes(): void {
        if (!this.environmentObjectSystem) return;

        // Voxel genre always uses serialized environment objects from world.json (environmentObjectsGeneratedProcedurally is always false)
        // Trees, rocks, etc. are placed/removed via voxelObjectPlacementTool, not generated procedurally

        // For Voxel genre, we don't need the environment texture - using atlas instead
        // But we still initialize it for compatibility
        this.environmentObjectSystem.initializeEnvironmentTexture({
            trunk: '#8B4513',   // Brown
            leaves: '#228B22',  // Green
            rock: '#696969'     // Gray
        });

        const terrain = this.voxelTerrainSystem;
        if (!terrain) return;
        // Height lookup function that uses voxel terrain system
        const getTerrainHeight = (x: number, z: number): number => terrain.getHeightAt(x, z);
        const pendingPhysics = this.pendingVoxelObjectPhysics;

        // Trees and rocks use 0.5m voxel blocks from the texture atlas. They wait in
        // pendingPhysics for their bodies, which generateScenery() builds afterwards.
        // proceduralCount is 0 — all objects come from world.json environmentObjects array.
        registerVoxelTreeType(this.environmentObjectSystem, {
            proceduralCount: 0,
            treeConfig: {
                voxelSize: 0.5,
                minTrunkHeight: 6,
                maxTrunkHeight: 10,
                leavesLayers: 4
            },
            getTerrainHeight,
            terrainVoxelSize: this.voxelBlockSize,
            pendingPhysics
        });

        registerVoxelRockType(this.environmentObjectSystem, {
            proceduralCount: 0,
            rockConfig: {
                voxelSize: 0.5,
                minWidth: 2,
                maxWidth: 4,
                minHeight: 1,
                maxHeight: 3
            },
            getTerrainHeight,
            terrainVoxelSize: this.voxelBlockSize,
            pendingPhysics
        });
    }

    /**
     * Generate voxel terrain directly using simplex noise.
     * This creates wavy terrain with hills and varying terrain types.
     *
     * Uses terrain-to-block mappings from this.terrainBlockMap (populated in registerBlockTypes())
     * so that changing a mapping automatically changes what blocks the terrain generates.
     *
     * Edit this method to customize terrain generation.
     *
     * Key parameters to adjust:
     * - noiseScale: smaller = smoother terrain, larger = more chaotic
     * - heightMultiplier: controls how tall hills are
     * - baseHeight: the average ground level
     * - fillDepth: how many blocks deep underground to fill
     *
     * Example - Flat terrain for a city:
     * ```typescript
     * // Set heightMultiplier to 0 and baseHeight to 0 for flat ground
     * const heightMultiplier = 0;
     * const baseHeight = 0;
     * ```
     *
     * Example - Dramatic mountains:
     * ```typescript
     * const heightMultiplier = 10;
     * const noiseScale = 0.03;  // Smoother, larger hills
     * ```
     *
     * WALKABILITY IS VALIDATED FOR YOU. The method runs in three passes: it
     * decides every column's height, then calls `repairTerrainWalkability`
     * (`engine/terrain/voxel/TerrainWalkability.js`) over the whole grid, then writes the
     * validated heights as blocks. That middle pass is what stops noise plus
     * `Math.floor` from leaving a pit the player falls into and cannot climb out
     * of — one cell, a 2x2, or a whole basin. Columns below `waterHeight` are
     * passed as the exclusion mask, so a pond stays the hole it is meant to be.
     *
     * If you change how heights are decided, keep that order: compute the grid
     * first, validate, and only then write. Writing voxels inside the height loop
     * puts the terrain on disk before anything can see whether a column is a
     * trap — which is exactly the bug the validator exists to prevent. A
     * deliberate unreachable pit needs the exclusion mask (or a raised
     * `maxBasinColumns`), not the validator removed.
     *
     * SUBCLASS EXTENSION POINT — `protected` so community templates can
     * subclass `WorldGenerator` and override only the terrain-shape step
     * while inheriting everything else from baseline. If you rename this
     * method, change its signature, or restructure the public APIs it
     * relies on (`getVoxelTerrainSystem`, `getVoxelBlockSize`, `getSeed`,
     * `getBlockTypes`), grep `templates/` for overrides and update them
     * in lockstep; `pnpm run check` type-checks the merged templates
     * (check-templates). See game/docs/editing-baseline.md.
     */
    protected generateVoxelTerrain(): void {
        const voxelWorld = this.voxelTerrainSystem?.getVoxelWorld();
        if (!voxelWorld) {
            console.error('[WorldGenerator] Cannot generate terrain - VoxelWorld not initialized');
            return;
        }

        const worldSizeX = this.effectiveWorldSizeX;
        const worldSizeZ = this.effectiveWorldSizeZ;
        const halfX = worldSizeX / 2;
        const halfZ = worldSizeZ / 2;
        const blockSize = this.voxelBlockSize;

        // ========================================
        // TERRAIN GENERATION PARAMETERS
        // Adjust these to change terrain appearance.
        // ========================================
        const noiseScale = 0.08;         // Noise frequency (smaller = smoother hills)
        const heightMultiplier = 3;      // Maximum hill height in blocks
        const baseHeight = 0;            // Ground level (Y = 0)
        // How many BLOCKS deep to fill underground — a count, not a distance, so the
        // physical thickness is fillDepth * voxelBlockSize (3 m at the default 1 m voxel,
        // 1.5 m at 0.5). Below the fill is AIR, not stone: this IS the terrain's structure.
        // Raise it if neighbouring columns differ in height by more than fillDepth blocks,
        // which leaves a visible gap of air in the exposed face. Keep it in step with the
        // engine's UNDERGROUND_FILL_DEPTH (VoxelTerrainSystem), which flattenArea uses —
        // this path does not read that constant, so the two can silently diverge.
        const fillDepth = 3;

        // Terrain type thresholds
        const sandNoiseThreshold = 0.75; // Above this = sand
        const stoneHeight = 4;           // Heights above this = stone
        const waterHeight = -2;          // Heights below this = water
        // Gem Island: the land rises towards the middle and sinks under the water
        // past this radius (metres from the world centre), so the world is an island.
        const islandRadius = 24;
        const beachWidth = 3;            // Sand this far inside the island's edge
        // ========================================

        const seed = this.rng.getSeed();
        let totalBlocks = 0;

        // worldProfileData.terrain — AI-editable shape + ground override.
        //   shape: 'flat'  → constant-Y plane (cities, racetracks, dungeons, plazas, top-down levels)
        //   shape: 'default' (or omitted) → existing per-cell procedural noise
        //   groundBlockType (string) → override the surface block by name; falls back to per-cell defaults
        // Belt-and-suspenders: cameraMode === 'top-down' implies flat — top-down + procedural hills
        // is always wrong, so the engine treats the camera signal as an implicit flat trigger even
        // if the agent forgets to set terrain.shape.
        const terrainCfg = this.worldProfileData.terrain;
        const isFlat = terrainCfg?.shape === 'flat' || this.worldProfileData.cameraMode === 'top-down';
        // Engine pre-registers custom block types from world.json, so name lookups go through
        // engine.blocks. resolveOptional emits a structured warning distinguishing a missing
        // entry from one whose texture failed to load — agents and humans get an actionable cause.
        const overrideBlock = this.engine?.blocks.resolveOptional(
            terrainCfg?.groundBlockType,
            'terrain.groundBlockType',
        );
        if (isFlat) {
            console.log(`[WorldGenerator] terrain.shape='flat' (cameraMode='${this.worldProfileData.cameraMode ?? 'third-person'}') — flat plane at y=${baseHeight}${overrideBlock !== undefined ? `, surface='${terrainCfg?.groundBlockType}'` : ''}`);
        }

        console.log(`[WorldGenerator] Generating ${worldSizeX}x${worldSizeZ}m terrain with noise...`);
        const genStart = performance.now();

        // Fast path: a flat plane with a uniform surface block + sub-layer
        // fill is the entire content of every chunk inside the world
        // footprint. Bypass the per-voxel `setBlockFast` loop and stamp each
        // chunk's RLE arrays directly — O(numChunks), not O(numVoxels).
        // Falls back to the per-voxel loop below for procedural terrain.
        if (isFlat) {
            const groundCfg = this.worldProfileData.groundConfig;
            const surfaceBlock = (groundCfg?.surfaceBlockType
                ? this.engine?.blocks.resolveOptional(groundCfg.surfaceBlockType, 'groundConfig.surfaceBlockType')
                : undefined)
                ?? overrideBlock
                ?? this.getBlockForTerrain(TerrainTypes.GRASS);
            const subLayers: number[] = groundCfg?.subLayers?.length
                ? groundCfg.subLayers.map((name, i) =>
                    this.engine?.blocks.resolveOptional(name, `groundConfig.subLayers[${i}]`)
                    ?? this.getUndergroundBlock(surfaceBlock),
                )
                : [this.getUndergroundBlock(surfaceBlock)];
            // `terrain.fillDepthBlocks` overrides the default 3-block fill for
            // FLAT terrain only: a side-on 2D game fills to the world floor,
            // because its camera looks at the terrain's cross-section and a
            // 3-block band over open sky reads as a floating strip.
            // `stampFlatTerrain` clamps the fill to the world's own bounds, so
            // an oversized value is simply "solid to the bottom".
            const { chunks, edgeColumns } = stampFlatTerrain(voxelWorld, {
                halfX, halfZ, baseHeight,
                fillDepth: terrainCfg?.fillDepthBlocks ?? fillDepth,
                blockSize, surfaceBlock, subLayers,
            });
            voxelWorld.finalizeBulkGeneration();
            console.log(`[WorldGenerator] Generated flat terrain (${chunks} chunks + ${edgeColumns} edge columns, ${(performance.now() - genStart).toFixed(0)}ms)`);
            return;
        }

        // Use setBlockFast for bulk generation - ~100x faster than setBlock
        // Water block type is constant across the grid — look it up once.
        const waterBlockType = this.getBlockForTerrain(TerrainTypes.WATER);

        // PASS 1 — decide every column's height and surface block, WITHOUT writing
        // any voxels yet. Heights must exist as a grid before they can be checked
        // for walkability: whether a column is a trap is a property of its
        // NEIGHBOURS, which the old single-pass loop had not computed yet.
        //
        // `ceil` reproduces the `x < halfX` bound of the loop this replaced, so a
        // world whose size is not a whole number of blocks keeps its final partial
        // column; the epsilon keeps an exact multiple (the common case) from
        // gaining a phantom column to float error. Indexing columns rather than
        // accumulating `x += blockSize` also drops the drift the old loop carried.
        const EPS = 1e-9;
        const columnsX = Math.max(1, Math.ceil((halfX * 2) / blockSize - EPS));
        const columnsZ = Math.max(1, Math.ceil((halfZ * 2) / blockSize - EPS));
        const heights: number[] = new Array(columnsX * columnsZ);
        const surfaceBlocks: number[] = new Array(columnsX * columnsZ);
        // Water floors are MEANT to sit below their banks — the player swims
        // there. Mask them so the validator reports the pond and leaves it.
        const underwater: boolean[] = new Array(columnsX * columnsZ).fill(false);
        for (let ix = 0; ix < columnsX; ix++) {
            const x = -halfX + ix * blockSize;
            for (let iz = 0; iz < columnsZ; iz++) {
                const z = -halfZ + iz * blockSize;
                // Generate height using simplex-like noise (using seeded random).
                // Flat terrain never reaches here — the fast path above returned.
                const nx = x * noiseScale;
                const nz = z * noiseScale;
                const noiseValue = this.noise2D(nx, nz, seed);

                // Gem Island: a gentle dome inside the island, a slope into the sea outside it.
                const distFromCentre = Math.hypot(x, z);
                const islandShape = distFromCentre < islandRadius
                    ? 2 * (1 - distFromCentre / islandRadius)
                    : -Math.min(8, (distFromCentre - islandRadius) * 0.8);

                // Calculate terrain height
                const height = Math.floor(baseHeight + noiseValue * heightMultiplier + islandShape);

                // Determine terrain type based on height and noise, then look up block type
                let terrainType: number;
                if (height >= stoneHeight) {
                    terrainType = TerrainTypes.STONE;
                } else if (distFromCentre > islandRadius - beachWidth) {
                    terrainType = TerrainTypes.SAND;
                } else {
                    // Use secondary noise for grass/sand variation
                    const terrainNoise = this.noise2D(nx * 2, nz * 2, seed + 1000);
                    if (terrainNoise > sandNoiseThreshold) {
                        terrainType = TerrainTypes.SAND;
                    } else {
                        terrainType = TerrainTypes.GRASS;
                    }
                }
                const column = ix * columnsZ + iz;
                heights[column] = height;
                surfaceBlocks[column] = overrideBlock ?? this.getBlockForTerrain(terrainType);
                underwater[column] = height < waterHeight;
            }
        }

        // PASS 2 — the standard pre-write terrain validation step. Noise plus
        // `Math.floor` can leave a column (or a 2x2, or a whole basin) lower than
        // every neighbour by more than the player's step height: they fall in and
        // cannot climb out. Any generator that computes its own heights should run
        // this before writing blocks — it is why the check lives in the engine
        // rather than being re-implemented per column in game code.
        const validated = repairTerrainWalkability({
            heights,
            sizeX: columnsX,
            sizeZ: columnsZ,
            maxStep: stepHeightForWorld(blockSize),
            excluded: underwater,
            quantum: blockSize,
        });
        if (validated.raisedColumns > 0) {
            const ponds = validated.basins.filter(b => b.intended).length;
            console.log(`[WorldGenerator] Walkability: raised ${validated.raisedColumns} trapped column(s) across ${validated.basins.length - ponds} basin(s)${ponds > 0 ? `, left ${ponds} water basin(s) alone` : ''}`);
        }

        // PASS 3 — write the validated heights as voxels.
        for (let ix = 0; ix < columnsX; ix++) {
            const x = -halfX + ix * blockSize;
            for (let iz = 0; iz < columnsZ; iz++) {
                const z = -halfZ + iz * blockSize;
                const column = ix * columnsZ + iz;
                const height = validated.heights[column]!;
                const surfaceBlockType = surfaceBlocks[column]!;

                // Set surface block using fast method (skips cache invalidation)
                voxelWorld.setBlockFast(x, height, z, surfaceBlockType);
                totalBlocks++;

                // Fill underground blocks (uses undergroundBlockMap for lookup)
                const undergroundBlockType = this.getUndergroundBlock(surfaceBlockType);
                for (let d = 1; d <= fillDepth; d++) {
                    const belowY = height - d * blockSize;
                    if (belowY >= TERRAIN_FLOOR_Y) {
                        voxelWorld.setBlockFast(x, belowY, z, undergroundBlockType);
                        totalBlocks++;
                    }
                }

                // Fill water blocks from terrain surface up to water level (flat water surface)
                if (height < waterHeight) {
                    for (let wy = height + blockSize; wy <= waterHeight; wy += blockSize) {
                        voxelWorld.setBlockFast(x, wy, z, waterBlockType);
                        totalBlocks++;
                    }
                }
            }
        }

        // Finalize bulk generation - clears caches once instead of per-block
        voxelWorld.finalizeBulkGeneration();

        console.log(`[WorldGenerator] Generated ${totalBlocks} voxel blocks in ${(performance.now() - genStart).toFixed(0)}ms`);
    }

    /**
     * Simple 2D noise function using seeded random.
     * Returns value between -1 and 1.
     */
    private noise2D(x: number, z: number, seed: number): number {
        // Hash function for deterministic noise
        const hash = (x: number, z: number): number => {
            let h = seed;
            h = Math.imul(h ^ (Math.floor(x * 374761393) >>> 0), 1103515245);
            h = Math.imul(h ^ (Math.floor(z * 668265263) >>> 0), 1103515245);
            return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
        };

        // Bilinear interpolation of 4 corner values
        const x0 = Math.floor(x);
        const z0 = Math.floor(z);
        const fx = x - x0;
        const fz = z - z0;

        const v00 = hash(x0, z0) * 2 - 1;
        const v10 = hash(x0 + 1, z0) * 2 - 1;
        const v01 = hash(x0, z0 + 1) * 2 - 1;
        const v11 = hash(x0 + 1, z0 + 1) * 2 - 1;

        // Smooth interpolation
        const sx = fx * fx * (3 - 2 * fx);
        const sz = fz * fz * (3 - 2 * fz);

        const v0 = v00 + sx * (v10 - v00);
        const v1 = v01 + sx * (v11 - v01);

        return v0 + sz * (v1 - v0);
    }

    /**
     * Flatten an area of terrain to a specific height.
     * Use this to create flat surfaces for roads, buildings, or other structures.
     * 
     * Call this to prepare flat areas before placing buildings.
     * 
     * @param centerX - Center X coordinate of the area
     * @param centerZ - Center Z coordinate of the area
     * @param width - Width of the area to flatten
     * @param depth - Depth of the area to flatten
     * @param height - Target height for the flat surface
     * @param blockType - Block type to use for the surface (default: ASPHALT for roads)
     * @param rebuildMeshes - Whether to rebuild meshes after modification (default: false for initial generation, true for runtime)
     * 
     * @example
     * // Flatten a 20x20 area for a building at ground level
     * this.flattenArea(0, 0, 20, 20, 0, BlockTypes.STONE);
     * 
     * // Create a road (with mesh rebuild for runtime modification)
     * this.flattenArea(-50, 0, 100, 8, 0, BlockTypes.ASPHALT, true);
     *
     * Delegates to VoxelTerrainSystem.flattenArea; `margin` widens the flattened
     * footprint on every side.
     */
    flattenArea(centerX: number, centerZ: number, width: number, depth: number, height: number, blockType?: number, rebuildMeshes: boolean = false, margin: number = 0): void {
        if (!this.voxelTerrainSystem) { console.warn('[FLATTEN] Cannot flatten area - terrain system not initialized'); return; }
        this.voxelTerrainSystem.flattenArea(centerX, centerZ, width, depth, height, blockType, rebuildMeshes, margin);
    }

    /**
     * Set a single terrain block at a specific position.
     * 
     * @param x - World X coordinate
     * @param y - World Y coordinate (height)
     * @param z - World Z coordinate
     * @param blockType - Block type ID from BlockTypes
     */
    setTerrainBlock(x: number, y: number, z: number, blockType: number): void {
        const voxelWorld = this.voxelTerrainSystem?.getVoxelWorld();
        if (!voxelWorld) {
            console.warn('[WorldGenerator] Cannot set block - terrain not initialized');
            return;
        }
        voxelWorld.setBlock(x, y, z, blockType);
    }

    /**
     * Get the block type IDs for use in flattenArea() and setTerrainBlock().
     * Returns engine-defined BlockTypes merged with custom block types from world.json.
     * Custom-block ids are read from the atlas (populated by `engine.blocks` at world load).
     *
     * NOTE: This rebuilds the merged map on every call (O(N) over customBlockTypes).
     * Cache the result if you call it inside a hot loop. Currently used only by
     * template-authoring callers, not the per-frame render path.
     */
    getBlockTypes(): typeof BlockTypes & Record<string, number> {
        const atlas = getVoxelTextureAtlas();
        const result: Record<string, number> = { ...BlockTypes };
        for (const spec of this.worldProfileData.customBlockTypes ?? []) {
            const id = atlas.getBlockIdByName(spec.name);
            if (id === undefined) continue; // skip entries whose textures failed to load
            const upperName = spec.name.toUpperCase().replace(/[^A-Z0-9]/g, '_');
            result[upperName] = id;
        }
        return result as typeof BlockTypes & Record<string, number>;
    }

    /** Look up the block type for a terrain type using the terrain-to-block mapping. */
    private getBlockForTerrain(terrainType: number): number {
        return this.terrainBlockMap.get(terrainType) ?? BlockType.NONE;
    }

    /** Look up the underground block type for a surface block type. */
    private getUndergroundBlock(surfaceBlockType: number): number {
        return this.undergroundBlockMap.get(surfaceBlockType) ?? surfaceBlockType;
    }

    /**
     * Expand `worldProfileData.hotspots[]` into terrain modifications + injected
     * environmentObject entries. Runs after `generateVoxelTerrain()` (terrain Y
     * is final) and before EnvironmentObjectSystem is created (so injected
     * objects flow through the standard scenery loader).
     *
     * Each hotspot is dispatched through `HotspotInterpreterRegistry.applyAll()`,
     * which throws on unknown types or interpreter errors — half-rendered levels
     * are worse than no rendering, and the agent needs feedback to fix authoring
     * mistakes (validate-world-json catches most of these up-front, but the
     * runtime guard is a defense-in-depth).
     *
     * `vxlTerrain` — terrain came from a baked .vxl file: only vxl-safe
     * interpreters ('building') apply; the rest are warn-skipped per hotspot.
     */
    private expandHotspots(vxlTerrain: boolean = false): void {
        const hotspots = this.worldProfileData.hotspots;
        if (!hotspots || hotspots.length === 0) return;

        if (!this.voxelTerrainSystem) {
            console.warn('[WorldGenerator] Cannot expand hotspots — terrain system not initialized');
            return;
        }

        // Without gameData, we have nowhere to attach the injected env-objects —
        // `generateScenery` → `loadSceneryFromWorldJson` reads from
        // `this.gameData.environmentObjects`. Bail out loudly so authoring errors
        // aren't masked by silent no-ops.
        if (!this.gameData) {
            console.warn('[WorldGenerator] Cannot expand hotspots — gameData not available');
            return;
        }

        // Inject env-objects directly into the gameData array — `generateScenery`
        // → `loadSceneryFromWorldJson` reads from `this.gameData.environmentObjects`
        // shortly after this method returns. Mutating in-place is the simplest
        // way to bridge the hotspot expansion to the existing scenery pipeline.
        // The `?? []` + reassignment handles the case where the array was undefined
        // at gameData-load (older world.json shapes).
        const envObjects = (this.gameData.environmentObjects as InjectedEnvironmentObject[] | undefined) ?? [];
        this.gameData.environmentObjects = envObjects;
        const assets: HotspotAsset[] = (this.gameData.assets as HotspotAsset[] | undefined) ?? [];

        // Single seeded RNG shared across all interpreters in this run, so two
        // interpreters acting on the same hotspot produce reproducible output.
        // XOR-mixed with a hotspot-domain salt so map-shape and hotspot layout
        // don't share RNG state by accident.
        const seededRng = new SeededRandom((this.worldProfileData.worldSeed ?? 42) ^ 0x4015);
        const rng = () => seededRng.next();

        const ctx: HotspotContext = {
            flattenArea: (centerX, centerZ, width, depth, height, blockType, rebuildMeshes, margin) => {
                this.flattenArea(centerX, centerZ, width, depth, height, blockType, rebuildMeshes ?? false, margin ?? 0);
            },
            getHeightAt: (x, z) => this.voxelTerrainSystem!.getHeightAt(x, z),
            resolveBlockByName: (name) => this.engine?.blocks.resolve(name).id,
            pushEnvironmentObject: (envObj) => envObjects.push(envObj),
            assets,
            rng,
        };

        const registry = buildDefaultHotspotRegistry();
        // Throws on bad type / interpreter error — propagate up so generation
        // fails loudly rather than producing a corrupted world.
        registry.applyAll(ctx, hotspots, { vxlTerrain });
        console.log(`[WorldGenerator] Expanded ${hotspots.length} hotspot(s) → +${envObjects.length} environment objects`);
    }

    /**
     * Get voxel terrain configuration.
     *
     * Edit this method to customize voxel terrain appearance.
     *
     * Example - Shiny metallic blocks:
     * ```typescript
     * return {
     *     blockSize: this.voxelBlockSize,
     *     material: {
     *         roughness: 0.3,    // Shinier surface
     *         metalness: 0.5,    // More metallic
     *     }
     * };
     * ```
     *
     * Example - Icy slippery blocks:
     * ```typescript
     * return {
     *     blockSize: this.voxelBlockSize,
     *     physics: {
     *         friction: 0.1,      // Very slippery
     *         restitution: 0.3    // Slightly bouncy
     *     }
     * };
     * ```
     */
    private getVoxelTerrainConfig(): VoxelTerrainConfig {
        return {
            blockSize: this.voxelBlockSize,
            material: {
                roughness: 0.9,          // Slightly rough surface for voxel look
                metalness: 0.0           // Non-metallic
            },
            physics: {
                friction: 0.7,           // Normal grip
                restitution: 0.0         // No bounce
            }
        };
    }

    /**
     * Get the terrain physics friction value (for player movement deceleration)
     */
    getTerrainFriction(): number {
        this.terrainFriction ??= this.getVoxelTerrainConfig().physics?.friction ?? 0.7;
        return this.terrainFriction;
    }

    /**
     * Register terrain types needed for this world.
     * Terrain types define surface properties (grip, foliage spawning, etc.)
     * and are later mapped to block types for voxel rendering.
     * 
     * To add new terrain types (e.g., snow, mud):
     * 1. Add it to TerrainTypes object at the top of this file
     * 2. Call createXxxTerrainType(this.terrainRegistry) or register manually
     * 3. Map it to a block type in registerBlockTypes()
     */
    private registerTerrainTypes(): void {
        TerrainTypes.GRASS = createGrassTerrainType(this.terrainRegistry);
        TerrainTypes.SAND = createSandTerrainType(this.terrainRegistry);
        TerrainTypes.ASPHALT = createAsphaltTerrainType(this.terrainRegistry);
        TerrainTypes.ICE = createIceTerrainType(this.terrainRegistry);
        TerrainTypes.LAVA = createLavaTerrainType(this.terrainRegistry);
        TerrainTypes.DIRT = createDirtTerrainType(this.terrainRegistry);
        TerrainTypes.STONE = createStoneTerrainType(this.terrainRegistry);
        TerrainTypes.WATER = createWaterTerrainType(this.terrainRegistry);

        console.log('[WorldGenerator] Terrain types registered:', TerrainTypes);
    }

    /**
     * Register block-to-terrain mappings for VoxelTerrainTypeProvider.
     * This maps surface block types to terrain types for placement rules.
     * 
     * When EnvironmentObjectSystem checks if a tree can be placed, it queries:
     * 1. VoxelWorld for the surface block type at (x, z)
     * 2. VoxelTerrainTypeProvider maps block type -> terrain type
     * 3. TerrainRegistry provides properties (canPlaceTrees, canPlaceRocks, etc.)
     */
    private registerBlockTerrainMappings(): void {
        // Map each block type to its corresponding terrain type
        // GRASS block -> GRASS terrain (trees can grow)
        this.voxelTerrainTypeProvider.registerBlockTerrainMapping(BlockTypes.GRASS, TerrainTypes.GRASS);
        // SAND block -> SAND terrain (no trees, rocks okay)
        this.voxelTerrainTypeProvider.registerBlockTerrainMapping(BlockTypes.SAND, TerrainTypes.SAND);
        // STONE block -> STONE terrain (rocks okay, no trees)
        this.voxelTerrainTypeProvider.registerBlockTerrainMapping(BlockTypes.STONE, TerrainTypes.STONE);
        // ICE block -> ICE terrain (nothing grows)
        this.voxelTerrainTypeProvider.registerBlockTerrainMapping(BlockTypes.ICE, TerrainTypes.ICE);
        // WATER block -> WATER terrain (fluid, swimmable)
        this.voxelTerrainTypeProvider.registerBlockTerrainMapping(BlockTypes.WATER, TerrainTypes.WATER);
        // DIRT block -> DIRT terrain
        this.voxelTerrainTypeProvider.registerBlockTerrainMapping(BlockTypes.DIRT, TerrainTypes.DIRT);
        // ASPHALT block -> ASPHALT terrain (roads, no vegetation)
        this.voxelTerrainTypeProvider.registerBlockTerrainMapping(BlockTypes.ASPHALT, TerrainTypes.ASPHALT);
        // LAVA block -> LAVA terrain (nothing grows)
        this.voxelTerrainTypeProvider.registerBlockTerrainMapping(BlockTypes.LAVA, TerrainTypes.LAVA);

        console.log('[WorldGenerator] Block-to-terrain mappings registered');
    }

    /**
     * Register block types needed for this world.
     *
     * ENGINE BLOCK TYPES: Call utility functions like createGrassBlockType(atlas).
     * TEMPLATE-PROCEDURAL BLOCK TYPES: Generate the texture in this file (see
     * generateMarbleTexture below) and call atlas.registerBlockTexture().
     *
     * AGENT-AUTHORED BLOCK TYPES (`worldProfileData.customBlockTypes`): NOT
     * registered here — the engine pre-registers them via `engine.blocks` in
     * GameEngine.loadGame, before this method runs. Resolve their ids by name
     * via `engine.blocks.resolve(name)`.
     *
     * This method also populates this.terrainBlockMap and this.undergroundBlockMap,
     * which are used by generateVoxelTerrain() for procedural generation.
     * Changing a mapping here changes what blocks the terrain generates.
     *
     * To change terrain surface appearance (e.g., make grass areas snowy):
     * 1. Register a new block type (e.g., SNOW) using atlas.registerBlockTexture()
     * 2. Change the terrain-to-block mapping: this.terrainBlockMap.set(TerrainTypes.GRASS, BlockTypes.SNOW)
     *
     * To create a new block type (e.g., snow, mud, crystal):
     * 1. Add it to BlockTypes object at the top of this file
     * 2. Create a texture generator method (see generateMarbleTexture below)
     * 3. Get a new ID with atlas.getNextBlockId()
     * 4. Register with atlas.registerBlockTexture({ id, name, size, top: canvas })
     * 5. Map to a terrain type: this.terrainBlockMap.set(TerrainTypes.GRASS, BlockTypes.SNOW)
     */
    private async registerBlockTypes(): Promise<void> {
        const atlas = getVoxelTextureAtlas();
        // A low-poly game paints every block face as flat colour — no pixel-art texture noise.
        atlas.setFaceStyle(this.gameData?.artStyle === 'low-poly' ? 'flat' : 'textured');

        // Engine-provided block types (textures built into engine)
        BlockTypes.GRASS = createGrassBlockType(atlas);
        BlockTypes.SAND = createSandBlockType(atlas);
        BlockTypes.ICE = createIceBlockType(atlas);
        BlockTypes.STONE = createStoneBlockType(atlas);
        BlockTypes.DIRT = createDirtBlockType(atlas);
        BlockTypes.ASPHALT = createAsphaltBlockType(atlas);
        BlockTypes.WATER = createWaterBlockType(atlas, TerrainTypes.WATER);
        BlockTypes.LAVA = createLavaBlockType(atlas);
        BlockTypes.TRUNK = createTrunkBlockType(atlas, MaterialId.WOOD);
        BlockTypes.LEAVES = createLeavesBlockType(atlas, MaterialId.LEAVES);

        // Register block type names for AI tools (case-insensitive)
        // These allow the AI to reference block types by name instead of ID
        atlas.registerBlockName('grass', BlockTypes.GRASS);
        atlas.registerBlockName('sand', BlockTypes.SAND);
        atlas.registerBlockName('ice', BlockTypes.ICE);
        atlas.registerBlockName('stone', BlockTypes.STONE);
        atlas.registerBlockName('rock', BlockTypes.STONE);  // Alias
        atlas.registerBlockName('dirt', BlockTypes.DIRT);
        atlas.registerBlockName('asphalt', BlockTypes.ASPHALT);
        atlas.registerBlockName('road', BlockTypes.ASPHALT);  // Alias
        atlas.registerBlockName('water', BlockTypes.WATER);
        atlas.registerBlockName('lava', BlockTypes.LAVA);
        atlas.registerBlockName('trunk', BlockTypes.TRUNK);
        atlas.registerBlockName('wood', BlockTypes.TRUNK);  // Alias
        atlas.registerBlockName('leaves', BlockTypes.LEAVES);
        atlas.registerBlockName('foliage', BlockTypes.LEAVES);  // Alias

        // CUSTOM BLOCK TYPE EXAMPLE: Marble
        BlockTypes.MARBLE = atlas.getNextBlockId();
        atlas.registerBlockTexture({
            id: BlockTypes.MARBLE,
            name: 'marble',
            size: 16,
            top: this.generateMarbleTexture(16, new SeededRandom(this.rng.getSeed() ^ MARBLE_SEED_SALT))
        });
        atlas.registerBlockName('marble', BlockTypes.MARBLE);

        // Set materials on blocks for proper debris buoyancy
        // Objects with density < 1000 float, > 1000 sink
        atlas.setBlockMaterial(BlockTypes.GRASS, MaterialId.DIRT);    // Grass block is mostly soil
        atlas.setBlockMaterial(BlockTypes.STONE, MaterialId.STONE);
        atlas.setBlockMaterial(BlockTypes.SAND, MaterialId.SAND);
        atlas.setBlockMaterial(BlockTypes.DIRT, MaterialId.DIRT);
        atlas.setBlockMaterial(BlockTypes.ICE, MaterialId.ICE);       // Ice floats!
        atlas.setBlockMaterial(BlockTypes.ASPHALT, MaterialId.CONCRETE);
        atlas.setBlockMaterial(BlockTypes.MARBLE, MaterialId.STONE);

        // Terrain-to-block mappings, read by generateVoxelTerrain() below
        // To change terrain surface appearance, edit these mappings.
        // Example: this.terrainBlockMap.set(TerrainTypes.GRASS, BlockTypes.SNOW) makes grass areas snowy
        this.terrainBlockMap.set(TerrainTypes.GRASS, BlockTypes.GRASS);
        this.terrainBlockMap.set(TerrainTypes.SAND, BlockTypes.SAND);
        this.terrainBlockMap.set(TerrainTypes.ASPHALT, BlockTypes.ASPHALT);
        this.terrainBlockMap.set(TerrainTypes.ICE, BlockTypes.ICE);
        this.terrainBlockMap.set(TerrainTypes.LAVA, BlockTypes.LAVA);
        this.terrainBlockMap.set(TerrainTypes.DIRT, BlockTypes.DIRT);
        this.terrainBlockMap.set(TerrainTypes.STONE, BlockTypes.STONE);
        this.terrainBlockMap.set(TerrainTypes.WATER, BlockTypes.WATER);

        // Underground block mappings (what's below the surface)
        this.undergroundBlockMap.set(BlockTypes.GRASS, BlockTypes.DIRT);

        // Custom block types from world.json are loaded by `engine.blocks` before
        // the genre's WorldGenerator runs — see GameEngine.loadGame. Resolve them
        // by name via `engine.blocks.resolve(name)` instead of maintaining a local
        // map here.

        console.log('[WorldGenerator] Block types registered:', BlockTypes);
    }

    /**
     * Apply smooth surface settings to the VoxelWorld. This must be called AFTER
     * terrain generation when VoxelWorld exists.
     *
     * The settings are world.json's `blockTypeProperties` (keyed by block NAME,
     * e.g. "asphalt", for stability), which the engine installs into the texture
     * atlas's block properties at load; this reads them back from there.
     */
    private applySmoothSurfaceSettings(): void {
        const voxelWorld = this.voxelTerrainSystem?.getVoxelWorld();
        if (!voxelWorld) {
            // VoxelWorld not initialized (e.g., map asset loaded as VoxelObject) — smooth surfaces don't apply
            return;
        }

        for (const block of getVoxelTextureAtlas().getAllBlockTypesWithProperties()) {
            if (block.id === 0 || !block.properties.smoothSurface) continue;
            const smoothRadius = block.properties.smoothRadius;
            console.log(`[WorldGenerator] Enabling smooth surface for ${block.name} (ID: ${block.id}) with radius ${smoothRadius}`);
            voxelWorld.enableSmoothSurfaceForBlockType(block.id);
            voxelWorld.setSmoothSurfaceFilterDistance(smoothRadius);
        }
    }

    /**
     * Generate marble texture - white/gray with veining pattern.
     *
     * A template for any custom texture:
     * Just change the colors and drawing logic for your material.
     * Examples: snow (white with blue tint), mud (brown with dark spots),
     * crystal (blue/purple with bright highlights), autumn leaves (orange/red mix)
     *
     * Draws from `rng` (seeded from the world seed) so a world's marble looks the
     * same on every load.
     */
    private generateMarbleTexture(size: number, rng: SeededRandom): HTMLCanvasElement {
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d')!;

        // Base white-gray color
        ctx.fillStyle = '#E8E8E8';
        ctx.fillRect(0, 0, size, size);

        // Add gray veining
        ctx.strokeStyle = '#B0B0B0';
        ctx.lineWidth = 0.5;
        for (let i = 0; i < 3; i++) {
            ctx.beginPath();
            ctx.moveTo(rng.next() * size, 0);
            ctx.bezierCurveTo(
                rng.next() * size, size * 0.3,
                rng.next() * size, size * 0.7,
                rng.next() * size, size
            );
            ctx.stroke();
        }

        // Add subtle variation
        for (let y = 0; y < size; y++) {
            for (let x = 0; x < size; x++) {
                if (rng.next() > 0.85) {
                    ctx.fillStyle = rng.next() > 0.5 ? '#F0F0F0' : '#D0D0D0';
                    ctx.fillRect(x, y, 1, 1);
                }
            }
        }

        return canvas;
    }

    /**
     * Spawn hook, run as the last step of procedural world generation: logs the
     * configured spawn against the terrain surface. It never writes the spawn —
     * the Y from world.json is kept verbatim, which is what lets a spawn sit
     * inside a roofed room, building or cave rather than on the roof above it.
     *
     * PlayerLoader.createPlayerPhysicsBody makes sure the player is not clipped
     * or floating — capsule-overlap test, snap-down onto an interior floor,
     * minimal step-up — in memory, at spawn time, only when needed. A stale Y
     * under a procedural hill is lifted onto the surface there.
     *
     * Protected so a subclass can add its own spawn logic; it must not mutate
     * worldProfileData either, since the editor saves that object back to disk.
     */
    protected prepareStartingPlate(): void {
        const spawnPos = this.worldProfileData.playerSpawnPosition;
        if (!spawnPos || !this.voxelTerrainSystem) return;
        const terrainHeight = this.voxelTerrainSystem.getHeightAt(spawnPos.x, spawnPos.z);
        console.log(`✅ Spawn position preserved: (${spawnPos.x}, ${spawnPos.y}, ${spawnPos.z}) — top surface at y=${terrainHeight} (PlayerLoader corrects at spawn if needed)`);
    }

    private generateFoliage(): void {
        console.log('Step 5: Generating voxel foliage...');
        if (!this.voxelTerrainSystem) {
            console.warn('[WorldGenerator] Cannot generate foliage: voxelTerrainSystem not initialized');
            return;
        }

        // Create VoxelFoliageSystem - see VoxelFoliageSystem.ts for customFoliage docs
        this.foliageSystem = new VoxelFoliageSystem({
            world: this.world,
            seed: this.rng.getSeed(),
            terrainRegistry: this.terrainRegistry,
            terrainVoxelSize: this.voxelBlockSize,
            isPositionOccupied: (x: number, z: number) => this.isPositionOccupied(x, z)
        });

        // Connect to terrain system and generate chunk-based foliage
        this.voxelTerrainSystem.setFoliageSystem(this.foliageSystem);

        // Generate foliage for all chunks - foliage is parented to terrain meshes
        // for automatic visibility inheritance (chunk hidden = foliage hidden)
        this.voxelTerrainSystem.generateAllFoliage(
            (blockType: number) => this.voxelTerrainTypeProvider.getTerrainTypeForBlockType(blockType)
        );

        console.log('✅ Voxel foliage generated');
    }

    /** Get the foliage system for animation updates */
    getFoliageSystem(): VoxelFoliageSystem | null { return this.foliageSystem; }

    /** Check if a position is occupied by a static object (tree, rock, building, etc.) */
    private isPositionOccupied(x: number, z: number): boolean {
        return this.environmentObjectSystem?.isPositionOccupied(x, z) ?? false;
    }

    /**
     * Find a valid voxel spawn position for animals.
     * @param worldX Approximate world X coordinate
     * @param worldZ Approximate world Z coordinate
     * @returns Valid spawn position or null if no valid position found
     */
    public findValidVoxelSpawnPosition(worldX: number, worldZ: number, fromY?: number): THREE.Vector3 | null {
        if (this.voxelTerrainSystem) {
            return this.voxelTerrainSystem.findValidVoxelSpawnPosition(worldX, worldZ, this.environmentObjectSystem ?? undefined, fromY);
        }
        // No voxel grid (terrain.shape 'none', open water): resolve the floor
        // with physics raycasts against whatever colliders the level built.
        // Returning null here silently spawned zero NPCs on mesh levels.
        if (!this.engine) return null;
        this.physicsSpawnFinder ??= createPhysicsSpawnFinder(
            this.engine,
            this.engine.getDynamicObjectManager?.()?.getTerrainBounds() ?? null,
            { requireHeadroom: true },
        );
        return this.physicsSpawnFinder(worldX, worldZ, fromY);
    }


    private async generateScenery(): Promise<void> {
        if (!this.environmentObjectSystem) {
            throw new Error('Environment object system not initialized');
        }

        // Register callback so pending voxel object physics (trees, rocks) are created
        // before the engine's physics step at the end of generateScenery()
        if (this.engine?.physicsWorld) {
            const pw = this.engine.physicsWorld;
            this.environmentObjectSystem.setOnBeforePhysicsStep(() => {
                this.pendingVoxelObjectPhysics.createAll(pw);
            });
        }

        await this.environmentObjectSystem.generateScenery();
    }

    /** Unpack InstancedMesh into individual meshes for Scene editor selection */
    unpackInstancedMeshes(): void {
        this.environmentObjectSystem?.unpackInstancedMeshes();
    }

    /** Pack individual meshes back into InstancedMesh for performance */
    packInstancedMeshes(): void {
        this.environmentObjectSystem?.packInstancedMeshes();
    }

    /**
     * Serialize environment objects to level file format.
     *
     * Returns ALL objects registered with ObjectIdService — both procedural objects
     * (trees, rocks loaded by EnvironmentObjectSystem) and runtime-placed asset
     * objects (via PlacedObjectSystem). This array completely replaces
     * environmentObjects in world.json, so omissions cause data loss.
     */
    serializeEnvironmentObjects(): Array<Record<string, unknown>> {
        const result: Array<Record<string, unknown>> = [];
        const idService = getObjectIdService();
        const matrix = new THREE.Matrix4();

        for (const registered of idService.getAllByType('object')) {
            const sceneObject = registered.object;
            const data = registered.data;
            if (!sceneObject || !data) continue;

            // For an instanced object the transform is its instance's — the
            // authored one, which getInstanceMatrix reads even while culling has
            // repacked the mesh's render buffer; for individual meshes it is
            // directly on the object.
            let position: THREE.Vector3;
            let rotation: THREE.Euler;
            let scale: THREE.Vector3;

            if (idService.getInstanceMatrix(registered, matrix)) {
                position = new THREE.Vector3();
                const quaternion = new THREE.Quaternion();
                scale = new THREE.Vector3();
                matrix.decompose(position, quaternion, scale);
                rotation = new THREE.Euler().setFromQuaternion(quaternion);
            } else {
                position = sceneObject.position;
                rotation = sceneObject.rotation;
                scale = sceneObject.scale;
            }

            result.push(serializeEnvironmentObject(
                data,
                registered.id,
                { x: position.x, y: position.y, z: position.z },
                { x: rotation.x, y: rotation.y, z: rotation.z },
                { x: scale.x, y: scale.y, z: scale.z }
            ));
        }

        return result;
    }

    /**
     * Get the EnvironmentObjectSystem instance.
     * 
     * Use this to access the environment object system and register new object types.
     * Example:
     * ```typescript
     * const envSystem = worldGenerator.getEnvironmentObjectSystem();
     * envSystem.registerEnvironmentObjectType({ ... });
     * ```
     * 
     * @returns The EnvironmentObjectSystem instance, or null if world hasn't been generated yet
     */
    getEnvironmentObjectSystem(): EnvironmentObjectSystem | null {
        return this.environmentObjectSystem;
    }

    /**
     * Release everything this generator built: the placed objects, foliage and
     * fluid, whichever terrain runtime the world used (procedural voxel or baked
     * VxlScene), the declared mesh level, the navmesh it installed
     * from a level's sidecar, and the objects still waiting for physics.
     * Game.dispose() calls it. Safe to call twice; a sidecar that arrives after
     * it is ignored.
     *
     * Each system withdraws only what is still its own (the global navmesh, the
     * baked-terrain slot), so a dispose that runs after the next world installed
     * its own leaves that one alone.
     */
    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;

        this.pendingVoxelObjectPhysics.clear();
        // Objects first: they hold navmesh obstacles and flatten through the terrain.
        this.environmentObjectSystem?.dispose();
        this.environmentObjectSystem = null;
        // Foliage and fluid read the VoxelWorld the terrain owns, so they go before it.
        this.foliageSystem?.dispose();
        this.foliageSystem = null;
        this.fluidSystem?.dispose();
        this.fluidSystem = null;

        this.voxelTerrainSystem?.dispose();
        this.voxelTerrainSystem = null;
        this.vxlSceneTerrain?.dispose();
        this.vxlSceneTerrain = null;
        this.declaredMeshLevel?.dispose();
        this.declaredMeshLevel = null;

        if (this.bootNavMesh) {
            if (getGlobalNavMesh() === this.bootNavMesh) setGlobalNavMesh(null);
            this.bootNavMesh.dispose();
            this.bootNavMesh = null;
        }
        this.physicsSpawnFinder = null;
    }
}
