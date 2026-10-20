import * as THREE from 'three';

/**
 * Procedural posing for the catalog animals (Mixamo-named rigs, T-pose bind, face +Z, left = +X).
 *
 * The catalog clips are 2-key static poses, so everything is solved here. Poses are authored as
 * MODEL-SPACE deltas: `delta(bone)` rotates that bone about the character's own X/Y/Z axes on top
 * of whatever its parent already does, so nothing depends on the rig's local bone axes:
 *
 *     model[child] = delta[child] * model[parent] * bindLocal[child]
 *     local[child] = conj(model[parent]) * model[child]
 *
 * Axes: +Y up, +Z forward, +X the character's LEFT. Forward lean of the trunk / head is +X rotation,
 * a leg swinging forward is -X rotation, an arm hanging down is rotZ(-a) on the left and rotZ(+a) on the right.
 */
export const BONE = {
    hips: 'mixamorigHips', spine: 'mixamorigSpine', spine1: 'mixamorigSpine1', spine2: 'mixamorigSpine2',
    neck: 'mixamorigNeck', head: 'mixamorigHead',
    lShoulder: 'mixamorigLeftShoulder', lArm: 'mixamorigLeftArm', lFore: 'mixamorigLeftForeArm', lHand: 'mixamorigLeftHand',
    rShoulder: 'mixamorigRightShoulder', rArm: 'mixamorigRightArm', rFore: 'mixamorigRightForeArm', rHand: 'mixamorigRightHand',
    lUp: 'mixamorigLeftUpLeg', lLeg: 'mixamorigLeftLeg', lFoot: 'mixamorigLeftFoot', lToe: 'mixamorigLeftToeBase',
    rUp: 'mixamorigRightUpLeg', rLeg: 'mixamorigRightLeg', rFoot: 'mixamorigRightFoot', rToe: 'mixamorigRightToeBase',
} as const;

const AX = { x: new THREE.Vector3(1, 0, 0), y: new THREE.Vector3(0, 1, 0), z: new THREE.Vector3(0, 0, 1) };
const qa = new THREE.Quaternion();
const qb = new THREE.Quaternion();

export class AnimalRig {
    readonly root: THREE.Object3D;
    private bones = new Map<string, THREE.Bone>();
    private order: THREE.Bone[] = [];
    private bindLocal = new Map<THREE.Bone, THREE.Quaternion>();
    private delta = new Map<THREE.Bone, THREE.Quaternion>();
    private model = new Map<THREE.Bone, THREE.Quaternion>();
    private hipsBind = new THREE.Vector3();
    /** Standing height of the bind pose (m), measured from the skinned meshes. */
    height = 1;
    /** Height of the feet soles above the model origin at bind. */
    footY = 0;
    /** Hip joint to ankle at bind (model units): the leg that sets the stride length (BallView's cadence). */
    legLength = 0.3;
    /** Hips above the soles at bind (model units): scales the engine's locomotion clips to this animal (AnimalClips.ts). */
    hipsHeight = 0.5;
    /** The tail chain (bones with "tail" in the name), root first: posed like any other bone, so a long tail can be curled up. */
    readonly tail: string[] = [];

    constructor(root: THREE.Object3D) {
        this.root = root;
        root.updateMatrixWorld(true);
        root.traverse((o) => {
            const b = o as THREE.Bone;
            const isTail = b.isBone && /tail/i.test(o.name) && !o.name.startsWith('mixamorig');
            if (b.isBone && (o.name.startsWith('mixamorig') || isTail) && !this.bones.has(o.name)) {
                if (isTail) this.tail.push(o.name);
                this.bones.set(o.name, b);
                this.order.push(b);
                this.bindLocal.set(b, b.quaternion.clone());
                this.delta.set(b, new THREE.Quaternion());
                this.model.set(b, new THREE.Quaternion());
            }
        });
        const hips = this.bones.get(BONE.hips);
        if (hips) this.hipsBind.copy(hips.position);
        const box = new THREE.Box3();
        root.traverse((o) => {
            const m = o as THREE.SkinnedMesh;
            if (m.isSkinnedMesh) { m.geometry.computeBoundingBox?.(); }
        });
        box.setFromObject(root, true);
        this.height = Math.max(0.1, box.max.y - box.min.y);
        this.footY = box.min.y;
        if (hips) {
            const h = new THREE.Vector3(), inv = new THREE.Matrix4().copy(root.matrixWorld).invert();
            hips.getWorldPosition(h).applyMatrix4(inv);
            this.hipsHeight = Math.max(0.05 * this.height, h.y - this.footY);
        }
        const up = this.bones.get(BONE.lUp), foot = this.bones.get(BONE.lFoot);
        if (up && foot) {
            const a = new THREE.Vector3(), b = new THREE.Vector3(), inv = new THREE.Matrix4().copy(root.matrixWorld).invert();
            up.getWorldPosition(a).applyMatrix4(inv);
            foot.getWorldPosition(b).applyMatrix4(inv);
            this.legLength = Math.max(0.05 * this.height, a.distanceTo(b));
        }
    }

    has(name: string): boolean { return this.bones.has(name); }

    /** The hips bone's bind position (its parent's units). */
    get hipsBindPosition(): THREE.Vector3 { return this.hipsBind; }
    /** Names of every posed bone (the Mixamo set plus the tail chain). */
    get boneNames(): ReadonlySet<string> { return new Set(this.bones.keys()); }

    /**
     * Pose ONLY the tail chain, on top of whatever the rest of the skeleton is doing now (a clip from an AnimationMixer): the same model-space
     * deltas as `set`, against the parents' current orientation instead of the procedural chain's. Call after the mixer has updated.
     */
    applyTail(deltas: (index: number) => [number, number, number]): void {
        const hips = this.bones.get(BONE.hips);
        const armature = hips?.parent;
        if (!armature) return;
        armature.updateWorldMatrix(true, false);
        const armInv = new THREE.Quaternion();
        armature.getWorldQuaternion(armInv).invert();
        const pm = new THREE.Quaternion(), m = new THREE.Quaternion(), d = new THREE.Quaternion();
        this.tail.forEach((name, i) => {
            const b = this.bones.get(name);
            const parent = b?.parent;
            if (!b || !parent) return;
            parent.updateWorldMatrix(true, false);
            parent.getWorldQuaternion(pm).premultiply(armInv);   // the parent's model-space rotation now
            const [rx, ry, rz] = deltas(i);
            qa.setFromAxisAngle(AX.z, rz); qb.setFromAxisAngle(AX.y, ry);
            d.copy(qb).multiply(qa);
            qa.setFromAxisAngle(AX.x, rx);
            d.premultiply(qa);
            m.copy(d).multiply(pm).multiply(this.bindLocal.get(b)!);
            b.quaternion.copy(pm.invert()).multiply(m);
            b.updateMatrixWorld(true);
        });
    }

    /** Set a bone's model-space delta as rotations about X, Y, Z (applied Z, then Y, then X). */
    set(name: string, rx = 0, ry = 0, rz = 0): void {
        const b = this.bones.get(name);
        if (!b) return;
        const d = this.delta.get(b)!;
        qa.setFromAxisAngle(AX.z, rz);
        qb.setFromAxisAngle(AX.y, ry);
        d.copy(qb).multiply(qa);
        qa.setFromAxisAngle(AX.x, rx);
        d.premultiply(qa);
    }
    reset(): void { for (const d of this.delta.values()) d.identity(); }

    /** Offset the hips (m, model space) on top of their bind position. */
    setHips(x: number, y: number, z: number): void {
        const hips = this.bones.get(BONE.hips);
        if (hips) hips.position.set(this.hipsBind.x + x, this.hipsBind.y + y, this.hipsBind.z + z);
    }

    /** Resolve all deltas into bone quaternions (call once per frame after setting poses). */
    apply(): void {
        for (const b of this.order) {
            const parent = b.parent as THREE.Bone | null;
            const d = this.delta.get(b)!;
            const m = this.model.get(b)!;
            const pm = parent && this.model.get(parent);
            if (!pm) {
                // top of the chain: hips (their parent is the armature, treated as identity)
                m.copy(d).multiply(this.bindLocal.get(b)!);
                b.quaternion.copy(m);
            } else {
                m.copy(d).multiply(pm).multiply(this.bindLocal.get(b)!);
                qa.copy(pm).invert();
                b.quaternion.copy(qa).multiply(m);
            }
        }
    }
}
