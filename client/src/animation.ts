import * as THREE from "three";
import type { GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";

/**
 * AnimationManager handles skeletal animations for GLTF models
 * Manages animation playback, cross-fading, and state transitions
 */
export class AnimationManager {
  private mixer: THREE.AnimationMixer;
  private animations: Map<string, THREE.AnimationAction> = new Map();
  private currentAction: THREE.AnimationAction | null = null;
  private currentAnimationName: string | null = null;

  constructor(gltf: GLTF) {
    this.mixer = new THREE.AnimationMixer(gltf.scene);

    // Parse and store all animations from the GLTF
    if (gltf.animations && gltf.animations.length > 0) {
      gltf.animations.forEach((clip) => {
        const action = this.mixer.clipAction(clip);
        // Normalize animation names (lowercase, trim whitespace)
        const normalizedName = clip.name.toLowerCase().trim();
        this.animations.set(normalizedName, action);
        console.log(`Registered animation: "${normalizedName}"`);
      });
    } else {
      console.warn("No animations found in GLTF model");
    }
  }

  /**
   * Play an animation with optional cross-fade transition
   * @param name - Animation name (case-insensitive)
   * @param loop - Whether to loop the animation
   * @param fadeTime - Cross-fade duration in seconds
   */
  playAnimation(name: string, loop: boolean = true, fadeTime: number = 0.2): void {
    const normalizedName = name.toLowerCase().trim();

    // Don't restart if already playing
    if (this.currentAnimationName === normalizedName) {
      return;
    }

    const action = this.animations.get(normalizedName);
    if (!action) {
      console.warn(`Animation "${name}" not found. Available:`, Array.from(this.animations.keys()));
      return;
    }

    // Configure the new action
    action.reset();
    action.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, loop ? Infinity : 1);
    action.clampWhenFinished = !loop; // Hold on last frame if not looping

    // Cross-fade from current to new animation
    if (this.currentAction && this.currentAction !== action && fadeTime > 0) {
      this.currentAction.fadeOut(fadeTime);
      action.fadeIn(fadeTime);
    } else {
      action.setEffectiveWeight(1.0);
    }

    action.play();
    this.currentAction = action;
    this.currentAnimationName = normalizedName;
  }

  /**
   * Stop the current animation
   * @param fadeTime - Fade out duration in seconds
   */
  stopAnimation(fadeTime: number = 0.2): void {
    if (this.currentAction) {
      if (fadeTime > 0) {
        this.currentAction.fadeOut(fadeTime);
      } else {
        this.currentAction.stop();
      }
      this.currentAction = null;
      this.currentAnimationName = null;
    }
  }

  /**
   * Set animation playback speed
   * @param speed - Playback rate (1.0 = normal, 2.0 = double speed, etc.)
   */
  setSpeed(speed: number): void {
    if (this.currentAction) {
      this.currentAction.setEffectiveTimeScale(speed);
    }
  }

  /**
   * Update the animation mixer (call this every frame)
   * @param deltaTime - Time elapsed since last update in seconds
   */
  update(deltaTime: number): void {
    this.mixer.update(deltaTime);
  }

  /**
   * Get list of available animation names
   */
  getAnimationNames(): string[] {
    return Array.from(this.animations.keys());
  }

  /**
   * Check if an animation exists
   */
  hasAnimation(name: string): boolean {
    return this.animations.has(name.toLowerCase().trim());
  }

  /**
   * Get current animation name
   */
  getCurrentAnimation(): string | null {
    return this.currentAnimationName;
  }
}
