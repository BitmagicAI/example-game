import * as THREE from 'three';
import { CollectibleComponent } from 'engine/interaction/CollectibleComponent.js';
import type { PhysicsWorld } from 'engine/physics/PhysicsWorld.js';

/** How high above the ground a gem floats, and how far it bobs and how fast it spins. */
const FLOAT_HEIGHT = 1.0;
const BOB_AMPLITUDE = 0.15;
const SPIN_SPEED = 1.5; // radians per second
/** How close the player has to get to pick a gem up, in metres. */
const PICKUP_RADIUS = 1.2;

const GEM_COLOURS = [0x37e0ff, 0xff4fa3, 0x7dff5a, 0xffc93c, 0xb57bff];

/**
 * One gem: a glowing voxel cube standing on its corner, floating above the ground.
 *
 * Pickup uses the engine's `CollectibleComponent` — a physics trigger sensor that fires
 * once when the player walks into it, so there is no distance check in the update loop
 * (see `engine/agent-docs/collectible-objects.md`).
 */
export class Gem {
    /** Stays put so the pickup sensor stays where the gem is; the mesh bobs inside it. */
    readonly root = new THREE.Group();
    private readonly spinner = new THREE.Group();
    private readonly mesh: THREE.Mesh<THREE.BoxGeometry, THREE.MeshStandardMaterial>;
    private readonly pickup: CollectibleComponent;
    private readonly phase: number;
    private collected = false;

    constructor(
        scene: THREE.Scene,
        physicsWorld: PhysicsWorld,
        groundPosition: THREE.Vector3,
        index: number,
        onCollect: (gem: Gem) => void,
    ) {
        const colour = GEM_COLOURS[index % GEM_COLOURS.length]!;
        this.mesh = new THREE.Mesh(
            new THREE.BoxGeometry(0.5, 0.5, 0.5),
            new THREE.MeshStandardMaterial({
                color: colour,
                emissive: colour,
                emissiveIntensity: 0.6,
                roughness: 0.3,
                metalness: 0.1,
            }),
        );
        // Tip the cube onto one corner so it reads as a gem rather than a block.
        this.mesh.rotation.set(Math.PI / 4, 0, Math.atan(Math.SQRT1_2));
        this.spinner.add(this.mesh);
        this.root.add(this.spinner);

        this.root.position.copy(groundPosition).add(new THREE.Vector3(0, FLOAT_HEIGHT, 0));
        this.root.name = `gem_${index}`;
        scene.add(this.root);
        this.phase = index * 0.7;

        this.pickup = new CollectibleComponent(physicsWorld, {
            object3D: this.root,
            radius: PICKUP_RADIUS,
            yOffset: 0,
            collectible: {
                onCollect: () => {
                    if (this.collected) return;
                    this.collected = true;
                    this.root.visible = false;
                    onCollect(this);
                },
            },
        });
    }

    get position(): THREE.Vector3 {
        return this.root.position;
    }

    /** Spin and bob. `time` is seconds since the game started. */
    update(time: number): void {
        if (this.collected) return;
        this.spinner.rotation.y = time * SPIN_SPEED + this.phase;
        this.spinner.position.y = Math.sin(time * 2 + this.phase) * BOB_AMPLITUDE;
    }

    dispose(): void {
        this.pickup.dispose();
        this.root.removeFromParent();
        this.mesh.geometry.dispose();
        this.mesh.material.dispose();
    }
}
